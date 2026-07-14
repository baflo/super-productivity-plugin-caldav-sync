/**
 * The reconcile state machine (Phase 2 of docs/two-way-sync-design.md).
 *
 * Every write path funnels through here: If-Match/If-None-Match CAS on the
 * server, three-way decisions against the device-local {etag, snap, gone}
 * record, deterministic field merge on concurrent edits (base = snapshot,
 * tie-break = task.updated vs LAST-MODIFIED, SP wins ties — inputs that are
 * identical on all clients once SP sync and polling have caught up).
 */
import type { CalDAVConfig, Task } from '../types.ts';
import { eventUidForTask, eventUidForTaskId, shouldDeleteTask, shouldSyncTask } from '../rules.ts';
import { createEventFromTask } from '../ical/build.ts';
import { parseVEvent, type ParsedVEvent } from '../ical/parse.ts';
import {
  dayStrFromEpoch,
  semanticEqual,
  semanticOfEvent,
  semanticOfTask,
  type Semantic,
} from '../ical/semantic.ts';
import {
  deleteCalDAVEvent,
  getCalDAVEvent,
  putCalDAVEvent,
  PreconditionFailedError,
  type FetchedEvent,
} from '../caldav/client.ts';
import { getEventTimezone } from '../caldav/timezone.ts';
import { applySemanticToTask, taskUpdatesFromSemantic } from './import.ts';
import {
  dropRecord,
  getRecord,
  loadPullState,
  savePullState,
  setRecord,
  type TaskRecord,
} from './state.ts';

export interface ReconcileStats {
  imported: number;
  pushed: number;
  unchanged: number;
  removedRemotely: number;
  deletedEvents: number;
  conflicts: number;
  importedTaskIds: string[];
}

const MAX_CAS_RETRIES = 2;

/** Task object with a semantic applied — used to build merged events */
function taskWithSemantic(task: Task, sem: Semantic): Task {
  return { ...task, ...(taskUpdatesFromSemantic(task, sem) ?? {}) };
}

/**
 * Re-read the task at execution time. Hook payloads and pollTick's task list
 * are snapshots — a concurrently queued import (per-task queue!) may have
 * updated the task after the snapshot was taken. Deciding on a stale
 * snapshot would push outdated values right back to the calendar (observed
 * as "title correct everywhere, times diverge").
 */
async function freshTask(taskId: string, fallback: Task | null): Promise<Task | null> {
  try {
    const tasks = await PluginAPI.getTasks();
    return tasks.find((t) => t.id === taskId) ?? fallback;
  } catch {
    return fallback;
  }
}

/** CAS write; returns the new record on success, null on 412 */
async function writeEventCAS(
  config: CalDAVConfig,
  task: Task,
  sem: Semantic,
  record: TaskRecord,
): Promise<TaskRecord | null> {
  const tz = await getEventTimezone(config);
  const ics = createEventFromTask(taskWithSemantic(task, sem), config, tz);
  const uid = eventUidForTask(task);
  const opts =
    record.etag && !record.gone ? { ifMatch: record.etag } : { ifNoneMatch: true };
  try {
    const result = await putCalDAVEvent(config, uid, ics, opts);
    let etag = result.etag ?? null;
    if (!etag) {
      // Server modified the object on storage (sabre) — learn the real ETag
      etag = (await getCalDAVEvent(config, uid))?.etag ?? null;
    }
    return { etag, snap: sem, gone: false };
  } catch (error) {
    if (error instanceof PreconditionFailedError) return null;
    throw error;
  }
}

/** Deletion always wins (existence is owned by SP): CAS first, force on 412 */
async function deleteEventCAS(
  config: CalDAVConfig,
  taskId: string,
  record: TaskRecord,
): Promise<void> {
  const uid = eventUidForTaskId(taskId);
  try {
    await deleteCalDAVEvent(config, uid, record.etag ? { ifMatch: record.etag } : {});
  } catch (error) {
    if (error instanceof PreconditionFailedError) {
      console.warn(
        '[CalDAV Sync] Event changed concurrently but the task is gone/done — deleting anyway:',
        taskId,
      );
      PluginAPI.showSnack({
        msg: 'A calendar edit was discarded because the task was completed/removed',
        type: 'WARNING',
      });
      await deleteCalDAVEvent(config, uid);
    } else {
      throw error;
    }
  }
}

