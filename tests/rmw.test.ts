import { beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  installStubs,
  resetAll,
  okResponse,
  setFetchImpl,
  fetchCalls,
  tasksStore,
  task,
} from './helpers.ts';

installStubs();
const { rebuildEventFromRaw, createEventFromTask, SP_ALARM_MARKER } = await import(
  '../src/ical/build.ts'
);
const { parseVEvent, unfoldICalLines } = await import('../src/ical/parse.ts');
const { semanticEqual, semanticOfEvent, semanticOfTask } = await import('../src/ical/semantic.ts');
const { DEFAULT_CONFIG } = await import('../src/config.ts');
const { pushLocalChange, reconcileWithRemote } = await import('../src/sync/reconcile.ts');
const { loadPullState } = await import('../src/sync/state.ts');
const { getConfig } = await import('../src/config.ts');
import type { CalDAVConfig } from '../src/types.ts';

const cfg = (overrides: Partial<CalDAVConfig> = {}): CalDAVConfig => ({
  ...DEFAULT_CONFIG,
  ...overrides,
});

const RAW_WITH_FOREIGN = [
  'BEGIN:VEVENT',
  'UID:sp-task-x',
  'DTSTAMP:20260710T090000Z',
  'LAST-MODIFIED:20260710T090000Z',
  'DTSTART:20260720T090000Z',
  'DTEND:20260720T100000Z',
  'SUMMARY:Alter Titel',
  'DESCRIPTION:Alte Notiz',
  'LOCATION:Besprechungsraum 3',
  'CATEGORIES:Arbeit,Wichtig',
  'X-MOZ-LASTACK:20260710T080000Z',
  'STATUS:CONFIRMED',
  'TRANSP:OPAQUE',
  'BEGIN:VALARM',
  'ACTION:AUDIO',
  'TRIGGER:-PT30M',
  'END:VALARM',
  'BEGIN:VALARM',
  `${SP_ALARM_MARKER}:1`,
  'ACTION:DISPLAY',
  'DESCRIPTION:Alter Titel',
  'TRIGGER:PT0S',
  'END:VALARM',
  'END:VEVENT',
];

beforeEach(() => resetAll());

test('rebuild preserves foreign props and user alarms, regenerates owned props and our alarm', () => {
  const t = task({
    id: 'x',
    title: 'Neuer Titel',
    notes: 'Neue Notiz',
    dueWithTime: Date.UTC(2026, 6, 21, 14, 0),
    timeEstimate: 90 * 60000,
  });
  const ics = rebuildEventFromRaw(RAW_WITH_FOREIGN, t, cfg({ reminderMinutesBefore: 15 }));

  // owned props regenerated
  assert.match(ics, /SUMMARY:Neuer Titel/);
  assert.match(ics, /DESCRIPTION:Neue Notiz/);
  assert.match(ics, /DTSTART:20260721T140000Z/);
  assert.match(ics, /DTEND:20260721T153000Z/);
  assert.doesNotMatch(ics, /Alter Titel/);
  assert.doesNotMatch(ics, /20260720T090000Z/);

  // foreign props preserved
  assert.match(ics, /LOCATION:Besprechungsraum 3/);
  assert.match(ics, /CATEGORIES:Arbeit\,?/);
  assert.match(ics, /X-MOZ-LASTACK:20260710T080000Z/);
  assert.match(ics, /STATUS:CONFIRMED/);

  // user alarm (AUDIO) kept, our marked alarm regenerated with new trigger
  assert.match(ics, /ACTION:AUDIO[\s\S]*TRIGGER:-PT30M/);
  assert.match(ics, new RegExp(`${SP_ALARM_MARKER}:1[\\s\\S]*TRIGGER:-PT15M`));
  assert.equal((ics.match(/BEGIN:VALARM/g) ?? []).length, 2, 'exactly two alarms');

  // result parses and matches the task semantically
  const parsed = parseVEvent(ics);
  assert.ok(parsed);
  assert.ok(semanticEqual(semanticOfTask(t), semanticOfEvent(parsed)));
});

test('legacy unmarked plugin alarm (DESCRIPTION == old SUMMARY) is adopted, not duplicated', () => {
  const legacyRaw = [
    'BEGIN:VEVENT',
    'UID:sp-task-x',
    'DTSTART:20260720T090000Z',
    'DTEND:20260720T100000Z',
    'SUMMARY:Mein Task',
    'BEGIN:VALARM',
    'ACTION:DISPLAY',
    'DESCRIPTION:Mein Task',
    'TRIGGER:PT0S',
    'END:VALARM',
    'END:VEVENT',
  ];
  const t = task({ id: 'x', title: 'Mein Task', dueWithTime: Date.UTC(2026, 6, 20, 9, 0) });
  const ics = rebuildEventFromRaw(legacyRaw, t, cfg());
  assert.equal((ics.match(/BEGIN:VALARM/g) ?? []).length, 1, 'legacy alarm replaced, not duplicated');
  assert.match(ics, new RegExp(`${SP_ALARM_MARKER}:1`));
});

