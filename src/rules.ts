import type { CalDAVConfig, Task } from './types.ts';

export function shouldSyncTask(task: Task): boolean {
  return !!(task.dueWithTime || task.dueDay) && !task.isDone;
}

export function shouldDeleteTask(task: Task, config: CalDAVConfig): boolean {
  if (!task.dueWithTime && !task.dueDay) return true;
  if (task.isDone && config.deleteCompletedTasks) return true;
  return false;
}

export function eventUidForTask(task: Task): string {
  return `sp-task-${task.id}`;
}

export function eventUidForTaskId(taskId: string): string {
  return `sp-task-${taskId}`;
}
