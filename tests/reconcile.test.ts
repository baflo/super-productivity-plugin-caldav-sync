import { beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  installStubs,
  resetAll,
  okResponse,
  setFetchImpl,
  fetchCalls,
  snacks,
  updateTaskCalls,
  tasksStore,
  task,
  configStore,
  type StubResponse,
} from './helpers.ts';

installStubs();
const { pushLocalChange, deleteLocalTask, reconcileWithRemote, mergeFields } = await import(
  '../src/sync/reconcile.ts'
);
const { loadPullState, savePullState } = await import('../src/sync/state.ts');
const { semanticOfTask } = await import('../src/ical/semantic.ts');
const { parseVEvent } = await import('../src/ical/parse.ts');
const { getConfig } = await import('../src/config.ts');

const ICS = (lines: string[]): string =>
  ['BEGIN:VCALENDAR', 'BEGIN:VEVENT', 'UID:sp-task-x', ...lines, 'END:VEVENT', 'END:VCALENDAR'].join(
    '\r\n',
  );

const header = (call: [string, RequestInit], name: string): string | undefined =>
  (call[1].headers as Record<string, string>)?.[name];

beforeEach(() => resetAll());

test('first push uses If-None-Match: *, subsequent update uses If-Match', async () => {
  const config = await getConfig();
  const t = task({ id: 'x', title: 'A', dueDay: '2026-07-20' });

  await pushLocalChange(config, t);
  let put = fetchCalls.filter(([, o]) => o.method === 'PUT')[0];
  assert.equal(header(put, 'If-None-Match'), '*');
  assert.equal(header(put, 'If-Match'), undefined);

  fetchCalls.length = 0;
  await pushLocalChange(config, { ...t, title: 'B' });
  put = fetchCalls.filter(([, o]) => o.method === 'PUT')[0];
  assert.equal(header(put, 'If-Match'), '"stub-etag"');
});

test('push with unchanged semantics is a no-op (no request)', async () => {
  const config = await getConfig();
  const t = task({ id: 'x', title: 'A', dueDay: '2026-07-20' });
  await pushLocalChange(config, t);
  fetchCalls.length = 0;

  const didWrite = await pushLocalChange(config, { ...t });

  assert.equal(didWrite, false);
  assert.equal(fetchCalls.length, 0);
});

test('lost CAS race (412): pulls the remote version and reconciles instead of overwriting', async () => {
  const config = await getConfig();
  const t = task({ id: 'x', title: 'Lokal', dueDay: '2026-07-20', updated: Date.UTC(2026, 6, 1) });
  await pushLocalChange(config, t); // seed record {etag: stub-etag, snap}
  fetchCalls.length = 0;

  // Remote was edited concurrently (newer LAST-MODIFIED) → our If-Match 412s
  const remoteIcs = ICS([
    'LAST-MODIFIED:20260713T120000Z',
    'SUMMARY:Kalender',
    'DTSTART;VALUE=DATE:20260721',
  ]);
  setFetchImpl(async (_url, opts = {}): Promise<StubResponse> => {
    const ifMatch = (opts.headers as Record<string, string>)?.['If-Match'];
    if (opts.method === 'PUT' && ifMatch && ifMatch !== '"e-new"') {
      // stale ETag → CAS rejection; the fresh one (from the GET) succeeds
      return { ...okResponse(412), ok: false, status: 412, statusText: 'Precondition Failed' };
    }
    if (opts.method === 'GET') return okResponse(200, remoteIcs, { ETag: '"e-new"' });
    return okResponse(200, '', { ETag: '"e-after-merge"' });
  });

  // Local edit while remote changed: title local, schedule remote → merge
  await pushLocalChange(config, { ...t, title: 'Lokal NEU', updated: Date.UTC(2026, 6, 14) });

  // Merged result was written (both-changed on disjoint fields):
  const puts = fetchCalls.filter(([, o]) => o.method === 'PUT');
  assert.equal(puts.length, 2, '412 attempt + merged write');
  assert.match(String(puts[1][1].body), /SUMMARY:Lokal NEU/, 'local title kept');
  assert.match(String(puts[1][1].body), /DTSTART;VALUE=DATE:20260721/, 'remote date kept');
  // …and the remote date was imported into the task
  assert.ok(updateTaskCalls.some(([, u]) => u.dueDay === '2026-07-21'));
});

