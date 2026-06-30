/**
 * CalDAV Schedule Sync Plugin for Super Productivity
 *
 * Automatically synchronizes scheduled tasks to a CalDAV calendar.
 * Configuration is managed by Super Productivity via the plugin settings dialog
 * (jsonSchemaCfg in manifest.json) — no custom UI needed.
 *
 * FEATURES:
 * - Tasks with plannedAt (scheduled date) are synced as timed events
 * - Tasks with dueWithTime (due date + time) are synced as timed events
 * - Tasks with dueDay (due date only) are synced as all-day events
 * - Changes to tasks (title, time, description) are automatically propagated
 * - Deleted or completed tasks are removed from the calendar
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
  deleteCompletedTasks: true,
  addReminders: true,
  reminderMinutesBefore: 0,
};

async function getConfig() {
  const saved = await PluginAPI.getConfig();
  return { ...DEFAULT_CONFIG, ...saved };
}

// ============================================================================
// CalDAV Helper Functions
// ============================================================================

function shouldSyncTask(task) {
  return !!(task.plannedAt || task.dueWithTime || task.dueDay) && !task.isDone;
}

function shouldDeleteTask(task, config) {
  if (!task.plannedAt && !task.dueWithTime && !task.dueDay) return true;
  if (task.isDone && config.deleteCompletedTasks) return true;
  return false;
}

function eventUidForTask(task) {
  return `sp-task-${task.id}`;
}

function createEventFromTask(task, config) {
  config = config || {};
  const hasTime = task.plannedAt || task.dueWithTime;

  let dtstart, dtend;

  if (hasTime) {
    const startDate = new Date(task.plannedAt || task.dueWithTime);
    const duration = task.timeEstimate || 3600000;
    const endDate = new Date(startDate.getTime() + duration);
    dtstart = `DTSTART:${formatICalDateTimeUTC(startDate)}`;
    dtend = `DTEND:${formatICalDateTimeUTC(endDate)}`;
  } else {
    const dateOnly = task.dueDay.replace(/-/g, '');
    dtstart = `DTSTART;VALUE=DATE:${dateOnly}`;
    dtend = `DTEND;VALUE=DATE:${dateOnly}`;
  }

  // Reminder (VALARM): Super Productivity notifies you at a task's scheduled
  // time, so mirror that as an alarm on timed events. Optional lead time via
  // config.reminderMinutesBefore (0 = at the scheduled time, like SP).
  // All-day (dueDay-only) tasks get no alarm, matching SP (no notification).
  let alarmLines = [];
  if (config.addReminders !== false && hasTime) {
    const mins = Math.max(0, parseInt(config.reminderMinutesBefore, 10) || 0);
    const trigger = mins > 0 ? `-PT${mins}M` : 'PT0S';
    alarmLines = [
      'BEGIN:VALARM',
      'ACTION:DISPLAY',
      `DESCRIPTION:${escapeICalText(task.title)}`,
      `TRIGGER:${trigger}`,
      'END:VALARM',
    ];
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
    ...alarmLines,
    'END:VEVENT',
    'END:VCALENDAR',
  ]
    .filter((line) => line)
    .join('\r\n');
}

function formatICalDateTimeUTC(date) {
  const pad = (n) => String(n).padStart(2, '0');
  return (
    `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}` +
    `T${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}Z`
  );
}

function escapeICalText(text) {
  if (!text) return '';
  return text
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\n/g, '\\n');
}

function authHeader(config) {
  return 'Basic ' + btoa(`${config.username}:${config.password}`);
}

async function putCalDAVEvent(config, eventUid, eventData) {
  const response = await fetch(`${config.calendarUrl}${eventUid}.ics`, {
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
  const response = await fetch(`${config.calendarUrl}${eventUid}.ics`, {
    method: 'DELETE',
    headers: { Authorization: authHeader(config) },
  });

  if (!response.ok && response.status !== 404) {
    console.warn('[CalDAV Sync] DELETE warning:', response.status, response.statusText);
  }
}

// ============================================================================
// Event Handlers
// ============================================================================

async function onTaskUpdate(taskIdOrObject) {
  const config = await getConfig();
  if (!config.enabled) return;

  const taskId =
    typeof taskIdOrObject === 'object' ? taskIdOrObject.taskId : taskIdOrObject;
  const tasks = await PluginAPI.getTasks();
  const task = tasks.find((t) => t.id === taskId);
  if (!task) return;

  if (shouldSyncTask(task)) {
    try {
      await putCalDAVEvent(config, eventUidForTask(task), createEventFromTask(task, config));
      PluginAPI.showSnack({ msg: `"${task.title}" synchronized to calendar`, type: 'SUCCESS' });
    } catch (error) {
      console.error('[CalDAV Sync] Error synchronizing:', error);
      PluginAPI.showSnack({ msg: `Error synchronizing: ${error.message}`, type: 'ERROR' });
    }
  } else if (shouldDeleteTask(task, config)) {
    try {
      await deleteCalDAVEvent(config, eventUidForTask(task));
      PluginAPI.showSnack({
        msg: `Event for "${task.title}" removed (no longer scheduled)`,
        type: 'SUCCESS',
      });
    } catch (error) {
      console.error('[CalDAV Sync] Error deleting:', error);
    }
  }
}

async function onTaskDelete(taskIdOrObject) {
  const config = await getConfig();
  if (!config.enabled) return;

  const taskId =
    typeof taskIdOrObject === 'object' ? taskIdOrObject.taskId : taskIdOrObject;
  try {
    await deleteCalDAVEvent(config, `sp-task-${taskId}`);
    PluginAPI.showSnack({ msg: 'Task removed from calendar', type: 'SUCCESS' });
  } catch (error) {
    console.error('[CalDAV Sync] Error deleting event:', error);
    PluginAPI.showSnack({ msg: `Error removing from calendar: ${error.message}`, type: 'ERROR' });
  }
}

async function onTaskComplete(taskIdOrObject) {
  const config = await getConfig();
  if (config.deleteCompletedTasks) {
    await onTaskDelete(taskIdOrObject);
  }
}

// ============================================================================
// Initialization
// ============================================================================

async function init() {
  PluginAPI.registerHook(PluginAPI.Hooks.TASK_UPDATE, onTaskUpdate);
  PluginAPI.registerHook(PluginAPI.Hooks.TASK_DELETE, onTaskDelete);
  PluginAPI.registerHook(PluginAPI.Hooks.TASK_COMPLETE, onTaskComplete);

  PluginAPI.registerHeaderButton({
    label: 'CalDAV Sync',
    icon: 'cloud_upload',
    onClick: async () => {
      const config = await getConfig();

      if (!config.enabled) {
        PluginAPI.showSnack({
          msg: 'CalDAV Sync is disabled. Enable it in the plugin settings.',
          type: 'ERROR',
        });
        return;
      }

      if (!config.calendarUrl || !config.username || !config.password) {
        PluginAPI.showSnack({
          msg: 'CalDAV configuration incomplete! Open the plugin settings.',
          type: 'ERROR',
        });
        return;
      }

      try {
        const tasks = await PluginAPI.getTasks();
        const tasksToSync = tasks.filter(shouldSyncTask);

        if (tasksToSync.length === 0) {
          PluginAPI.showSnack({ msg: 'No scheduled tasks to synchronize found', type: 'SUCCESS' });
          return;
        }

        let synced = 0;
        let errors = 0;

        for (const task of tasksToSync) {
          try {
            await putCalDAVEvent(config, eventUidForTask(task), createEventFromTask(task, config));
            synced++;
            if (synced < tasksToSync.length) {
              await new Promise((resolve) => setTimeout(resolve, 300));
            }
          } catch (error) {
            console.error('[CalDAV Sync] Error synchronizing task:', task.id, error);
            errors++;
          }
        }

        PluginAPI.showSnack({
          msg: `${synced} tasks synchronized, ${errors} errors`,
          type: errors === 0 ? 'SUCCESS' : 'ERROR',
        });
      } catch (error) {
        console.error('[CalDAV Sync] Error:', error);
        PluginAPI.showSnack({ msg: `Error synchronizing: ${error.message}`, type: 'ERROR' });
      }
    },
  });

  const config = await getConfig();
  if (config.enabled) {
    PluginAPI.showSnack({ msg: 'CalDAV Sync enabled', type: 'SUCCESS' });
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
    await putCalDAVEvent(config, eventUidForTask(task), createEventFromTask(task, config));
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
};

console.log('[CalDAV Sync] Debug functions available at window.CalDAVSync');
