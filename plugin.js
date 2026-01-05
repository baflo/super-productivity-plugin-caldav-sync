/**
 * CalDAV Schedule Sync Plugin for Super Productivity
 *
 * Automatically synchronizes scheduled tasks to a CalDAV calendar.
 *
 * FEATURES:
 * - Tasks with plannedAt (scheduled date) are synced as timed events
 * - Tasks with dueWithTime (due date + time) are synced as timed events
 * - Tasks with dueDay (due date only) are synced as all-day events
 * - All tasks are synchronized, including imported ones from Jira/GitHub/etc.
 * - Changes to tasks (title, time, description) are automatically propagated
 * - Deleted or completed tasks are removed from the calendar
 *
 * CONFIGURATION:
 * Use the Settings UI (Side Panel → "CalDAV Settings") to configure.
 * No manual code editing required!
 *
 * DEBUG:
 * Use window.CalDAVSync.* functions in the browser console for debugging.
 */

// ============================================================================
// Configuration & State
// ============================================================================

// CalDAV Configuration (loaded from Settings UI)
let caldavConfig = {
  username: '',
  password: '',
  calendarUrl: '',
  enabled: false
};

// Mapping: { taskId: eventUid } - Tracks which Super Productivity task corresponds to which CalDAV event
let taskEventMapping = {};

// ============================================================================
// CalDAV Helper Functions
// ============================================================================

/**
 * Creates or updates a CalDAV event for a task
 */
async function syncTaskToCalDAV(task) {
  if (!caldavConfig.enabled) {
    console.log('[CalDAV Sync] Plugin is disabled');
    return;
  }

  // Check if task should be synchronized
  if (!shouldSyncTask(task)) {
    console.log('[CalDAV Sync] Task skipped:', task.id, task.title);
    return;
  }

  try {
    // IMPORTANT: UID must be consistent with the UID in the iCalendar event!
    const eventUid = `sp-task-${task.id}`;
    const eventData = createEventFromTask(task);

    console.log('[CalDAV Sync] Synchronizing task:', task.id, task.title);
    console.log('[CalDAV Sync] Event UID:', eventUid);

    // Push event to calendar
    await putCalDAVEvent(eventUid, eventData);

    // Save mapping
    taskEventMapping[task.id] = eventUid;
    await saveData();

    console.log('[CalDAV Sync] Task successfully synchronized:', task.id);
    console.log('[CalDAV Sync] Mapping saved - entries:', Object.keys(taskEventMapping).length);

    PluginAPI.showSnack({
      msg: `"${task.title}" synchronized to calendar`,
      type: 'SUCCESS'
    });
  } catch (error) {
    console.error('[CalDAV Sync] Error synchronizing:', error);
    PluginAPI.showSnack({
      msg: `Error synchronizing: ${error.message}`,
      type: 'ERROR'
    });
  }
}

/**
 * Checks if a task should be synchronized
 * Returns true if the task has a scheduled date, due date with time, or due date only
 */
function shouldSyncTask(task) {
  // Task must have plannedAt (scheduled) OR dueWithTime (due + time) OR dueDay (date only)
  if (!task.plannedAt && !task.dueWithTime && !task.dueDay) {
    return false;
  }

  // Task must not be completed
  if (task.isDone) {
    return false;
  }

  return true;
}

/**
 * Creates iCalendar event data from a task
 * Supports both timed events and all-day events
 */
