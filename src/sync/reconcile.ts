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
import { createEventFromTask, rebuildEventFromRaw } from '../ical/build.ts';
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
  rawForRecord,
  savePullState,
  setRecord,
  type TaskRecord,
} from './state.ts';
import { trace } from '../trace.ts';

// ---------------------------------------------------------------------------
// Ping-pong breaker: detects the cross-direction oscillation pattern
// (write X → import Y → write X again, or import X → write Y → import X)
// within a short window and skips the repeating operation instead of playing
// along. Same-direction sequences (user changing their mind) never match.
// ---------------------------------------------------------------------------
interface SyncHistoryEntry {
  v: string;
  dir: 'write' | 'import';
  at: number;
}
const syncHistory = new Map<string, SyncHistoryEntry[]>();
const OSCILLATION_WINDOW_MS = 2 * 60 * 1000;
let lastOscillationSnackAt = 0;

function recordTransition(taskId: string, dir: 'write' | 'import', v: string): void {
  const entries = (syncHistory.get(taskId) ?? []).filter(
    (e) => Date.now() - e.at < OSCILLATION_WINDOW_MS,
  );
  entries.push({ v, dir, at: Date.now() });
  syncHistory.set(taskId, entries.slice(-6));
}

function isOscillating(taskId: string, dir: 'write' | 'import', v: string): boolean {
  const now = Date.now();
  const entries = (syncHistory.get(taskId) ?? []).filter(
    (e) => now - e.at < OSCILLATION_WINDOW_MS,
  );
  const n = entries.length;
  const opposite = dir === 'write' ? 'import' : 'write';
  return (
    n >= 2 &&
    entries[n - 1].dir === opposite &&
    entries[n - 1].v !== v &&
    entries[n - 2].dir === dir &&
    entries[n - 2].v === v
  );
}

function breakOscillation(taskId: string, dir: 'write' | 'import', title: string): void {
  console.error(
    `[CalDAV Sync] Ping-pong detected (${dir}) for task ${taskId} — skipping this update to break the loop. ` +
      'If this repeats: check for an outdated plugin version on another device and run window.CalDAVSync.enableTrace().',
  );
  if (Date.now() - lastOscillationSnackAt > 60000) {
    lastOscillationSnackAt = Date.now();
    PluginAPI.showSnack({
      msg: `Sync loop detected for "${title}" — paused this update (see console)`,
      type: 'WARNING',
    });
  }
}

export function getSyncHistory(): Map<string, SyncHistoryEntry[]> {
  return syncHistory;
}

export function resetSyncHistory(): void {
  syncHistory.clear();
  lastOscillationSnackAt = 0;
}

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
): Promise<TaskRecord | null | 'skipped'> {
  if (isOscillating(task.id, 'write', scheduleKey(sem))) {
    breakOscillation(task.id, 'write', task.title);
    return 'skipped';
  }
  const uid = eventUidForTask(task);

  // Read-modify-write basis: the raw lines of the version we If-Match
  // against. When missing (older record / echo adoption), fetch it so
  // foreign properties (LOCATION, user alarms, X-props) survive our write.
  let rawLines = record.raw ?? null;
  if (!rawLines && record.etag && !record.gone) {
    const current = await getCalDAVEvent(config, uid);
    if (current) {
      if (current.etag && current.etag !== record.etag) {
        trace('RMW pre-GET found newer version', task.id);
        return null; // concurrent change — caller reconciles
      }
      rawLines = parseVEvent(current.ics)?.rawLines ?? null;
    }
  }

  const tz = await getEventTimezone(config);
  const outTask = taskWithSemantic(task, sem);
  const ics =
    rawLines && rawLines.length > 0
      ? rebuildEventFromRaw(rawLines, outTask, config, tz)
      : createEventFromTask(outTask, config, tz);
  const opts =
    record.etag && !record.gone ? { ifMatch: record.etag } : { ifNoneMatch: true };
  trace('PUT', task.id, opts, 'schedule:', scheduleKey(sem), 'rmw:', !!rawLines);
  try {
    const result = await putCalDAVEvent(config, uid, ics, opts);
    let etag = result.etag ?? null;
    if (!etag) {
      // Server modified the object on storage (sabre) — learn the real ETag
      etag = (await getCalDAVEvent(config, uid))?.etag ?? null;
    }
    recordTransition(task.id, 'write', scheduleKey(sem));
    return {
      etag,
      snap: sem,
      gone: false,
      raw: rawForRecord(parseVEvent(ics)?.rawLines),
    };
  } catch (error) {
    if (error instanceof PreconditionFailedError) {
      trace('PUT 412', task.id);
      return null;
    }
    throw error;
  }
}

