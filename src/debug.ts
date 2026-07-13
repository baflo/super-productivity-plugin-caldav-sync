import { getConfig } from './config.ts';
import { eventUidForTask, eventUidForTaskId, shouldDeleteTask, shouldSyncTask } from './rules.ts';
import { createEventFromTask } from './ical/build.ts';
import { deleteCalDAVEvent, listCalDAVTaskIds, putCalDAVEvent } from './caldav/client.ts';
import { pendingOps } from './sync/queue.ts';
import { cleanupOrphanedEvents, manualSync } from './manual-sync.ts';

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
      await putCalDAVEvent(config, eventUidForTask(task), createEventFromTask(task, config));
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

    manualSync,
  };

  console.log('[CalDAV Sync] Debug functions available at window.CalDAVSync');
}
