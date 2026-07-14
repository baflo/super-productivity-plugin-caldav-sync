/**
 * Minimal, tolerant iCalendar parser for the pull path.
 *
 * Scope: extract the first VEVENT of a VCALENDAR with the properties the
 * plugin owns (SUMMARY, DESCRIPTION, DTSTART, DTEND, DURATION,
 * LAST-MODIFIED, UID). Nested components (VALARM — which has its own
 * DESCRIPTION! — and VTIMEZONE) are skipped when scanning properties.
 *
 * Timezone handling: UTC (`...Z`) and IANA `TZID=` values (resolved via
 * Intl). Unknown TZIDs and floating times fall back to device-local time
 * (documented design decision for Phase 1; embedded VTIMEZONE blocks are
 * not evaluated).
 */

export interface ICalDateTime {
  /** VALUE=DATE (all-day) */
  dateOnly: boolean;
  epochMs: number;
}

export interface ParsedVEvent {
  uid?: string;
  summary?: string;
  description?: string;
  dtstart?: ICalDateTime;
  dtend?: ICalDateTime;
  durationMs?: number;
  /** LAST-MODIFIED as epoch ms */
  lastModified?: number;
  /** Unfolded VEVENT block lines, for future read-modify-write */
  rawLines: string[];
}

interface RawProp {
  name: string;
  params: Record<string, string>;
  value: string;
}

/** RFC 5545 unfolding: CRLF (or LF) followed by space/tab continues the line */
export function unfoldICalLines(text: string): string[] {
  const physical = text.split(/\r\n|\n|\r/);
  const lines: string[] = [];
  for (const line of physical) {
    if ((line.startsWith(' ') || line.startsWith('\t')) && lines.length > 0) {
      lines[lines.length - 1] += line.slice(1);
    } else if (line.length > 0) {
      lines.push(line);
    }
  }
  return lines;
}

export function unescapeICalText(value: string): string {
  return value.replace(/\\([\\;,nN])/g, (_m, ch: string) =>
    ch === 'n' || ch === 'N' ? '\n' : ch,
  );
}

/** Split "NAME;PARAM=x;OTHER="a:b":VALUE" respecting quoted params */
export function parseContentLine(line: string): RawProp | null {
  let inQuote = false;
  let colonIdx = -1;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') inQuote = !inQuote;
    else if (ch === ':' && !inQuote) {
      colonIdx = i;
      break;
    }
  }
  if (colonIdx < 0) return null;

  const prelude = line.slice(0, colonIdx);
  const value = line.slice(colonIdx + 1);

  // split prelude on ';' outside quotes
  const parts: string[] = [];
  let current = '';
  inQuote = false;
  for (const ch of prelude) {
    if (ch === '"') inQuote = !inQuote;
    if (ch === ';' && !inQuote) {
      parts.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  parts.push(current);

  const name = parts[0].toUpperCase();
  if (!name) return null;
  const params: Record<string, string> = {};
  for (const part of parts.slice(1)) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    const key = part.slice(0, eq).toUpperCase();
    let val = part.slice(eq + 1);
    if (val.startsWith('"') && val.endsWith('"')) val = val.slice(1, -1);
    params[key] = val;
  }
  return { name, params, value };
}

/** Offset (ms) of an IANA timezone at a given instant */
function tzOffsetMs(epochMs: number, timeZone: string): number {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
  const parts: Record<string, number> = {};
  for (const p of dtf.formatToParts(new Date(epochMs))) {
    if (p.type !== 'literal') parts[p.type] = Number(p.value);
  }
  const asUTC = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour % 24,
    parts.minute,
    parts.second,
  );
  return asUTC - epochMs;
}

/** Convert wall-clock time in an IANA zone to epoch ms (DST-aware) */
export function zonedTimeToEpochMs(
  y: number,
  mo: number,
  d: number,
  h: number,
  mi: number,
  s: number,
  timeZone: string,
): number {
  const guess = Date.UTC(y, mo - 1, d, h, mi, s);
  const offset1 = tzOffsetMs(guess, timeZone);
  const epoch = guess - offset1;
  const offset2 = tzOffsetMs(epoch, timeZone);
  return offset2 === offset1 ? epoch : guess - offset2;
}

