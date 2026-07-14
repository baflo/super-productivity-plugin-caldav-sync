import { test } from 'node:test';
import assert from 'node:assert/strict';
import { semanticEqual, semanticOfEvent, semanticOfTask } from '../src/ical/semantic.ts';
import { parseVEvent } from '../src/ical/parse.ts';
import { createEventFromTask } from '../src/ical/build.ts';
import { DEFAULT_CONFIG } from '../src/config.ts';
import { task } from './helpers.ts';

const eventSem = (lines: string[]) => {
  const ev = parseVEvent(
    ['BEGIN:VCALENDAR', 'BEGIN:VEVENT', ...lines, 'END:VEVENT', 'END:VCALENDAR'].join('\r\n'),
  );
  assert.ok(ev);
  return semanticOfEvent(ev);
};

test('task and its own generated event are semantically equal (timed and all-day)', () => {
  for (const t of [
    task({ id: 'a', title: 'Timed Täsk', notes: 'n1\nn2', dueWithTime: Date.UTC(2026, 6, 14, 9, 0), timeEstimate: 30 * 60000 }),
    task({ id: 'b', title: 'All day', dueDay: '2026-07-14' }),
    task({ id: 'c', title: 'No estimate', dueWithTime: Date.UTC(2026, 6, 14, 9, 0) }),
  ]) {
    const ics = createEventFromTask(t, { ...DEFAULT_CONFIG, addReminders: true });
    const ev = parseVEvent(ics);
    assert.ok(ev);
    assert.ok(
      semanticEqual(semanticOfTask(t), semanticOfEvent(ev)),
      `round-trip not equal for ${t.id}`,
    );
  }
});

test('seconds are rounded away, VALARM and whitespace differences are ignored', () => {
  const t = task({ id: 'a', title: 'X', dueWithTime: Date.UTC(2026, 6, 14, 9, 0, 20), timeEstimate: 60 * 60000 });
  const sem = eventSem([
    'SUMMARY: X ',
    'DTSTART:20260714T090005Z',
    'DTEND:20260714T100010Z',
    'BEGIN:VALARM',
    'TRIGGER:-PT30M',
    'DESCRIPTION:different alarm',
    'END:VALARM',
  ]);
  assert.ok(semanticEqual(semanticOfTask(t), sem));
});

test('genuine differences are detected', () => {
  const t = task({ id: 'a', title: 'X', dueWithTime: Date.UTC(2026, 6, 14, 9, 0), timeEstimate: 3600000 });
  const base = semanticOfTask(t);
  assert.ok(!semanticEqual(base, eventSem(['SUMMARY:Y', 'DTSTART:20260714T090000Z', 'DTEND:20260714T100000Z'])), 'title');
  assert.ok(!semanticEqual(base, eventSem(['SUMMARY:X', 'DTSTART:20260714T093000Z', 'DTEND:20260714T100000Z'])), 'start');
  assert.ok(!semanticEqual(base, eventSem(['SUMMARY:X', 'DTSTART:20260714T090000Z', 'DTEND:20260714T110000Z'])), 'duration');
  assert.ok(!semanticEqual(base, eventSem(['SUMMARY:X', 'DTSTART;VALUE=DATE:20260714'])), 'allDay flip');
});

test('all-day: multi-day event still equals a single dueDay task (duration ignored)', () => {
  const t = task({ id: 'a', title: 'AD', dueDay: '2026-07-14' });
  const sem = eventSem(['SUMMARY:AD', 'DTSTART;VALUE=DATE:20260714', 'DTEND;VALUE=DATE:20260717']);
  assert.ok(semanticEqual(semanticOfTask(t), sem));
});

test('DURATION is honored when DTEND is absent', () => {
  const t = task({ id: 'a', title: 'X', dueWithTime: Date.UTC(2026, 6, 14, 9, 0), timeEstimate: 90 * 60000 });
  const sem = eventSem(['SUMMARY:X', 'DTSTART:20260714T090000Z', 'DURATION:PT1H30M']);
  assert.ok(semanticEqual(semanticOfTask(t), sem));
});

test('unscheduled or done-irrelevant tasks yield null semantic', () => {
  assert.equal(semanticOfTask(task({ id: 'a', title: 'x' })), null);
});
