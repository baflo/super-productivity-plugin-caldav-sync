/**
 * Pull path (Phase 1): poll the calendar for changes and import calendar
 * edits into SP tasks.
 *
 * Change detection is cheap: a Depth:0 PROPFIND for CTag/sync-token per
 * tick; only when it moved do we fetch the delta (RFC 6578 sync-collection
 * when available, full ETag diff otherwise) and GET the changed events.
 *
 * Runs only while the app is visible; a visibilitychange/focus listener
 * fires one immediate catch-up tick on resume (mobile WebViews freeze
 * timers in background — see design doc, resolved Q5).
 */
import type { CalDAVConfig, Task } from '../types.ts';
import { getConfig, isConfigComplete } from '../config.ts';
import { shouldSyncTask } from '../rules.ts';
import {
  getCalDAVEvent,
  getCalendarSyncState,
  propfindEtags,
  syncCollectionDelta,
} from '../caldav/client.ts';
import { taskIdFromHref } from '../caldav/xml.ts';
import { parseVEvent } from '../ical/parse.ts';
import { semanticEqual, semanticOfEvent, semanticOfTask } from '../ical/semantic.ts';
import { applySemanticToTask } from './import.ts';
import { loadPullState, savePullState } from './state.ts';
import { flushPendingOps, pendingOps } from './queue.ts';

export interface PullStats {
  upToDate: boolean;
  imported: number;
  unchanged: number;
  skipped: number;
  removedRemotely: number;
  /** Tasks that just received calendar values — do not push them right back */
  importedTaskIds: string[];
}

const BASE_INTERVAL_MS = 45000;
const JITTER_MS = 15000;
const MAX_BACKOFF = 16;

let timer: ReturnType<typeof setTimeout> | null = null;
let backoff = 1;
let inFlightTick: Promise<PullStats> | null = null;
let started = false;

function isVisible(): boolean {
  return typeof document === 'undefined' || document.visibilityState !== 'hidden';
}

function scheduleNext(delayMs: number): void {
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => void run(), delayMs);
}

// One periodic cycle: retry queued (failed/offline) ops first — this runs
// regardless of twoWaySync so offline pushes catch up automatically — then
// pull calendar changes when two-way sync is on. Exported for tests.
export async function runPollCycle(): Promise<void> {
  const config = await getConfig();
  if (!config.enabled || !isConfigComplete(config)) return;

  if (pendingOps.size > 0) {
    await flushPendingOps(config);
  }
  if (config.twoWaySync && isVisible()) {
    await pollTick(config);
  }
}

async function run(): Promise<void> {
  try {
    await runPollCycle();
    backoff = 1;
  } catch (error) {
    console.warn('[CalDAV Sync] Poll cycle failed:', error);
    backoff = Math.min(backoff * 2, MAX_BACKOFF);
  }
  scheduleNext((BASE_INTERVAL_MS + Math.random() * JITTER_MS) * backoff);
}

export function startPolling(): void {
  if (started) return;
  started = true;

  if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
    document.addEventListener('visibilitychange', () => {
      if (isVisible()) scheduleNext(1000); // catch-up tick on resume
    });
  }
  if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
    window.addEventListener('focus', () => scheduleNext(1000));
    // Back online: flush queued ops / catch up immediately
    window.addEventListener('online', () => scheduleNext(1000));
  }
  scheduleNext(5000);
}

// Concurrent callers (scheduled cycle vs. manual sync) share one tick: the
// second caller AWAITS the running tick instead of silently skipping —
// otherwise a manual sync could push without having pulled.
export function pollTick(config: CalDAVConfig): Promise<PullStats> {
  if (inFlightTick) return inFlightTick;
  const stats: PullStats = {
    upToDate: false,
    imported: 0,
    unchanged: 0,
    skipped: 0,
    removedRemotely: 0,
    importedTaskIds: [],
  };
  inFlightTick = pollTickInner(config, stats).finally(() => {
    inFlightTick = null;
  });
  return inFlightTick;
}