/** Local task changed / needs syncing — optimistic CAS, full reconcile on 412 */
export async function pushLocalChange(config: CalDAVConfig, taskSnapshot: Task): Promise<boolean> {
  const task = (await freshTask(taskSnapshot.id, taskSnapshot)) as Task;
  const state = loadPullState(config.calendarUrl);
  const record = getRecord(state, task.id);

  if (!shouldSyncTask(task)) {
    if (shouldDeleteTask(task, config)) {
      await deleteEventCAS(config, task.id, record);
      dropRecord(state, task.id);
      savePullState(state);
      return true;
    }
    return false;
  }

  const desired = semanticOfTask(task);
  if (!desired) return false;
  if (record.snap && semanticEqual(desired, record.snap)) return false; // no semantic change

  const written = await writeEventCAS(config, task, desired, record);
  if (written) {
    setRecord(state, task.id, written);
    savePullState(state);
    return true;
  }
  // Lost the CAS race — someone wrote concurrently: pull and fully reconcile
  const fetched = await getCalDAVEvent(config, eventUidForTask(task));
  await reconcileWithRemote(config, task, task.id, fetched, undefined, 1);
  return true;
}

/** Task deleted locally (or completed with deleteCompletedTasks) */
export async function deleteLocalTask(config: CalDAVConfig, taskId: string): Promise<void> {
  const state = loadPullState(config.calendarUrl);
  await deleteEventCAS(config, taskId, getRecord(state, taskId));
  dropRecord(state, taskId);
  savePullState(state);
}

function scheduleKey(sem: Semantic): string {
  return sem.allDay ? `d:${dayStrFromEpoch(sem.start)}` : `t:${sem.start}:${sem.durationM}`;
}

export interface MergeResult {
  merged: Semantic;
  conflicts: string[];
  localWon: boolean;
}

/**
 * Deterministic field merge. Base = snapshot; a field only conflicts when it
 * genuinely differs on both sides, then LWW via task.updated vs LAST-MODIFIED
 * (SP wins ties). snap == null (bootstrap) degrades to pure per-field LWW.
 * Schedule (allDay/start/duration) merges as ONE compound field.
 */
export function mergeFields(
  desired: Semantic,
  remote: Semantic,
  snap: Semantic | null,
  task: Task,
  event: ParsedVEvent,
): MergeResult {
  const localWon = (task.updated ?? 0) >= (event.lastModified ?? 0);
  const conflicts: string[] = [];
  const merged: Semantic = { ...desired };

  const pick = (
    field: 'title' | 'notes',
    localTouched: boolean,
    remoteTouched: boolean,
  ): void => {
    if (desired[field] === remote[field]) return;
    if (remoteTouched && !localTouched) merged[field] = remote[field];
    else if (localTouched && remoteTouched) {
      if (!localWon) merged[field] = remote[field];
      conflicts.push(field);
    }
    // local touched only → keep desired
  };

  pick(
    'title',
    snap == null || desired.title !== snap.title,
    snap == null || remote.title !== snap.title,
  );
  pick(
    'notes',
    snap == null || desired.notes !== snap.notes,
    snap == null || remote.notes !== snap.notes,
  );

  const localSched = snap == null || scheduleKey(desired) !== scheduleKey(snap);
  const remoteSched = snap == null || scheduleKey(remote) !== scheduleKey(snap);
  if (scheduleKey(desired) !== scheduleKey(remote)) {
    if (remoteSched && !localSched) {
      merged.allDay = remote.allDay;
      merged.start = remote.start;
      merged.durationM = remote.durationM;
    } else if (localSched && remoteSched) {
      if (!localWon) {
        merged.allDay = remote.allDay;
        merged.start = remote.start;
        merged.durationM = remote.durationM;
      }
      conflicts.push('schedule');
    }
  }

  return { merged, conflicts, localWon };
}

/**
 * The four-case state machine. `fetched` is the current remote event
 * (null = does not exist on the server).
 */
