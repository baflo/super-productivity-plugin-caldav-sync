# CalDAV Schedule Sync Plugin

A plugin for Super Productivity that automatically synchronizes scheduled tasks to a CalDAV calendar.

## ✨ Features

- ✅ **Automatic synchronization** of scheduled tasks to CalDAV:
  - Tasks with **Due Date + Time** (`dueWithTime`) as timed events
  - Tasks with **Due Date only** (`dueDay`) as all-day events
  - Newly created tasks with a schedule, including **repeating task instances**
- 🔒 **Single Source of Truth**: Super Productivity has full control over the calendar
- 📥 **All tasks supported**: Syncs all scheduled tasks, including those imported from Jira/GitHub/etc.
- 📅 **iCalendar Standard**: RFC 5545 compliant (line folding, exclusive all-day DTEND), compatible with all CalDAV servers (Nextcloud, Radicale, etc.)
- 🔄 **Automatic Updates**: Changes (title, time, description) are propagated to the calendar
- 🗑️ **Cleanup**: Deleted (also batch-deleted) or completed tasks are removed from the calendar; manual sync additionally removes orphaned events
- 📶 **Retry queue**: Requests that fail (e.g. offline) are queued and retried on the next sync

## 🚀 Installation

1. Download the plugin directory
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

### Manual Synchronization

Open the main menu (burger menu) and click the **"CalDAV Sync"** entry to:
- Synchronize all scheduled tasks
- Remove orphaned events (`sp-task-*.ics` files in the calendar that no longer belong to a scheduled task)
- Retry previously failed requests
- See a summary notification

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
- **Timezone**: UTC with automatic conversion to your local timezone

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
window.CalDAVSync.manualSync()                   // Run a full manual sync
```

## ⚠️ Important Notes

- **Security**: Passwords are stored in the plugin's config (encrypted if Super Productivity sync is encrypted)
- **Single Source of Truth**: Use a dedicated calendar only for Super Productivity — the manual sync deletes `sp-task-*.ics` events that no longer belong to a scheduled task
- **Backup**: Create backups of your calendar before the first test
- **Desktop Version**: Recommended due to CORS restrictions in browsers
- **Retry queue**: The queue is held in memory; after an app restart, run a manual sync to bring the calendar back in line

## 📄 License

MIT License - Free to use and modify

---

**Happy syncing! 🎉**