test('field merge: disjoint edits merge, same-field conflict resolves by LWW with snack', async () => {
  const base = { title: 'T', notes: 'N', allDay: true, start: Date.UTC(2026, 6, 20), durationM: 1440 };
  const t = task({ id: 'x', title: 'T-lokal', dueDay: '2026-07-20', updated: 100 });
  const ev = parseVEvent(ICS(['LAST-MODIFIED:20260713T120000Z', 'SUMMARY:T', 'DTSTART;VALUE=DATE:20260720']));
  assert.ok(ev);

  // disjoint: local title, remote notes
  const r1 = mergeFields(
    { ...base, title: 'T-lokal' },
    { ...base, notes: 'N-remote' },
    base,
    t,
    ev,
  );
  assert.equal(r1.merged.title, 'T-lokal');
  assert.equal(r1.merged.notes, 'N-remote');
  assert.deepEqual(r1.conflicts, []);

  // same field: remote LAST-MODIFIED newer than task.updated → remote wins
  const r2 = mergeFields(
    { ...base, title: 'T-lokal' },
    { ...base, title: 'T-remote' },
    base,
    t,
    ev,
  );
  assert.equal(r2.merged.title, 'T-remote');
  assert.deepEqual(r2.conflicts, ['title']);
  assert.equal(r2.localWon, false);
});

test('genuine concurrent same-field edit surfaces a warning snack', async () => {
  const config = await getConfig();
  const t = task({ id: 'x', title: 'Basis', dueDay: '2026-07-20', updated: 100 });
  savePullState({
    calendarUrl: config.calendarUrl,
    syncToken: null,
    ctag: null,
    records: { x: { etag: '"old"', snap: semanticOfTask(t), gone: false } },
  });
  const fetched = {
    ics: ICS(['LAST-MODIFIED:20260713T120000Z', 'SUMMARY:Remote-Titel', 'DTSTART;VALUE=DATE:20260720']),
    etag: '"new"',
  };

  await reconcileWithRemote(config, { ...t, title: 'Lokal-Titel' }, 'x', fetched);

  assert.ok(snacks.some((s) => s.type === 'WARNING' && s.msg.includes('calendar won')));
  // remote won → imported into task, nothing pushed
  assert.ok(updateTaskCalls.some(([, u]) => u.title === 'Remote-Titel'));
  assert.equal(fetchCalls.filter(([, o]) => o.method === 'PUT').length, 0);
});

test('gone event + local change recreates via If-None-Match', async () => {
  const config = await getConfig();
  const t = task({ id: 'x', title: 'Neu terminiert', dueDay: '2026-07-22' });
  savePullState({
    calendarUrl: config.calendarUrl,
    syncToken: null,
    ctag: null,
    records: {
      x: {
        etag: null,
        snap: { title: 'Alt', notes: '', allDay: true, start: Date.UTC(2026, 6, 20), durationM: 1440 },
        gone: true,
      },
    },
  });

  await pushLocalChange(config, t);

  const put = fetchCalls.filter(([, o]) => o.method === 'PUT')[0];
  assert.equal(header(put, 'If-None-Match'), '*', 'recreate as CAS create');
  const record = loadPullState(config.calendarUrl).records['x'];
  assert.equal(record.gone, false);
});

test('deletion wins on 412: force-delete with warning snack', async () => {
  const config = await getConfig();
  savePullState({
    calendarUrl: config.calendarUrl,
    syncToken: null,
    ctag: null,
    records: { x: { etag: '"old"', snap: null, gone: false } },
  });
  let deletes = 0;
  setFetchImpl(async (_url, opts = {}): Promise<StubResponse> => {
    if (opts.method === 'DELETE') {
      deletes++;
      if ((opts.headers as Record<string, string>)?.['If-Match']) {
        return { ...okResponse(412), ok: false, status: 412, statusText: 'Precondition Failed' };
      }
      return okResponse(204);
    }
    return okResponse();
  });

  await deleteLocalTask(config, 'x');

  assert.equal(deletes, 2, 'CAS delete then force delete');
  assert.ok(snacks.some((s) => s.type === 'WARNING' && s.msg.includes('discarded')));
  assert.equal(loadPullState(config.calendarUrl).records['x'], undefined);
});