function createEventFromTask(task) {
  // Check if task has a time or only a date
  const hasTime = task.plannedAt || task.dueWithTime;
  const hasOnlyDate = !hasTime && task.dueDay;

  let dtstart, dtend;

  if (hasTime) {
    // Task has time → Timed event
    const timestamp = task.plannedAt || task.dueWithTime;
    const startDate = new Date(timestamp);

    // Calculate end date based on timeEstimate (in ms)
    const duration = task.timeEstimate || 3600000; // Default: 1 hour
    const endDate = new Date(startDate.getTime() + duration);

    dtstart = `DTSTART:${formatICalDateTimeUTC(startDate)}`;
    dtend = `DTEND:${formatICalDateTimeUTC(endDate)}`;
  } else if (hasOnlyDate) {
    // Task has only date → All-day event
    // dueDay format: "YYYY-MM-DD"
    const dateOnly = task.dueDay.replace(/-/g, ''); // "2026-01-03" → "20260103"

    // All-day events: DTSTART;VALUE=DATE and DTEND is same day
    dtstart = `DTSTART;VALUE=DATE:${dateOnly}`;
    dtend = `DTEND;VALUE=DATE:${dateOnly}`; // For all-day events End = Start (one day)
  }

  // Create iCalendar VEVENT
  const event = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Super Productivity//CalDAV Sync Plugin//EN',
    'BEGIN:VEVENT',
    `UID:sp-task-${task.id}`,
    `DTSTAMP:${formatICalDateTimeUTC(new Date())}`,
    dtstart,
    dtend,
    `SUMMARY:${escapeICalText(task.title)}`,
    task.notes ? `DESCRIPTION:${escapeICalText(task.notes)}` : '',
    'STATUS:CONFIRMED',
    'TRANSP:OPAQUE',
    'END:VEVENT',
    'END:VCALENDAR'
  ].filter(line => line).join('\r\n');

  return event;
}

/**
 * Formats a Date object as iCalendar DateTime in UTC
 */
function formatICalDateTimeUTC(date) {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  const day = String(date.getUTCDate()).padStart(2, '0');
  const hours = String(date.getUTCHours()).padStart(2, '0');
  const minutes = String(date.getUTCMinutes()).padStart(2, '0');
  const seconds = String(date.getUTCSeconds()).padStart(2, '0');
  
  return `${year}${month}${day}T${hours}${minutes}${seconds}Z`;
}

/**
 * Escapes iCalendar text (commas, semicolons, backslashes)
 */
function escapeICalText(text) {
  if (!text) return '';
  return text
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\n/g, '\\n');
}

/**
 * Sends an event via PUT to the CalDAV server
 */
async function putCalDAVEvent(eventUid, eventData) {
  const eventUrl = `${caldavConfig.calendarUrl}${eventUid}.ics`;

  console.log('[CalDAV Sync] PUT request to:', eventUrl);

  const response = await fetch(eventUrl, {
    method: 'PUT',
    headers: {
      'Content-Type': 'text/calendar; charset=utf-8',
      'Authorization': 'Basic ' + btoa(`${caldavConfig.username}:${caldavConfig.password}`)
    },
    body: eventData
  });

  console.log('[CalDAV Sync] PUT Response Status:', response.status, response.statusText);

  if (!response.ok) {
    const errorText = await response.text();
    console.error('[CalDAV Sync] PUT error details:', errorText);
    throw new Error(`CalDAV PUT failed: ${response.status} ${response.statusText}`);
  }

  console.log('[CalDAV Sync] PUT successful');
}

/**
 * Deletes an event from the CalDAV server
 */
async function deleteCalDAVEvent(eventUid) {
  console.log('[CalDAV Sync] >>> deleteCalDAVEvent() started <<<');
  console.log('[CalDAV Sync] Event UID:', eventUid);
  console.log('[CalDAV Sync] Plugin enabled:', caldavConfig.enabled);

  if (!caldavConfig.enabled) {
    console.log('[CalDAV Sync] ⚠️ DELETE skipped - plugin disabled');
    return;
  }

  const eventUrl = `${caldavConfig.calendarUrl}${eventUid}.ics`;
  console.log('[CalDAV Sync] DELETE Request URL:', eventUrl);
  console.log('[CalDAV Sync] Username:', caldavConfig.username);
  console.log('[CalDAV Sync] Has password:', !!caldavConfig.password);

  try {
    console.log('[CalDAV Sync] Sending DELETE request...');
    const response = await fetch(eventUrl, {
      method: 'DELETE',
      headers: {
        'Authorization': 'Basic ' + btoa(`${caldavConfig.username}:${caldavConfig.password}`)
      }
    });

    console.log('[CalDAV Sync] DELETE Response Status:', response.status);
    console.log('[CalDAV Sync] DELETE Response StatusText:', response.statusText);

    const responseText = await response.text();
    console.log('[CalDAV Sync] DELETE Response Body:', responseText);

    if (!response.ok && response.status !== 404) {
      console.warn('[CalDAV Sync] ⚠️ DELETE warning:', response.status, response.statusText);
      // Don't throw error, just log
    } else {
      console.log('[CalDAV Sync] ✅ DELETE successful or event did not exist (404)');
    }
  } catch (error) {
    console.error('[CalDAV Sync] ❌ DELETE error:', error);
    throw error; // Re-throw error for better error handling
  }
}

