import type { CalDAVConfig, Task } from '../types.ts';
import { eventUidForTask } from '../rules.ts';
import type { CalendarTz } from '../caldav/timezone.ts';
import { parseContentLine } from './parse.ts';

/** Marker property identifying the plugin's own VALARM block */
export const SP_ALARM_MARKER = 'X-SP-CALDAV';

function scheduleLinesFor(task: Task, tz?: CalendarTz | null): string[] {
  if (task.dueWithTime) {
    const startMs = task.dueWithTime;
    const endMs = startMs + (task.timeEstimate || 3600000);
    if (tz) {
      return [
        `DTSTART;TZID=${tz.tzid}:${formatICalDateTimeZoned(startMs, tz.tzid)}`,
        `DTEND;TZID=${tz.tzid}:${formatICalDateTimeZoned(endMs, tz.tzid)}`,
      ];
    }
    return [
      `DTSTART:${formatICalDateTimeUTC(new Date(startMs))}`,
      `DTEND:${formatICalDateTimeUTC(new Date(endMs))}`,
    ];
  }
  // All-day event: DTEND is exclusive per RFC 5545, so it is the next day
  const startDate = new Date(`${task.dueDay}T00:00:00Z`);
  const endDate = new Date(startDate.getTime() + 24 * 60 * 60 * 1000);
  return [
    `DTSTART;VALUE=DATE:${formatICalDateUTC(startDate)}`,
    `DTEND;VALUE=DATE:${formatICalDateUTC(endDate)}`,
  ];
}

// Reminder (VALARM): static artifact derived from config only — unrelated
// to SP's task-attached reminders and excluded from any back-sync.
// All-day (dueDay-only) tasks get no alarm, matching SP (no notification).
function ourAlarmLines(task: Task, config: CalDAVConfig): string[] {
  if (config.addReminders === false || !task.dueWithTime) return [];
  const mins = Math.max(0, Math.trunc(config.reminderMinutesBefore) || 0);
  const trigger = mins > 0 ? `-PT${mins}M` : 'PT0S';
  return [
    'BEGIN:VALARM',
    `${SP_ALARM_MARKER}:1`,
    'ACTION:DISPLAY',
    `DESCRIPTION:${escapeICalText(task.title)}`,
    `TRIGGER:${trigger}`,
    'END:VALARM',
  ];
}

function ownedHeaderLines(task: Task): string[] {
  return [
    `UID:${eventUidForTask(task)}`,
    `DTSTAMP:${formatICalDateTimeUTC(new Date())}`,
    `LAST-MODIFIED:${formatICalDateTimeUTC(new Date())}`,
  ];
}

function wrapVCalendar(
  task: Task,
  tz: CalendarTz | null | undefined,
  veventLines: string[],
): string {
  // Embed the server-provided VTIMEZONE when we reference its TZID (device
  // TZ fallback has none; IANA TZIDs are resolved by servers/clients anyway)
  const vtimezoneLines = tz && task.dueWithTime ? tz.vtimezoneLines : [];
  return [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Super Productivity//CalDAV Sync Plugin//EN',
    ...vtimezoneLines,
    ...veventLines,
    'END:VCALENDAR',
  ]
    .filter((line) => line)
    .map(foldICalLine)
    .join('\r\n');
}

export function createEventFromTask(
  task: Task,
  config: CalDAVConfig,
  tz?: CalendarTz | null,
): string {
  return wrapVCalendar(task, tz, [
    'BEGIN:VEVENT',
    ...ownedHeaderLines(task),
    ...scheduleLinesFor(task, tz),
    `SUMMARY:${escapeICalText(task.title)}`,
    task.notes ? `DESCRIPTION:${escapeICalText(task.notes)}` : '',
    'STATUS:CONFIRMED',
    'TRANSP:OPAQUE',
    ...ourAlarmLines(task, config),
    'END:VEVENT',
  ]);
}

// Properties the plugin owns and always regenerates; everything else in an
// existing event is preserved verbatim (read-modify-write, design princ. 6).
const OWNED_PROPS = new Set([
  'UID',
  'DTSTAMP',
  'LAST-MODIFIED',
  'DTSTART',
  'DTEND',
  'DURATION',
  'SUMMARY',
  'DESCRIPTION',
]);

/**
 * Rebuild an event from the raw (unfolded) VEVENT lines of its current
 * server version: owned properties are regenerated from the task, all
 * foreign properties and nested components survive. The plugin's own VALARM
 * is identified by the X-SP-CALDAV marker (legacy unmarked alarms whose
 * DESCRIPTION equals the previous SUMMARY are adopted); user-added alarms
 * are kept.
 */
export function rebuildEventFromRaw(
  rawLines: readonly string[],
  task: Task,
  config: CalDAVConfig,
  tz?: CalendarTz | null,
): string {
  const foreignProps: string[] = [];
  const foreignBlocks: string[][] = [];
  let oldSummaryValue: string | null = null;

  const last = rawLines.length - 1; // END:VEVENT
  let i = 1; // skip BEGIN:VEVENT
  while (i < last) {
    const line = rawLines[i];
    const upper = line.toUpperCase();
    if (upper.startsWith('BEGIN:')) {
      const block: string[] = [line];
      i++;
      let depth = 1;
      while (i <= last && depth > 0) {
        const inner = rawLines[i];
        const innerUpper = inner.toUpperCase();
        if (innerUpper.startsWith('BEGIN:')) depth++;
        else if (innerUpper.startsWith('END:')) depth--;
        block.push(inner);
        i++;
      }
      foreignBlocks.push(block);
    } else {
      const prop = parseContentLine(line);
      if (prop?.name === 'SUMMARY') oldSummaryValue = prop.value;
      if (!prop || !OWNED_PROPS.has(prop.name)) {
        foreignProps.push(line);
      }
      i++;
    }
  }

  const isOurAlarm = (block: string[]): boolean => {
    if (block[0].toUpperCase() !== 'BEGIN:VALARM') return false;
    if (block.some((l) => l.toUpperCase().startsWith(SP_ALARM_MARKER))) return true;
    // Legacy alarms from pre-marker versions: DISPLAY + DESCRIPTION == old title
    const isDisplay = block.some((l) => l.toUpperCase().startsWith('ACTION:DISPLAY'));
    const descLine = block.find((l) => l.toUpperCase().startsWith('DESCRIPTION'));
    const descValue = descLine ? parseContentLine(descLine)?.value : undefined;
    return isDisplay && descValue !== undefined && descValue === oldSummaryValue;
  };
  const keptBlocks = foreignBlocks.filter((block) => !isOurAlarm(block));

  return wrapVCalendar(task, tz, [
    'BEGIN:VEVENT',
    ...ownedHeaderLines(task),
    ...scheduleLinesFor(task, tz),
    `SUMMARY:${escapeICalText(task.title)}`,
    task.notes ? `DESCRIPTION:${escapeICalText(task.notes)}` : '',
    ...foreignProps,
    ...ourAlarmLines(task, config),
    ...keptBlocks.flat(),
    'END:VEVENT',
  ]);
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

/** Wall-clock time of an instant in an IANA zone, as iCal local datetime */
export function formatICalDateTimeZoned(epochMs: number, tzid: string): string {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: tzid,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
  const parts: Record<string, string> = {};
  for (const p of dtf.formatToParts(new Date(epochMs))) {
    if (p.type !== 'literal') parts[p.type] = p.value;
  }
  const hour = String(Number(parts.hour) % 24).padStart(2, '0');
  return `${parts.year}${parts.month}${parts.day}T${hour}${parts.minute}${parts.second}`;
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
