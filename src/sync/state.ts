/**
 * Device-local pull state. Deliberately stored in localStorage and NOT in
 * plugin persistence: everything in SP's pluginUserData is synchronized
 * across clients, and shared mutable sync metadata is the main corruption
 * vector in a multi-writer setup (see docs/two-way-sync-design.md).
 */

export interface PullState {
  calendarUrl: string;
  syncToken: string | null;
  ctag: string | null;
  /** taskId -> last seen ETag */
  etags: Record<string, string>;
}

const STORAGE_KEY = 'caldav-sync.pullState';

function emptyState(calendarUrl: string): PullState {
  return { calendarUrl, syncToken: null, ctag: null, etags: {} };
}

// In-memory fallback when localStorage is unavailable (e.g. tests, quota)
let memoryState: PullState | null = null;

function storage(): Storage | null {
  try {
    return typeof localStorage !== 'undefined' ? localStorage : null;
  } catch {
    return null;
  }
}

export function loadPullState(calendarUrl: string): PullState {
  const store = storage();
  let state: PullState | null = null;
  if (store) {
    const raw = store.getItem(STORAGE_KEY);
    if (raw) {
      try {
        state = JSON.parse(raw) as PullState;
      } catch {
        state = null;
      }
    }
  } else {
    state = memoryState;
  }
  // A different calendar URL invalidates token and etags
  if (!state || state.calendarUrl !== calendarUrl) {
    return emptyState(calendarUrl);
  }
  return { ...state, etags: { ...state.etags } };
}

export function savePullState(state: PullState): void {
  memoryState = state;
  const store = storage();
  if (!store) return;
  try {
    store.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch (error) {
    console.warn('[CalDAV Sync] Could not persist pull state:', error);
  }
}

export function resetPullState(): void {
  memoryState = null;
  const store = storage();
  if (store) {
    try {
      store.removeItem(STORAGE_KEY);
    } catch {
      /* ignore */
    }
  }
}
