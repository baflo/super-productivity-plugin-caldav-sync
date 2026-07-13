import type { CalDAVConfig } from '../types.ts';
import { createEventFromTask } from '../ical/build.ts';
import { deleteCalDAVEvent, putCalDAVEvent } from '../caldav/client.ts';
import { eventUidForTask, eventUidForTaskId, shouldSyncTask } from '../rules.ts';

// In-memory retry queue for requests that failed, e.g. while offline
export const pendingOps = new Map<string, 'put' | 'delete'>();
let isFlushingPending = false;

// Hooks can fire nearly simultaneously for the same task (e.g. TASK_CREATED
// followed by the scheduling TASK_UPDATE when a task is created directly in
// the schedule view). Serialize CalDAV requests per task so a slow earlier
// request can never overtake and undo a later one.
const taskOpChains = new Map<string, Promise<unknown>>();

export function queuePerTask<T>(taskId: string, fn: () => Promise<T>): Promise<T> {
  const prev = taskOpChains.get(taskId) || Promise.resolve();
  const next = prev.then(fn, fn);
  taskOpChains.set(
    taskId,
    next.catch(() => {}),
  );
  return next;
}

export async function flushPendingOps(config: CalDAVConfig): Promise<void> {
  if (pendingOps.size === 0 || isFlushingPending) return;
  isFlushingPending = true;
  try {
    let tasksById: Map<string, import('../types.ts').Task> | null = null;
    for (const [taskId, op] of Array.from(pendingOps.entries())) {
      try {
        if (op === 'delete') {
          await deleteCalDAVEvent(config, eventUidForTaskId(taskId));
        } else {
          if (!tasksById) {
            const tasks = await PluginAPI.getTasks();
            tasksById = new Map(tasks.map((t) => [t.id, t]));
          }
          const task = tasksById.get(taskId);
          if (task && shouldSyncTask(task)) {
            await putCalDAVEvent(
              config,
              eventUidForTask(task),
              createEventFromTask(task, config),
            );
          }
        }
        pendingOps.delete(taskId);
      } catch (error) {
        console.warn('[CalDAV Sync] Retry failed, keeping queued:', taskId, error);
      }
    }
  } finally {
    isFlushingPending = false;
  }
}
