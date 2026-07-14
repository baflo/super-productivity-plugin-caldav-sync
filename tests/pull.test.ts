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
const { pollTick, runPollCycle } = await import('../src/sync/poll.ts');
const { loadPullState, savePullState } = await import('../src/sync/state.ts');
const { consumeImporting } = await import('../src/sync/import.ts');
const { onTaskUpsert } = await import('../src/handlers.ts');
const { pendingOps } = await import('../src/sync/queue.ts');
const { getConfig } = await import('../src/config.ts');
const { createEventFromTask } = await import('../src/ical/build.ts');
const { DEFAULT_CONFIG } = await import('../src/config.ts');

const CTAG_RESP = (ctag: string, token?: string): string =>
  '<?xml version="1.0"?><d:multistatus xmlns:d="DAV:" xmlns:cs="http://calendarserver.org/ns/">' +
  `<d:response><d:href>/cal/</d:href><d:propstat><d:prop><cs:getctag>${ctag}</cs:getctag>` +
  (token ? `<d:sync-token>${token}</d:sync-token>` : '') +
  '</d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response></d:multistatus>';

const ETAG_LISTING = (items: Array<[string, string]>): string =>
  '<?xml version="1.0"?><d:multistatus xmlns:d="DAV:">' +
  items
    .map(
      ([href, etag]) =>
        `<d:response><d:href>${href}</d:href><d:propstat><d:prop><d:getetag>${etag}</d:getetag></d:prop>` +
        '<d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>',
    )
    .join('') +
  '</d:multistatus>';

// LAST-MODIFIED is included by default: real calendar servers always set it,
// and it makes the calendar win the bootstrap LWW against tasks without
// `updated` in these fixtures.
const EVENT_ICS = (uid: string, lines: string[]): string =>
  [
    'BEGIN:VCALENDAR',
    'BEGIN:VEVENT',
    `UID:${uid}`,
    'LAST-MODIFIED:20260713T120000Z',
    ...lines,
    'END:VEVENT',
    'END:VCALENDAR',
  ].join('\r\n');

beforeEach(() => {
  resetAll();
  pendingOps.clear();
  configStore.twoWaySync = true;
});

function stubServer(opts: {
  ctag: string;
  listing?: Array<[string, string]>;
  events?: Record<string, string>;
  eventEtags?: Record<string, string>;
}): void {
  setFetchImpl(async (url, init = {}) => {
    if (init.method === 'PROPFIND') {
      const depth = (init.headers as Record<string, string>)?.Depth;
      if (depth === '0') return okResponse(207, CTAG_RESP(opts.ctag));
      return okResponse(207, ETAG_LISTING(opts.listing ?? []));
    }
    if (init.method === 'GET' || init.method === undefined) {
      const name = decodeURIComponent(url.split('/').pop() ?? '');
      const ics = opts.events?.[name];
      if (!ics) return { ...okResponse(404), ok: false, status: 404, statusText: 'Not Found' };
      return okResponse(200, ics, { ETag: opts.eventEtags?.[name] ?? '"e-served"' });
    }
    return okResponse();
  });
}

test('calendar edit is imported into the task (title + time + duration)', async () => {
  tasksStore.push(
    task({ id: 't1', title: 'Alt', dueWithTime: Date.UTC(2026, 6, 14, 9, 0), timeEstimate: 3600000 }),
  );
  stubServer({
    ctag: 'c1',
    listing: [['/cal/sp-task-t1.ics', '"e1"']],
    events: {
      'sp-task-t1.ics': EVENT_ICS('sp-task-t1', [
        'SUMMARY:Neu',
        'DTSTART:20260714T103000Z',
        'DTEND:20260714T120000Z',
      ]),
    },
    eventEtags: { 'sp-task-t1.ics': '"e1"' },
  });

  const stats = await pollTick(await getConfig());

  assert.equal(stats.imported, 1);
  assert.equal(updateTaskCalls.length, 1);
  const [taskId, updates] = updateTaskCalls[0];
  assert.equal(taskId, 't1');
  assert.equal(updates.title, 'Neu');
  assert.equal(updates.dueWithTime, Date.UTC(2026, 6, 14, 10, 30));
  assert.equal(updates.timeEstimate, 90 * 60000);
  assert.equal(consumeImporting('t1'), true, 'import marked for echo suppression');
});

test('echo of our own write is recognized: no updateTask, ETag recorded', async () => {
  const t = task({
    id: 't1',
    title: 'Same',
    dueWithTime: Date.UTC(2026, 6, 14, 9, 0),
    timeEstimate: 3600000,
  });
  tasksStore.push(t);
  stubServer({
    ctag: 'c1',
    listing: [['/cal/sp-task-t1.ics', '"e7"']],
    events: { 'sp-task-t1.ics': createEventFromTask(t, { ...DEFAULT_CONFIG, addReminders: true }) },
    eventEtags: { 'sp-task-t1.ics': '"e7"' },
  });

  const stats = await pollTick(await getConfig());

  assert.equal(stats.unchanged, 1);
  assert.equal(updateTaskCalls.length, 0);
  const config = await getConfig();
  assert.equal(loadPullState(config.calendarUrl).records['t1'].etag, '"e7"');
});

