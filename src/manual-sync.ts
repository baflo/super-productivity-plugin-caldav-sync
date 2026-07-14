import type { CalDAVConfig, Task } from './types.ts';
import { getConfig, isConfigComplete } from './config.ts';
import { eventUidForTaskId, shouldDeleteTask, shouldSyncTask } from './rules.ts';
import { deleteCalDAVEvent, listCalDAVTaskIds } from './caldav/client.ts';
import { pendingOps, queuePerTask } from './sync/queue.ts';
import { pollTick } from './sync/poll.ts';
import { pushLocalChange } from './sync/reconcile.ts';
import { dropRecord, loadPullState, savePullState } from './sync/state.ts';

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

export async function cleanupOrphanedEvents(
  config: CalDAVConfig,
  tasks: readonly Task[],
): Promise<number> {
  const remoteTaskIds = await listCalDAVTaskIds(config);
  if (remoteTaskIds.length === 0) return 0;

  // Include archived tasks so events of done-but-kept tasks are not treated
  // as orphans when deleteCompletedTasks is off
  let archivedTasks: Task[] = [];
  try {
    archivedTasks = await PluginAPI.getArchivedTasks();
  } catch (error) {
    console.warn('[CalDAV Sync] Could not load archived tasks:', error);
  }

  const tasksById = new Map(
    [...tasks, ...archivedTasks].map((task) => [task.id, task]),
  );
  const orphanIds = remoteTaskIds.filter((taskId) => {
    const task = tasksById.get(taskId);
    return !task || shouldDeleteTask(task, config);
  });

  const state = loadPullState(config.calendarUrl);
  let removed = 0;
  await runPool(orphanIds, 3, async (taskId) => {
    try {
      await deleteCalDAVEvent(config, eventUidForTaskId(taskId));
      pendingOps.delete(taskId);
      dropRecord(state, taskId);
      removed++;
    } catch (error) {
      console.warn('[CalDAV Sync] Could not remove orphaned event:', taskId, error);
    }
  });
  if (removed > 0) savePullState(state);
  return removed;
}

export async function manualSync(): Promise<void> {
  const config = await getConfig();

  if (!config.enabled) {
    PluginAPI.showSnack({
      msg: 'CalDAV Sync is disabled. Enable it in the plugin settings.',
      type: 'ERROR',
    });
    return;
  }

  if (!isConfigComplete(config)) {
    PluginAPI.showSnack({
      msg: 'CalDAV configuration incomplete! Open the plugin settings.',
      type: 'ERROR',
    });
    return;
  }

  try {
    // Pull FIRST: import pending calendar edits before pushing, otherwise the
    // push would overwrite them with the (older) task state.
    let imported = 0;
    let importedTaskIds = new Set<string>();
    if (config.twoWaySync) {
      try {
        const pullStats = await pollTick(config);
        imported = pullStats.imported;
        importedTaskIds = new Set(pullStats.importedTaskIds);
      } catch (error) {
        console.warn('[CalDAV Sync] Pull during manual sync failed:', error);
      }
    }

    // getTasks AFTER the pull so the push sees the imported values. Tasks
    // that were just imported are excluded from the push entirely: their
    // event IS the newer truth, and re-pushing them could revert the
    // calendar if the task store has not caught up with the import yet.
    const tasks = await PluginAPI.getTasks();
    const tasksToSync = tasks.filter(
      (task) => shouldSyncTask(task) && !importedTaskIds.has(task.id),
    );

    let synced = 0;
    let upToDateCount = 0;
    let errors = 0;
    let firstError: string | null = null;

    await runPool(tasksToSync, 3, async (task) => {
      try {
        const didWrite = await queuePerTask(task.id, () => pushLocalChange(config, task));
        pendingOps.delete(task.id);
        if (didWrite) synced++;
        else upToDateCount++;
      } catch (error) {
        console.error('[CalDAV Sync] Error synchronizing task:', task.id, error);
        pendingOps.set(task.id, 'put');
        if (!firstError) firstError = (error as Error).message;
        errors++;
      }
    });

    let orphansRemoved = 0;
    try {
      orphansRemoved = await cleanupOrphanedEvents(config, tasks);
    } catch (error) {
      console.warn('[CalDAV Sync] Orphan cleanup skipped:', error);
    }

    const msgParts = [`${synced} tasks synchronized`];
    if (upToDateCount > 0) msgParts.push(`${upToDateCount} already up to date`);
    if (imported > 0) msgParts.push(`${imported} calendar edits imported`);
    if (orphansRemoved > 0) msgParts.push(`${orphansRemoved} orphaned events removed`);
    if (errors > 0) msgParts.push(`${errors} errors (first: ${firstError})`);
    PluginAPI.showSnack({
      msg: msgParts.join(', '),
      type: errors === 0 ? 'SUCCESS' : 'ERROR',
    });
  } catch (error) {
    console.error('[CalDAV Sync] Error:', error);
    PluginAPI.showSnack({
      msg: `Error synchronizing: ${(error as Error).message}`,
      type: 'ERROR',
    });
  }
}