test('another client wrote identical content: ETag adopted silently, nothing written', async () => {
  const config = await getConfig();
  const t = task({ id: 'x', title: 'Same', dueDay: '2026-07-20' });
  const snap = semanticOfTask(t);
  savePullState({
    calendarUrl: config.calendarUrl,
    syncToken: null,
    ctag: null,
    records: { x: { etag: '"mine"', snap, gone: false } },
  });
  const fetched = {
    ics: ICS(['LAST-MODIFIED:20260713T120000Z', 'SUMMARY:Same', 'DTSTART;VALUE=DATE:20260720']),
    etag: '"theirs"',
  };

  await reconcileWithRemote(config, t, 'x', fetched);

  assert.equal(fetchCalls.length, 0);
  assert.equal(updateTaskCalls.length, 0);
  assert.equal(loadPullState(config.calendarUrl).records['x'].etag, '"theirs"');
});

test('stale hook payload: push re-reads the task and keeps a just-imported time', async () => {
  const config = await getConfig();
  // Import already happened: task in the store has the NEW time from the
  // calendar; record snap reflects it.
  const importedTime = Date.UTC(2026, 6, 23, 14, 0);
  const current = task({
    id: 'x',
    title: 'Neu',
    dueWithTime: importedTime,
    timeEstimate: 3600000,
  });
  tasksStore.push(current);
  savePullState({
    calendarUrl: config.calendarUrl,
    syncToken: null,
    ctag: null,
    records: {
      x: {
        etag: '"e2"',
        snap: { title: 'Alt', notes: '', allDay: false, start: importedTime, durationM: 60 },
        gone: false,
      },
    },
  });

  // The hook payload still carries the PRE-import snapshot (old time):
  const stalePayloadTask = task({
    id: 'x',
    title: 'Neu',
    dueWithTime: Date.UTC(2026, 6, 22, 9, 0),
    timeEstimate: 3600000,
  });

  await pushLocalChange(config, stalePayloadTask);

  const put = fetchCalls.filter(([, o]) => o.method === 'PUT')[0];
  assert.ok(put, 'title change still pushed');
  assert.match(String(put[1].body), /SUMMARY:Neu/);
  assert.match(String(put[1].body), /DTSTART:20260723T140000Z/, 'imported time kept');
  assert.doesNotMatch(String(put[1].body), /20260722/, 'stale time NOT written back');
});

test('stale poll snapshot: reconcile re-reads the task and does not revert a newer local edit', async () => {
  const config = await getConfig();
  const current = task({ id: 'x', title: 'Neu', dueDay: '2026-07-20' });
  tasksStore.push(current);
  const snap = semanticOfTask(current); // store state == snap == remote
  savePullState({
    calendarUrl: config.calendarUrl,
    syncToken: null,
    ctag: null,
    records: { x: { etag: '"e1"', snap, gone: false } },
  });
  const fetched = {
    ics: ICS(['LAST-MODIFIED:20260713T120000Z', 'SUMMARY:Neu', 'DTSTART;VALUE=DATE:20260720']),
    etag: '"e1"',
  };

  // Poll captured the task list BEFORE the user's title edit:
  const staleCopy = task({ id: 'x', title: 'Alt', dueDay: '2026-07-20' });
  await reconcileWithRemote(config, staleCopy, 'x', fetched);

  assert.equal(fetchCalls.filter(([, o]) => o.method === 'PUT').length, 0, 'no revert push');
  assert.equal(updateTaskCalls.length, 0);
});

test('done task with deleteCompletedTasks: both-changed still resolves to delete', async () => {
  configStore.deleteCompletedTasks = true;
  const config = await getConfig();
  const t = task({ id: 'x', title: 'Done', dueDay: '2026-07-20', isDone: true });
  savePullState({
    calendarUrl: config.calendarUrl,
    syncToken: null,
    ctag: null,
    records: {
      x: { etag: '"old"', snap: { title: 'Alt', notes: '', allDay: true, start: 0, durationM: 1440 }, gone: false },
    },
  });
  const fetched = {
    ics: ICS(['LAST-MODIFIED:20260713T120000Z', 'SUMMARY:Editiert', 'DTSTART;VALUE=DATE:20260720']),
    etag: '"new"',
  };

  await reconcileWithRemote(config, t, 'x', fetched);

  assert.ok(fetchCalls.some(([, o]) => o.method === 'DELETE'), 'deletion wins');
  assert.equal(updateTaskCalls.length, 0);
});
