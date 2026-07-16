import type { CalDAVConfig, Task } from './types.ts';
import { getConfig, isConfigComplete } from './config.ts';
import { eventUidForTaskId, shouldDeleteTask } from './rules.ts';
import { deleteCalDAVEvent, listCalDAVTaskIds } from './caldav/client.ts';
import { pendingOps } from './sync/queue.ts';
import { fullReconcileSync, runPool } from './sync/full-sync.ts';
import { dropRecord, loadPullState, savePullState } from './sync/state.ts';

/**
 * Lightweight orphan cleanup used by the debounced post-delete sweep in the
 * handlers (the manual sync itself runs the full reconcile instead).
 */
export async function cleanupOrphanedEvents(
  config: CalDAVConfig,
  tasks: readonly Task[],
): Promise<number> {
  const remoteTaskIds = await listCalDAVTaskIds(config);
  if (remoteTaskIds.length === 0) return 0;

  // Include archived tasks so events of done-but-kept tasks are not treated
  // as orphans when deleteCompletedTasks is off
  let archivedTasks: Task[] = [];
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

  const state = loadPullState(config.calendarUrl);
  let removed = 0;
  await runPool(orphanIds, 3, async (taskId) => {
    try {
      await deleteCalDAVEvent(config, eventUidForTaskId(taskId));
      pendingOps.delete(taskId);
      dropRecord(state, taskId);
      removed++;
    } catch (error) {
      console.warn('[CalDAV Sync] Could not remove orphaned event:', taskId, error);
    }
  });
  if (removed > 0) savePullState(state);
  return removed;
}

export async function manualSync(): Promise<void> {
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
    const stats = await fullReconcileSync(config);

    const synced = stats.pushed + stats.recreated;
    const msgParts = [`${synced} tasks synchronized`];
    if (stats.upToDate > 0) msgParts.push(`${stats.upToDate} already up to date`);
    if (stats.imported > 0) msgParts.push(`${stats.imported} calendar edits imported`);
    if (stats.orphansRemoved > 0)
      msgParts.push(`${stats.orphansRemoved} orphaned events removed`);
    if (stats.deletedEvents > 0) msgParts.push(`${stats.deletedEvents} events removed`);
    if (stats.errors > 0) msgParts.push(`${stats.errors} errors (first: ${stats.firstError})`);
    PluginAPI.showSnack({
      msg: msgParts.join(', '),
      type: stats.errors === 0 ? 'SUCCESS' : 'ERROR',
    });
  } catch (error) {
    console.error('[CalDAV Sync] Error:', error);
    PluginAPI.showSnack({
      msg: `Error synchronizing: ${(error as Error).message}`,
      type: 'ERROR',
    });
  }
}
