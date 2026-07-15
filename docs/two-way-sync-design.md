# Two-Way Sync Design (SP ⇄ CalDAV)

## Roadmap

- **Phase 0 — module structure** ✅ (v2.2.2): TypeScript modules, esbuild
  bundle, unit tests in-repo.
- **Phase 1 — parser + pull path** ✅ (v2.3.0): iCal parser, `Semantic`
  projection, CTag/sync-token polling with visibility handling, import via
  `updateTask` with echo suppression. Interim conflict rule: import is skipped
  while a local op is queued (`pendingOps`); otherwise remote wins on
  difference. Per-task ETags are already recorded device-locally.
- **Phase 2 — three-way state + CAS** ✅ (v2.5.0): `{etag, snap, gone}`
  records (Phase-1 state migrates automatically), If-Match/If-None-Match on
  all writes with 412 → GET → full reconcile, GET-after-PUT fallback, the
  four-case `reconcile` state machine with per-field merge (schedule as one
  compound field), deterministic LWW via `task.updated` vs `LAST-MODIFIED`
  (SP wins ties), conflict snacks only for genuine same-field conflicts
  (bootstrap LWW without a merge base stays silent), no-eager-recreate via
  `gone`, semantic idempotence on every push (unchanged tasks produce zero
  requests). Already delivered from this phase's plan ahead of Phase 3:
  echo adoption of identical writes from other clients.
- **Phase 3 — multi-writer hardening** ✅ (v2.6.0): read-modify-write —
  records cache the raw VEVENT lines of the version their ETag identifies;
  writes rebuild from that basis so foreign properties (LOCATION, categories,
  X-props, user-added alarms) survive, with a pre-write GET when the raw
  basis is missing (migrated/echo-adopted records). The plugin's own VALARM
  carries the `X-SP-CALDAV:1` marker and is the only alarm it replaces
  (legacy unmarked alarms whose DESCRIPTION equals the previous SUMMARY are
  adopted). Known limit: foreign properties referencing third-party TZIDs
  (e.g. RDATE with an exotic zone) are preserved verbatim but their
  VTIMEZONE is not re-embedded.
- **Phase 4 — polish + migration**: manual sync as full reconcile (today:
  pull tick + CAS push + orphan cleanup), upstream proposal for a plugin
  scheduling API.

## Goals

- Events are **created and deleted exclusively by the plugin** (existence is owned
  by Super Productivity).
- Edits made in the calendar (title, date, time, duration, notes) flow **back into
  Super Productivity**.
- **Every client may write.** There is no single-writer election and no
  coordination between clients. Multiple SP clients — themselves synchronized via
  SP's own sync — must converge without ping-pong loops or lost updates beyond
  the inherent last-write-wins floor.

## Non-goals

- Importing events the plugin did not create (only `sp-task-*.ics` participate).
- Creating SP tasks from calendar events.
- Conflict UI. Conflicts resolve deterministically; at most a snack informs the
  user that one side was overridden.
- **Syncing reminders/alarms — in either direction (for now).** The VALARM the
  plugin writes is a static artifact derived purely from config
  (`addReminders`, `reminderMinutesBefore` = N minutes before DTSTART); it has
  no relation to SP's task-attached reminders (`reminderId`). Calendar-side
  VALARM edits are **not** imported, VALARMs are **not** part of the semantic
  comparison, and SP task reminders are never touched by an import.

## Core principles

1. **The CalDAV server is the only serialization point.** Every write is a
   compare-and-swap via `If-Match`. Of N concurrent writers exactly one wins;
   losers get 412, re-read, and almost always find nothing left to do.
2. **Write only on semantic difference.** Before any PUT the current server event
   is compared field-wise (normalized) against what we would write. Identical →
   no request. This is what makes N writers safe: a change written by one client
   is a no-op for every other client, so echo chains die after one round.
3. **Decisions depend only on synchronized data** (task fields, `task.updated`,
   event content, `LAST-MODIFIED`) — never on device-local clocks or plugin
   uptime. All clients therefore reach the same decision once SP sync and CalDAV
   polling have caught up, and the system reaches a fixpoint where nobody wants
   to write.
4. **Per-device three-way state, never shared.** Each device keeps its own
   `{etag, snapshot}` per task (localStorage). Sync metadata is *not* stored in
   `persistDataSynced` — shared mutable sync state is the main corruption vector
   in a multi-writer setup. Synced plugin storage holds configuration only.
5. **No eager recreation.** A missing event is never recreated as a *reaction* to
   its disappearance (that would flap against another client's legitimate
   delete-on-done during SP-sync lag). Recreation happens only when the task
   itself changes afterwards, or on manual sync.