export async function reconcileWithRemote(
  config: CalDAVConfig,
  taskSnapshot: Task | null,
  taskId: string,
  fetched: FetchedEvent | null,
  stats?: ReconcileStats,
  depth = 0,
): Promise<void> {
  const task = taskSnapshot ? await freshTask(taskId, taskSnapshot) : null;
  const state = loadPullState(config.calendarUrl);
  const record = getRecord(state, taskId);

  // Done task whose event is kept (deleteCompletedTasks off): never touch,
  // only adopt the ETag so it stops showing up as changed.
  if (task && !shouldSyncTask(task) && !shouldDeleteTask(task, config)) {
    if (fetched?.etag && fetched.etag !== record.etag) {
      setRecord(state, taskId, { ...record, etag: fetched.etag, gone: false });
      savePullState(state);
    }
    if (stats) stats.unchanged++;
    return;
  }

  const desired = task && shouldSyncTask(task) ? semanticOfTask(task) : null;
  const parsed = fetched ? parseVEvent(fetched.ics) : null;
  const remote = parsed ? semanticOfEvent(parsed) : null;
  if (fetched && !remote) {
    console.warn('[CalDAV Sync] Unparseable event, skipping:', taskId);
    if (stats) stats.unchanged++;
    return;
  }

  const localChanged = !semanticEqual(desired, record.snap);
  let remoteChanged: boolean;
  if (fetched) {
    if (fetched.etag && fetched.etag === record.etag) {
      remoteChanged = false;
    } else if (semanticEqual(remote, record.snap)) {
      // Another client wrote identical content — adopt the ETag silently
      setRecord(state, taskId, { ...record, etag: fetched.etag ?? record.etag, gone: false });
      savePullState(state);
      remoteChanged = false;
    } else {
      remoteChanged = true;
    }
  } else {
    remoteChanged = record.etag !== null;
  }

  // Case 1: nothing to do
  if (!localChanged && !remoteChanged) {
    if (stats) stats.unchanged++;
    return;
  }

  // Case 2: remote changed, local untouched
  if (remoteChanged && !localChanged) {
    if (!fetched) {
      // Vanished remotely: no eager recreation (principle 5)
      setRecord(state, taskId, { ...record, etag: null, gone: true });
      savePullState(state);
      if (stats) stats.removedRemotely++;
      return;
    }
    if (!desired || !task) {
      // Event exists/changed but the task must not have one → delete
      await deleteEventCAS(config, taskId, { ...record, etag: fetched.etag ?? record.etag });
      dropRecord(state, taskId);
      savePullState(state);
      if (stats) stats.deletedEvents++;
      return;
    }
    const didChange = await applySemanticToTask(task, remote as Semantic);
    setRecord(state, taskId, {
      etag: fetched.etag ?? null,
      snap: remote as Semantic,
      gone: false,
    });
    savePullState(state);
    if (stats) {
      if (didChange) {
        stats.imported++;
        stats.importedTaskIds.push(taskId);
      } else {
        stats.unchanged++;
      }
    }
    return;
  }

  // Case 3: local changed, remote untouched
  if (localChanged && !remoteChanged) {
    if (!desired) {
      await deleteEventCAS(config, taskId, record);
      dropRecord(state, taskId);
      savePullState(state);
      if (stats) stats.deletedEvents++;
      return;
    }
    if (!task) return;
    const baseRecord = fetched ? record : { ...record, etag: null, gone: true };
    const written = await writeEventCAS(config, task, desired, baseRecord);
    if (!written) {
      if (depth < MAX_CAS_RETRIES) {
        const again = await getCalDAVEvent(config, eventUidForTask(task));
        return reconcileWithRemote(config, task, taskId, again, stats, depth + 1);
      }
      throw new Error('CalDAV CAS retry limit reached for ' + taskId);
    }
    setRecord(state, taskId, written);
    savePullState(state);
    if (stats) stats.pushed++;
    return;
  }

  // Case 4: both changed
  if (!desired || !task) {
    // Deletion/completion wins deterministically
    await deleteEventCAS(config, taskId, { ...record, etag: fetched?.etag ?? record.etag });
    dropRecord(state, taskId);
    savePullState(state);
    if (stats) stats.deletedEvents++;
    return;
  }
  if (!fetched) {
    // Vanished remotely AND local change → recreation is allowed here
    const written = await writeEventCAS(config, task, desired, {
      ...record,
      etag: null,
      gone: true,
    });
    if (written) {
      setRecord(state, taskId, written);
      savePullState(state);
      if (stats) stats.pushed++;
    }
    return;
  }

  const { merged, conflicts, localWon } = mergeFields(
    desired,
    remote as Semantic,
    record.snap,
    task,
    parsed as ParsedVEvent,
  );
  // Only a real merge base makes a "conflict" meaningful — bootstrap
  // (snap == null) is plain LWW over an unknown base, no warning needed.
  if (conflicts.length > 0 && record.snap != null) {
    if (stats) stats.conflicts += conflicts.length;
    PluginAPI.showSnack({
      msg: `Concurrent edits on "${task.title}" merged — ${
        localWon ? 'Super Productivity' : 'calendar'
      } won for: ${conflicts.join(', ')}`,
      type: 'WARNING',
    });
  }

  if (!semanticEqual(merged, remote)) {
    const written = await writeEventCAS(config, task, merged, {
      ...record,
      etag: fetched.etag ?? record.etag,
      gone: false,
    });
    if (!written) {
      if (depth < MAX_CAS_RETRIES) {
        const again = await getCalDAVEvent(config, eventUidForTask(task));
        return reconcileWithRemote(config, task, taskId, again, stats, depth + 1);
      }
      throw new Error('CalDAV CAS retry limit reached for ' + taskId);
    }
    setRecord(state, taskId, written);
    savePullState(state);
    if (stats) stats.pushed++;
  } else {
    setRecord(state, taskId, {
      etag: fetched.etag ?? null,
      snap: merged,
      gone: false,
    });
    savePullState(state);
  }

  if (!semanticEqual(merged, desired)) {
    await applySemanticToTask(task, merged);
    if (stats) {
      stats.imported++;
      stats.importedTaskIds.push(taskId);
    }
  } else if (semanticEqual(merged, remote) && stats) {
    stats.unchanged++;
  }
}
