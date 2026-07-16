import { beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  installStubs,
  resetAll,
  okResponse,
  setFetchImpl,
  fetchCalls,
  tasksStore,
  updateTaskCalls,
  task,
  configStore,
} from './helpers.ts';

installStubs();
const { fullReconcileSync } = await import('../src/sync/full-sync.ts');
const { loadPullState, savePullState } = await import('../src/sync/state.ts');
const { semanticOfTask } = await import('../src/ical/semantic.ts');
const { getConfig } = await import('../src/config.ts');
const { pendingOps } = await import('../src/sync/queue.ts');

const CTAG = (ctag: string, token: string): string =>
  '<d:multistatus xmlns:d="DAV:" xmlns:cs="http://calendarserver.org/ns/">' +
  `<d:response><d:href>/cal/</d:href><d:propstat><d:prop><cs:getctag>${ctag}</cs:getctag>` +
  `<d:sync-token>${token}</d:sync-token></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response></d:multistatus>`;

const LISTING = (items: Array<[string, string]>): string =>
  '<d:multistatus xmlns:d="DAV:">' +
  items
    .map(
      ([href, etag]) =>
        `<d:response><d:href>${href}</d:href><d:propstat><d:prop><d:getetag>${etag}</d:getetag></d:prop>` +
        '<d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>',
    )
    .join('') +
  '</d:multistatus>';

function stubSweepServer(opts: {
  listing: Array<[string, string]>;
  events?: Record<string, string>;
  token?: string;
}): void {
  setFetchImpl(async (url, init = {}) => {
    if (init.method === 'PROPFIND') {
      const depth = (init.headers as Record<string, string>)?.Depth;
      if (depth === '0') return okResponse(207, CTAG('c-sweep', opts.token ?? 'tok-sweep'));
      return okResponse(207, LISTING(opts.listing));
    }
    if (init.method === 'GET') {
      const name = decodeURIComponent(url.split('/').pop() ?? '');
      const ics = opts.events?.[name];
      if (!ics) return { ...okResponse(404), ok: false, status: 404, statusText: 'Not Found' };
      return okResponse(200, ics, { ETag: '"e-served"' });
    }
    return okResponse();
  });
}

beforeEach(() => {
  resetAll();
  pendingOps.clear();
  configStore.twoWaySync = true;
});

test('recreates a missing event even when the task is unchanged since the last sync', async () => {
  const config = await getConfig();
  const t = task({ id: 'x', title: 'Unverändert', dueDay: '2026-07-20' });
  tasksStore.push(t);
  // Phase-2 gap: snap == desired would make pushLocalChange skip entirely
  savePullState({
    calendarUrl: config.calendarUrl,
    syncToken: 'old',
    ctag: 'old',
    records: { x: { etag: '"e1"', snap: semanticOfTask(t), gone: false } },
  });
  stubSweepServer({ listing: [] });

  const stats = await fullReconcileSync(config);

  assert.equal(stats.recreated, 1);
  const put = fetchCalls.filter(([, o]) => o.method === 'PUT')[0];
  assert.ok(put);
  assert.equal((put[1].headers as Record<string, string>)['If-None-Match'], '*');
  assert.match(String(put[1].body), /SUMMARY:Unverändert/);
});

test('fast path: unchanged task with matching ETag causes no GET and no PUT', async () => {
  const config = await getConfig();
  const t = task({ id: 'x', title: 'Ruhig', dueDay: '2026-07-20' });
  tasksStore.push(t);
  savePullState({
    calendarUrl: config.calendarUrl,
    syncToken: 'old',
    ctag: 'old',
    records: { x: { etag: '"e1"', snap: semanticOfTask(t), gone: false } },
  });
  stubSweepServer({ listing: [['/cal/sp-task-x.ics', '"e1"']] });

  const stats = await fullReconcileSync(config);

  assert.equal(stats.upToDate, 1);
  assert.equal(fetchCalls.filter(([, o]) => o.method === 'GET').length, 0);
  assert.equal(fetchCalls.filter(([, o]) => o.method === 'PUT').length, 0);
});

test('one-way mode with remote drift: SP state force-pushed via RMW, nothing imported', async () => {
  configStore.twoWaySync = false;
  const config = await getConfig();
  const t = task({ id: 'x', title: 'SP-Wahrheit', dueDay: '2026-07-20' });
  tasksStore.push(t);
  savePullState({
    calendarUrl: config.calendarUrl,
    syncToken: 'old',
    ctag: 'old',
    records: { x: { etag: '"e1"', snap: semanticOfTask(t), gone: false } },
  });
  // server has a diverged version (different etag, edited content + LOCATION)
  stubSweepServer({
    listing: [['/cal/sp-task-x.ics', '"e2"']],
    events: {
      'sp-task-x.ics': [
        'BEGIN:VCALENDAR',
        'BEGIN:VEVENT',
        'UID:sp-task-x',
        'SUMMARY:Kalender-Abweichung',
        'DTSTART;VALUE=DATE:20260722',
        'LOCATION:Anderswo',
        'END:VEVENT',
        'END:VCALENDAR',
      ].join('\r\n'),
    },
  });

  const stats = await fullReconcileSync(config);

  assert.equal(stats.pushed, 1);
  assert.equal(updateTaskCalls.length, 0, 'nothing imported in one-way mode');
  const put = fetchCalls.filter(([, o]) => o.method === 'PUT')[0];
  assert.match(String(put[1].body), /SUMMARY:SP-Wahrheit/);
  assert.match(String(put[1].body), /DTSTART;VALUE=DATE:20260720/, 'SP schedule restored');
  assert.match(String(put[1].body), /LOCATION:Anderswo/, 'foreign props still preserved');
});

test('sweep refreshes the sync token so the next poll starts clean', async () => {
  const config = await getConfig();
  stubSweepServer({ listing: [], token: 'tok-neu' });

  await fullReconcileSync(config);

  const state = loadPullState(config.calendarUrl);
  assert.equal(state.syncToken, 'tok-neu');
  assert.equal(state.ctag, 'c-sweep');
});

test('unscheduled task with leftover record and no event: record cleaned, no requests', async () => {
  const config = await getConfig();
  tasksStore.push(task({ id: 'x', title: 'Unscheduled' }));
  savePullState({
    calendarUrl: config.calendarUrl,
    syncToken: null,
    ctag: null,
    records: { x: { etag: '"stale"', snap: null, gone: true } },
  });
  stubSweepServer({ listing: [] });

  await fullReconcileSync(config);

  assert.equal(loadPullState(config.calendarUrl).records['x'], undefined);
  assert.equal(fetchCalls.filter(([, o]) => o.method === 'PUT' || o.method === 'DELETE').length, 0);
});