export function parseICalDate(value: string, params: Record<string, string>): ICalDateTime | null {
  const dateOnlyMatch = value.match(/^(\d{4})(\d{2})(\d{2})$/);
  if (params.VALUE === 'DATE' || dateOnlyMatch) {
    const m = dateOnlyMatch ?? value.match(/^(\d{4})(\d{2})(\d{2})/);
    if (!m) return null;
    return {
      dateOnly: true,
      epochMs: Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])),
    };
  }

  const m = value.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z?)$/);
  if (!m) return null;
  const [y, mo, d, h, mi, s] = [m[1], m[2], m[3], m[4], m[5], m[6]].map(Number);

  if (m[7] === 'Z') {
    return { dateOnly: false, epochMs: Date.UTC(y, mo - 1, d, h, mi, s) };
  }

  if (params.TZID) {
    try {
      return { dateOnly: false, epochMs: zonedTimeToEpochMs(y, mo, d, h, mi, s, params.TZID) };
    } catch {
      console.warn('[CalDAV Sync] Unknown TZID, treating as local time:', params.TZID);
    }
  }
  // Floating time: interpret in device-local timezone
  return { dateOnly: false, epochMs: new Date(y, mo - 1, d, h, mi, s).getTime() };
}

export function parseICalDuration(value: string): number | null {
  const m = value.match(/^([+-])?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/);
  if (!m) return null;
  const sign = m[1] === '-' ? -1 : 1;
  const [weeks, days, hours, minutes, seconds] = [m[2], m[3], m[4], m[5], m[6]].map(
    (v) => Number(v ?? 0),
  );
  return (
    sign *
    (((weeks * 7 + days) * 24 * 3600 + hours * 3600 + minutes * 60 + seconds) * 1000)
  );
}

/** Extract the first VEVENT from an iCalendar text; null if none found */
export function parseVEvent(icsText: string): ParsedVEvent | null {
  const lines = unfoldICalLines(icsText);

  const startIdx = lines.findIndex((l) => l.toUpperCase() === 'BEGIN:VEVENT');
  if (startIdx < 0) return null;

  const event: ParsedVEvent = { rawLines: [] };
  let nestedDepth = 0;

  for (let i = startIdx + 1; i < lines.length; i++) {
    const line = lines[i];
    const upper = line.toUpperCase();
    if (upper === 'END:VEVENT' && nestedDepth === 0) {
      event.rawLines = lines.slice(startIdx, i + 1);
      return event;
    }
    if (upper.startsWith('BEGIN:')) {
      nestedDepth++;
      continue;
    }
    if (upper.startsWith('END:')) {
      nestedDepth = Math.max(0, nestedDepth - 1);
      continue;
    }
    if (nestedDepth > 0) continue; // skip VALARM etc. — they have their own props

    const prop = parseContentLine(line);
    if (!prop) continue;
    switch (prop.name) {
      case 'UID':
        event.uid = prop.value;
        break;
      case 'SUMMARY':
        event.summary = unescapeICalText(prop.value);
        break;
      case 'DESCRIPTION':
        event.description = unescapeICalText(prop.value);
        break;
      case 'DTSTART':
        event.dtstart = parseICalDate(prop.value, prop.params) ?? undefined;
        break;
      case 'DTEND':
        event.dtend = parseICalDate(prop.value, prop.params) ?? undefined;
        break;
      case 'DURATION':
        event.durationMs = parseICalDuration(prop.value) ?? undefined;
        break;
      case 'LAST-MODIFIED': {
        const parsed = parseICalDate(prop.value, prop.params);
        if (parsed) event.lastModified = parsed.epochMs;
        break;
      }
    }
  }
  return null; // unterminated VEVENT
}