// ============================================================================
// Persistence
// ============================================================================
// IMPORTANT: persistDataSynced() and loadSyncedData() accept NO key parameter!
// There is only one persistence slot per plugin.
// We therefore store Config and Mapping together in one object.

/**
 * Loads saved data (Config + Mapping) from the plugin storage
 */
async function loadData() {
  try {
    console.log('[CalDAV Sync] Loading plugin data...');

    const dataString = await PluginAPI.loadSyncedData();
    console.log('[CalDAV Sync] Loaded string:', dataString);

    if (!dataString || typeof dataString !== 'string') {
      console.log('[CalDAV Sync] ⚠️ No saved data found - using defaults');
      return;
    }

    const data = JSON.parse(dataString);
    console.log('[CalDAV Sync] Parsed data:', data);

    // Load config
    if (data.config && typeof data.config === 'object') {
      caldavConfig = data.config;
      console.log('[CalDAV Sync] ✅ Config loaded:', {
        enabled: caldavConfig.enabled,
        hasUrl: !!caldavConfig.calendarUrl,
        hasUsername: !!caldavConfig.username,
        hasPassword: !!caldavConfig.password
      });
    }

    // Load mapping
    if (data.mapping && typeof data.mapping === 'object') {
      taskEventMapping = data.mapping;
      console.log('[CalDAV Sync] ✅ Mapping loaded:', Object.keys(taskEventMapping).length, 'entries');
    }
  } catch (error) {
    console.error('[CalDAV Sync] ❌ Error loading:', error);
    // On error: keep defaults
  }
}

/**
 * Saves Config and Mapping together to the plugin storage
 */
async function saveData() {
  try {
    const data = {
      config: caldavConfig,
      mapping: taskEventMapping
    };

    const dataString = JSON.stringify(data);
    console.log('[CalDAV Sync] Saving plugin data:', data);

    await PluginAPI.persistDataSynced(dataString);
    console.log('[CalDAV Sync] ✅ Data successfully saved');
  } catch (error) {
    console.error('[CalDAV Sync] ❌ Error saving:', error);
    throw error;
  }
}

// ============================================================================
// Event Handlers
// ============================================================================


/**
 * Called when a task is updated
 * Syncs the task to CalDAV or removes it if no longer scheduled
 */
