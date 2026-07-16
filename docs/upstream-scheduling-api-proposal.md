# Upstream proposal: scheduling API for plugins

Ready-to-post issue text for `johannesjo/super-productivity`. Context: the
CalDAV sync plugin imports calendar-side time changes via
`PluginAPI.updateTask`, which cannot keep SP's reminders in sync.

---

**Title:** Plugin API: allow plugins to (re)schedule tasks with reminder handling

## Problem

Plugins can update a task's scheduling fields through
`PluginAPI.updateTask(taskId, { dueWithTime, dueDay })` — the fields land in
the entity and the UI reacts. However, reminder bookkeeping does **not**
follow:

- `task-reminder.effects.ts` manages reminders exclusively via the dedicated
  actions (`scheduleTaskWithTime`, `reScheduleTaskWithTime`, `unscheduleTask`,
  `planTaskForDay`); on a plain `updateTask` it only reacts to `isDone`.
- Those scheduling actions are not available to plugins either:
  `allowed-plugin-actions.const.ts` deliberately excludes them from
  `dispatchAction`.

Concrete consequence (CalDAV two-way sync plugin): when a user moves an event
in their calendar app, the plugin imports the new time into the task — but an
existing SP reminder keeps firing at the **old** time. There is currently no
way for a plugin to fix that.

## Proposal

Either of these would solve it (first one preferred):

1. **A bridge method** on the plugin API, e.g.

   ```ts
   scheduleTask(taskId: string, schedule:
     | { dueWithTime: number; remindAt?: number | 'AT_START' }
     | { dueDay: string }
     | null  // unschedule
   ): Promise<void>;
   ```

   internally dispatching `scheduleTaskWithTime` / `reScheduleTaskWithTime` /
   `planTaskForDay` / `unscheduleTask` so reminder handling stays consistent.

2. **Allowlisting the scheduling actions** for `dispatchAction` in
   `allowed-plugin-actions.const.ts`. Smaller change, but plugins would need
   to mirror SP's internal dispatch logic (choose schedule vs. re-schedule,
   compute `remindAt`), which seems more fragile across releases.

## Notes

- The existing `updateTask` passthrough is otherwise sufficient for two-way
  sync (title, notes, timeEstimate, due fields all work).
- Happy to contribute a PR for either variant if you can indicate which
  direction you'd prefer.

---

*Reference implementation hitting this limitation:*
*https://github.com/baflo/super-productivity-plugin-caldav-sync (two-way CalDAV sync, see `docs/two-way-sync-design.md`, resolved question 1).*
