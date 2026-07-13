import type { CalDAVConfig, Task } from '../types.ts';
import { eventUidForTask } from '../rules.ts';

export function createEventFromTask(task: Task, config: CalDAVConfig): string {
  let dtstart: string;
  let dtend: string;

  if (task.dueWithTime) {
    const startDate = new Date(task.dueWithTime);
    const duration = task.timeEstimate || 3600000;
    const endDate = new Date(startDate.getTime() + duration);
    dtstart = `DTSTART:${formatICalDateTimeUTC(startDate)}`;
    dtend = `DTEND:${formatICalDateTimeUTC(endDate)}`;
  } else {
    // All-day event: DTEND is exclusive per RFC 5545, so it is the next day
    const startDate = new Date(`${task.dueDay}T00:00:00Z`);
    const endDate = new Date(startDate.getTime() + 24 * 60 * 60 * 1000);
    dtstart = `DTSTART;VALUE=DATE:${formatICalDateUTC(startDate)}`;
    dtend = `DTEND;VALUE=DATE:${formatICalDateUTC(endDate)}`;
  }

  // Reminder (VALARM): static artifact derived from config only — unrelated
  // to SP's task-attached reminders and excluded from any future back-sync.
  // All-day (dueDay-only) tasks get no alarm, matching SP (no notification).
  let alarmLines: string[] = [];
  if (config.addReminders !== false && task.dueWithTime) {
    const mins = Math.max(0, Math.trunc(config.reminderMinutesBefore) || 0);
    const trigger = mins > 0 ? `-PT${mins}M` : 'PT0S';
    alarmLines = [
      'BEGIN:VALARM',
      'ACTION:DISPLAY',
      `DESCRIPTION:${escapeICalText(task.title)}`,
      `TRIGGER:${trigger}`,
      'END:VALARM',
    ];
  }

  return [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Super Productivity//CalDAV Sync Plugin//EN',
    'BEGIN:VEVENT',
    `UID:${eventUidForTask(task)}`,
    `DTSTAMP:${formatICalDateTimeUTC(new Date())}`,
    dtstart,
    dtend,
    `SUMMARY:${escapeICalText(task.title)}`,
    task.notes ? `DESCRIPTION:${escapeICalText(task.notes)}` : '',
    'STATUS:CONFIRMED',
    'TRANSP:OPAQUE',
    ...alarmLines,
    'END:VEVENT',
    'END:VCALENDAR',
  ]
    .filter((line) => line)
    .map(foldICalLine)
    .join('\r\n');
}

export function formatICalDateTimeUTC(date: Date): string {
  const pad = (n: number): string => String(n).padStart(2, '0');
  return (
    `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}` +
    `T${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}Z`
  );
}

export function formatICalDateUTC(date: Date): string {
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}`;
}

export function escapeICalText(text: string | undefined): string {
  if (!text) return '';
  return text
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\n/g, '\\n');
}

// RFC 5545: content lines must not exceed 75 octets; longer lines are folded
// with CRLF + space. Iterates code points so multi-byte chars are never split.
export function foldICalLine(line: string): string {
  const encoder = new TextEncoder();
  if (encoder.encode(line).length <= 75) return line;

  const parts: string[] = [];
  let current = '';
  let currentLen = 0;
  for (const char of line) {
    const charLen = encoder.encode(char).length;
    if (currentLen + charLen > 75) {
      parts.push(current);
      current = ' ';
      currentLen = 1;
    }
    current += char;
    currentLen += charLen;
  }
  parts.push(current);
  return parts.join('\r\n');
}