async function onTaskUpdate(taskIdOrObject) {
  // IMPORTANT: Super Productivity sometimes passes {taskId: 'xxx'} instead of just the ID!
  const taskId = typeof taskIdOrObject === 'object' ? taskIdOrObject.taskId : taskIdOrObject;

  console.log('[CalDAV Sync] ========================================');
  console.log('[CalDAV Sync] TASK_UPDATE HOOK TRIGGERED!');
  console.log('[CalDAV Sync] Task ID:', taskId);
  console.log('[CalDAV Sync] Timestamp:', new Date().toISOString());
  console.log('[CalDAV Sync] ========================================');

  const tasks = await PluginAPI.getTasks();
  const task = tasks.find(t => t.id === taskId);

  if (task) {
    console.log('[CalDAV Sync] Task found:', {
      id: task.id,
      title: task.title,
      plannedAt: task.plannedAt,
      dueWithTime: task.dueWithTime,
      dueDay: task.dueDay,
      isDone: task.isDone
    });
  }

  if (!task) {
    console.warn('[CalDAV Sync] Task not found:', taskId);
    return;
  }
  
  // Check if task should be synchronized
  if (shouldSyncTask(task)) {
    // Task is syncable → synchronize or update event
    await syncTaskToCalDAV(task);
  } else {
    // Task is NO longer syncable → delete event if it exists
    // (e.g. when plannedAt/dueWithTime was removed, or task was completed)
    const eventUid = taskEventMapping[taskId] || `sp-task-${taskId}`;

    console.log('[CalDAV Sync] Task no longer syncable, deleting event:', taskId);

    try {
      await deleteCalDAVEvent(eventUid);

      // Remove from mapping (if exists)
      if (taskEventMapping[taskId]) {
        delete taskEventMapping[taskId];
        await saveData();
      }

      PluginAPI.showSnack({
        msg: `Event for "${task.title}" removed (no longer scheduled)`,
        type: 'SUCCESS'
      });
    } catch (error) {
      console.error('[CalDAV Sync] Error deleting:', error);
      // Don't show error, as task might never have been synced
    }
  }
}

/**
 * Called when a task is deleted
 * Removes the corresponding CalDAV event
 */
async function onTaskDelete(taskIdOrObject) {
  // IMPORTANT: Super Productivity sometimes passes {taskId: 'xxx'} instead of just the ID!
  const taskId = typeof taskIdOrObject === 'object' ? taskIdOrObject.taskId : taskIdOrObject;

  console.log('[CalDAV Sync] ========================================');
  console.log('[CalDAV Sync] onTaskDelete HOOK TRIGGERED!');
  console.log('[CalDAV Sync] Task ID (extracted):', taskId);
  console.log('[CalDAV Sync] Original parameter:', taskIdOrObject);
  console.log('[CalDAV Sync] Current mapping:', taskEventMapping);
  console.log('[CalDAV Sync] ========================================');

  // Try to get UID from mapping, use standard UID if not found
  const eventUid = taskEventMapping[taskId] || `sp-task-${taskId}`;

  console.log('[CalDAV Sync] Event UID to be deleted:', eventUid);
  console.log('[CalDAV Sync] CalDAV enabled?', caldavConfig.enabled);

  try {
    await deleteCalDAVEvent(eventUid);

    // Remove from mapping (if exists)
    if (taskEventMapping[taskId]) {
      delete taskEventMapping[taskId];
      await saveData();
    }

    console.log('[CalDAV Sync] Event successfully deleted for task:', taskId);

    PluginAPI.showSnack({
      msg: 'Task removed from calendar',
      type: 'SUCCESS'
    });
  } catch (error) {
    console.error('[CalDAV Sync] Error deleting event:', error);
    PluginAPI.showSnack({
      msg: `Error removing from calendar: ${error.message}`,
      type: 'ERROR'
    });
  }
}

/**
 * Called when a task is completed
 * Removes the event from the calendar
 */
async function onTaskComplete(taskIdOrObject) {
  // IMPORTANT: Super Productivity sometimes passes {taskId: 'xxx'} instead of just the ID!
  const taskId = typeof taskIdOrObject === 'object' ? taskIdOrObject.taskId : taskIdOrObject;

  // Delete event when task is completed
  await onTaskDelete(taskId);
}

// ============================================================================
// Plugin Initialization
// ============================================================================

