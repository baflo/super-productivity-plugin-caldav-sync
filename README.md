# CalDAV Schedule Sync Plugin

A plugin for Super Productivity that automatically synchronizes scheduled tasks to a CalDAV calendar.

## ✨ Features

- ✅ **Automatic synchronization** of scheduled tasks to CalDAV:
  - Tasks with **Scheduled Date** (`plannedAt`)
  - Tasks with **Due Date + Time** (`dueWithTime`)
  - Tasks with **Due Date only** (`dueDay`) as all-day events
- 🔒 **Single Source of Truth**: Super Productivity has full control over the calendar
- 📥 **All tasks supported**: Syncs all scheduled tasks, including those imported from Jira/GitHub/etc.
- 📅 **iCalendar Standard**: Compatible with all CalDAV servers (Nextcloud, Radicale, etc.)
- 🔄 **Automatic Updates**: Changes (title, time, description) are propagated to the calendar
- 🗑️ **Cleanup**: Deleted or completed tasks are also removed from the calendar


## 🚀 Installation

1. Download the plugin directory
2. In Super Productivity: `Settings` → `Plugins` → `Add Plugin`
3. Enable the plugin

## ⚙️ Configuration

After activating the plugin:

1. Open the **CalDAV Settings** via:
   - Side panel button: "CalDAV Settings"
2. Enter your CalDAV credentials:
   - **Calendar URL**: Your CalDAV calendar URL (must end with `/`)
   - **Username**: Your CalDAV username
   - **Password**: App-specific password (recommended)
   - **Enable auto sync**: Check the box to activate
   - **Delete completed tasks from calendar**: When enabled, completed tasks are automatically removed from the calendar (default: disabled)
3. Click **Test Connection** to verify your settings
4. Click **Save**

### Finding your Calendar URL

**Nextcloud:**
```
https://[your-cloud]/remote.php/dav/calendars/[username]/[calendar-name]/
```

Example:
```
https://cloud.example.com/remote.php/dav/calendars/florian/super-productivity/
```

**Important:** The URL must end with a `/`!

## 🎯 Usage

### Automatic Synchronization

Once the plugin is activated and configured:
- Every task with **Scheduled Date** (`plannedAt`), **Due Date with Time** (`dueWithTime`), or **Due Date only** (`dueDay`) is automatically synchronized
- Changes to the task (title, time, description) update the calendar event
- Deleting the task or removing the time also deletes the event
- When a task is marked as completed, the event is removed from the calendar (if "Delete completed tasks from calendar" is enabled)

### Manual Synchronization

Click the **"CalDAV Sync"** button in the header bar to:
- Manually synchronize all scheduled tasks
- Clean up orphaned events (tasks that are no longer scheduled)
- See synchronization status

## 🔍 Which tasks are synchronized?

A task is **only** synchronized if:
- ✅ It has a **Scheduled Date** (`plannedAt`) **OR** a **Due Date with Time** (`dueWithTime`) **OR** a **Due Date only** (`dueDay`)
- ✅ It is **not** marked as completed (`isDone = false`)

**Note:** All tasks are synchronized, including those imported from Jira, GitHub, GitLab, etc.

### What gets synchronized?

- **Start Time**: `task.plannedAt` or `task.dueWithTime` (whichever is set)
- **End Time**: Start time + `task.timeEstimate` (Default: 1 hour)
- **All-day Events**: Tasks with only `task.dueDay` (no time) are created as all-day events
- **Title**: `task.title`
- **Description**: `task.notes`
- **UID**: `sp-task-{taskId}` (for tracking)
- **Timezone**: UTC with automatic conversion to your local timezone

## 🐛 Troubleshooting

### Plugin doesn't load / No sync

1. **Check the browser console** (Ctrl+Shift+I → Console)
2. Look for `[CalDAV Sync]` logs
3. Common issues:
   - Plugin disabled → Enable it in the settings UI
   - Missing credentials → Fill out all fields in settings
   - Wrong URL → Check that URL ends with `/`

### CORS Errors

If you see CORS errors:
- This is normal if the CalDAV server doesn't allow CORS
- Use the desktop version of Super Productivity (no CORS issues)
- Or configure your CalDAV server for CORS

### Tasks are not syncing

1. Check if the task has a **Scheduled Date** (`plannedAt`) **or** a **Due Date with Time** (`dueWithTime`) **or** a **Due Date only** (`dueDay`)
   - **Scheduled Date**: Use `S` or the Schedule view in Super Productivity
   - **Due Date with Time**: Set a due date and select a time (not just a date!)
   - **Due Date only**: Set a due date without time for all-day events
2. Check the console for errors
3. Use `window.CalDAVSync.getTaskDetails('taskId')` to inspect a specific task

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

All plugin logs have the prefix `[CalDAV Sync]`:

```javascript
// Open browser console: Ctrl+Shift+I
// Example logs:
[CalDAV Sync] Plugin wird initialisiert...
[CalDAV Sync] Config geladen: {enabled: true, hasUrl: true, ...}
[CalDAV Sync] Plugin erfolgreich initialisiert
[CalDAV Sync] Button wurde geklickt
[CalDAV Sync] Tasks geladen: 34
[CalDAV Sync] Tasks zum Synchronisieren: 5
```

### Debug Functions

```javascript
// Open console and test:
window.CalDAVSync.showData()                     // Show all data (config + mapping)
window.CalDAVSync.showConfig()                   // Show config
window.CalDAVSync.getTaskDetails(taskId)         // Show details for a specific task
window.CalDAVSync.cleanupOrphanedMappings()      // Remove orphaned mappings
window.CalDAVSync.forceRemoveMapping(taskId)     // Remove mapping for specific task
window.CalDAVSync.resetAll()                     // Reset all data
```

## ⚠️ Important Notes

- **Security**: Passwords are stored in the plugin's synced data (encrypted if Super Productivity sync is encrypted)
- **Single Source of Truth**: Use a dedicated calendar only for Super Productivity
- **Backup**: Create backups of your calendar before the first test
- **Desktop Version**: Recommended due to CORS restrictions in browsers

## 🔮 Future Features (Optional)

- [x] Settings UI (iFrame)
- [x] All-day events support

## 📄 License

MIT License - Free to use and modify

---

**Happy syncing! 🎉**
