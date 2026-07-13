import type { CalDAVConfig } from '../types.ts';

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

export async function putCalDAVEvent(
  config: CalDAVConfig,
  eventUid: string,
  eventData: string,
): Promise<void> {
  const response = await fetch(eventUrl(config, eventUid), {
    method: 'PUT',
    headers: {
      'Content-Type': 'text/calendar; charset=utf-8',
      Authorization: authHeader(config),
    },
    body: eventData,
  });

  if (!response.ok) {
    throw new Error(`CalDAV PUT failed: ${response.status} ${response.statusText}`);
  }
}

export async function deleteCalDAVEvent(
  config: CalDAVConfig,
  eventUid: string,
): Promise<void> {
  const response = await fetch(eventUrl(config, eventUid), {
    method: 'DELETE',
    headers: { Authorization: authHeader(config) },
  });

  if (!response.ok && response.status !== 404) {
    throw new Error(`CalDAV DELETE failed: ${response.status} ${response.statusText}`);
  }
}

// Lists all sp-task-*.ics resources in the calendar and returns their task ids
export async function listCalDAVTaskIds(config: CalDAVConfig): Promise<string[]> {
  const response = await fetch(config.calendarUrl, {
    method: 'PROPFIND',
    headers: {
      Authorization: authHeader(config),
      Depth: '1',
      'Content-Type': 'application/xml; charset=utf-8',
    },
    body:
      '<?xml version="1.0" encoding="utf-8" ?>' +
      '<d:propfind xmlns:d="DAV:"><d:prop><d:resourcetype/></d:prop></d:propfind>',
  });

  if (!response.ok) {
    throw new Error(
      `CalDAV PROPFIND failed: ${response.status} ${response.statusText}`,
    );
  }

  const xml = new DOMParser().parseFromString(await response.text(), 'application/xml');
  const hrefs = Array.from(xml.getElementsByTagNameNS('DAV:', 'href'));
  const taskIds: string[] = [];
  for (const href of hrefs) {
    const name = decodeURIComponent((href.textContent || '').split('/').pop() || '');
    const match = name.match(/^sp-task-(.+)\.ics$/);
    if (match) taskIds.push(match[1]);
  }
  return taskIds;
}
