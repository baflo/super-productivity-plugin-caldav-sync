import { beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  installStubs,
  resetAll,
  okResponse,
  errResponse,
  setFetchImpl,
  fetchCalls,
  tasksStore,
  archivedTasksStore,
  snacks,
  configStore,
  task,
  updateTaskCalls,
} from './helpers.ts';

installStubs();
const { manualSync } = await import('../src/manual-sync.ts');
const { pendingOps } = await import('../src/sync/queue.ts');

const multistatus = (hrefs: string[]): string =>
  '<?xml version="1.0"?><d:multistatus xmlns:d="DAV:">' +
  hrefs.map((h) => `<d:response><d:href>${h}</d:href></d:response>`).join('') +
  '</d:multistatus>';

beforeEach(() => {
  resetAll();
  pendingOps.clear();
});

test('manual sync PUTs scheduled tasks, removes orphans, keeps foreign events, reports summary', async () => {
  tasksStore.push(task({ id: 'keep1', title: 'k', dueDay: '2026-07-15' }));
  setFetchImpl(async (_url, opts = {}) => {
    if (opts.method === 'PROPFIND') {
      return okResponse(
        207,
        multistatus([
          '/dav/cal/',
          '/dav/cal/sp-task-keep1.ics',
          '/dav/cal/sp-task-orphan1.ics',
          '/dav/cal/unrelated.ics',
        ]),
      );
    }
    return okResponse();
  });

  await manualSync();

  const delUrls = fetchCalls.filter(([, o]) => o.method === 'DELETE').map(([u]) => u);
  assert.ok(delUrls.some((u) => u.endsWith('sp-task-orphan1.ics')), 'orphan deleted');
  assert.ok(!delUrls.some((u) => u.endsWith('sp-task-keep1.ics')), 'scheduled task kept');
  assert.ok(!delUrls.some((u) => u.endsWith('unrelated.ics')), 'foreign event untouched');
  assert.equal(snacks.length, 1);
  assert.equal(snacks[0].type, 'SUCCESS');
  assert.match(snacks[0].msg, /1 tasks synchronized/);
  assert.match(snacks[0].msg, /1 orphaned events removed/);
});

test('done tasks in archive are kept when deleteCompletedTasks is off', async () => {
  configStore.deleteCompletedTasks = false;
  archivedTasksStore.push(task({ id: 'done1', title: 'd', dueDay: '2026-07-01', isDone: true }));
  setFetchImpl(async (_url, opts = {}) => {
    if (opts.method === 'PROPFIND') {
      return okResponse(207, multistatus(['/dav/cal/sp-task-done1.ics']));
    }
    return okResponse();
  });

  await manualSync();

  assert.ok(!fetchCalls.some(([, o]) => o.method === 'DELETE'), 'archived done task event kept');
});

test('error summary includes first error detail with HTTP status', async () => {
  tasksStore.push(task({ id: 'e1', title: 'fails', dueDay: '2026-07-15' }));
  setFetchImpl(async (_url, opts = {}) => {
    if (opts.method === 'PUT') return errResponse(401, 'Unauthorized');
    return okResponse(207, multistatus([]));
  });

  await manualSync();

  assert.equal(snacks.length, 1);
  assert.equal(snacks[0].type, 'ERROR');
  assert.match(snacks[0].msg, /1 errors \(first: CalDAV PUT failed: 401 Unauthorized\)/);
  assert.equal(pendingOps.get('e1'), 'put');
});

test('manual sync with two-way: pulls calendar edits BEFORE pushing and does not push them back', async () => {
  configStore.twoWaySync = true;
  tasksStore.push(task({ id: 't1', title: 'Alt', dueDay: '2026-07-14' }));
  tasksStore.push(task({ id: 't2', title: 'Anderer', dueDay: '2026-07-15' }));
  const editedIcs = [
    'BEGIN:VCALENDAR',
    'BEGIN:VEVENT',
    'UID:sp-task-t1',
    'SUMMARY:Kalender-Titel',
    'DTSTART;VALUE=DATE:20260714',
    'END:VEVENT',
    'END:VCALENDAR',
  ].join('\r\n');

  setFetchImpl(async (url, opts = {}) => {
    if (opts.method === 'PROPFIND') {
      const depth = (opts.headers as Record<string, string>)?.Depth;
      if (depth === '0') {
        return okResponse(
          207,
          '<d:multistatus xmlns:d="DAV:" xmlns:cs="http://calendarserver.org/ns/">' +
            '<d:response><d:href>/cal/</d:href><d:propstat><d:prop><cs:getctag>c1</cs:getctag></d:prop>' +
            '<d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response></d:multistatus>',
        );
      }
      return okResponse(
        207,
        '<d:multistatus xmlns:d="DAV:"><d:response><d:href>/cal/sp-task-t1.ics</d:href>' +
          '<d:propstat><d:prop><d:getetag>"e1"</d:getetag></d:prop>' +
          '<d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response></d:multistatus>',
      );
    }
    if (opts.method === 'GET' || opts.method === undefined) {
      return okResponse(200, editedIcs, { ETag: '"e1"' });
    }
    return okResponse();
  });

  await manualSync();

  // 1) the calendar edit was imported…
  assert.equal(updateTaskCalls.length, 1);
  assert.equal(updateTaskCalls[0][1].title, 'Kalender-Titel');
  // 2) …and the just-imported task is NOT pushed back (its event is the
  //    newer truth); other tasks still get pushed
  const puts = fetchCalls.filter(([, o]) => o.method === 'PUT');
  assert.equal(puts.length, 1);
  assert.ok(puts[0][0].endsWith('sp-task-t2.ics'), 'only the other task pushed');
  assert.ok(
    !fetchCalls.some(([u, o]) => o.method === 'PUT' && u.endsWith('sp-task-t1.ics')),
    'imported task not pushed back',
  );
  // 3) pull happened before the push (request order)
  const methods = fetchCalls.map(([, o]) => o.method);
  assert.ok(methods.indexOf('GET') < methods.indexOf('PUT'), 'pull before push');
  // 4) summary mentions the import
  assert.match(snacks[0].msg, /1 calendar edits imported/);
});

test('disabled config yields explanatory snack and no requests', async () => {
  configStore.enabled = false;
  await manualSync();
  assert.equal(fetchCalls.length, 0);
  assert.equal(snacks[0].type, 'ERROR');
  assert.match(snacks[0].msg, /disabled/);
});
