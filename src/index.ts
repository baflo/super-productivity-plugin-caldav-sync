/**
 * CalDAV Schedule Sync Plugin for Super Productivity
 *
 * Automatically synchronizes scheduled tasks to a CalDAV calendar.
 * Configuration is managed by Super Productivity via the plugin settings
 * dialog (jsonSchemaCfg in manifest.json) — no custom UI needed.
 *
 * Source lives in src/, bundled to dist/plugin.js via esbuild.
 * DEBUG: window.CalDAVSync.* in the browser console
 */
import { getConfig } from './config.ts';
import { onTaskComplete, onTaskCreated, onTaskDelete, onTaskUpsert } from './handlers.ts';
import { manualSync } from './manual-sync.ts';
import { startPolling } from './sync/poll.ts';
import { installDebug } from './debug.ts';

async function init(): Promise<void> {
  PluginAPI.registerHook(PluginAPI.Hooks.TASK_UPDATE ?? 'taskUpdate', onTaskUpsert);
  PluginAPI.registerHook(PluginAPI.Hooks.TASK_DELETE ?? 'taskDelete', onTaskDelete);
  PluginAPI.registerHook(PluginAPI.Hooks.TASK_COMPLETE ?? 'taskComplete', onTaskComplete);
  // TASK_CREATED covers tasks created with a schedule, incl. repeat instances
  // (fall back to the raw hook name for SP versions without the enum member)
  PluginAPI.registerHook(PluginAPI.Hooks.TASK_CREATED ?? 'taskCreated', onTaskCreated);

  // Menu entry (burger menu) instead of a header button to keep the
  // primary UI uncluttered
  PluginAPI.registerMenuEntry({
    label: 'CalDAV Sync',
    icon: 'cloud_upload',
    onClick: manualSync,
  });

  // Pull path (two-way sync): no-op unless twoWaySync is enabled in config
  startPolling();

  const config = await getConfig();
  if (config.enabled) {
    console.log('[CalDAV Sync] Enabled', config.twoWaySync ? '(two-way)' : '(push-only)');
  }
}

installDebug();
void init();
