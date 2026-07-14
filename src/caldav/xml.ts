/** Parsing helpers for WebDAV multistatus responses (PROPFIND / REPORT). */

export interface MultistatusEntry {
  href: string;
  etag?: string;
  /** true when the response reports 404 (deleted item in a sync REPORT) */
  is404: boolean;
}

export interface MultistatusResult {
  entries: MultistatusEntry[];
  /** RFC 6578 sync token (top-level in REPORTs, inside prop for PROPFIND) */
  syncToken?: string;
  /** calendarserver.org getctag when requested */
  ctag?: string;
}

const DAV_NS = 'DAV:';
const CS_NS = 'http://calendarserver.org/ns/';

function firstText(el: Document | Element, ns: string, local: string): string | undefined {
  const found = el.getElementsByTagNameNS(ns, local)[0];
  const text = found?.textContent?.trim();
  return text || undefined;
}

export function parseMultistatus(xmlText: string): MultistatusResult {
  const doc = new DOMParser().parseFromString(xmlText, 'application/xml');

  const entries: MultistatusEntry[] = [];
  for (const resp of Array.from(doc.getElementsByTagNameNS(DAV_NS, 'response'))) {
    const href = firstText(resp, DAV_NS, 'href');
    if (!href) continue;
    const statuses = Array.from(resp.getElementsByTagNameNS(DAV_NS, 'status')).map(
      (s) => s.textContent ?? '',
    );
    entries.push({
      href,
      etag: firstText(resp, DAV_NS, 'getetag'),
      is404: statuses.some((s) => s.includes(' 404 ') || s.endsWith(' 404')),
    });
  }

  return {
    entries,
    syncToken: firstText(doc, DAV_NS, 'sync-token'),
    ctag: firstText(doc, CS_NS, 'getctag'),
  };
}

/** Extract the task id from an sp-task-*.ics href basename, or null */
export function taskIdFromHref(href: string): string | null {
  const name = decodeURIComponent((href.split('/').pop() ?? '').trim());
  const match = name.match(/^sp-task-(.+)\.ics$/);
  return match ? match[1] : null;
}
