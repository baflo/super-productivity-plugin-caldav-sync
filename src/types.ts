/**
 * Minimal typings for the Super Productivity plugin runtime.
 *
 * Maintained by hand against packages/plugin-api in the SP repo — the
 * published @super-productivity/plugin-api npm package (1.0.1) is outdated
 * and lacks dueDay/dueWithTime and getConfig.
 */

export interface Task {
  id: string;
  title: string;
  notes?: string;
  isDone: boolean;
  timeEstimate: number;
  updated?: number;
  reminderId?: string | null;
  projectId?: string | null;
  /** Due date without time, ISO day string 'YYYY-MM-DD' */
  dueDay?: string | null;
  /** Due date with time, epoch ms */
  dueWithTime?: number | null;
  subTaskIds?: string[];
}

export interface CalDAVConfig {
  calendarUrl: string;
  username: string;
  password: string;
  enabled: boolean;
  deleteCompletedTasks: boolean;
  addReminders: boolean;
  reminderMinutesBefore: number;
  /** Import calendar-side edits (title, date/time, duration, notes) back into SP */
  twoWaySync: boolean;
}

export interface SnackCfg {
  msg: string;
  type?: 'SUCCESS' | 'ERROR' | 'WARNING' | 'INFO';
  ico?: string;
}

export interface SPPluginAPI {
  Hooks: Record<string, string | undefined>;
  registerHook(hook: string, fn: (payload: unknown) => void | Promise<void>): void;
  registerMenuEntry(cfg: { label: string; icon?: string; onClick: () => void }): void;
  showSnack(cfg: SnackCfg): void;
  getConfig<T = unknown>(): Promise<T | null>;
  getTasks(): Promise<Task[]>;
  getArchivedTasks(): Promise<Task[]>;
  updateTask(taskId: string, updates: Partial<Task>): Promise<void>;
}

declare global {
  /** Injected by the Super Productivity plugin runner */
  // eslint-disable-next-line no-var
  var PluginAPI: SPPluginAPI;
}