test('addReminders off removes our alarm but keeps user alarms', () => {
  const t = task({ id: 'x', title: 'T', dueWithTime: Date.UTC(2026, 6, 21, 14, 0) });
  const ics = rebuildEventFromRaw(RAW_WITH_FOREIGN, t, cfg({ addReminders: false }));
  assert.equal((ics.match(/BEGIN:VALARM/g) ?? []).length, 1);
  assert.match(ics, /ACTION:AUDIO/);
  assert.doesNotMatch(ics, new RegExp(`${SP_ALARM_MARKER}`));
});

test('fresh events carry the alarm marker so future RMW recognizes it', () => {
  const t = task({ id: 'x', title: 'T', dueWithTime: Date.UTC(2026, 6, 21, 14, 0) });
  const ics = createEventFromTask(t, cfg());
  assert.match(ics, new RegExp(`${SP_ALARM_MARKER}:1`));
});

test('full cycle: import caches raw, subsequent push preserves LOCATION on the server', async () => {
  const config = await getConfig();
  tasksStore.push(task({ id: 'x', title: 'Alt', dueDay: '2026-07-20' }));

  // Calendar version carries a LOCATION added by a calendar client
  const remoteIcs = [
    'BEGIN:VCALENDAR',
    'BEGIN:VEVENT',
    'UID:sp-task-x',
    'LAST-MODIFIED:20260713T120000Z',
    'SUMMARY:Kalender-Titel',
    'DTSTART;VALUE=DATE:20260720',
    'DTEND;VALUE=DATE:20260721',
    'LOCATION:Draußen',
    'END:VEVENT',
    'END:VCALENDAR',
  ].join('\r\n');

  await reconcileWithRemote(config, tasksStore[0], 'x', { ics: remoteIcs, etag: '"e1"' });
  assert.equal(tasksStore[0].title, 'Kalender-Titel', 'import happened');
  const record = loadPullState(config.calendarUrl).records['x'];
  assert.ok(record.raw?.some((l) => l.startsWith('LOCATION:')), 'raw cached with LOCATION');

  // User edits the title in SP → push must keep the LOCATION
  tasksStore[0].title = 'SP-Titel';
  fetchCalls.length = 0;
  await pushLocalChange(config, tasksStore[0]);

  const put = fetchCalls.filter(([, o]) => o.method === 'PUT')[0];
  assert.ok(put);
  assert.match(String(put[1].body), /SUMMARY:SP-Titel/);
  assert.match(String(put[1].body), /LOCATION:Draußen/, 'foreign LOCATION survived the push');
});

test('missing raw with existing etag: push GETs the event first to preserve props', async () => {
  const config = await getConfig();
  tasksStore.push(task({ id: 'x', title: 'Neu', dueDay: '2026-07-20' }));
  // Seed a record WITHOUT raw (e.g. migrated from an older version)
  const { savePullState } = await import('../src/sync/state.ts');
  const { semanticOfTask: sot } = await import('../src/ical/semantic.ts');
  savePullState({
    calendarUrl: config.calendarUrl,
    syncToken: null,
    ctag: null,
    records: {
      x: {
        etag: '"e1"',
        snap: { ...(sot(task({ id: 'x', title: 'Alt', dueDay: '2026-07-20' })) as object) } as never,
        gone: false,
      },
    },
  });
  const serverIcs = [
    'BEGIN:VCALENDAR',
    'BEGIN:VEVENT',
    'UID:sp-task-x',
    'SUMMARY:Alt',
    'DTSTART;VALUE=DATE:20260720',
    'LOCATION:Keller',
    'END:VEVENT',
    'END:VCALENDAR',
  ].join('\r\n');
  setFetchImpl(async (_url, opts = {}) => {
    if (opts.method === 'GET') return okResponse(200, serverIcs, { ETag: '"e1"' });
    return okResponse();
  });

  await pushLocalChange(config, tasksStore[0]);

  const methods = fetchCalls.map(([, o]) => o.method);
  assert.ok(methods.indexOf('GET') < methods.indexOf('PUT'), 'GET before PUT');
  const put = fetchCalls.filter(([, o]) => o.method === 'PUT')[0];
  assert.match(String(put[1].body), /LOCATION:Keller/, 'props from pre-GET preserved');
  assert.match(String(put[1].body), /SUMMARY:Neu/);
});

test('rebuild output round-trips through fold/unfold with long foreign lines', () => {
  const longLoc = 'LOCATION:' + 'Sehr länger Ort mit Ümläuten '.repeat(8).trim();
  const raw = unfoldICalLines(
    ['BEGIN:VEVENT', 'UID:sp-task-x', 'SUMMARY:T', 'DTSTART;VALUE=DATE:20260720', longLoc, 'END:VEVENT'].join(
      '\r\n',
    ),
  );
  const t = task({ id: 'x', title: 'T', dueDay: '2026-07-21' });
  const ics = rebuildEventFromRaw(raw, t, cfg());
  const enc = new TextEncoder();
  for (const line of ics.split('\r\n')) {
    assert.ok(enc.encode(line).length <= 75, `line too long: ${line}`);
  }
  const reparsed = unfoldICalLines(ics);
  assert.ok(reparsed.includes(longLoc), 'long foreign line survives fold/unfold');
});