async function init() {
  console.log('[CalDAV Sync] Plugin initializing...');

  // Load saved data (Config + Mapping)
  await loadData();

  // Extra safety check: Ensure taskEventMapping is an object
  if (typeof taskEventMapping !== 'object' || Array.isArray(taskEventMapping)) {
    console.warn('[CalDAV Sync] taskEventMapping is not a valid object, reinitializing');
    taskEventMapping = {};
  }

  console.log('[CalDAV Sync] Config loaded:', {
    enabled: caldavConfig.enabled,
    hasUrl: !!caldavConfig.calendarUrl,
    hasUsername: !!caldavConfig.username,
    hasPassword: !!caldavConfig.password
  });

  console.log('[CalDAV Sync] Task-Event-Mapping:', Object.keys(taskEventMapping).length, 'entries');

  // Register event hooks
  // IMPORTANT: ANY_TASK_UPDATE instead of TASK_UPDATE - triggers for ALL changes (incl. time)
  PluginAPI.registerHook(PluginAPI.Hooks.TASK_UPDATE, onTaskUpdate);
  PluginAPI.registerHook(PluginAPI.Hooks.TASK_DELETE, onTaskDelete);
  PluginAPI.registerHook(PluginAPI.Hooks.TASK_COMPLETE, onTaskComplete);

  // Register side panel button for settings
  PluginAPI.registerSidePanelButton({
    label: 'CalDAV Settings',
    icon: 'settings',
    onClick: () => {
      console.log('[CalDAV Sync] Settings menu opened');
    },
    onRightClick: () => {
      console.log('[CalDAV Sync] Settings menu right-click opened');
    }
  });

  // Register sync button
  PluginAPI.registerHeaderButton({
    label: 'CalDAV Sync',
    icon: 'cloud_upload',
    onRightClick: () => {
      console.log('[CalDAV Sync] Button right-click');
    },
    onClick: async () => {
      console.log('[CalDAV Sync] Button clicked');

      if (!caldavConfig.enabled) {
        PluginAPI.showSnack({
          msg: 'CalDAV Sync is disabled. Enable it in CalDAV Settings',
          type: 'ERROR'
        });
        return;
      }

      if (!caldavConfig.calendarUrl || !caldavConfig.username || !caldavConfig.password) {
        PluginAPI.showSnack({
          msg: 'CalDAV configuration incomplete! Open CalDAV Settings',
          type: 'ERROR'
        });
        return;
      }

      try {
        // Manual sync of all scheduled tasks
        console.log('[CalDAV Sync] Loading tasks...');
        const tasks = await PluginAPI.getTasks();
        console.log('[CalDAV Sync] Tasks loaded:', tasks.length);

        // Cleanup: Remove mappings for tasks that are no longer scheduled
        const taskIds = new Set(tasks.map(t => t.id));
        const scheduledTaskIds = new Set(tasks.filter(shouldSyncTask).map(t => t.id));

        let cleanedUp = 0;
        for (const taskId in taskEventMapping) {
          // If task still exists but is no longer scheduled, clean up
          if (taskIds.has(taskId) && !scheduledTaskIds.has(taskId)) {
            console.log('[CalDAV Sync] Cleanup: Task no longer scheduled, deleting event:', taskId);
            try {
              await deleteCalDAVEvent(taskEventMapping[taskId]);
              delete taskEventMapping[taskId];
              cleanedUp++;
            } catch (error) {
              console.error('[CalDAV Sync] Cleanup error:', error);
            }
          }
        }

        if (cleanedUp > 0) {
          await saveData();
          console.log(`[CalDAV Sync] ✅ ${cleanedUp} unscheduled event(s) cleaned up`);
        }

        const tasksToSync = tasks.filter(shouldSyncTask);
        console.log('[CalDAV Sync] Tasks to synchronize:', tasksToSync.length);

        if (tasksToSync.length === 0) {
          PluginAPI.showSnack({
            msg: 'No scheduled tasks to synchronize found',
            type: 'SUCCESS'
          });
          return;
        }

        let syncedCount = 0;
        let errorCount = 0;

        for (const task of tasksToSync) {
          try {
            await syncTaskToCalDAV(task);
            syncedCount++;

            // Rate-limiting: 300ms delay between requests (prevents HTTP 429)
            if (syncedCount < tasksToSync.length) {
              await new Promise(resolve => setTimeout(resolve, 300));
            }
          } catch (error) {
            console.error('[CalDAV Sync] Error synchronizing task:', task.id, error);
            errorCount++;
          }
        }

        PluginAPI.showSnack({
          msg: `${syncedCount} tasks synchronized, ${errorCount} errors`,
          type: errorCount === 0 ? 'SUCCESS' : 'ERROR'
        });
      } catch (error) {
        console.error('[CalDAV Sync] Error:', error);
        PluginAPI.showSnack({
          msg: `Error synchronizing: ${error.message}`,
          type: 'ERROR'
        });
      }
    }
  });
  
  console.log('[CalDAV Sync] Plugin successfully initialized');

  // Listener for postMessage from settings iframe
  window.addEventListener('message', async (event) => {
    console.log('[CalDAV Sync] postMessage received:', event.data);

    if (!event.data || event.data.pluginId !== 'caldav-sync') {
      console.log('[CalDAV Sync] Ignoring message (not for this plugin)');
      return;
    }

    if (event.data.type === 'REQUEST_CONFIG') {
      console.log('[CalDAV Sync] ✅ Config request from iframe received, sending config...');

      // Send config back to iframe
      event.source.postMessage({
        type: 'CONFIG_RESPONSE',
        config: caldavConfig
      }, '*');
    }

    if (event.data.type === 'SAVE_CONFIG') {
      console.log('[CalDAV Sync] ✅ Config save request from iframe received!');
      console.log('[CalDAV Sync] New config:', event.data.config);

      try {
        // Update local config
        caldavConfig = event.data.config;

        // Save config AND mapping together
        await saveData();

        console.log('[CalDAV Sync] Config successfully saved');

        // Send confirmation back
        event.source.postMessage({
          type: 'CONFIG_SAVED',
          success: true
        }, '*');

        // Show snackbar
        PluginAPI.showSnack({
          msg: 'CalDAV settings saved',
          type: 'SUCCESS'
        });
      } catch (error) {
        console.error('[CalDAV Sync] Error saving config:', error);

        // Send error back
        event.source.postMessage({
          type: 'CONFIG_SAVED',
          success: false,
          error: error.message
        }, '*');
      }
    }
  });

  // Show status message
  if (caldavConfig.enabled) {
    PluginAPI.showSnack({
      msg: 'CalDAV Sync enabled',
      type: 'SUCCESS'
    });
  }
}