6. **Read-modify-write on events.** Foreign properties (LOCATION, attendee
   fields, third-party X-props, user-tuned VALARMs when reminders are disabled)
   are preserved; the plugin only rewrites the properties it owns.

## Data structures (per device)

```
// localStorage['caldav-sync.state'] — device-local, never synced
state = {
  syncToken: string | null,       // RFC 6578 sync-token, or last seen CTag
  records: {
    [taskId]: {
      etag: string | null,        // ETag of the event as last seen/written
      snap: Semantic | null,      // semantic content at last successful sync
      gone: boolean,              // event vanished remotely; do not recreate eagerly
    }
  }
}

// The semantic projection — the ONLY thing ever compared or merged
Semantic = {
  title:    string,   // trimmed
  notes:    string,   // trimmed, '' if absent
  allDay:   boolean,
  start:    number,   // epoch ms, minute granularity; for allDay: day start UTC
  durationM: number,  // minutes; for allDay: days
}
```

`semanticOfTask(task, config)` and `semanticOfEvent(parsedVevent)` both produce
this shape. Normalization (trim, minute rounding, timezone resolution to UTC)
lives here and nowhere else. `DTSTAMP`, `SEQUENCE`, **VALARM**, formatting, and
ETags never enter a comparison — alarms are write-only output, not synced data.

When writing, the plugin regenerates *its own* VALARM block from config and
tags it with an `X-SP-CALDAV:1` property inside the VALARM so read-modify-write
can identify and replace exactly that block; any other VALARMs the user added
in a calendar client are preserved like all foreign properties (principle 6).

In-memory only:

```
importing = Set<taskId>   // suppress hook echo while applying remote → task
```

## Field mapping

| Semantic  | Task                        | VEVENT                              |
|-----------|-----------------------------|-------------------------------------|
| title     | `title`                     | `SUMMARY`                           |
| notes     | `notes`                     | `DESCRIPTION`                       |
| allDay    | `dueDay` set, no `dueWithTime` | `DTSTART;VALUE=DATE`             |
| start     | `dueWithTime` \| `dueDay`   | `DTSTART` (TZID resolved to UTC)    |
| durationM | `timeEstimate`              | `DTEND − DTSTART` (or `DURATION`)   |

## The reconcile state machine

Every code path funnels into one function. `record` defaults to
`{etag: null, snap: null, gone: false}`.

```
reconcile(task, event /* parsed or null */, record):
  desired = task exists && shouldSync(task) ? semanticOfTask(task, config) : null
  remote  = event ? semanticOfEvent(event) : null

  localChanged  = !equal(desired, record.snap)
  remoteChanged = event
      ? (event.etag !== record.etag && !equal(remote, record.snap))
      : (record.etag !== null)          // event vanished

  // ETag moved but content identical → another client wrote the same thing.
  // Adopt the new ETag silently. This is the multi-writer echo suppressor.
  if event && event.etag !== record.etag && equal(remote, record.snap):
    record.etag = event.etag
    remoteChanged = false

  case !localChanged && !remoteChanged:
    done

  case remoteChanged && !localChanged:
    if event == null:                    // vanished remotely
      record.gone = true                 // principle 5: do NOT recreate now
    else if desired == null:             // task gone/done/unscheduled here
      deleteEvent(record)                // existence is owned by SP
    else:
      importToTask(task, remote)         // never counter-write
      record = {etag: event.etag, snap: remote, gone: false}

  case localChanged && !remoteChanged:
    if desired == null:
      deleteEvent(record)
    else:
      putEvent(task, desired, record)    // CAS, see below

  case both:
    if desired == null:
      deleteEvent(record)                // deletion wins, deterministic
    else if event == null:
      record.gone = true                 // vanished + local change → recreate
      putEvent(task, desired, record)    //   is allowed here: task changed
    else:
      merged = mergeFields(desired, remote, record.snap, task, event)
      if !equal(merged, remote):  putEvent(task→merged, record)
      if !equal(merged, desired): importToTask(task, merged)
      record.snap = merged
```

### Field merge (deterministic on all clients)

```
mergeFields(desired, remote, snap, task, event):
  for each field f in Semantic:
    localTouched  = snap == null || desired[f] != snap[f]
    remoteTouched = snap == null || remote[f]  != snap[f]
    if  localTouched && !remoteTouched: merged[f] = desired[f]
    if !localTouched &&  remoteTouched: merged[f] = remote[f]
    if  localTouched &&  remoteTouched:            // same field, both sides
      merged[f] = (task.updated >= event.lastModified) ? desired[f] : remote[f]
      note conflict → one snack per reconcile run
  // start/durationM/allDay are merged as ONE compound field (they interact)
```

