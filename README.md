# CalDAV Schedule Sync Plugin

A plugin for Super Productivity that automatically synchronizes scheduled tasks to a CalDAV calendar.

> **⚠️ Sync direction:** By default this plugin writes **from Super Productivity to your calendar** only. With the optional **two-way sync** setting, edits made in calendar apps (title, date/time, duration, notes) are imported back — but creating, completing and deleting tasks always stays exclusive to Super Productivity. Use a dedicated calendar for this plugin.

## ✨ Features

- ➡️ **One-way sync** (Super Productivity → CalDAV): the calendar mirrors your scheduled tasks
- ✅ **Automatic synchronization** of scheduled tasks to CalDAV:
  - Tasks with **Due Date + Time** (`dueWithTime`) as timed events
  - Tasks with **Due Date only** (`dueDay`) as all-day events
  - Newly created tasks with a schedule, including **repeating task instances**
- 🔒 **Single Source of Truth**: Super Productivity has full control over the calendar
- 📥 **All tasks supported**: Syncs all scheduled tasks, including those imported from Jira/GitHub/etc.
- 📅 **iCalendar Standard**: RFC 5545 compliant (line folding, exclusive all-day DTEND), compatible with all CalDAV servers (Nextcloud, Radicale, etc.)
- 🔄 **Automatic Updates**: Changes (title, time, description) are propagated to the calendar
- ⏰ **Optional reminder alarms** (VALARM) on timed events, with configurable lead time
- 🗑️ **Cleanup**: Deleted (also batch-deleted) or completed tasks are removed from the calendar — including subtask events when a parent is deleted; manual sync additionally removes orphaned events
- 📶 **Retry queue**: Requests that fail (e.g. offline) are queued and retried automatically (~45 s interval while the app is open, immediately on reconnect) — no manual sync needed

## 🚀 Installation

1. Download the plugin ZIP (or build it yourself, see Development below)
2. In Super Productivity: `Settings` → `Plugins` → `Add Plugin`
3. Enable the plugin

## ⚙️ Configuration

The plugin is configured via the standard Super Productivity plugin settings
(`Settings` → `Plugins` → `CalDAV Schedule Sync`):

- **Calendar URL**: Your CalDAV calendar URL (a missing trailing `/` is added automatically)
- **Username**: Your CalDAV username
- **Password**: App-specific password (recommended)
- **Enable auto sync**: Check the box to activate
- **Delete completed tasks from calendar**: When enabled, completed tasks are automatically removed from the calendar (default: disabled)
- **Add reminders (alarms) to calendar events**: Adds a VALARM to timed events so Nextcloud and your phone remind you (default: enabled)
- **Reminder lead time (minutes before)**: 0 = remind at the task's scheduled time (matches Super Productivity); e.g. 10 = notify 10 minutes before
- **Two-way sync: import calendar edits**: Polls the calendar (~45 s while the app is open) and imports edits made in calendar apps back into Super Productivity (default: disabled)

### Finding your Calendar URL

**Nextcloud:**
```
https://[your-cloud]/remote.php/dav/calendars/[username]/[calendar-name]/
```

Example:
```
https://cloud.example.com/remote.php/dav/calendars/florian/super-productivity/
```

## 🎯 Usage

### Automatic Synchronization

Once the plugin is activated and configured:
- Every task with a **Due Date with Time** (`dueWithTime`) or **Due Date only** (`dueDay`) is automatically synchronized — including tasks that are created with a schedule right away (e.g. instances of repeating tasks)
- Changes to the task (title, time, description) update the calendar event
- Deleting the task or removing the due date also deletes the event
- When a task is marked as completed, the event is removed from the calendar (if "Delete completed tasks from calendar" is enabled)
- Successful syncs are silent (see console logs); only errors show a notification

### Two-Way Sync (optional)

When **two-way sync** is enabled, the plugin polls the calendar while the app
is open (cheap CTag/sync-token check every ~45 s, immediately on app focus) and
imports calendar-side edits into the matching task:

- **Imported**: title, date/time (timezone-aware), duration (→ time estimate), notes
- **Concurrent edits merge**: if the task changed in SP *and* the event changed in the
  calendar, disjoint fields (e.g. title here, time there) are merged; a genuine
  same-field conflict resolves deterministically (newer edit wins, SP wins ties)
  with a warning notification
- **Safe writes**: every write uses HTTP `If-Match`, so the plugin can never
  blindly overwrite a concurrent calendar change — conflicts are detected and merged
- **Polite writes**: updates preserve everything other calendar apps added to
  an event (location, categories, their own reminders, custom properties) —
  only the task-owned fields (title, time, description) are rewritten
- **Not imported**: reminders/alarms (write-only, from plugin config), completion, deletion —
  an event deleted in the calendar is *not* re-created automatically, but reappears
  when the task changes or on the next manual sync
- An empty description in the calendar never wipes existing task notes
- **Known limitation**: a Super Productivity reminder attached to the task keeps
  firing at the old time after a calendar-side time change (the plugin API offers
  no way to move SP reminders yet)

### Manual Synchronization

Open the main menu (burger menu) and click the **"CalDAV Sync"** entry to run
a **full reconcile**: every task/event pairing is checked in one pass —
- local changes are pushed, calendar edits imported (when two-way sync is enabled)
- events deleted from the calendar are recreated (with their preserved extras)
- orphaned `sp-task-*.ics` events are removed
- previously failed requests are retried, and a summary notification is shown

With two-way sync disabled, the full sync treats Super Productivity as the
single source of truth and restores the calendar to match it.

