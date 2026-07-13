/**
 * Shared test stubs: PluginAPI, fetch, and DOMParser doubles installed on
 * globalThis so the src modules resolve them at call time.
 */
import type { CalDAVConfig, SnackCfg, SPPluginAPI, Task } from '../src/types.ts';

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
}

export function okResponse(status = 200, body = ''): StubResponse {
  return { ok: true, status, statusText: 'OK', text: async () => body };
}

export function errResponse(status: number, statusText: string): StubResponse {
  return { ok: false, status, statusText, text: async () => '' };
}

type FetchImpl = (url: string, opts?: RequestInit) => Promise<StubResponse>;
let fetchImpl: FetchImpl = async () => okResponse();

export function setFetchImpl(fn: FetchImpl): void {
  fetchImpl = fn;
}

class FakeDOMParser {
  parseFromString(text: string): Document {
    const hrefs = [...text.matchAll(/<d:href>([^<]*)<\/d:href>/g)].map((m) => ({
      textContent: m[1],
    }));
    return { getElementsByTagNameNS: () => hrefs } as unknown as Document;
  }
}

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
  };
  (globalThis as Record<string, unknown>).PluginAPI = api;
  (globalThis as Record<string, unknown>).fetch = (url: string, opts?: RequestInit) => {
    fetchCalls.push([url, opts ?? {}]);
    return fetchImpl(url, opts);
  };
  (globalThis as Record<string, unknown>).DOMParser = FakeDOMParser;
}

export function resetAll(): void {
  resetConfig();
  snacks.length = 0;
  tasksStore.length = 0;
  archivedTasksStore.length = 0;
  fetchCalls.length = 0;
  fetchImpl = async () => okResponse();
}
