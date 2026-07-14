import type { CalDAVConfig, Task } from './types.ts';
import { getConfig, isConfigComplete, SYNC_RELEVANT_FIELDS } from './config.ts';
import { shouldDeleteTask, shouldSyncTask } from './rules.ts';
import { flushPendingOps, pendingOps, queuePerTask } from './sync/queue.ts';
import { consumeImporting } from './sync/import.ts';
import { deleteLocalTask, pushLocalChange } from './sync/reconcile.ts';
import { cleanupOrphanedEvents } from './manual-sync.ts';
import { trace } from './trace.ts';

interface TaskRef {
  task?: Task | null;
  taskId?: string;
  changes?: Partial<Task>;
}

// Hook payloads vary by SP version and action: a plain task id string,
// { taskId }, { taskId, task, changes } or the task object itself.
export function extractTaskRef(payload: unknown): TaskRef {
  if (typeof payload === 'string') return { taskId: payload };
  if (!payload || typeof payload !== 'object') return {};
  const p = payload as Record<string, unknown>;
  const task = (p.task ??
    (p.id && p.title !== undefined ? p : null)) as Task | null;
  return {
    task,
    taskId: (p.taskId as string | undefined) ?? task?.id,
    changes: p.changes as Partial<Task> | undefined,
  };
}

// TASK_DELETE delivers { taskId } for single deletes but { taskIds } for
// batch deletes. Deleting a parent cascades to its subtasks WITHOUT their
// ids appearing in the payload — include task.subTaskIds when present, and
// a deferred orphan sweep (scheduled by onTaskDelete) catches the rest.
export function extractDeletedTaskIds(payload: unknown): string[] {
  if (typeof payload === 'string') return [payload];
  if (!payload || typeof payload !== 'object') return [];
  const p = payload as Record<string, unknown>;
  const ids = new Set<string>();
  if (Array.isArray(p.taskIds)) for (const id of p.taskIds as string[]) ids.add(id);
  if (p.taskId) ids.add(p.taskId as string);
  const task = p.task as Task | undefined;
  if (task && Array.isArray(task.subTaskIds)) for (const id of task.subTaskIds) ids.add(id);
  return [...ids];
}

// Deferred orphan sweep after deletes: subtask events whose ids never appear
// in any hook payload are cleaned up by diffing the calendar against the
// remaining tasks (debounced, so batch deletes trigger one sweep).
let orphanSweepDelayMs = 5000;
let sweepTimer: ReturnType<typeof setTimeout> | null = null;

export function setOrphanSweepDelayForTests(ms: number): void {
  orphanSweepDelayMs = ms;
}

export function cancelOrphanSweepForTests(): void {
  if (sweepTimer) {
    clearTimeout(sweepTimer);
    sweepTimer = null;
  }
}

function scheduleOrphanSweep(): void {
  if (sweepTimer) clearTimeout(sweepTimer);
  sweepTimer = setTimeout(() => void runOrphanSweep(), orphanSweepDelayMs);
  // In Node (tests) a pending timer would keep the process alive; browsers
  // return a number and this is a no-op there.
  (sweepTimer as unknown as { unref?: () => void }).unref?.();
}

async function runOrphanSweep(): Promise<void> {
  try {
    const config = await getConfig();
    if (!config.enabled || !isConfigComplete(config)) return;
    const removed = await cleanupOrphanedEvents(config, await PluginAPI.getTasks());
    if (removed > 0) {
      console.log('[CalDAV Sync] Post-delete sweep removed', removed, 'orphaned events');
    }
  } catch (error) {
    console.warn('[CalDAV Sync] Post-delete orphan sweep failed:', error);
  }
}

// allowDelete=false for TASK_CREATED: a brand-new task cannot have an event
// yet, and issuing a DELETE here would race the PUT of the scheduling
// TASK_UPDATE that follows right after when creating a task in the schedule
// view
export async function onTaskUpsert(payload: unknown, allowDelete = true): Promise<void> {
  const { task: payloadTask, taskId, changes } = extractTaskRef(payload);

  // Echo suppression: this hook invocation was caused by our own
  // updateTask while importing a calendar edit — do not write it back.
  if (taskId && consumeImporting(taskId)) {
    trace('hook: import echo suppressed', taskId);
    return;
  }
  trace('hook: upsert', taskId, changes ? Object.keys(changes) : '(no changes field)');

  const config = await getConfig();
  if (!config.enabled || !isConfigComplete(config)) return;

  if (
    changes &&
    Object.keys(changes).length > 0 &&
    !SYNC_RELEVANT_FIELDS.some((field) => field in changes)
  ) {
    return;
  }

  let task: Task | undefined | null = payloadTask
    ? { ...payloadTask, ...changes }
    : null;
  if (!task) {
    if (!taskId) return;
    const tasks = await PluginAPI.getTasks();
    task = tasks.find((t) => t.id === taskId);
  }
  if (!task) return;
  const resolvedTask = task;

  if (shouldSyncTask(resolvedTask)) {
    try {
      const didWrite = await queuePerTask(resolvedTask.id, () =>
        pushLocalChange(config, resolvedTask),
      );
      pendingOps.delete(resolvedTask.id);
      if (didWrite) console.log('[CalDAV Sync] Synchronized:', resolvedTask.title);
      await flushPendingOps(config);
    } catch (error) {
      console.error('[CalDAV Sync] Error synchronizing, queued for retry:', error);
      pendingOps.set(resolvedTask.id, 'put');
      PluginAPI.showSnack({
        msg: `CalDAV sync failed for "${resolvedTask.title}": ${(error as Error).message} — will retry on next sync`,
        type: 'ERROR',
      });
    }
  } else if (allowDelete && shouldDeleteTask(resolvedTask, config)) {
    await deleteEventForTaskId(config, resolvedTask.id);
    await flushPendingOps(config);
  }
}

export async function onTaskCreated(payload: unknown): Promise<void> {
  await onTaskUpsert(payload, false);
}

export async function deleteEventForTaskId(
  config: CalDAVConfig,
  taskId: string,
): Promise<void> {
  try {
    await queuePerTask(taskId, () => deleteLocalTask(config, taskId));
    pendingOps.delete(taskId);
    console.log('[CalDAV Sync] Event removed for task:', taskId);
  } catch (error) {
    console.error(
      '[CalDAV Sync] Error deleting event, queued for retry:',
      taskId,
      error,
    );
    pendingOps.set(taskId, 'delete');
  }
}

export async function onTaskDelete(payload: unknown): Promise<void> {
  const config = await getConfig();
  if (!config.enabled || !isConfigComplete(config)) return;

  for (const taskId of extractDeletedTaskIds(payload)) {
    await deleteEventForTaskId(config, taskId);
  }
  await flushPendingOps(config);
  scheduleOrphanSweep();
}

export async function onTaskComplete(payload: unknown): Promise<void> {
  const config = await getConfig();
  if (!config.enabled || !isConfigComplete(config)) return;
  if (!config.deleteCompletedTasks) return;

  const { taskId } = extractTaskRef(payload);
  if (!taskId) return;
  await deleteEventForTaskId(config, taskId);
  await flushPendingOps(config);
}