`task.updated` comes from SP's data (identical on all clients after SP sync);
`LAST-MODIFIED` comes from the event. Ties → SP wins. No local clock involved.
Bootstrap (no record yet, event and task both exist): `snap == null` makes every
differing field "touched on both sides" → pure LWW, still deterministic.

### Writing with CAS

```
putEvent(task, desired, record):
  ics = record has raw event cached
        ? rewriteOwnedProps(rawEvent, desired, config)   // principle 6
        : buildFreshEvent(task, desired, config)
  headers = record.etag ? {If-Match: record.etag} : {If-None-Match: '*'}
  resp = PUT eventUrl, headers, ics

  201/204 → etag = resp.ETag ?? (GET event).etag   // some servers omit/rewrite
            record = {etag, snap: desired, gone: false}
  412     → event2 = GET event                     // lost the race
            reconcile(task, event2, record)        // usually ends in "done"
  other   → retry queue (existing pendingOps mechanism)

deleteEvent(record):
  DELETE with If-Match: record.etag
  204/404 → drop record
  412     → GET; existence is owned by SP → DELETE without If-Match; drop record
            (deterministic: deletion always wins; snack the lost calendar edit)
```

### Importing without echo

```
importToTask(task, sem):
  importing.add(task.id)
  PluginAPI.updateTask(task.id, taskFieldsFrom(sem))
  // TASK_UPDATE fires from our own updateTask:
  onTaskUpsert: if importing.delete(taskId) → return   // record already updated
```

Reminders are out of scope (see non-goals): an import never touches
`reminderId`, and no reminder-related UX is attempted for now. Known,
documented limitation: an SP reminder attached to the task keeps firing at the
old time after a calendar-side time edit (see resolved Q1).

SP sync then carries the change to other clients; for them the calendar already
matches (principle 2) → no further writes anywhere. Chain terminates.

## Poll tick (per device, only while app runs)

```
every POLL_INTERVAL (45s + random jitter 0–15s; backoff ×2 on errors, cap 10min):
  token2 = PROPFIND ctag / REPORT sync-collection(state.syncToken)
  if token2 == state.syncToken: return

  changed = sync-collection result if supported
            else PROPFIND Depth:1 getetag → diff against records
  events  = calendar-multiget REPORT for changed sp-task-*.ics hrefs

  tasks = PluginAPI.getTasks() (+ getArchivedTasks for done-keep policy)
  for each changed/deleted href:
    reconcile(taskById[idFromHref], parsedEvent | null, record)
  state.syncToken = token2
```

Jitter exists so N clients don't stampede the server in lockstep; correctness
does not depend on it.

## Hook handlers (delta to current implementation)

- `TASK_UPDATE` / `TASK_CREATED`: skip if `importing` (echo). Otherwise
  `reconcile(task, cachedOrFetchedEvent, record)` — in the common fast path the
  cached record allows an immediate CAS PUT without a prior GET; a 412 falls
  back to GET + full reconcile.
- `TASK_DELETE` / `TASK_COMPLETE` (with deleteCompletedTasks): `deleteEvent`,
  which is already per-task-serialized via `queuePerTask`.
- Manual sync: full reconcile over all tasks and all remote `sp-task-*.ics`
  (this is also where `gone` events of still-scheduled tasks get recreated and
  orphans get removed).

## Multi-client scenarios, replayed against the rules

| Scenario | Outcome |
|---|---|
| Calendar edit; A and B both poll | Both import identical values; SP sync merges identical task states; neither writes (principle 2). |
| A writes task change; B reacts to same change via SP sync | B compares → server already matches → no-op. |
| A and B PUT concurrently | One wins CAS; loser gets 412 → GET → content equal → adopt ETag only. |
| Task done on A (event deleted); B still has stale undone task | B sees event vanish → `gone`, no recreate (principle 5). SP sync delivers done → B agrees. No flap. |
| Same field edited in calendar and in SP within one poll interval | Deterministic LWW via `task.updated` vs `LAST-MODIFIED`; all clients pick the same winner; loser side gets a conflict snack. Inherent LWW floor. |
| Clients with different plugin versions | Semantic (not byte) comparison absorbs formatting differences; only genuine mapping changes across versions could fight — mitigated by minute-granularity normalization. |
| Clients with different reminder config | Cannot cause write storms: VALARM is not part of the semantic comparison, so an alarm difference alone never triggers a write. The alarm only flips when a genuine content write happens — and since plugin config is synced (resolved Q2), configs converge anyway. |

## Parser requirements

