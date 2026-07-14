/**
 * Device-local three-way sync state. Deliberately stored in localStorage and
 * NOT in plugin persistence: everything in SP's pluginUserData is synchronized
 * across clients, and shared mutable sync metadata is the main corruption
 * vector in a multi-writer setup (see docs/two-way-sync-design.md).
 *
 * Per task: the ETag of the event as last seen/written, the semantic snapshot
 * at the last successful sync (the merge base), and the `gone` flag for
 * events that vanished remotely (no eager recreation, design principle 5).
 */
import type { Semantic } from '../ical/semantic.ts';

export interface TaskRecord {
  etag: string | null;
  snap: Semantic | null;
  gone: boolean;
}

export interface PullState {
  calendarUrl: string;
  syncToken: string | null;
  ctag: string | null;
  records: Record<string, TaskRecord>;
}

const STORAGE_KEY = 'caldav-sync.pullState';

function emptyState(calendarUrl: string): PullState {
  return { calendarUrl, syncToken: null, ctag: null, records: {} };
}

// Memoized so every module works on the same object; storage is the backup.
let current: PullState | null = null;

function storage(): Storage | null {
  try {
    return typeof localStorage !== 'undefined' ? localStorage : null;
  } catch {
    return null;
  }
}

/** Accepts current and Phase-1 ({etags}) persisted shapes */
function fromPersisted(raw: unknown, calendarUrl: string): PullState | null {
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as Record<string, unknown>;
  if (obj.calendarUrl !== calendarUrl) return null;
  if (obj.records && typeof obj.records === 'object') return obj as unknown as PullState;
  if (obj.etags && typeof obj.etags === 'object') {
    const records: Record<string, TaskRecord> = {};
    for (const [taskId, etag] of Object.entries(obj.etags as Record<string, string>)) {
      records[taskId] = { etag, snap: null, gone: false };
    }
    return {
      calendarUrl,
      syncToken: (obj.syncToken as string | null) ?? null,
      ctag: (obj.ctag as string | null) ?? null,
      records,
    };
  }
  return null;
}

export function loadPullState(calendarUrl: string): PullState {
  if (current && current.calendarUrl === calendarUrl) return current;

  let state: PullState | null = null;
  const store = storage();
  if (store) {
    const raw = store.getItem(STORAGE_KEY);
    if (raw) {
      try {
        state = fromPersisted(JSON.parse(raw), calendarUrl);
      } catch {
        state = null;
      }
    }
  }
  current = state ?? emptyState(calendarUrl);
  return current;
}

export function savePullState(state: PullState): void {
  current = state;
  const store = storage();
  if (!store) return;
  try {
    store.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch (error) {
    console.warn('[CalDAV Sync] Could not persist pull state:', error);
  }
}

export function getRecord(state: PullState, taskId: string): TaskRecord {
  return state.records[taskId] ?? { etag: null, snap: null, gone: false };
}

export function setRecord(state: PullState, taskId: string, record: TaskRecord): void {
  state.records[taskId] = record;
}

export function dropRecord(state: PullState, taskId: string): void {
  delete state.records[taskId];
}

export function resetPullState(): void {
  current = null;
  const store = storage();
  if (store) {
    try {
      store.removeItem(STORAGE_KEY);
    } catch {
      /* ignore */
    }
  }
}
