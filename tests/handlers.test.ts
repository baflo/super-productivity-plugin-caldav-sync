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
  snacks,
  configStore,
  task,
} from './helpers.ts';

installStubs();
const { onTaskUpsert, onTaskCreated, onTaskDelete, onTaskComplete, extractTaskRef, extractDeletedTaskIds } =
  await import('../src/handlers.ts');
const { pendingOps } = await import('../src/sync/queue.ts');
const { getConfig } = await import('../src/config.ts');

beforeEach(() => {
  resetAll();
  pendingOps.clear();
});

test('extractTaskRef handles string, {taskId}, {taskId, task, changes} and bare task payloads', () => {
  assert.deepEqual(extractTaskRef('id1'), { taskId: 'id1' });
  const t = task({ id: 't1', title: 'x' });
  const ref = extractTaskRef({ taskId: 't1', task: t, changes: { title: 'y' } });
  assert.equal(ref.task?.id, 't1');
  assert.deepEqual(ref.changes, { title: 'y' });
  assert.equal(extractTaskRef(t).taskId, 't1');
});

test('extractDeletedTaskIds handles taskIds array, taskId and plain string', () => {
  assert.deepEqual(extractDeletedTaskIds({ taskIds: ['a', 'b'] }), ['a', 'b']);
  assert.deepEqual(extractDeletedTaskIds({ taskId: 'a' }), ['a']);
  assert.deepEqual(extractDeletedTaskIds('a'), ['a']);
  assert.deepEqual(extractDeletedTaskIds(null), []);
});

test('batch delete sends one DELETE per task id', async () => {
  await onTaskDelete({ taskIds: ['t1', 't2', 't3'] });
  const config = await getConfig();
  const deleteUrls = fetchCalls.filter(([, o]) => o.method === 'DELETE').map(([u]) => u);
  assert.deepEqual(
    deleteUrls,
    ['t1', 't2', 't3'].map((id) => `${config.calendarUrl}sp-task-${id}.ics`),
  );
});

test('update with only irrelevant changes triggers no request', async () => {
  await onTaskUpsert({
    taskId: 't1',
    task: task({ id: 't1', title: 'x', dueDay: '2026-07-10' }),
    changes: { subTaskIds: ['a'] } as never,
  });
  assert.equal(fetchCalls.length, 0);
});

test('update with relevant change PUTs the merged task', async () => {
  await onTaskUpsert({
    taskId: 't1',
    task: task({ id: 't1', title: 'x', dueDay: '2026-07-10' }),
    changes: { title: 'new' },
  });
  assert.equal(fetchCalls.length, 1);
  const [url, opts] = fetchCalls[0];
  assert.equal(opts.method, 'PUT');
  assert.ok(url.endsWith('sp-task-t1.ics'));
  assert.match(String(opts.body), /SUMMARY:new/);
});

test('created scheduled task is synced; created unscheduled task triggers nothing', async () => {
  await onTaskCreated({ taskId: 't9', task: task({ id: 't9', title: 'neu', dueDay: '2026-07-11' }) });
  assert.equal(fetchCalls.filter(([, o]) => o.method === 'PUT').length, 1);

  fetchCalls.length = 0;
  await onTaskCreated({ taskId: 't10', task: task({ id: 't10', title: 'unscheduled' }) });
  assert.equal(fetchCalls.length, 0, 'no DELETE race for freshly created tasks');
});

test('per-task serialization: slow DELETE finishes before subsequent PUT starts', async () => {
  const opOrder: string[] = [];
  setFetchImpl(async (_url, opts = {}) => {
    opOrder.push(`start:${opts.method}`);
    if (opts.method === 'DELETE') {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    opOrder.push(`end:${opts.method}`);
    return okResponse();
  });
  const p1 = onTaskUpsert({
    taskId: 'race1',
    task: task({ id: 'race1', title: 'r' }),
    changes: { dueWithTime: undefined },
  });
  const p2 = onTaskUpsert({
    taskId: 'race1',
    task: task({ id: 'race1', title: 'r' }),
    changes: { dueWithTime: Date.UTC(2026, 6, 20, 9, 0) },
  });
  await Promise.all([p1, p2]);
  assert.deepEqual(opOrder, ['start:DELETE', 'end:DELETE', 'start:PUT', 'end:PUT']);
});

test('failed PUT is queued with error snack, then flushed on next successful operation', async () => {
  tasksStore.push(task({ id: 'r1', title: 'retry me', dueDay: '2026-07-12' }));
  setFetchImpl(async () => errResponse(500, 'ERR'));
  await onTaskUpsert({
    taskId: 'r1',
    task: tasksStore[0],
    changes: { title: 'retry me' },
  });
  assert.equal(pendingOps.get('r1'), 'put');
  assert.ok(snacks.some((s) => s.type === 'ERROR' && s.msg.includes('500')));

  setFetchImpl(async () => okResponse());
  fetchCalls.length = 0;
  await onTaskUpsert({
    taskId: 't1',
    task: task({ id: 't1', title: 'x', dueDay: '2026-07-10' }),
    changes: { title: 'x' },
  });
  const putUrls = fetchCalls.filter(([, o]) => o.method === 'PUT').map(([u]) => u);
  assert.ok(putUrls.some((u) => u.endsWith('sp-task-r1.ics')), 'queued op retried on flush');
  assert.equal(pendingOps.size, 0);
});

test('taskComplete respects deleteCompletedTasks setting', async () => {
  await onTaskComplete({ taskId: 't1', task: task({ id: 't1', title: 'x' }) });
  assert.equal(fetchCalls.length, 0, 'ignored while deleteCompletedTasks is off');

  configStore.deleteCompletedTasks = true;
  await onTaskComplete({ taskId: 't1', task: task({ id: 't1', title: 'x' }) });
  assert.ok(
    fetchCalls.some(([u, o]) => o.method === 'DELETE' && u.endsWith('sp-task-t1.ics')),
  );
});

test('disabled or incomplete config short-circuits without requests', async () => {
  configStore.enabled = false;
  await onTaskUpsert({ taskId: 't1', task: task({ id: 't1', title: 'x', dueDay: '2026-07-10' }) });
  configStore.enabled = true;
  configStore.password = '';
  await onTaskUpsert({ taskId: 't1', task: task({ id: 't1', title: 'x', dueDay: '2026-07-10' }) });
  assert.equal(fetchCalls.length, 0);
});