- Unfold (CRLF + space/tab), unescape `\\n \\, \\; \\\\`.
- `DTSTART`/`DTEND` with `VALUE=DATE`, UTC (`...Z`), and `TZID=` (resolve via
  embedded `VTIMEZONE` or IANA name lookup; fall back to treating as floating
  local time).
- `DURATION` as DTEND alternative.
- Preserve all unrecognized lines verbatim for read-modify-write.

## Formerly open questions — resolved

### 1. `updateTask` with `dueWithTime`/`dueDay` — works, with one reminder caveat

Verified in SP source (master, ~v18.13):

- `PluginBridgeService.updateTask` passes `Partial<Task>` through to
  `TaskService.update` **without a field whitelist** — `dueWithTime`, `dueDay`,
  `title`, `notes`, `timeEstimate` all land in the entity, views react, and the
  `TASK_UPDATE` hook fires (our echo suppression handles that).
- **But**: reminder bookkeeping does *not* follow. `task-reminder.effects.ts`
  manages reminders exclusively via `scheduleTaskWithTime` /
  `reScheduleTaskWithTime` / `unscheduleTask` / `planTaskForDay`; on a plain
  `updateTask` it only reacts to `isDone`. And those scheduling actions are
  **not plugin-dispatchable**: `allowed-plugin-actions.const.ts` explicitly
  excludes them (allowlist contains only layout/focus/current-task/context
  actions).

**Design consequence:** import via `updateTask` as planned. Reminders are
excluded from sync scope entirely for now (see non-goals): an import never
touches `reminderId`, and the plugin's VALARMs are unrelated static artifacts.
Documented limitation: a task-attached SP reminder keeps firing at the *old*
time after a calendar-side time edit. Long term: propose upstream (SP) either
allowlisting the scheduling actions for plugins or adding a `scheduleTask()`
bridge method — that would let imports move SP reminders along. Membership in
the Today tag after a `dueDay` import is reconciled by SP's own day-change/sync
effects (`task-due.effects.ts`) rather than immediately — acceptable lag,
verify UX during implementation.

### 2. Plugin config is synced — requirement satisfied

`PluginConfigService.getPluginConfig` persists via
`PluginUserPersistenceService`, which dispatches into the `pluginUserData`
NgRx slice — gzip-compressed and included in **IndexedDB, the op-log, and the
sync server** (per the service's own docs). So `addReminders` /
`reminderMinutesBefore` (and the CalDAV credentials) converge across clients via
SP sync automatically; no `persistDataSynced` workaround needed.

**Design consequence:** the flip side confirms principle 4 — the device-local
three-way state must live in `localStorage`, *not* in plugin persistence,
precisely because everything in `pluginUserData` is synced.

### 3. `sync-collection` REPORT — supported by all target servers

- **Radicale**: verified empirically against a live instance —
  `cs:getctag` + `d:sync-token` via PROPFIND, initial and incremental
  `sync-collection` REPORTs work; the delta contains only changed resources
  plus a fresh token, and **deletions appear as `<response>` entries with
  status 404**, exactly as RFC 6578 specifies.
- **Nextcloud / Baïkal**: both are sabre/dav-based; sabre/dav ships
  WebDAV-Sync (RFC 6578) since 2.0.

CTag + full ETag diff stays in as the universal fallback for anything exotic.

### 4. ICS rewriting and ETag-on-PUT — both handled, semantic compare is mandatory

Verified empirically against Radicale:

- PUT **does** return an `ETag` header (201 + ETag).
- The stored ICS is **rewritten** — property order changes (DTSTAMP/SUMMARY
  reordered on round-trip). Byte or line-based comparison is therefore useless
  even on the friendliest server; the `Semantic` projection is not an
  optimization but a requirement.
- CAS semantics confirmed: `If-Match` with a stale ETag → **412**;
  `If-None-Match: *` against an existing resource → **412**.

sabre/dav (Nextcloud/Baïkal) documents the complementary case: ETag is returned
on PUT *most* of the time, but **omitted whenever the server modifies the object
on storage** — then the client must GET immediately. Our `putEvent` already
specifies exactly that fallback (`resp.ETag ?? (GET event).etag`).

### 5. Mobile lifecycle — poll only while visible, catch up on resume

SP's Android/iOS apps are WebView wrappers around the same Angular app; plugin
JS (and thus our `setInterval`) is throttled or frozen while the app is
backgrounded, and there is no background execution without native support.

**Design consequence:** run the poll interval only while
`document.visibilityState === 'visible'`; register `visibilitychange`/`focus`
listeners and fire **one immediate catch-up tick on resume**. Nothing is lost
while suspended: local changes sit in the retry queue / SP data, remote changes
are picked up by the catch-up tick, and the sync-token makes the catch-up cheap
regardless of how long the app was asleep.
