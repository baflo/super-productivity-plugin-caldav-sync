import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createEventFromTask, escapeICalText } from '../src/ical/build.ts';
import { DEFAULT_CONFIG } from '../src/config.ts';
import type { CalDAVConfig } from '../src/types.ts';
import { task } from './helpers.ts';

const cfg = (overrides: Partial<CalDAVConfig> = {}): CalDAVConfig => ({
  ...DEFAULT_CONFIG,
  ...overrides,
});

test('all-day event: DTEND is the exclusive next day', () => {
  const ics = createEventFromTask(task({ id: 'a', title: 'All day', dueDay: '2026-07-10' }), cfg());
  assert.match(ics, /DTSTART;VALUE=DATE:20260710/);
  assert.match(ics, /DTEND;VALUE=DATE:20260711/);
});

test('all-day event: DTEND rolls over month and year boundaries', () => {
  const ics = createEventFromTask(task({ id: 'a', title: 't', dueDay: '2026-12-31' }), cfg());
  assert.match(ics, /DTEND;VALUE=DATE:20270101/);
});

test('timed event uses timeEstimate for DTEND', () => {
  const ics = createEventFromTask(
    task({
      id: 'a',
      title: 'Timed',
      dueWithTime: Date.UTC(2026, 6, 10, 14, 30),
      timeEstimate: 30 * 60 * 1000,
    }),
    cfg(),
  );
  assert.match(ics, /DTSTART:20260710T143000Z/);
  assert.match(ics, /DTEND:20260710T150000Z/);
});

test('timed event defaults to 1h duration without estimate', () => {
  const ics = createEventFromTask(
    task({ id: 'a', title: 'Timed', dueWithTime: Date.UTC(2026, 6, 10, 14, 0) }),
    cfg(),
  );
  assert.match(ics, /DTEND:20260710T150000Z/);
});

test('VALARM: present on timed events, honors lead time, absent when disabled or all-day', () => {
  const timed = task({ id: 'v', title: 'Alarm', dueWithTime: Date.UTC(2026, 6, 10, 14, 0) });
  assert.match(createEventFromTask(timed, cfg({ addReminders: true })), /BEGIN:VALARM[\s\S]*TRIGGER:PT0S/);
  assert.match(
    createEventFromTask(timed, cfg({ addReminders: true, reminderMinutesBefore: 15 })),
    /TRIGGER:-PT15M/,
  );
  assert.doesNotMatch(createEventFromTask(timed, cfg({ addReminders: false })), /VALARM/);
  assert.doesNotMatch(
    createEventFromTask(task({ id: 'v2', title: 'ad', dueDay: '2026-07-10' }), cfg({ addReminders: true })),
    /VALARM/,
  );
});

test('folding: no physical line exceeds 75 octets, content survives unfolding', () => {
  const longTitle = 'Ein sehr länger Titel mit Ümläuten '.repeat(10);
  const ics = createEventFromTask(task({ id: 'f', title: longTitle, dueDay: '2026-07-10' }), cfg());
  const enc = new TextEncoder();
  for (const line of ics.split('\r\n')) {
    assert.ok(enc.encode(line).length <= 75, `line too long: ${line}`);
  }
  const unfolded = ics.replace(/\r\n /g, '');
  assert.ok(unfolded.includes(escapeICalText(longTitle)));
});

test('escaping normalizes CR/CRLF and escapes special characters', () => {
  assert.equal(escapeICalText('a\r\nb\rc\nd'), 'a\\nb\\nc\\nd');
  assert.equal(escapeICalText('a;b,c\\d'), 'a\\;b\\,c\\\\d');
  assert.equal(escapeICalText(undefined), '');
});
