import type { CalDAVConfig } from '../types.ts';
import { parseMultistatus, taskIdFromHref, type MultistatusEntry } from './xml.ts';

// btoa only accepts Latin-1, so UTF-8-encode first (umlauts in credentials!)
export function authHeader(config: CalDAVConfig): string {
  const bytes = new TextEncoder().encode(`${config.username}:${config.password}`);
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return 'Basic ' + btoa(binary);
}

export function eventUrl(config: CalDAVConfig, eventUid: string): string {
  return `${config.calendarUrl}${encodeURIComponent(eventUid)}.ics`;
}

/** Thrown on 412: the compare-and-swap precondition (If-Match /
 * If-None-Match) failed — someone else wrote the resource concurrently. */
export class PreconditionFailedError extends Error {
  constructor(operation: string) {
    super(`CalDAV ${operation} precondition failed (412) — concurrent change`);
    this.name = 'PreconditionFailedError';
  }
}

export interface PutOptions {
  /** CAS update: only write if the server still has this ETag */
  ifMatch?: string;
  /** CAS create: only write if the resource does not exist yet */
  ifNoneMatch?: boolean;
}

export interface PutResult {
  /** Absent when the server modified the object on storage (sabre behavior)
   * — caller must GET to learn the current ETag. */
  etag?: string;
}

export async function putCalDAVEvent(
  config: CalDAVConfig,
  eventUid: string,
  eventData: string,
  opts: PutOptions = {},
): Promise<PutResult> {
  const headers: Record<string, string> = {
    'Content-Type': 'text/calendar; charset=utf-8',
    Authorization: authHeader(config),
  };
  if (opts.ifMatch) headers['If-Match'] = opts.ifMatch;
  else if (opts.ifNoneMatch) headers['If-None-Match'] = '*';

  const response = await fetch(eventUrl(config, eventUid), {
    method: 'PUT',
    headers,
    body: eventData,
  });

  if (response.status === 412) throw new PreconditionFailedError('PUT');
  if (!response.ok) {
    throw new Error(`CalDAV PUT failed: ${response.status} ${response.statusText}`);
  }
  return { etag: response.headers?.get('ETag') ?? undefined };
}

export async function deleteCalDAVEvent(
  config: CalDAVConfig,
  eventUid: string,
  opts: { ifMatch?: string } = {},
): Promise<void> {
  const headers: Record<string, string> = { Authorization: authHeader(config) };
  if (opts.ifMatch) headers['If-Match'] = opts.ifMatch;

  const response = await fetch(eventUrl(config, eventUid), {
    method: 'DELETE',
    headers,
  });

  if (response.status === 412) throw new PreconditionFailedError('DELETE');
  if (!response.ok && response.status !== 404) {
    throw new Error(`CalDAV DELETE failed: ${response.status} ${response.statusText}`);
  }
}

async function propfind(
  config: CalDAVConfig,
  depth: '0' | '1',
  propXml: string,
): Promise<ReturnType<typeof parseMultistatus>> {
  const response = await fetch(config.calendarUrl, {
    method: 'PROPFIND',
    headers: {
      Authorization: authHeader(config),
      Depth: depth,
      'Content-Type': 'application/xml; charset=utf-8',
    },
    body:
      '<?xml version="1.0" encoding="utf-8" ?>' +
      `<d:propfind xmlns:d="DAV:" xmlns:cs="http://calendarserver.org/ns/"><d:prop>${propXml}</d:prop></d:propfind>`,
  });

  if (!response.ok) {
    throw new Error(
      `CalDAV PROPFIND failed: ${response.status} ${response.statusText}`,
    );
  }
  return parseMultistatus(await response.text());
}

// Lists all sp-task-*.ics resources in the calendar and returns their task ids
export async function listCalDAVTaskIds(config: CalDAVConfig): Promise<string[]> {
  const result = await propfind(config, '1', '<d:resourcetype/>');
  return result.entries
    .map((entry) => taskIdFromHref(entry.href))
    .filter((id): id is string => id !== null);
}

export interface CalendarSyncState {
  ctag?: string;
  syncToken?: string;
}

/** Cheap change detection: CTag + sync-token of the calendar collection */
export async function getCalendarSyncState(
  config: CalDAVConfig,
): Promise<CalendarSyncState> {
  const result = await propfind(config, '0', '<cs:getctag/><d:sync-token/>');
  return { ctag: result.ctag, syncToken: result.syncToken };
}

/** All .ics entries with their ETags (full-diff fallback path) */
export async function propfindEtags(config: CalDAVConfig): Promise<MultistatusEntry[]> {
  const result = await propfind(config, '1', '<d:getetag/>');
  return result.entries.filter((entry) => entry.href.endsWith('.ics'));
}

export interface SyncDelta {
  changed: MultistatusEntry[];
  deletedHrefs: string[];
  newToken?: string;
}

/**
 * RFC 6578 sync-collection REPORT. Returns null when the server rejects the
 * token (expired/invalid) — caller must fall back to a full ETag diff.
 */
export async function syncCollectionDelta(
  config: CalDAVConfig,
  syncToken: string,
): Promise<SyncDelta | null> {
  const response = await fetch(config.calendarUrl, {
    method: 'REPORT',
    headers: {
      Authorization: authHeader(config),
      Depth: '0',
      'Content-Type': 'application/xml; charset=utf-8',
    },
    body:
      '<?xml version="1.0" encoding="utf-8" ?>' +
      '<d:sync-collection xmlns:d="DAV:">' +
      `<d:sync-token>${syncToken}</d:sync-token>` +
      '<d:sync-level>1</d:sync-level>' +
      '<d:prop><d:getetag/></d:prop>' +
      '</d:sync-collection>',
  });

  if (!response.ok) {
    // 403/409/507: token invalid or truncated result — resync from scratch
    console.warn(
      '[CalDAV Sync] sync-collection failed, falling back to full diff:',
      response.status,
    );
    return null;
  }

  const result = parseMultistatus(await response.text());
  return {
    changed: result.entries.filter((e) => !e.is404),
    deletedHrefs: result.entries.filter((e) => e.is404).map((e) => e.href),
    newToken: result.syncToken,
  };
}

export interface FetchedEvent {
  ics: string;
  etag?: string;
}

/** GET a single event; null when it does not exist (404) */
export async function getCalDAVEvent(
  config: CalDAVConfig,
  eventUid: string,
): Promise<FetchedEvent | null> {
  const response = await fetch(eventUrl(config, eventUid), {
    method: 'GET',
    headers: { Authorization: authHeader(config) },
  });
  if (response.status === 404) return null;
  if (!response.ok) {
    throw new Error(`CalDAV GET failed: ${response.status} ${response.statusText}`);
  }
  return {
    ics: await response.text(),
    etag: response.headers?.get('ETag') ?? undefined,
  };
}
