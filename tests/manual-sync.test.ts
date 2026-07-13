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

test('disabled config yields explanatory snack and no requests', async () => {
  configStore.enabled = false;
  await manualSync();
  assert.equal(fetchCalls.length, 0);
  assert.equal(snacks[0].type, 'ERROR');
  assert.match(snacks[0].msg, /disabled/);
});
