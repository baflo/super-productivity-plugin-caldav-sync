/**
 * Applying remote (calendar) state to SP tasks — with echo suppression so
 * our own updateTask does not bounce back into a PUT via the TASK_UPDATE
 * hook.
 */
import type { Task } from '../types.ts';
import type { Semantic } from '../ical/semantic.ts';
import { dayStrFromEpoch } from '../ical/semantic.ts';

// taskId -> expiry timestamp. Entries expire in case the hook never fires
// (otherwise a stale entry would swallow one genuine user edit later).
const importingUntil = new Map<string, number>();
const IMPORT_SUPPRESS_MS = 10000;

export function markImporting(taskId: string): void {
  importingUntil.set(taskId, Date.now() + IMPORT_SUPPRESS_MS);
}

/** Returns true (and consumes the mark) when the hook invocation is our own echo */
export function consumeImporting(taskId: string): boolean {
  const expiry = importingUntil.get(taskId);
  if (expiry === undefined) return false;
  importingUntil.delete(taskId);
  return expiry >= Date.now();
}

const MINUTE_MS = 60000;

/**
 * Computes the minimal Partial<Task> that brings the task in line with the
 * remote semantic. Returns null when there is nothing to change.
 *
 * Reminders are out of scope: reminderId is never touched (design non-goal).
 */
export function taskUpdatesFromSemantic(task: Task, sem: Semantic): Partial<Task> | null {
  const updates: Partial<Task> = {};

  if (sem.title && sem.title !== task.title) {
    updates.title = sem.title;
  }

  // Conservative notes guard: an empty/absent DESCRIPTION never wipes
  // existing task notes — some calendar clients drop DESCRIPTION on edit.
  const taskNotes = task.notes ?? '';
  if (sem.notes !== taskNotes && (sem.notes !== '' || taskNotes === '')) {
    updates.notes = sem.notes;
  }

  if (sem.allDay) {
    const day = dayStrFromEpoch(sem.start);
    if (task.dueDay !== day) updates.dueDay = day;
    if (task.dueWithTime) updates.dueWithTime = null;
  } else {
    const taskStart = task.dueWithTime
      ? Math.round(task.dueWithTime / MINUTE_MS) * MINUTE_MS
      : null;
    if (taskStart !== sem.start) updates.dueWithTime = sem.start;
    if (task.dueDay) updates.dueDay = null;
    // A task without estimate maps to a 1h event on push, so for already
    // timed tasks the 1h default keeps unrelated edits from materializing
    // an estimate. On the all-day/unscheduled -> timed transition however
    // the event duration must always be taken over — without this, moving
    // an all-day event onto a time slot never imported the duration.
    const wasTimed = !!task.dueWithTime;
    const taskDurationM = wasTimed
      ? Math.round((task.timeEstimate || 3600000) / MINUTE_MS)
      : Math.round((task.timeEstimate || 0) / MINUTE_MS);
    if (taskDurationM !== sem.durationM) {
      updates.timeEstimate = sem.durationM * MINUTE_MS;
    }
  }

  return Object.keys(updates).length > 0 ? updates : null;
}

/** Import remote semantic into the task; returns true when something changed */
export async function applySemanticToTask(task: Task, sem: Semantic): Promise<boolean> {
  const updates = taskUpdatesFromSemantic(task, sem);
  if (!updates) return false;

  markImporting(task.id);
  await PluginAPI.updateTask(task.id, updates);
  console.log('[CalDAV Sync] Imported calendar edit for task:', task.id, updates);
  return true;
}
