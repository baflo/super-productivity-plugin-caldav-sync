import { afterEach, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  installStubs,
  resetAll,
  okResponse,
  setFetchImpl,
  fetchCalls,
  task,
} from './helpers.ts';

installStubs();
const { getEventTimezone, setTimezoneOverride, resetTimezoneCache, isUTCZone } = await import(
  '../src/caldav/timezone.ts'
);
const { getConfig } = await import('../src/config.ts');
const { parseVEvent } = await import('../src/ical/parse.ts');
const { createEventFromTask } = await import('../src/ical/build.ts');
const { semanticOfEvent, semanticOfTask, semanticEqual } = await import('../src/ical/semantic.ts');
const { DEFAULT_CONFIG } = await import('../src/config.ts');

const TZ_PROP_RESP =
  '<?xml version="1.0"?><d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">' +
  '<d:response><d:href>/cal/</d:href><d:propstat><d:prop><c:calendar-timezone>' +
  'BEGIN:VCALENDAR\r\nPRODID:-//Nextcloud//EN\r\nBEGIN:VTIMEZONE\r\nTZID:Europe/Berlin\r\n' +
  'BEGIN:DAYLIGHT\r\nTZOFFSETFROM:+0100\r\nTZOFFSETTO:+0200\r\nTZNAME:CEST\r\nDTSTART:19700329T020000\r\n' +
  'RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=-1SU\r\nEND:DAYLIGHT\r\nBEGIN:STANDARD\r\nTZOFFSETFROM:+0200\r\n' +
  'TZOFFSETTO:+0100\r\nTZNAME:CET\r\nDTSTART:19701025T030000\r\nRRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU\r\n' +
  'END:STANDARD\r\nEND:VTIMEZONE\r\nEND:VCALENDAR' +
  '</c:calendar-timezone></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response></d:multistatus>';

beforeEach(() => {
  resetAll();
  setTimezoneOverride(undefined); // lift the global test override
  resetTimezoneCache();
});

afterEach(() => {
  setTimezoneOverride(null); // restore deterministic UTC for other suites
});

test('server calendar-timezone is parsed (TZID + VTIMEZONE block) and cached', async () => {
  setFetchImpl(async () => okResponse(207, TZ_PROP_RESP));
  const config = await getConfig();

  const tz = await getEventTimezone(config);
  assert.equal(tz?.tzid, 'Europe/Berlin');
  assert.equal(tz?.vtimezoneLines[0], 'BEGIN:VTIMEZONE');
  assert.equal(tz?.vtimezoneLines.at(-1), 'END:VTIMEZONE');
  assert.ok(tz!.vtimezoneLines.some((l) => l.includes('CEST')));

  const callsBefore = fetchCalls.length;
  await getEventTimezone(config);
  assert.equal(fetchCalls.length, callsBefore, 'second call served from cache');
});

test('UTC server timezone falls back to plain UTC events (null)', async () => {
  setFetchImpl(async () =>
    okResponse(
      207,
      TZ_PROP_RESP.replace(/Europe\/Berlin/g, 'Etc/UTC'),
    ),
  );
  const tz = await getEventTimezone(await getConfig());
  assert.equal(tz, null);
});

test('isUTCZone matches UTC/GMT variants only', () => {
  for (const z of ['UTC', 'Etc/UTC', 'GMT', 'Etc/GMT']) assert.ok(isUTCZone(z), z);
  for (const z of ['Europe/Berlin', 'America/New_York', 'Etc/GMT-2']) assert.ok(!isUTCZone(z), z);
});

test('round-trip: event built with server tz parses back semantically equal', async () => {
  setFetchImpl(async () => okResponse(207, TZ_PROP_RESP));
  const tz = await getEventTimezone(await getConfig());
  const t = task({
    id: 'rt',
    title: 'TZ-Task',
    dueWithTime: Date.UTC(2026, 6, 14, 10, 0),
    timeEstimate: 45 * 60000,
  });
  const ics = createEventFromTask(t, { ...DEFAULT_CONFIG, addReminders: true }, tz);
  const parsed = parseVEvent(ics);
  assert.ok(parsed);
  assert.ok(semanticEqual(semanticOfTask(t), semanticOfEvent(parsed)));
});
