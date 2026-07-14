/**
 * Event timezone resolution: events are written in the calendar's default
 * timezone (CalDAV `calendar-timezone` property, RFC 4791 §5.2.2) so they
 * look native in calendar clients instead of showing up as UTC.
 *
 * Fallback chain: server calendar-timezone → device timezone (TZID without
 * embedded VTIMEZONE — accepted by Nextcloud/Radicale/Baïkal for IANA names)
 * → UTC. Cached per calendar URL.
 */
import type { CalDAVConfig } from '../types.ts';
import { authHeader } from './client.ts';
import { unfoldICalLines } from '../ical/parse.ts';

export interface CalendarTz {
  tzid: string;
  /** VTIMEZONE block (unfolded lines) to embed verbatim; empty for device TZ */
  vtimezoneLines: string[];
}

const CACHE_TTL_MS = 60 * 60 * 1000;
const cache = new Map<string, { tz: CalendarTz | null; fetchedAt: number }>();

// Tests (and debugging) can pin the timezone deterministically
let override: CalendarTz | null | undefined;

export function setTimezoneOverride(tz: CalendarTz | null | undefined): void {
  override = tz;
}

export function resetTimezoneCache(): void {
  cache.clear();
}

export function isUTCZone(tzid: string): boolean {
  return /^(etc\/)?(utc|gmt)([+-]?0+)?$/i.test(tzid) || tzid === 'Z';
}

async function fetchCalendarTimezoneProp(config: CalDAVConfig): Promise<string | null> {
  const response = await fetch(config.calendarUrl, {
    method: 'PROPFIND',
    headers: {
      Authorization: authHeader(config),
      Depth: '0',
      'Content-Type': 'application/xml; charset=utf-8',
    },
    body:
      '<?xml version="1.0" encoding="utf-8" ?>' +
      '<d:propfind xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">' +
      '<d:prop><c:calendar-timezone/></d:prop></d:propfind>',
  });
  if (!response.ok) return null;
  const doc = new DOMParser().parseFromString(await response.text(), 'application/xml');
  const el = doc.getElementsByTagNameNS('urn:ietf:params:xml:ns:caldav', 'calendar-timezone')[0];
  const text = el?.textContent?.trim();
  return text || null;
}

function parseServerTimezone(icsText: string): CalendarTz | null {
  const lines = unfoldICalLines(icsText);
  const begin = lines.findIndex((l) => l.toUpperCase() === 'BEGIN:VTIMEZONE');
  const end = lines.map((l) => l.toUpperCase()).lastIndexOf('END:VTIMEZONE');
  if (begin < 0 || end <= begin) return null;
  const vtimezoneLines = lines.slice(begin, end + 1);
  const tzidLine = vtimezoneLines.find((l) => l.toUpperCase().startsWith('TZID'));
  const tzid = tzidLine?.slice(tzidLine.indexOf(':') + 1).trim();
  if (!tzid) return null;
  return { tzid, vtimezoneLines };
}

function deviceTimezone(): CalendarTz | null {
  try {
    const tzid = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (tzid && !isUTCZone(tzid)) return { tzid, vtimezoneLines: [] };
  } catch {
    /* ignore */
  }
  return null;
}

export async function getEventTimezone(config: CalDAVConfig): Promise<CalendarTz | null> {
  if (override !== undefined) return override;

  const cached = cache.get(config.calendarUrl);
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) return cached.tz;

  let tz: CalendarTz | null = null;
  try {
    const icsText = await fetchCalendarTimezoneProp(config);
    if (icsText) {
      tz = parseServerTimezone(icsText);
      if (tz && isUTCZone(tz.tzid)) tz = null; // UTC calendar → plain Z format
    }
  } catch (error) {
    console.warn('[CalDAV Sync] Could not read calendar-timezone:', error);
  }
  if (!tz) tz = deviceTimezone();

  cache.set(config.calendarUrl, { tz, fetchedAt: Date.now() });
  return tz;
}
