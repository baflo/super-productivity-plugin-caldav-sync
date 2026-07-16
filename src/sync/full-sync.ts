/**
 * Full reconcile sweep (manual sync, Phase 4): every pairing of task and
 * event goes through the reconcile machinery in ONE pass — pushes local
 * changes, imports calendar edits (when twoWaySync is on), recreates
 * missing events, removes orphans, and refreshes the sync token so the
 * next poll starts clean. Catches any drift the incremental token/ETag
 * delta may have missed.
 */
import type { CalDAVConfig, Task } from '../types.ts';
import { shouldDeleteTask, shouldSyncTask, eventUidForTaskId } from '../rules.ts';
import {
  deleteCalDAVEvent,
  getCalDAVEvent,
  getCalendarSyncState,
  propfindEtags,
} from '../caldav/client.ts';
import { taskIdFromHref } from '../caldav/xml.ts';
import { semanticEqual, semanticOfTask } from '../ical/semantic.ts';
import {
  deleteLocalTask,
  forcePushTask,
  pushLocalChange,
  reconcileWithRemote,
  recreateEvent,
  type ReconcileStats,
} from './reconcile.ts';
import { dropRecord, getRecord, loadPullState, savePullState, setRecord } from './state.ts';
import { pendingOps } from './queue.ts';
import { trace } from '../trace.ts';

// Runs worker(item) for all items with limited concurrency; workers must
// handle their own errors
export async function runPool<T>(
  items: readonly T[],
  limit: number,
  worker: (item: T) => Promise<void>,
): Promise<void> {
  let index = 0;
  const runners = Array.from(
    { length: Math.min(limit, items.length) },
    async () => {
      while (index < items.length) {
        const item = items[index++];
        await worker(item);
      }
    },
  );
  await Promise.all(runners);
}

export interface SweepStats extends ReconcileStats {
  recreated: number;
  orphansRemoved: number;
  upToDate: number;
  errors: number;
  firstError: string | null;
}

export async function fullReconcileSync(config: CalDAVConfig): Promise<SweepStats> {
  const stats: SweepStats = {
    imported: 0,
    pushed: 0,
    unchanged: 0,
    removedRemotely: 0,
    deletedEvents: 0,
    conflicts: 0,
    importedTaskIds: [],
    recreated: 0,
    orphansRemoved: 0,
    upToDate: 0,
    errors: 0,
    firstError: null,
  };

  // Token BEFORE the listing: anything changing during the sweep is re-seen
  // by the next poll instead of being skipped.
  const remoteState = await getCalendarSyncState(config);
  const listing = await propfindEtags(config);
  const remoteEtags = new Map<string, string | undefined>();
  for (const entry of listing) {
    const taskId = taskIdFromHref(entry.href);
    if (taskId) remoteEtags.set(taskId, entry.etag);
  }

  const tasks = await PluginAPI.getTasks();
  let archivedTasks: Task[] = [];
  try {
    archivedTasks = await PluginAPI.getArchivedTasks();
  } catch (error) {
    console.warn('[CalDAV Sync] Could not load archived tasks:', error);
  }
  const liveIds = new Set(tasks.map((t) => t.id));
  const archivedById = new Map(archivedTasks.map((t) => [t.id, t]));
  const state = loadPullState(config.calendarUrl);

  const fail = (taskId: string, error: unknown): void => {
    console.error('[CalDAV Sync] Full sync failed for task:', taskId, error);
    stats.errors++;
    if (!stats.firstError) stats.firstError = (error as Error).message;
    pendingOps.set(taskId, 'put');
  };

  // 1) every live task
  const relevantTasks = tasks.filter(
    (task) =>
      shouldSyncTask(task) ||
      remoteEtags.has(task.id) ||
      getRecord(state, task.id).etag !== null,
  );
  await runPool(relevantTasks, 3, async (task) => {
    const record = getRecord(state, task.id);
    const remoteEtag = remoteEtags.get(task.id);
    const eventExists = remoteEtags.has(task.id);
    const keep = !shouldSyncTask(task) && !shouldDeleteTask(task, config);
    try {
      if (!eventExists) {
        if (shouldSyncTask(task)) {
          if (await recreateEvent(config, task)) stats.recreated++;
        } else if (record.etag !== null || record.snap !== null) {
          dropRecord(state, task.id); // nothing local, nothing remote
        }
        pendingOps.delete(task.id);
        return;
      }
      if (keep) {
        if (remoteEtag && remoteEtag !== record.etag) {
          setRecord(state, task.id, { ...record, etag: remoteEtag, gone: false, raw: null });
        }
        stats.upToDate++;
        return;
      }
      if (!shouldSyncTask(task)) {
        await deleteLocalTask(config, task.id);
        stats.deletedEvents++;
        pendingOps.delete(task.id);
        return;
      }
      // fast path: nothing moved on either side
      if (
        remoteEtag !== undefined &&
        remoteEtag === record.etag &&
        record.snap &&
        semanticEqual(semanticOfTask(task), record.snap)
      ) {
        stats.upToDate++;
        pendingOps.delete(task.id);
        return;
      }

      if (config.twoWaySync) {
        const fetched = await getCalDAVEvent(config, eventUidForTaskId(task.id));
        await reconcileWithRemote(config, task, task.id, fetched, stats);
      } else if (remoteEtag !== undefined && remoteEtag === record.etag) {
        // remote untouched → plain CAS push of local changes
        if (await pushLocalChange(config, task)) stats.pushed++;
        else stats.upToDate++;
      } else {
        // one-way mode with remote drift: SP is the source of truth
        if (await forcePushTask(config, task)) stats.pushed++;
      }
      pendingOps.delete(task.id);
    } catch (error) {
      fail(task.id, error);
    }
  });

  // 2) orphans: events whose task no longer exists (archived done tasks are
  //    kept when deleteCompletedTasks is off)
  const orphanIds = [...remoteEtags.keys()].filter((taskId) => {
    if (liveIds.has(taskId)) return false;
    const archived = archivedById.get(taskId);
    return !archived || shouldDeleteTask(archived, config);
  });
  await runPool(orphanIds, 3, async (taskId) => {
    try {
      await deleteCalDAVEvent(config, eventUidForTaskId(taskId));
      dropRecord(state, taskId);
      pendingOps.delete(taskId);
      stats.orphansRemoved++;
    } catch (error) {
      console.warn('[CalDAV Sync] Could not remove orphaned event:', taskId, error);
    }
  });

  // 3) fresh baseline for the incremental poll
  state.syncToken = remoteState.syncToken ?? null;
  state.ctag = remoteState.ctag ?? null;
  savePullState(state);

  trace('full sweep', stats);
  return stats;
}