async function pollTickInner(config: CalDAVConfig, stats: PullStats): Promise<PullStats> {
  const state = loadPullState(config.calendarUrl);
  const remote = await getCalendarSyncState(config);

  const tokenUnchanged =
    remote.syncToken != null && state.syncToken != null && remote.syncToken === state.syncToken;
  const ctagUnchanged =
    remote.syncToken == null && remote.ctag != null && remote.ctag === state.ctag;
  if (tokenUnchanged || ctagUnchanged) {
    stats.upToDate = true;
    return stats;
  }

  // Determine changed/deleted sp-task entries
  let changed: Array<{ taskId: string; etag?: string }> = [];
  let deletedTaskIds: string[] = [];
  let newToken: string | undefined;

  const delta = state.syncToken ? await syncCollectionDelta(config, state.syncToken) : null;
  if (delta) {
    for (const entry of delta.changed) {
      const taskId = taskIdFromHref(entry.href);
      if (taskId) changed.push({ taskId, etag: entry.etag });
    }
    deletedTaskIds = delta.deletedHrefs
      .map(taskIdFromHref)
      .filter((id): id is string => id !== null);
    newToken = delta.newToken;
  } else {
    // Full diff via ETags (initial run, no token, or token rejected)
    const listing = await propfindEtags(config);
    const seen = new Set<string>();
    for (const entry of listing) {
      const taskId = taskIdFromHref(entry.href);
      if (!taskId) continue;
      seen.add(taskId);
      if (!entry.etag || state.etags[taskId] !== entry.etag) {
        changed.push({ taskId, etag: entry.etag });
      }
    }
    deletedTaskIds = Object.keys(state.etags).filter((taskId) => !seen.has(taskId));
    newToken = remote.syncToken;
  }

  const tasks: Task[] = changed.length > 0 ? await PluginAPI.getTasks() : [];
  const tasksById = new Map(tasks.map((t) => [t.id, t]));

  for (const { taskId, etag } of changed) {
    try {
      const task = tasksById.get(taskId);
      // No matching task -> orphan (manual sync territory). Done/unscheduled
      // tasks: existence & schedule authority stays with SP, never import.
      if (!task || !shouldSyncTask(task)) {
        stats.skipped++;
        if (etag) state.etags[taskId] = etag;
        continue;
      }
      // A queued local op means the task is ahead of the calendar — do not
      // overwrite the newer local state with a stale event (Phase 1 guard).
      if (pendingOps.has(taskId)) {
        stats.skipped++;
        continue;
      }

      const fetched = await getCalDAVEvent(config, `sp-task-${taskId}`);
      if (!fetched) {
        stats.removedRemotely++;
        delete state.etags[taskId];
        continue;
      }
      const parsed = parseVEvent(fetched.ics);
      const remoteSem = parsed ? semanticOfEvent(parsed) : null;
      if (!remoteSem) {
        stats.skipped++;
        if (fetched.etag) state.etags[taskId] = fetched.etag;
        continue;
      }

      if (semanticEqual(remoteSem, semanticOfTask(task))) {
        // Echo of our own write or no-op — just record the ETag
        stats.unchanged++;
      } else {
        const didChange = await applySemanticToTask(task, remoteSem);
        if (didChange) {
          stats.imported++;
          stats.importedTaskIds.push(taskId);
        } else {
          stats.unchanged++;
        }
      }
      const effectiveEtag = fetched.etag ?? etag;
      if (effectiveEtag) state.etags[taskId] = effectiveEtag;
    } catch (error) {
      console.warn('[CalDAV Sync] Pull failed for task, will retry next tick:', taskId, error);
    }
  }

  for (const taskId of deletedTaskIds) {
    // No eager recreation (design principle 5) — just forget the ETag.
    if (state.etags[taskId]) {
      delete state.etags[taskId];
      stats.removedRemotely++;
    }
  }

  state.syncToken = newToken ?? null;
  state.ctag = remote.ctag ?? null;
  savePullState(state);

  if (stats.imported > 0) {
    console.log('[CalDAV Sync] Pull tick:', stats);
  }
  return stats;
}