// Start plugin
init();

// ============================================================================
// Debug Helper Functions (available in Browser Console)
// ============================================================================

/**
 * Debug function: Shows current Task-Event-Mapping
 * Call in console: window.CalDAVSync.showMapping()
 */
window.CalDAVSync = {
  showData: async () => {
    console.log('=== CalDAV Config (Current) ===');
    console.log({
      enabled: caldavConfig.enabled,
      username: caldavConfig.username,
      calendarUrl: caldavConfig.calendarUrl,
      hasPassword: !!caldavConfig.password
    });

    console.log('\n=== CalDAV Mapping (Current) ===');
    console.table(taskEventMapping);
    console.log('Number of entries:', Object.keys(taskEventMapping).length);

    // Show saved version
    const dataString = await PluginAPI.loadSyncedData();
    console.log('\n=== Saved Data (Raw) ===');
    console.log(dataString);

    if (dataString) {
      const data = JSON.parse(dataString);
      console.log('\n=== Saved Data (Parsed) ===');
      console.log('Config:', data.config);
      console.log('Mapping:', data.mapping);
    }

    return {
      current: { config: caldavConfig, mapping: taskEventMapping },
      saved: dataString ? JSON.parse(dataString) : null
    };
  },

  showConfig: () => {
    console.log('=== CalDAV Config ===');
    console.log({
      enabled: caldavConfig.enabled,
      username: caldavConfig.username,
      calendarUrl: caldavConfig.calendarUrl,
      hasPassword: !!caldavConfig.password
    });
    return caldavConfig;
  },

  syncTask: async (taskId) => {
    const tasks = await PluginAPI.getTasks();
    const task = tasks.find(t => t.id === taskId);
    if (!task) {
      console.error('Task not found:', taskId);
      return;
    }
    console.log('Synchronizing task:', task);
    await syncTaskToCalDAV(task);
  },

  deleteEvent: async (taskId) => {
    const eventUid = taskEventMapping[taskId];
    if (!eventUid) {
      console.error('No event UID for task:', taskId);
      return;
    }
    console.log('Deleting event:', eventUid);
    await deleteCalDAVEvent(eventUid);
    delete taskEventMapping[taskId];
    await saveData();
    console.log('Event deleted and mapping updated');
  },

  resetMapping: async () => {
    if (confirm('Really reset the complete Task-Event-Mapping?')) {
      taskEventMapping = {};
      await saveData();
      console.log('Mapping reset');
    }
  },

  resetAll: async () => {
    if (confirm('Really reset ALL data (Config + Mapping)?')) {
      caldavConfig = {
        username: '',
        password: '',
        calendarUrl: '',
        enabled: false
      };
      taskEventMapping = {};
      await saveData();
      console.log('All data reset');
    }
  },

  cleanupOrphanedMappings: async () => {
    console.log('[CalDAV Sync] Checking for orphaned mappings...');
    const tasks = await PluginAPI.getTasks();
    const taskIds = new Set(tasks.map(t => t.id));

    let removedCount = 0;
    for (const taskId in taskEventMapping) {
      if (!taskIds.has(taskId)) {
        console.log('[CalDAV Sync] Removing orphaned mapping for deleted task:', taskId);
        delete taskEventMapping[taskId];
        removedCount++;
      }
    }

    if (removedCount > 0) {
      await saveData();
      console.log(`[CalDAV Sync] ✅ ${removedCount} orphaned mapping(s) removed`);
    } else {
      console.log('[CalDAV Sync] No orphaned mappings found');
    }

    return removedCount;
  },

  forceRemoveMapping: async (taskId) => {
    if (taskEventMapping[taskId]) {
      console.log('[CalDAV Sync] Removing mapping for task:', taskId);
      delete taskEventMapping[taskId];
      await saveData();
      console.log('[CalDAV Sync] ✅ Mapping removed');
      return true;
    } else {
      console.log('[CalDAV Sync] No mapping found for task:', taskId);
      return false;
    }
  },

  getTaskDetails: async (taskId) => {
    const tasks = await PluginAPI.getTasks();
    const task = tasks.find(t => t.id === taskId);
    if (!task) {
      console.error('[CalDAV Sync] Task not found:', taskId);
      return null;
    }

    console.log('=== Task Details ===');
    console.log('ID:', task.id);
    console.log('Title:', task.title);
    console.log('isDone:', task.isDone);
    console.log('plannedAt:', task.plannedAt);
    console.log('dueWithTime:', task.dueWithTime);
    console.log('dueDay:', task.dueDay);
    console.log('issueProviderId:', task.issueProviderId);
    console.log('shouldSyncTask:', shouldSyncTask(task));
    console.log('\n=== Full Task Object ===');
    console.log(task);

    return task;
  }
};

console.log('[CalDAV Sync] Debug functions available at window.CalDAVSync');
console.log('Examples:');
console.log('  window.CalDAVSync.showData()                     - Show all data (Config + Mapping)');
console.log('  window.CalDAVSync.showConfig()                   - Show config');
console.log('  window.CalDAVSync.getTaskDetails(taskId)         - Show details for a task');
console.log('  window.CalDAVSync.cleanupOrphanedMappings()      - Remove orphaned mappings');
console.log('  window.CalDAVSync.forceRemoveMapping(taskId)     - Remove mapping for specific task');
console.log('  window.CalDAVSync.resetMapping()                 - Reset mapping');
console.log('  window.CalDAVSync.resetAll()                     - Reset all data');

