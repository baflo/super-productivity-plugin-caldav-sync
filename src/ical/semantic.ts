/**
 * The Semantic projection — the ONLY shape that is ever compared between a
 * task and a calendar event. All normalization (trimming, minute rounding,
 * timezone resolution) lives here and nowhere else.
 *
 * Deliberately excluded (see docs/two-way-sync-design.md): DTSTAMP, SEQUENCE,
 * ETags, formatting, and VALARM — alarms are write-only output derived from
 * config, not synced data.
 */
import type { Task } from '../types.ts';
import type { ParsedVEvent } from './parse.ts';

export interface Semantic {
  title: string;
  notes: string;
  allDay: boolean;
  /** Epoch ms, rounded to the minute; for allDay: UTC day start */
  start: number;
  /** Minutes; compared for timed events only */
  durationM: number;
}

const MINUTE_MS = 60000;
const DAY_MS = 24 * 60 * MINUTE_MS;
const DEFAULT_DURATION_M = 60;

function roundToMinute(epochMs: number): number {
  return Math.round(epochMs / MINUTE_MS) * MINUTE_MS;
}

export function dayStrFromEpoch(epochMs: number): string {
  const d = new Date(epochMs);
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

export function semanticOfTask(task: Task): Semantic | null {
  if (task.dueWithTime) {
    return {
      title: task.title.trim(),
      notes: (task.notes ?? '').trim(),
      allDay: false,
      start: roundToMinute(task.dueWithTime),
      durationM: Math.round((task.timeEstimate || 3600000) / MINUTE_MS),
    };
  }
  if (task.dueDay) {
    return {
      title: task.title.trim(),
      notes: (task.notes ?? '').trim(),
      allDay: true,
      start: new Date(`${task.dueDay}T00:00:00Z`).getTime(),
      durationM: 24 * 60,
    };
  }
  return null;
}

export function semanticOfEvent(event: ParsedVEvent): Semantic | null {
  if (!event.dtstart) return null;

  if (event.dtstart.dateOnly) {
    return {
      title: (event.summary ?? '').trim(),
      notes: (event.description ?? '').trim(),
      allDay: true,
      start: event.dtstart.epochMs,
      durationM: event.dtend
        ? Math.max(1, Math.round((event.dtend.epochMs - event.dtstart.epochMs) / MINUTE_MS))
        : 24 * 60,
    };
  }

  const start = roundToMinute(event.dtstart.epochMs);
  let durationM = DEFAULT_DURATION_M;
  if (event.dtend) {
    durationM = Math.round((roundToMinute(event.dtend.epochMs) - start) / MINUTE_MS);
  } else if (event.durationMs != null) {
    durationM = Math.round(event.durationMs / MINUTE_MS);
  }
  return {
    title: (event.summary ?? '').trim(),
    notes: (event.description ?? '').trim(),
    allDay: false,
    start,
    durationM: Math.max(1, durationM),
  };
}

/**
 * Field-wise equality. For all-day pairs the duration is ignored: SP's
 * dueDay models exactly one day, so a multi-day calendar event still maps to
 * the same task state.
 */
export function semanticEqual(a: Semantic | null, b: Semantic | null): boolean {
  if (a == null || b == null) return a === b;
  if (a.title !== b.title || a.notes !== b.notes) return false;
  if (a.allDay !== b.allDay) return false;
  if (a.allDay) {
    return dayStrFromEpoch(a.start) === dayStrFromEpoch(b.start);
  }
  return a.start === b.start && a.durationM === b.durationM;
}

export { DAY_MS };