test('unchanged ctag short-circuits without further requests', async () => {
  const config = await getConfig();
  savePullState({ calendarUrl: config.calendarUrl, syncToken: null, ctag: 'c1', records: {} });
  stubServer({ ctag: 'c1' });

  const stats = await pollTick(config);

  assert.equal(stats.upToDate, true);
  assert.equal(fetchCalls.length, 1, 'only the Depth:0 PROPFIND');
});

test('newer local task state wins the LWW merge and is pushed, not overwritten', async () => {
  // task.updated is NEWER than the event's LAST-MODIFIED → local wins
  tasksStore.push(
    task({ id: 't1', title: 'Lokal neuer', dueDay: '2026-07-14', updated: Date.UTC(2026, 6, 14) }),
  );
  stubServer({
    ctag: 'c1',
    listing: [['/cal/sp-task-t1.ics', '"e1"']],
    events: {
      'sp-task-t1.ics': EVENT_ICS('sp-task-t1', ['SUMMARY:Kalender alt', 'DTSTART;VALUE=DATE:20260714']),
    },
  });

  const stats = await pollTick(await getConfig());

  assert.equal(updateTaskCalls.length, 0, 'local task untouched');
  assert.equal(stats.pushed, 1);
  const puts = fetchCalls.filter(([, o]) => o.method === 'PUT');
  assert.equal(puts.length, 1);
  assert.match(String(puts[0][1].body), /SUMMARY:Lokal neuer/);
  assert.equal((puts[0][1].headers as Record<string, string>)['If-Match'], '"e-served"');
});

test('done/unscheduled tasks and unknown events are never imported', async () => {
  tasksStore.push(task({ id: 'done1', title: 'D', dueDay: '2026-07-14', isDone: true }));
  stubServer({
    ctag: 'c1',
    listing: [
      ['/cal/sp-task-done1.ics', '"e1"'],
      ['/cal/sp-task-ghost.ics', '"e2"'],
    ],
    events: {},
  });

  const stats = await pollTick(await getConfig());

  assert.equal(stats.skipped, 2);
  assert.equal(updateTaskCalls.length, 0);
  assert.equal(fetchCalls.filter(([, o]) => o.method === 'GET').length, 0, 'no GETs for skipped');
});

test('remotely deleted event: no eager recreation, record marked gone', async () => {
  const config = await getConfig();
  tasksStore.push(task({ id: 't1', title: 'X', dueDay: '2026-07-14' }));
  savePullState({
    calendarUrl: config.calendarUrl,
    syncToken: null,
    ctag: 'c0',
    records: { t1: { etag: '"e1"', snap: null, gone: false } },
  });
  stubServer({ ctag: 'c1', listing: [] });

  const stats = await pollTick(config);

  assert.equal(stats.removedRemotely, 1);
  assert.equal(fetchCalls.filter(([, o]) => o.method === 'PUT').length, 0, 'no recreation PUT');
  const record = loadPullState(config.calendarUrl).records['t1'];
  assert.equal(record.gone, true);
  assert.equal(record.etag, null);
});

test('empty DESCRIPTION does not wipe existing task notes', async () => {
  tasksStore.push(
    task({ id: 't1', title: 'Alt', notes: 'wichtige Notizen', dueDay: '2026-07-14' }),
  );
  stubServer({
    ctag: 'c1',
    listing: [['/cal/sp-task-t1.ics', '"e1"']],
    events: {
      'sp-task-t1.ics': EVENT_ICS('sp-task-t1', ['SUMMARY:Neu', 'DTSTART;VALUE=DATE:20260714']),
    },
  });

  await pollTick(await getConfig());

  assert.equal(updateTaskCalls.length, 1);
  const [, updates] = updateTaskCalls[0];
  assert.equal(updates.title, 'Neu');
  assert.equal('notes' in updates, false, 'notes untouched');
});

test('all-day -> timed edit imports the duration even for tasks without estimate', async () => {
  tasksStore.push(task({ id: 't1', title: 'X', dueDay: '2026-07-14', timeEstimate: 0 }));
  stubServer({
    ctag: 'c1',
    listing: [['/cal/sp-task-t1.ics', '"e1"']],
    events: {
      'sp-task-t1.ics': EVENT_ICS('sp-task-t1', [
        'SUMMARY:X',
        'DTSTART:20260714T140000Z',
        'DTEND:20260714T150000Z',
      ]),
    },
  });

  await pollTick(await getConfig());

  const [, updates] = updateTaskCalls[0];
  assert.equal(updates.dueWithTime, Date.UTC(2026, 6, 14, 14, 0));
  assert.equal(updates.dueDay, null);
  assert.equal(updates.timeEstimate, 3600000, 'duration imported on transition');
});

