import { getConfig } from './config.ts';
import { eventUidForTask, eventUidForTaskId, shouldDeleteTask, shouldSyncTask } from './rules.ts';
import { createEventFromTask } from './ical/build.ts';
import { deleteCalDAVEvent, listCalDAVTaskIds, putCalDAVEvent } from './caldav/client.ts';
import { pendingOps } from './sync/queue.ts';
import { cleanupOrphanedEvents, manualSync } from './manual-sync.ts';
import { pollTick } from './sync/poll.ts';
import { loadPullState, resetPullState } from './sync/state.ts';
import { getEventTimezone } from './caldav/timezone.ts';

export function installDebug(): void {
  const globalObj = (typeof window !== 'undefined' ? window : globalThis) as Record<
    string,
    unknown
  >;

  globalObj.CalDAVSync = {
    showConfig: async () => {
      const config = await getConfig();
      console.log('=== CalDAV Config ===');
      console.log({ ...config, password: config.password ? '***' : '' });
      return config;
    },

    syncTask: async (taskId: string) => {
      const config = await getConfig();
      const tasks = await PluginAPI.getTasks();
      const task = tasks.find((t) => t.id === taskId);
      if (!task) {
        console.error('Task not found:', taskId);
        return;
      }
      console.log('Synchronizing task:', task);
      const tz = await getEventTimezone(config);
      await putCalDAVEvent(config, eventUidForTask(task), createEventFromTask(task, config, tz));
    },

    deleteEvent: async (taskId: string) => {
      const config = await getConfig();
      console.log('Deleting event for task:', taskId);
      await deleteCalDAVEvent(config, eventUidForTaskId(taskId));
      console.log('Event deleted');
    },

    getTaskDetails: async (taskId: string) => {
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

    pullNow: async () => {
      const config = await getConfig();
      const stats = await pollTick(config);
      console.log('[CalDAV Sync] Pull result:', stats);
      return stats;
    },

    showPullState: async () => {
      const config = await getConfig();
      const state = loadPullState(config.calendarUrl);
      console.log('=== Pull state (device-local) ===');
      console.log(state);
      return state;
    },

    resetPullState,

    manualSync,
  };

  console.log('[CalDAV Sync] Debug functions available at window.CalDAVSync');
}
