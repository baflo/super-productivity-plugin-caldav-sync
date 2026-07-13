/**
 * CalDAV Schedule Sync Plugin for Super Productivity
 *
 * Automatically synchronizes scheduled tasks to a CalDAV calendar.
 * Configuration is managed by Super Productivity via the plugin settings dialog
 * (jsonSchemaCfg in manifest.json) — no custom UI needed.
 *
 * FEATURES:
 * - Tasks with dueWithTime (due date + time) are synced as timed events
 * - Tasks with dueDay (due date only) are synced as all-day events
 * - Newly created tasks with a schedule (incl. repeat instances) are synced
 * - Changes to tasks (title, time, description) are automatically propagated
 * - Deleted or completed tasks are removed from the calendar
 * - Manual sync also removes orphaned events left behind in the calendar
 * - Failed requests (e.g. offline) are queued and retried on the next sync
 *
 * DEBUG: window.CalDAVSync.* in the browser console
 */

// ============================================================================
// Config
// ============================================================================

const DEFAULT_CONFIG = {
  calendarUrl: '',
  username: '',
  password: '',
  enabled: false,
  deleteCompletedTasks: false,
};

async function getConfig() {
  const saved = await PluginAPI.getConfig();
  const config = { ...DEFAULT_CONFIG, ...saved };
  if (config.calendarUrl && !config.calendarUrl.endsWith('/')) {
    config.calendarUrl += '/';
  }
  return config;
}

function isConfigComplete(config) {
  return !!(config.calendarUrl && config.username && config.password);
}

// Task fields whose change requires a re-sync. Hook payloads for other
// changes (e.g. subtask order) are ignored to avoid needless PUTs.
const SYNC_RELEVANT_FIELDS = [
  'title',
  'notes',
  'dueDay',
  'dueWithTime',
  'timeEstimate',
  'isDone',
];

// ============================================================================
// CalDAV Helper Functions
// ============================================================================

function shouldSyncTask(task) {
  return !!(task.dueWithTime || task.dueDay) && !task.isDone;
}

function shouldDeleteTask(task, config) {
  if (!task.dueWithTime && !task.dueDay) return true;
  if (task.isDone && config.deleteCompletedTasks) return true;
  return false;
}

function eventUidForTask(task) {
  return `sp-task-${task.id}`;
}

function createEventFromTask(task) {
  let dtstart, dtend;

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
    'END:VEVENT',
    'END:VCALENDAR',
  ]
    .filter((line) => line)
    .map(foldICalLine)
    .join('\r\n');
}

function formatICalDateTimeUTC(date) {
  const pad = (n) => String(n).padStart(2, '0');
  return (
    `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}` +
    `T${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}Z`
  );
}