test('already-timed task without estimate: unrelated edit does not materialize an estimate', async () => {
  tasksStore.push(
    task({ id: 't1', title: 'Alt', dueWithTime: Date.UTC(2026, 6, 14, 14, 0), timeEstimate: 0 }),
  );
  stubServer({
    ctag: 'c1',
    listing: [['/cal/sp-task-t1.ics', '"e1"']],
    events: {
      'sp-task-t1.ics': EVENT_ICS('sp-task-t1', [
        'SUMMARY:Neu',
        'DTSTART:20260714T140000Z',
        'DTEND:20260714T150000Z',
      ]),
    },
  });

  await pollTick(await getConfig());

  const [, updates] = updateTaskCalls[0];
  assert.equal(updates.title, 'Neu');
  assert.equal('timeEstimate' in updates, false, '1h event == no-estimate default');
});

test('concurrent pollTick callers share one tick instead of skipping', async () => {
  const t = task({ id: 't1', title: 'Same', dueDay: '2026-07-14' });
  tasksStore.push(t);
  setFetchImpl(async (_url, init = {}) => {
    if (init.method === 'PROPFIND' && (init.headers as Record<string, string>)?.Depth === '0') {
      await new Promise((resolve) => setTimeout(resolve, 30));
      return okResponse(207, CTAG_RESP('c1'));
    }
    if (init.method === 'PROPFIND') return okResponse(207, ETAG_LISTING([]));
    return okResponse();
  });
  const config = await getConfig();

  const [s1, s2] = await Promise.all([pollTick(config), pollTick(config)]);

  assert.deepEqual(s1, s2, 'second caller awaited the same tick');
  assert.equal(
    fetchCalls.filter(([, o]) => o.method === 'PROPFIND' && (o.headers as Record<string, string>)?.Depth === '0').length,
    1,
    'only one Depth:0 PROPFIND despite two callers',
  );
});

test('timed -> all-day edit clears dueWithTime and sets dueDay', async () => {
  tasksStore.push(
    task({ id: 't1', title: 'X', dueWithTime: Date.UTC(2026, 6, 14, 9, 0), timeEstimate: 3600000 }),
  );
  stubServer({
    ctag: 'c1',
    listing: [['/cal/sp-task-t1.ics', '"e1"']],
    events: {
      'sp-task-t1.ics': EVENT_ICS('sp-task-t1', ['SUMMARY:X', 'DTSTART;VALUE=DATE:20260716']),
    },
  });

  await pollTick(await getConfig());

  const [, updates] = updateTaskCalls[0];
  assert.equal(updates.dueDay, '2026-07-16');
  assert.equal(updates.dueWithTime, null);
});

test('poll cycle flushes queued offline ops even with two-way sync disabled', async () => {
  configStore.twoWaySync = false;
  tasksStore.push(task({ id: 'off1', title: 'offline edit', dueDay: '2026-07-15' }));
  pendingOps.set('off1', 'put');

  await runPollCycle();

  const puts = fetchCalls.filter(([, o]) => o.method === 'PUT').map(([u]) => u);
  assert.ok(puts.some((u) => u.endsWith('sp-task-off1.ics')), 'queued op pushed');
  assert.equal(pendingOps.size, 0);
  assert.equal(
    fetchCalls.filter(([, o]) => o.method === 'PROPFIND').length,
    0,
    'no pull without twoWaySync',
  );
});

test('echo suppression consumes exactly one hook invocation', async () => {
  tasksStore.push(
    task({ id: 't1', title: 'Alt', dueWithTime: Date.UTC(2026, 6, 14, 9, 0), timeEstimate: 3600000 }),
  );
  stubServer({
    ctag: 'c1',
    listing: [['/cal/sp-task-t1.ics', '"e1"']],
    events: {
      'sp-task-t1.ics': EVENT_ICS('sp-task-t1', [
        'SUMMARY:Neu',
        'DTSTART:20260714T103000Z',
        'DTEND:20260714T113000Z',
      ]),
    },
  });
  await pollTick(await getConfig());
  assert.equal(updateTaskCalls.length, 1);

  // The hook fired by our own updateTask is swallowed…
  fetchCalls.length = 0;
  await onTaskUpsert({ taskId: 't1', task: tasksStore[0], changes: { title: 'Neu' } });
  assert.equal(fetchCalls.length, 0, 'echo suppressed');

  // …but the next genuine user edit goes through.
  await onTaskUpsert({ taskId: 't1', task: tasksStore[0], changes: { title: 'User edit' } });
  assert.equal(fetchCalls.filter(([, o]) => o.method === 'PUT').length, 1);
});
