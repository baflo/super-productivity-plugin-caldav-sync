import type { CalDAVConfig, Task } from './types.ts';
import { getConfig, isConfigComplete, SYNC_RELEVANT_FIELDS } from './config.ts';
import { shouldDeleteTask, shouldSyncTask, eventUidForTask, eventUidForTaskId } from './rules.ts';
import { createEventFromTask } from './ical/build.ts';
import { deleteCalDAVEvent, putCalDAVEvent } from './caldav/client.ts';
import { flushPendingOps, pendingOps, queuePerTask } from './sync/queue.ts';
import { consumeImporting } from './sync/import.ts';

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
// batch deletes (e.g. deleting a task with subtasks)
export function extractDeletedTaskIds(payload: unknown): string[] {
  if (typeof payload === 'string') return [payload];
  if (!payload || typeof payload !== 'object') return [];
  const p = payload as Record<string, unknown>;
  if (Array.isArray(p.taskIds)) return p.taskIds as string[];
  if (p.taskId) return [p.taskId as string];
  return [];
}

// allowDelete=false for TASK_CREATED: a brand-new task cannot have an event
// yet, and issuing a DELETE here would race the PUT of the scheduling
// TASK_UPDATE that follows right after when creating a task in the schedule
// view
export async function onTaskUpsert(payload: unknown, allowDelete = true): Promise<void> {
  const { task: payloadTask, taskId, changes } = extractTaskRef(payload);

  // Echo suppression: this hook invocation was caused by our own
  // updateTask while importing a calendar edit — do not write it back.
  if (taskId && consumeImporting(taskId)) return;

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
      await queuePerTask(resolvedTask.id, () =>
        putCalDAVEvent(
          config,
          eventUidForTask(resolvedTask),
          createEventFromTask(resolvedTask, config),
        ),
      );
      pendingOps.delete(resolvedTask.id);
      console.log('[CalDAV Sync] Synchronized:', resolvedTask.title);
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
    await queuePerTask(taskId, () =>
      deleteCalDAVEvent(config, eventUidForTaskId(taskId)),
    );
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
