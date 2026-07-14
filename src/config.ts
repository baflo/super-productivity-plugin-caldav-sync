import type { CalDAVConfig, Task } from './types.ts';

export const DEFAULT_CONFIG: CalDAVConfig = {
  calendarUrl: '',
  username: '',
  password: '',
  enabled: false,
  deleteCompletedTasks: false,
  addReminders: true,
  reminderMinutesBefore: 0,
  twoWaySync: false,
};

export async function getConfig(): Promise<CalDAVConfig> {
  const saved = await PluginAPI.getConfig<Partial<CalDAVConfig>>();
  const config = { ...DEFAULT_CONFIG, ...(saved ?? {}) };
  if (config.calendarUrl && !config.calendarUrl.endsWith('/')) {
    config.calendarUrl += '/';
  }
  return config;
}

export function isConfigComplete(config: CalDAVConfig): boolean {
  return !!(config.calendarUrl && config.username && config.password);
}

// Task fields whose change requires a re-sync. Hook payloads for other
// changes (e.g. subtask order) are ignored to avoid needless PUTs.
export const SYNC_RELEVANT_FIELDS: readonly (keyof Task)[] = [
  'title',
  'notes',
  'dueDay',
  'dueWithTime',
  'timeEstimate',
  'isDone',
];