## 🔍 Which tasks are synchronized?

A task is **only** synchronized if:
- ✅ It has a **Due Date with Time** (`dueWithTime`) **OR** a **Due Date only** (`dueDay`)
- ✅ It is **not** marked as completed (`isDone = false`)

**Note:** All tasks are synchronized, including those imported from Jira, GitHub, GitLab, etc.

### What gets synchronized?

- **Start Time**: `task.dueWithTime`
- **End Time**: Start time + `task.timeEstimate` (Default: 1 hour)
- **All-day Events**: Tasks with only `task.dueDay` (no time)
- **Title**: `task.title`
- **Description**: `task.notes`
- **UID / filename**: `sp-task-{taskId}` (for tracking)
- **Timezone**: events are written in the calendar's default timezone (CalDAV `calendar-timezone` property, e.g. set by Nextcloud), falling back to the device timezone, then UTC

## 🐛 Troubleshooting

### Plugin doesn't load / No sync

1. **Check the browser console** (Ctrl+Shift+I → Console)
2. Look for `[CalDAV Sync]` logs
3. Common issues:
   - Plugin disabled → Enable it in the settings UI
   - Missing credentials → Fill out all fields in settings
   - "Enable auto sync" not checked

### CORS Errors

If you see CORS errors:
- This is normal if the CalDAV server doesn't allow CORS
- Use the desktop version of Super Productivity (no CORS issues)
- Or configure your CalDAV server for CORS

### Sync errors

- The manual sync summary shows the **first error message including the HTTP status** (e.g. `2 errors (first: CalDAV PUT failed: 401 Unauthorized)`) — this usually tells you whether it's a wrong URL (404), wrong credentials (401), or a permission problem (403)
- Auto-sync error notifications include the same detail; the full list of errors is in the console (`[CalDAV Sync]` prefix)

### Tasks are not syncing

1. Check if the task has a **Due Date with Time** (`dueWithTime`) **or** a **Due Date only** (`dueDay`)
   - **Due Date with Time**: Set a due date and select a time
   - **Due Date only**: Set a due date without time for all-day events
2. Check the console for errors
3. Use `window.CalDAVSync.getTaskDetails('taskId')` to inspect a specific task
4. Use `window.CalDAVSync.showPendingRetries()` to see queued (failed) operations

### "Configuration incomplete" error

Make sure all fields are filled in the settings UI:
- Calendar URL
- Username
- Password
- Enable checkbox is checked

## 🔧 App-Specific Password (Nextcloud)

For Nextcloud, it's recommended to use an app-specific password:

1. Nextcloud → **Settings** → **Security**
2. Scroll to **"Devices & sessions"**
3. Create a new app password: `Super Productivity CalDAV`
4. Copy the generated password
5. Use this in the plugin (NOT your main password!)

## 📝 Development & Debugging

### Project structure

The source lives in TypeScript modules under `src/` and is bundled into the
single `dist/plugin.js` that Super Productivity loads:

```bash
npm install
npm test          # typecheck + unit tests (requires Node >= 22.18)
npm run build     # bundle src/ -> dist/plugin.js
npm run package   # test + build + dist/caldav-sync.zip (installable ZIP)
```

There are no runtime dependencies — `node_modules` is dev-tooling only
(esbuild, TypeScript). Do not edit `dist/plugin.js` by hand.

CI builds and tests every push/PR and uploads the installable ZIP as a
workflow artifact. To publish a release: bump the version in `manifest.json`
and `package.json`, then push a matching tag (`git tag v2.5.2 && git push
--tags`) — the workflow attaches `caldav-sync.zip` to a GitHub release.

### Console Logs

All plugin logs have the prefix `[CalDAV Sync]`.

### Debug Functions

```javascript
// Open browser console: Ctrl+Shift+I
window.CalDAVSync.showConfig()                   // Show config (password masked)
window.CalDAVSync.getTaskDetails(taskId)         // Show details for a specific task
window.CalDAVSync.syncTask(taskId)               // Force-sync a specific task
window.CalDAVSync.deleteEvent(taskId)            // Delete the event for a task
window.CalDAVSync.listEvents()                   // List task ids of all events in the calendar
window.CalDAVSync.cleanupOrphans()               // Remove orphaned events
window.CalDAVSync.showPendingRetries()           // Show queued (failed) operations
window.CalDAVSync.enableTrace()                  // Verbose sync tracing (persists across reloads)
window.CalDAVSync.disableTrace()                 // Turn tracing off
window.CalDAVSync.showSyncHistory()              // Recent write/import transitions per task
window.CalDAVSync.pullNow()                      // Run one two-way sync pull tick
window.CalDAVSync.showPullState()                // Show device-local pull state (ETags, sync token)
window.CalDAVSync.resetPullState()               // Reset pull state (forces full re-scan)
window.CalDAVSync.manualSync()                   // Run a full manual sync
```

## ⚠️ Important Notes

- **Security**: Passwords are stored in the plugin's config (encrypted if Super Productivity sync is encrypted)
- **Single Source of Truth**: Use a dedicated calendar only for Super Productivity — the manual sync deletes `sp-task-*.ics` events that no longer belong to a scheduled task
- **Backup**: Create backups of your calendar before the first test
- **Desktop Version**: Recommended due to CORS restrictions in browsers
- **Retry queue**: Failed requests are retried automatically every ~45 s and when the connection returns. The queue is held in memory; after an app restart, run a manual sync to bring the calendar back in line

## 📄 License

MIT License - Free to use and modify

---

**Happy syncing! 🎉**
