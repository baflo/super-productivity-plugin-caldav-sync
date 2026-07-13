import { beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { installStubs, resetAll, okResponse, setFetchImpl, fetchCalls } from './helpers.ts';

installStubs();
const { authHeader, eventUrl, listCalDAVTaskIds } = await import('../src/caldav/client.ts');
const { getConfig } = await import('../src/config.ts');

beforeEach(() => resetAll());

test('authHeader UTF-8-encodes credentials with umlauts', () => {
  const header = authHeader({
    username: 'flö',
    password: 'pässwörd',
  } as Parameters<typeof authHeader>[0]);
  const decoded = Buffer.from(header.replace('Basic ', ''), 'base64').toString('utf8');
  assert.equal(decoded, 'flö:pässwörd');
});

test('getConfig appends missing trailing slash; eventUrl URL-encodes the uid', async () => {
  const config = await getConfig();
  assert.ok(config.calendarUrl.endsWith('/'));
  assert.equal(eventUrl(config, 'sp-task-a b'), `${config.calendarUrl}sp-task-a%20b.ics`);
});

test('listCalDAVTaskIds extracts task ids from sp-task-*.ics hrefs only', async () => {
  setFetchImpl(async () =>
    okResponse(
      207,
      '<?xml version="1.0"?><d:multistatus xmlns:d="DAV:">' +
        '<d:response><d:href>/dav/cal/</d:href></d:response>' +
        '<d:response><d:href>/dav/cal/sp-task-abc.ics</d:href></d:response>' +
        '<d:response><d:href>/dav/cal/sp-task-x%20y.ics</d:href></d:response>' +
        '<d:response><d:href>/dav/cal/unrelated.ics</d:href></d:response>' +
        '</d:multistatus>',
    ),
  );
  const config = await getConfig();
  const ids = await listCalDAVTaskIds(config);
  assert.deepEqual(ids, ['abc', 'x y']);
  assert.equal(fetchCalls[0][1].method, 'PROPFIND');
});
