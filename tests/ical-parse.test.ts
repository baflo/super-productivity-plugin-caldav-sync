import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseVEvent,
  parseICalDuration,
  parseContentLine,
  unfoldICalLines,
  zonedTimeToEpochMs,
} from '../src/ical/parse.ts';
import { createEventFromTask } from '../src/ical/build.ts';
import { DEFAULT_CONFIG } from '../src/config.ts';
import { task } from './helpers.ts';

const wrap = (lines: string[]): string =>
  ['BEGIN:VCALENDAR', 'VERSION:2.0', 'BEGIN:VEVENT', ...lines, 'END:VEVENT', 'END:VCALENDAR'].join(
    '\r\n',
  );

test('unfolding joins continuation lines (space and tab)', () => {
  const lines = unfoldICalLines('SUMMARY:Hello\r\n  World\r\nDESCRIPTION:a\r\n\tb');
  assert.deepEqual(lines, ['SUMMARY:Hello World', 'DESCRIPTION:ab']);
});

test('content line parsing respects quoted params containing colons/semicolons', () => {
  const prop = parseContentLine('DTSTART;TZID="Foo:Bar;Baz";VALUE=DATE-TIME:20260710T120000');
  assert.equal(prop?.name, 'DTSTART');
  assert.equal(prop?.params.TZID, 'Foo:Bar;Baz');
  assert.equal(prop?.value, '20260710T120000');
});

test('parses UTC datetime, date-only and unescapes text', () => {
  const ev = parseVEvent(
    wrap([
      'UID:sp-task-x',
      'SUMMARY:Hallo\\, Welt\\; mit\\nZeile',
      'DESCRIPTION:Notiz',
      'DTSTART:20260710T143000Z',
      'DTEND:20260710T153000Z',
      'LAST-MODIFIED:20260709T100000Z',
    ]),
  );
  assert.ok(ev);
  assert.equal(ev.uid, 'sp-task-x');
  assert.equal(ev.summary, 'Hallo, Welt; mit\nZeile');
  assert.equal(ev.dtstart?.epochMs, Date.UTC(2026, 6, 10, 14, 30));
  assert.equal(ev.dtstart?.dateOnly, false);
  assert.equal(ev.dtend?.epochMs, Date.UTC(2026, 6, 10, 15, 30));
  assert.equal(ev.lastModified, Date.UTC(2026, 6, 9, 10, 0));

  const allDay = parseVEvent(wrap(['DTSTART;VALUE=DATE:20260710', 'DTEND;VALUE=DATE:20260711']));
  assert.equal(allDay?.dtstart?.dateOnly, true);
  assert.equal(allDay?.dtstart?.epochMs, Date.UTC(2026, 6, 10));
});

test('TZID datetimes resolve DST-aware via Intl', () => {
  // Berlin: CEST (UTC+2) in July, CET (UTC+1) in January
  assert.equal(
    zonedTimeToEpochMs(2026, 7, 10, 14, 0, 0, 'Europe/Berlin'),
    Date.UTC(2026, 6, 10, 12, 0),
  );
  assert.equal(
    zonedTimeToEpochMs(2026, 1, 10, 14, 0, 0, 'Europe/Berlin'),
    Date.UTC(2026, 0, 10, 13, 0),
  );
  const ev = parseVEvent(wrap(['DTSTART;TZID=Europe/Berlin:20260710T140000']));
  assert.equal(ev?.dtstart?.epochMs, Date.UTC(2026, 6, 10, 12, 0));
});

test('DURATION parsing', () => {
  assert.equal(parseICalDuration('PT1H30M'), 90 * 60000);
  assert.equal(parseICalDuration('P1DT12H'), 36 * 3600 * 1000);
  assert.equal(parseICalDuration('P2W'), 14 * 24 * 3600 * 1000);
  assert.equal(parseICalDuration('-PT15M'), -15 * 60000);
  assert.equal(parseICalDuration('nonsense'), null);
});

test('VALARM DESCRIPTION does not leak into the event description', () => {
  const ev = parseVEvent(
    wrap([
      'SUMMARY:Event',
      'DTSTART:20260710T140000Z',
      'BEGIN:VALARM',
      'ACTION:DISPLAY',
      'DESCRIPTION:Alarm text — must not leak',
      'TRIGGER:PT0S',
      'END:VALARM',
    ]),
  );
  assert.equal(ev?.summary, 'Event');
  assert.equal(ev?.description, undefined);
});

test('VTIMEZONE before the VEVENT is skipped', () => {
  const ics = [
    'BEGIN:VCALENDAR',
    'BEGIN:VTIMEZONE',
    'TZID:Europe/Berlin',
    'BEGIN:STANDARD',
    'DTSTART:19701025T030000',
    'END:STANDARD',
    'END:VTIMEZONE',
    'BEGIN:VEVENT',
    'SUMMARY:Real',
    'DTSTART:20260710T140000Z',
    'END:VEVENT',
    'END:VCALENDAR',
  ].join('\r\n');
  const ev = parseVEvent(ics);
  assert.equal(ev?.summary, 'Real');
  assert.equal(ev?.dtstart?.epochMs, Date.UTC(2026, 6, 10, 14, 0));
});

test('round-trip: parses what build.ts generates (incl. folded umlaut title)', () => {
  const longTitle = 'Sehr länger Titel mit Ümläuten und Kömmas, sowie; Semikolons '.repeat(4).trim();
  const t = task({
    id: 'rt1',
    title: longTitle,
    notes: 'zeile1\nzeile2',
    dueWithTime: Date.UTC(2026, 6, 14, 9, 0),
    timeEstimate: 45 * 60000,
  });
  const ics = createEventFromTask(t, { ...DEFAULT_CONFIG, addReminders: true });
  const ev = parseVEvent(ics);
  assert.equal(ev?.uid, 'sp-task-rt1');
  assert.equal(ev?.summary, longTitle);
  assert.equal(ev?.description, 'zeile1\nzeile2');
  assert.equal(ev?.dtstart?.epochMs, Date.UTC(2026, 6, 14, 9, 0));
  assert.equal(ev?.dtend?.epochMs, Date.UTC(2026, 6, 14, 9, 45));
});
