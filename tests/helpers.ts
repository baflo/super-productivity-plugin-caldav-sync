/**
 * Shared test stubs: PluginAPI, fetch, and DOMParser doubles installed on
 * globalThis so the src modules resolve them at call time.
 */
import type { CalDAVConfig, SnackCfg, SPPluginAPI, Task } from '../src/types.ts';
import { resetTimezoneCache, setTimezoneOverride } from '../src/caldav/timezone.ts';
import { resetPullState } from '../src/sync/state.ts';

export const snacks: SnackCfg[] = [];
export const tasksStore: Task[] = [];
export const archivedTasksStore: Task[] = [];
export const fetchCalls: Array<[string, RequestInit]> = [];

export const configStore: Partial<CalDAVConfig> = {};

export function resetConfig(): void {
  for (const key of Object.keys(configStore)) {
    delete (configStore as Record<string, unknown>)[key];
  }
  Object.assign(configStore, {
    calendarUrl: 'https://cloud.example.com/dav/calendars/flo/sp', // no trailing slash on purpose
    username: 'flö', // umlaut on purpose
    password: 'pässwörd',
    enabled: true,
    deleteCompletedTasks: false,
  });
}

export function task(partial: Partial<Task> & { id: string; title: string }): Task {
  return { isDone: false, timeEstimate: 0, ...partial };
}

export interface StubResponse {
  ok: boolean;
  status: number;
  statusText: string;
  text: () => Promise<string>;
  headers: { get: (name: string) => string | null };
}

export function okResponse(
  status = 200,
  body = '',
  headers: Record<string, string> = {},
): StubResponse {
  // Default ETag so CAS writes don't need a GET-after-PUT in every test
  const merged: Record<string, string> = { ETag: '"stub-etag"', ...headers };
  return {
    ok: true,
    status,
    statusText: 'OK',
    text: async () => body,
    headers: { get: (name) => merged[name] ?? merged[name.toLowerCase()] ?? null },
  };
}

export function errResponse(status: number, statusText: string): StubResponse {
  return {
    ok: false,
    status,
    statusText,
    text: async () => '',
    headers: { get: () => null },
  };
}

type FetchImpl = (url: string, opts?: RequestInit) => Promise<StubResponse>;
let fetchImpl: FetchImpl = async () => okResponse();

export function setFetchImpl(fn: FetchImpl): void {
  fetchImpl = fn;
}

/**
 * Prefix-agnostic mini DOM double: getElementsByTagNameNS matches elements
 * by local name in the wrapped text (any or no namespace prefix), and the
 * returned elements support nested getElementsByTagNameNS + textContent —
 * enough for parseMultistatus.
 */
class FakeElement {
  private readonly content: string;
  constructor(content: string) {
    this.content = content;
  }
  get textContent(): string {
    return this.content.replace(/<[^>]*>/g, '');
  }
  getElementsByTagNameNS(_ns: string, local: string): FakeElement[] {
    const re = new RegExp(
      `<(?:[\\w-]+:)?${local}(?:\\s[^>]*)?>([\\s\\S]*?)</(?:[\\w-]+:)?${local}>`,
      'g',
    );
    return [...this.content.matchAll(re)].map((m) => new FakeElement(m[1]));
  }
}

class FakeDOMParser {
  parseFromString(text: string): Document {
    return new FakeElement(text) as unknown as Document;
  }
}

class FakeStorage {
  private readonly data = new Map<string, string>();
  getItem(key: string): string | null {
    return this.data.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.data.set(key, value);
  }
  removeItem(key: string): void {
    this.data.delete(key);
  }
  clear(): void {
    this.data.clear();
  }
}

export const fakeStorage = new FakeStorage();

export const updateTaskCalls: Array<[string, Partial<Task>]> = [];

export function installStubs(): void {
  resetConfig();
  const api: Partial<SPPluginAPI> = {
    Hooks: {
      TASK_UPDATE: 'taskUpdate',
      TASK_DELETE: 'taskDelete',
      TASK_COMPLETE: 'taskComplete',
      TASK_CREATED: 'taskCreated',
    },
    registerHook: () => {},
    registerMenuEntry: () => {},
    showSnack: (s: SnackCfg) => {
      snacks.push(s);
    },
    getConfig: (async () => ({ ...configStore })) as SPPluginAPI['getConfig'],
    getTasks: async () => tasksStore.slice(),
    getArchivedTasks: async () => archivedTasksStore.slice(),
    updateTask: async (taskId: string, updates: Partial<Task>) => {
      updateTaskCalls.push([taskId, updates]);
      const t = tasksStore.find((x) => x.id === taskId);
      if (t) Object.assign(t, updates);
    },
  };
  (globalThis as Record<string, unknown>).PluginAPI = api;
  (globalThis as Record<string, unknown>).fetch = (url: string, opts?: RequestInit) => {
    fetchCalls.push([url, opts ?? {}]);
    return fetchImpl(url, opts);
  };
  (globalThis as Record<string, unknown>).DOMParser = FakeDOMParser;
  (globalThis as Record<string, unknown>).localStorage = fakeStorage;
  // Deterministic UTC events in tests regardless of host/server timezone;
  // timezone.test.ts lifts this override explicitly.
  setTimezoneOverride(null);
  resetTimezoneCache();
}

export function resetAll(): void {
  resetConfig();
  snacks.length = 0;
  tasksStore.length = 0;
  archivedTasksStore.length = 0;
  fetchCalls.length = 0;
  updateTaskCalls.length = 0;
  fakeStorage.clear();
  resetPullState();
  fetchImpl = async () => okResponse();
}