/** Import guarded by the ping-pong breaker; returns whether it was applied */
async function importGuarded(
  task: Task,
  sem: Semantic,
  stats: ReconcileStats | undefined,
  taskId: string,
): Promise<boolean> {
  if (isOscillating(taskId, 'import', scheduleKey(sem))) {
    breakOscillation(taskId, 'import', task.title);
    return false;
  }
  const didChange = await applySemanticToTask(task, sem);
  if (didChange) {
    recordTransition(taskId, 'import', scheduleKey(sem));
    if (stats) {
      stats.imported++;
      stats.importedTaskIds.push(taskId);
    }
  } else if (stats) {
    stats.unchanged++;
  }
  return didChange;
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
  if (written === 'skipped') return false;
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

/**
 * Recreate a missing event (manual full sync): the record's cached raw lines
 * are used as RMW basis so foreign props of the deleted event survive the
 * resurrection. An event appearing concurrently (If-None-Match 412) is
 * reconciled instead.
 */
export async function recreateEvent(config: CalDAVConfig, taskSnapshot: Task): Promise<boolean> {
  const task = (await freshTask(taskSnapshot.id, taskSnapshot)) as Task;
  if (!shouldSyncTask(task)) return false;
  const desired = semanticOfTask(task);
  if (!desired) return false;

  const state = loadPullState(config.calendarUrl);
  const record = getRecord(state, task.id);
  const written = await writeEventCAS(config, task, desired, {
    ...record,
    etag: null,
    gone: true,
  });
  if (written === 'skipped') return false;
  if (written) {
    setRecord(state, task.id, written);
    savePullState(state);
    return true;
  }
  const fetched = await getCalDAVEvent(config, eventUidForTask(task));
  await reconcileWithRemote(config, task, task.id, fetched, undefined, 1);
  return true;
}

/**
 * One-way mode (twoWaySync off) with remote drift: SP is the single source
 * of truth, so the task state is pushed over the diverged event — but still
 * via RMW on the CURRENT server version, preserving foreign properties.
 */
export async function forcePushTask(config: CalDAVConfig, taskSnapshot: Task): Promise<boolean> {
  const task = (await freshTask(taskSnapshot.id, taskSnapshot)) as Task;
  if (!shouldSyncTask(task)) return false;
  const desired = semanticOfTask(task);
  if (!desired) return false;

  const state = loadPullState(config.calendarUrl);
  const record = getRecord(state, task.id);
  const fetched = await getCalDAVEvent(config, eventUidForTask(task));
  if (!fetched) return recreateEvent(config, task);

  const written = await writeEventCAS(config, task, desired, {
    etag: fetched.etag ?? null,
    snap: record.snap,
    gone: false,
    raw: rawForRecord(parseVEvent(fetched.ics)?.rawLines),
  });
  if (written && written !== 'skipped') {
    setRecord(state, task.id, written);
    savePullState(state);
    return true;
  }
  return false; // 412 race or oscillation breaker — next sync retries
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
      setRecord(state, taskId, { ...record, etag: fetched.etag, gone: false, raw: null });
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
      // (and its raw lines: their version may carry different foreign props)
      setRecord(state, taskId, {
        ...record,
        etag: fetched.etag ?? record.etag,
        gone: false,
        raw: rawForRecord(parsed?.rawLines),
      });
      savePullState(state);
      remoteChanged = false;
    } else {
      remoteChanged = true;
    }
  } else {
    remoteChanged = record.etag !== null;
  }

  trace('reconcile', taskId, {
    localChanged,
    remoteChanged,
    recEtag: record.etag,
    remoteEtag: fetched?.etag ?? null,
    desired: desired ? scheduleKey(desired) + ' "' + desired.title + '"' : null,
    remote: remote ? scheduleKey(remote) + ' "' + remote.title + '"' : null,
    snap: record.snap ? scheduleKey(record.snap) + ' "' + record.snap.title + '"' : null,
  });

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
    const applied = await importGuarded(task, remote as Semantic, stats, taskId);
    if (applied || semanticEqual(remote, semanticOfTask(task))) {
      setRecord(state, taskId, {
        etag: fetched.etag ?? null,
        snap: remote as Semantic,
        gone: false,
        raw: rawForRecord(parsed?.rawLines),
      });
      savePullState(state);
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
    if (written === 'skipped') return;
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
    if (written && written !== 'skipped') {
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
      raw: rawForRecord(parsed?.rawLines) ?? record.raw,
    });
    if (written === 'skipped') return; // breaker: skip both sides this round
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
      raw: rawForRecord(parsed?.rawLines),
    });
    savePullState(state);
  }

  if (!semanticEqual(merged, desired)) {
    await importGuarded(task, merged, stats, taskId);
  } else if (semanticEqual(merged, remote) && stats) {
    stats.unchanged++;
  }
}