function formatICalDateUTC(date) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}`;
}

function escapeICalText(text) {
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
function foldICalLine(line) {
  const encoder = new TextEncoder();
  if (encoder.encode(line).length <= 75) return line;

  const parts = [];
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

// btoa only accepts Latin-1, so UTF-8-encode first (umlauts in credentials!)
function authHeader(config) {
  const bytes = new TextEncoder().encode(`${config.username}:${config.password}`);
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return 'Basic ' + btoa(binary);
}

function eventUrl(config, eventUid) {
  return `${config.calendarUrl}${encodeURIComponent(eventUid)}.ics`;
}

async function putCalDAVEvent(config, eventUid, eventData) {
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

async function deleteCalDAVEvent(config, eventUid) {
  const response = await fetch(eventUrl(config, eventUid), {
    method: 'DELETE',
    headers: { Authorization: authHeader(config) },
  });

  if (!response.ok && response.status !== 404) {
    throw new Error(`CalDAV DELETE failed: ${response.status} ${response.statusText}`);
  }
}

// Lists all sp-task-*.ics resources in the calendar and returns their task ids
async function listCalDAVTaskIds(config) {
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
    throw new Error(`CalDAV PROPFIND failed: ${response.status} ${response.statusText}`);
  }

  const xml = new DOMParser().parseFromString(await response.text(), 'application/xml');
  const hrefs = Array.from(xml.getElementsByTagNameNS('DAV:', 'href'));
  const taskIds = [];
  for (const href of hrefs) {
    const name = decodeURIComponent((href.textContent || '').split('/').pop() || '');
    const match = name.match(/^sp-task-(.+)\.ics$/);
    if (match) taskIds.push(match[1]);
  }
  return taskIds;
}

// ============================================================================
// Retry queue (in-memory) for requests that failed, e.g. while offline
// ============================================================================

const pendingOps = new Map(); // taskId -> 'put' | 'delete'
let isFlushingPending = false;

// Hooks can fire nearly simultaneously for the same task (e.g. TASK_CREATED
// followed by the scheduling TASK_UPDATE when a task is created directly in
// the schedule view). Serialize CalDAV requests per task so a slow earlier
// request can never overtake and undo a later one.
const taskOpChains = new Map(); // taskId -> Promise

function queuePerTask(taskId, fn) {
  const prev = taskOpChains.get(taskId) || Promise.resolve();
  const next = prev.then(fn, fn);
  taskOpChains.set(
    taskId,
    next.catch(() => {}),
  );
  return next;
}

async function flushPendingOps(config) {
  if (pendingOps.size === 0 || isFlushingPending) return;
  isFlushingPending = true;
  try {
    let tasksById = null;
    for (const [taskId, op] of Array.from(pendingOps.entries())) {
      try {
        if (op === 'delete') {
          await deleteCalDAVEvent(config, `sp-task-${taskId}`);
        } else {
          if (!tasksById) {
            const tasks = await PluginAPI.getTasks();
            tasksById = new Map(tasks.map((t) => [t.id, t]));
          }
          const task = tasksById.get(taskId);
          if (task && shouldSyncTask(task)) {
            await putCalDAVEvent(config, eventUidForTask(task), createEventFromTask(task));
          }
        }
        pendingOps.delete(taskId);
      } catch (error) {
        console.warn('[CalDAV Sync] Retry failed, keeping queued:', taskId, error);
      }
    }
  } finally {
    isFlushingPending = false;
  }
}

// ============================================================================
// Hook payload helpers
// ============================================================================

// Hook payloads vary by SP version and action: a plain task id string,
// { taskId }, { taskId, task, changes } or the task object itself.
function extractTaskRef(payload) {
  if (typeof payload === 'string') return { taskId: payload };
  if (!payload || typeof payload !== 'object') return {};
  const task =
    payload.task || (payload.id && payload.title !== undefined ? payload : null);
  return {
    task,
    taskId: payload.taskId || (task ? task.id : undefined),
    changes: payload.changes,
  };
}

// TASK_DELETE delivers { taskId } for single deletes but { taskIds } for
// batch deletes (e.g. deleting a task with subtasks)
function extractDeletedTaskIds(payload) {
  if (typeof payload === 'string') return [payload];
  if (!payload || typeof payload !== 'object') return [];
  if (Array.isArray(payload.taskIds)) return payload.taskIds;
  if (payload.taskId) return [payload.taskId];
  return [];
}

// ============================================================================
// Event Handlers
// ============================================================================

// allowDelete=false for TASK_CREATED: a brand-new task cannot have an event
// yet, and issuing a DELETE here would race the PUT of the scheduling
// TASK_UPDATE that follows right after when creating a task in the schedule
// view
async function onTaskUpsert(payload, allowDelete = true) {
  const config = await getConfig();
  if (!config.enabled || !isConfigComplete(config)) return;

  const { task: payloadTask, taskId, changes } = extractTaskRef(payload);

  if (
    changes &&
    Object.keys(changes).length > 0 &&
    !SYNC_RELEVANT_FIELDS.some((field) => field in changes)
  ) {
    return;
  }

  let task = payloadTask ? { ...payloadTask, ...changes } : null;
  if (!task) {
    if (!taskId) return;
    const tasks = await PluginAPI.getTasks();
    task = tasks.find((t) => t.id === taskId);
  }
  if (!task) return;

  if (shouldSyncTask(task)) {
    try {
      await queuePerTask(task.id, () =>
        putCalDAVEvent(config, eventUidForTask(task), createEventFromTask(task)),
      );
      pendingOps.delete(task.id);
      console.log('[CalDAV Sync] Synchronized:', task.title);
      await flushPendingOps(config);
    } catch (error) {
      console.error('[CalDAV Sync] Error synchronizing, queued for retry:', error);
      pendingOps.set(task.id, 'put');
      PluginAPI.showSnack({
        msg: `CalDAV sync failed for "${task.title}" — will retry on next sync`,
        type: 'ERROR',
      });
    }
  } else if (allowDelete && shouldDeleteTask(task, config)) {
    await deleteEventForTaskId(config, task.id);
    await flushPendingOps(config);
  }
}

async function onTaskCreated(payload) {
  await onTaskUpsert(payload, false);
}

async function deleteEventForTaskId(config, taskId) {
  try {
    await queuePerTask(taskId, () => deleteCalDAVEvent(config, `sp-task-${taskId}`));
    pendingOps.delete(taskId);
    console.log('[CalDAV Sync] Event removed for task:', taskId);
  } catch (error) {
    console.error('[CalDAV Sync] Error deleting event, queued for retry:', taskId, error);
    pendingOps.set(taskId, 'delete');
  }
}

async function onTaskDelete(payload) {
  const config = await getConfig();
  if (!config.enabled || !isConfigComplete(config)) return;

  for (const taskId of extractDeletedTaskIds(payload)) {
    await deleteEventForTaskId(config, taskId);
  }
  await flushPendingOps(config);
}

async function onTaskComplete(payload) {
  const config = await getConfig();
  if (!config.enabled || !isConfigComplete(config)) return;
  if (!config.deleteCompletedTasks) return;

  const { taskId } = extractTaskRef(payload);
  if (!taskId) return;
  await deleteEventForTaskId(config, taskId);
  await flushPendingOps(config);
}

// ============================================================================
// Manual sync (header button)
// ============================================================================

// Runs worker(item) for all items with limited concurrency; workers must
// handle their own errors
async function runPool(items, limit, worker) {
  let index = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (index < items.length) {
      const item = items[index++];
      await worker(item);
    }
  });
  await Promise.all(runners);
}

async function cleanupOrphanedEvents(config, tasks) {
  const remoteTaskIds = await listCalDAVTaskIds(config);
  if (remoteTaskIds.length === 0) return 0;

  // Include archived tasks so events of done-but-kept tasks are not treated
  // as orphans when deleteCompletedTasks is off
  let archivedTasks = [];
  try {
    archivedTasks = await PluginAPI.getArchivedTasks();
  } catch (error) {
    console.warn('[CalDAV Sync] Could not load archived tasks:', error);
  }

  const tasksById = new Map(
    [...tasks, ...archivedTasks].map((task) => [task.id, task]),
  );
  const orphanIds = remoteTaskIds.filter((taskId) => {
    const task = tasksById.get(taskId);
    return !task || shouldDeleteTask(task, config);
  });

  let removed = 0;
  await runPool(orphanIds, 3, async (taskId) => {
    try {
      await deleteCalDAVEvent(config, `sp-task-${taskId}`);
      pendingOps.delete(taskId);
      removed++;
    } catch (error) {
      console.warn('[CalDAV Sync] Could not remove orphaned event:', taskId, error);
    }
  });
  return removed;
}

async function manualSync() {
  const config = await getConfig();

  if (!config.enabled) {
    PluginAPI.showSnack({
      msg: 'CalDAV Sync is disabled. Enable it in the plugin settings.',
      type: 'ERROR',
    });
    return;
  }

  if (!isConfigComplete(config)) {
    PluginAPI.showSnack({
      msg: 'CalDAV configuration incomplete! Open the plugin settings.',
      type: 'ERROR',
    });
    return;
  }

  try {
    const tasks = await PluginAPI.getTasks();
    const tasksToSync = tasks.filter(shouldSyncTask);

    let synced = 0;
    let errors = 0;

    await runPool(tasksToSync, 3, async (task) => {
      try {
        await putCalDAVEvent(config, eventUidForTask(task), createEventFromTask(task));
        pendingOps.delete(task.id);
        synced++;
      } catch (error) {
        console.error('[CalDAV Sync] Error synchronizing task:', task.id, error);
        pendingOps.set(task.id, 'put');
        errors++;
      }
    });

    let orphansRemoved = 0;
    try {
      orphansRemoved = await cleanupOrphanedEvents(config, tasks);
    } catch (error) {
      console.warn('[CalDAV Sync] Orphan cleanup skipped:', error);
    }

    const msgParts = [`${synced} tasks synchronized`];
    if (orphansRemoved > 0) msgParts.push(`${orphansRemoved} orphaned events removed`);
    if (errors > 0) msgParts.push(`${errors} errors`);
    PluginAPI.showSnack({
      msg: msgParts.join(', '),
      type: errors === 0 ? 'SUCCESS' : 'ERROR',
    });
  } catch (error) {
    console.error('[CalDAV Sync] Error:', error);
    PluginAPI.showSnack({ msg: `Error synchronizing: ${error.message}`, type: 'ERROR' });
  }
}

// ============================================================================
// Initialization
// ============================================================================

async function init() {
  PluginAPI.registerHook(PluginAPI.Hooks.TASK_UPDATE, onTaskUpsert);
  PluginAPI.registerHook(PluginAPI.Hooks.TASK_DELETE, onTaskDelete);
  PluginAPI.registerHook(PluginAPI.Hooks.TASK_COMPLETE, onTaskComplete);
  // TASK_CREATED covers tasks created with a schedule, incl. repeat instances
  // (fall back to the raw hook name for SP versions without the enum member)
  PluginAPI.registerHook(PluginAPI.Hooks.TASK_CREATED || 'taskCreated', onTaskCreated);

  PluginAPI.registerHeaderButton({
    label: 'CalDAV Sync',
    icon: 'cloud_upload',
    onClick: manualSync,
  });

  const config = await getConfig();
  if (config.enabled) {
    console.log('[CalDAV Sync] Enabled');
  }
}

init();

// ============================================================================
// Debug (browser console)
// ============================================================================

window.CalDAVSync = {
  showConfig: async () => {
    const config = await getConfig();
    console.log('=== CalDAV Config ===');
    console.log({ ...config, password: config.password ? '***' : '' });
    return config;
  },

  syncTask: async (taskId) => {
    const config = await getConfig();
    const tasks = await PluginAPI.getTasks();
    const task = tasks.find((t) => t.id === taskId);
    if (!task) {
      console.error('Task not found:', taskId);
      return;
    }
    console.log('Synchronizing task:', task);
    await putCalDAVEvent(config, eventUidForTask(task), createEventFromTask(task));
  },

  deleteEvent: async (taskId) => {
    const config = await getConfig();
    console.log('Deleting event for task:', taskId);
    await deleteCalDAVEvent(config, `sp-task-${taskId}`);
    console.log('Event deleted');
  },

  getTaskDetails: async (taskId) => {
    const config = await getConfig();
    const tasks = await PluginAPI.getTasks();
    const task = tasks.find((t) => t.id === taskId);
    if (!task) {
      console.error('[CalDAV Sync] Task not found:', taskId);
      return null;
    }
    console.log('=== Task Details ===');
    console.log('shouldSync:', shouldSyncTask(task));
    console.log('shouldDelete:', shouldDeleteTask(task, config));
    console.log(task);
    return task;
  },

  listEvents: async () => {
    const config = await getConfig();
    const taskIds = await listCalDAVTaskIds(config);
    console.log('=== Events in calendar (task ids) ===');
    console.log(taskIds);
    return taskIds;
  },

  cleanupOrphans: async () => {
    const config = await getConfig();
    const tasks = await PluginAPI.getTasks();
    const removed = await cleanupOrphanedEvents(config, tasks);
    console.log('[CalDAV Sync] Orphaned events removed:', removed);
    return removed;
  },

  showPendingRetries: () => {
    console.log('=== Pending retries (taskId -> op) ===');
    console.log(Object.fromEntries(pendingOps));
    return new Map(pendingOps);
  },

  manualSync,
};

console.log('[CalDAV Sync] Debug functions available at window.CalDAVSync');
