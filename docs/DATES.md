# Dates (renewals and deadlines)

One global list of dates that matter: a lease ends, an insurance policy renews,
a web domain expires, a payment plan finishes, a holiday starts, a form is due. Steve looks at it for a snapshot, gets an alert before each date on
the desktop and on the phone, and can put an agent on any line. Forge's agents
can read and change the list, so they know what is coming up.

The list is global. It does not belong to a project.

This file is the contract between the parts. If code and this file disagree,
fix one of them in the same commit.

## Never

- No personal data in the repo. No real dates, names, addresses or account
  numbers in code, docs, checks or fixtures. Use made-up examples
  ("Shop lease ends").
- Checks never read or write the live data dir (`%APPDATA%\Forge`). They use a
  temp dir.

## Data

File: `<dataDir>/dates.json`, where `dataDir` is `getDataDir()` from
`electron/store.ts`.

```json
{ "version": 1, "items": [ /* DateItem */ ], "weekly": { /* DatesWeekly */ } }
```

`weekly` is the weekly check's state; see "Weekly check".

`DateItem`:

| Field | Type | Default | Meaning |
|---|---|---|---|
| `id` | string | made by the store | Short random id. Never changes. |
| `title` | string | required | What happens. Max 120 characters. |
| `date` | `YYYY-MM-DD` | required | The day it happens. A calendar day, no time, no time zone. |
| `group` | string | `""` | Free text, for example a business name. |
| `kind` | string | `'other'` | One of `DATE_KINDS`: `contract`, `insurance`, `domain`, `payment`, `subscription`, `licence`, `holiday`, `task`, `other`. An unknown value becomes `other`. |
| `amount` | string | `""` | Money in free text, for example "250 a month". Shown as written. |
| `endDate` | `YYYY-MM-DD` | absent | The last day, for something that spans days (a holiday). Not before `date`. |
| `note` | string | `""` | The facts: amounts, notice rules, who to call. |
| `action` | string | `""` | What to do when it comes up. |
| `estimated` | boolean | `false` | True when the date is not confirmed. The UI says "about". |
| `remindDays` | number[] | `[30, 7, 1, 0]` | Days before `date` on which an alert fires. Unique, sorted high to low, each 0 to 730. The alerts also add 30 to this list unless the line repeats monthly; see "Alerts". |
| `repeat` | `'none' \| 'monthly' \| 'quarterly' \| 'yearly'` | `'none'` | See "Complete". |
| `done` | boolean | `false` | |
| `doneAt` | ISO timestamp | absent | Set when `done` becomes true. |
| `snoozedUntil` | `YYYY-MM-DD` | absent | No alerts before this day. |
| `alerted` | string[] | `[]` | Keys of the alerts already sent. See "Alerts". |
| `source` | string | `'steve'` | Who made it: `'steve'`, `'agent'`, `'seed'`. |
| `createdAt`, `updatedAt` | ISO timestamp | set by the store | |

The file can be written by hand. On load, a missing optional field gets its
default. An item with no title or a bad date is dropped with one log line.
Unknown fields are dropped. A file that is not valid JSON is renamed to
`dates.json.bad-<timestamp>` and the list starts empty. A file with no
`weekly` block, or with bad values in it, gets the defaults; when `since` is
missing or bad the file is saved at once, so the weekly check counts from that
moment. `version` stays 1. Loading never throws.

Writes are atomic (temp file, then rename).

## Pure logic: `shared/dates.ts`

No Node APIs, no DOM. `electron/`, `src/` and `web/` all import it.

All day arithmetic is on calendar days (`YYYY-MM-DD` parts), never on
milliseconds of local time, so a clock change cannot move a date.

- `normaliseItem(raw): DateItem | null`
- `todayOf(now: Date): string` — the local calendar day.
- `daysLeft(item, today): number` — `date` minus `today` in whole days. Negative means overdue.
- `statusOf(item, today): 'done' | 'overdue' | 'today' | 'soon' | 'upcoming' | 'later'`
  — `soon` is 1 to 30 days, `upcoming` is 31 to 180, `later` is more than 180.
  An item with `endDate` is `today` from `date` to `endDate`, and `done` after
  `endDate`. It is never `overdue`.
- `DATE_KINDS` — the kinds, in display order, each with a plain label
  (`Contract`, `Insurance`, `Web domain`, `Payment`, `Subscription`, `Licence`,
  `Holiday`, `To do`, `Other`).
- `sortItems(items, today)` — open items, soonest first; then done items, newest `doneAt` first.
- `bucketsOf(items, today)` — ordered, non-empty buckets for a UI:
  `Overdue`, `Today`, `Next 30 days`, `Next 6 months`, `Later`, `Done`.
- `monthBlocksOf(items, today): DateMonthBlock[]` — the list in calendar-month
  blocks, for a UI that shows each month in its own colour:
  `{ key: 'overdue', label: 'Overdue', items }` when any open line is overdue;
  then one block per month that holds open, not-overdue lines, in date order:
  `{ key: 'YYYY-MM', year, month (1-12), label: 'November 2026', tone, items }`,
  lines by date; then `{ key: 'done', label: 'Done', items }` when any. `tone`
  is the month's index, 0 to 11, so a month has the same colour on every face
  and in every year. A line with an `endDate` that is running now sits in
  today's month.
- `urgencyOf(item, today): DateUrgency` — for a line's colour: `'done'`;
  `'late'` (overdue); `'today'` (`statusOf` is `today`, so a running `endDate`
  line too); `'week'` (1 to 7 days); `'month'` (8 to 30 days); `'calm'` (more
  than 30).
- `humanWhen(item, today): string` — plain words: `today`, `tomorrow`,
  `in 12 days`, `in 5 months`, `in 2 years`, `3 days overdue`.
- `dueAlert(item, today): { key, daysLeft, threshold } | null` — see "Alerts".
- `markAlerted(item, alert): DateItem`
- `effectiveRemindDays(item): number[]` — the thresholds the alerts use. See "Alerts".
- `alertSummary(alerts, today): DateAlert` — one alert for several. See "Alerts".
- `dateNoticeOf(alert): DateNotice` — an alert as an in-app notice:
  `{ id, title, body }`, or `{ title, body, summary: true }` for a summary.
- `completeItem(item, now): DateItem` — see "Complete".
- `applyPatch(item, patch: DatePatch): DateItem` — checked field update. A new
  `date` drops every `alerted` key that does not start with the new date.
- `alertText(item, today): { title, body }` — the words of a notification.
- `agentPrompt(item, today): string` — the first prompt for an agent put on this line.
- `attentionCount(items, today): number` — open items that are overdue, today, or within 7 days.
- Weekly check: `WEEKLY_DEFAULTS`, `normaliseWeekly(raw, now)`,
  `weeklyPatchError(patch)`, `weeklyDue(weekly, now)`, `nextWeeklyRun(weekly, now)`,
  `weeklyView(weekly, now)`, `weeklyPrompt(custom, today, openLines)`,
  `DEFAULT_WEEKLY_PROMPT`, `WEEKLY_HARD_RULES`. See "Weekly check".
- `DATES_IPC` — the IPC channel names.
- Types: `DateItem`, `DateInput` (title + date required, the rest optional),
  `DatePatch`, `DateAlert` (`{ item, daysLeft, title, body, summary?, items? }`),
  `DateNotice` (`{ id?, title, body, summary? }`), `DateMonthBlock`,
  `DateUrgency`, `DatesWeekly`, `DatesWeeklyView` (plus `nextRunAt`),
  `DatesWeeklyPatch`, `DatesApi`, `DatesWeeklyApi`.

### Alerts

`dueAlert` returns at most one alert for an item on a given day.

- No alert for a done item. No alert while `today < snoozedUntil`.
- `d = daysLeft`.
- The thresholds are `effectiveRemindDays(item)`: `remindDays` plus 30, unless
  `repeat` is `'monthly'`. So every other open line alerts when it enters its
  last 30 days, even when 30 is not in its `remindDays` (an empty list too).
  `remindDays` itself is not changed.
- If `d >= 0`: take the smallest threshold `t` with `t >= d`.
  None: no alert. Key is `<date>:<t>`. Key already in `alerted`: no alert.
  Else alert. `markAlerted` adds the key for `t` and for every larger
  threshold, so a new item that is already inside three thresholds alerts once.
  Example: `[7, 1, 0]` alerts at 30 days (not again at 29), then at 7, 1 and 0.
  A new line 10 days out with `[1, 0]` alerts once now (the 30), then at 1.
- If `d < 0` and the item has no `endDate`: one alert for each 7-day block.
  Key is `<date>:late<floor((-d - 1) / 7)>`.
- If `d < 0` and the item has an `endDate`: no alert.

The alert pass acts only from 08:00 to 21:00 local time. A threshold crossed in
the night, or while the PC was off, fires on the next pass inside those hours.

Batching: when one pass finds 3 or more alerts (`ALERT_SUMMARY_FROM`), the
listeners get ONE summary alert in their place, made by `alertSummary`:
`summary: true`, `items` = every line in it (soonest first), `item` and
`daysLeft` = the soonest line's, title "5 dates are coming up", body = the
soonest three as `<title>: <humanWhen>`, one per line, then "and 2 more". Every
line is still marked. With 1 or 2 alerts, each is heard on its own as before.
The desktop notification, the in-app notices and the phone push all follow.

### Complete

- `repeat: 'none'`: `done = true`, `doneAt = now`.
- `repeat: 'monthly'`, `'quarterly'` or `'yearly'`: the item stays open.
  `date` moves forward 1, 3 or 12 months at a time to the next occurrence after
  today (a day that does not exist in the new month becomes that month's last
  day). `alerted` and `snoozedUntil` are cleared.
- UI repeat choices: "Does not repeat", "Every month", "Every 3 months",
  "Every year".

## Main process: `electron/dates-store.ts`, `electron/dates-ipc.ts`

`getDates(): DatesService` is a module singleton on the live data dir.
`createDatesService({ dir, now? })` makes one on any dir, for checks.

`DatesService`:

- `list(): DateItem[]`
- `add(input: DateInput, source?: string): DateItem`
- `update(id, patch: DatePatch): DateItem | null`
- `complete(id): DateItem | null`
- `snooze(id, until: string): DateItem | null`
- `remove(id): boolean`
- `onChange(cb: (items: DateItem[]) => void): () => void`
- `onAlert(cb: (alert: DateAlert) => void): () => void`
- `checkNow(now?: Date, opts?: { force?: boolean }): DateAlert[]` — the alert
  pass. Marks what it fires and returns one alert per line; the `onAlert`
  listeners hear the same, or one summary when there are 3 or more (see
  "Alerts"). Outside 08:00 to 21:00 it does nothing unless `force`.
- `dir: string` — the folder `dates.json` is in.
- `getWeekly(): DatesWeeklyView`, `setWeekly(patch): DatesWeeklyView` (throws a
  plain sentence on a bad value), `markWeeklyRun(result: 'started' | 'failed',
  error?): DatesWeeklyView`, `onWeekly(cb): () => void`. See "Weekly check".

`initDates()` in `electron/dates-ipc.ts` registers the IPC handlers, sends
changes (of the list and of the weekly check) to every renderer window, and
starts the scheduler: first tick 60 seconds after start, then every 15
minutes. Each tick runs the alert pass, then the weekly check when
`weeklyDue` says so.

Desktop alert: an Electron `Notification` with the alert's words (a summary's
too). A click shows and focuses the Forge window and tells the renderer to
open the Dates surface. Each alert is also sent to every renderer window as
`DATES_IPC.alert` with `dateNoticeOf(alert)`; see "In-app notices".

`openDateAgent(id): Promise<{ ok: boolean; error?: string }>` in
`electron/dates-ipc.ts` opens an agent pane on the desktop with
`agentPrompt(item)` as its first prompt, by the same route as the
`open_agent_pane` tool. The phone uses it.

## Desktop renderer

`window.forgeDates` (typed accessor: `src/lib/datesApi.ts`):
`list()`, `add(input)`, `update(id, patch)`, `complete(id)`, `snooze(id, until)`,
`remove(id)`, `onChange(cb)`, `onOpen(cb)`, `onAlert(cb)`. The last three return
an unsubscribe function. `onOpen` fires when a notification was clicked;
`onAlert` gets a `DateNotice` each time an alert fires.

`window.forgeDates.weekly`: `get()`, `set(patch)`, `runNow()`, `onChange(cb)`.
`get()`, `set()` and `onChange` give a `DatesWeeklyView` (with `nextRunAt`).
`runNow()` resolves `{ ok, error? }`.

A preload from before these may lack them: use `datesWeeklyApi()` (null when
missing) and `onDatesAlert(cb)` (a no-op when missing) from
`src/lib/datesApi.ts`.

Surface id: `dates`. Title: `Dates`. Placement: `full`.

Both faces (desktop and phone) can narrow the list by kind and by group.

## Agent tools

The same three tools in both tool sets: Forge's own agents (`forgeToolDefs`)
and pane agents (the forge-bridge MCP server).

- `dates_list` `{ include_done?: boolean, kind?: string, group?: string }` —
  open items, soonest first, one line each: id, date, days left, kind, group,
  title, amount, note, action.
- `dates_add` `{ title, date, kind?, group?, amount?, end_date?, note?, action?, estimated?, remind_days?, repeat? }`
- `dates_update` `{ id, title?, date?, kind?, group?, amount?, end_date?, note?, action?, estimated?, remind_days?, repeat?, done?, snooze_until?, delete? }`
  — `done: true` completes, `delete: true` removes.

`show_view` accepts `dates`.

## Phone (Forge Web)

Wire, in `shared/web.ts`:

- Requests: `dates` (list), `dates-add`, `dates-update` (same fields as the
  tool), `dates-agent` `{ id }` (calls `openDateAgent`), `dates-weekly`
  `{ action: 'run' }` or `{ action: 'set', enabled?, weekday?, hour? }`
  (behind the same gate as the other writes: an admitted browser). The
  `dates` result carries `weekly` (`DatesWeeklyView`) from a desktop that has
  it; `dates-weekly` answers with that result, or `failed` with the sentence.
- Server frame `dates` `{ items, weekly? }`, broadcast after every change to
  the list and to the weekly check.
- Server frame `date-alert` `{ id?, title, body, summary? }` (a `DateNotice`),
  to every admitted browser when an alert fires. See "In-app notices".
- Push payload kind `date` `{ id, title, body }`, or `{ title, body, summary: true }`
  for a summary (no `id`). Date alerts are always delivered; they are not tied
  to a session being watched. The worker tags a line's push `date:<id>` and a
  summary `date:summary`. A tap opens the Dates screen.
- Client state (`web/src/state.tsx`): `dates`, `datesOpen`, `datesWeekly`
  (`DatesWeeklyView | null`), `dateNotice` (`{ id?, title, body, summary?, at }
  | null`, `at` in epoch ms). Actions under `dates`: `refresh`, `add`,
  `update`, `startAgent`, `open`, `close`, `runWeekly()`, `setWeekly(patch)`,
  `dismissNotice()`.

Entry: a "Dates" row in the More sheet, with `attentionCount` when it is not 0.

## In-app notices

When an alert fires (one line, or a summary), each face gets a `DateNotice`
`{ id?, title, body, summary? }` to show inside the app, beside the OS
notification:

- Desktop: `DATES_IPC.alert` to every renderer window;
  `window.forgeDates.onAlert(cb)`.
- Phone: the `date-alert` frame; `state.dateNotice` holds the latest, with
  `at`, until `dates.dismissNotice()`. The phone's general notice queue takes
  text only, so this is its own field.

A tap on a notice opens Dates. A summary has no `id`.

## Weekly check

Once a week an agent pane opens on the desktop to check every mailbox and
account it can reach and bring the list up to date.

State: the top-level `weekly` block of `dates.json`, `DatesWeekly`:

| Field | Type | Default | Meaning |
|---|---|---|---|
| `enabled` | boolean | `true` | |
| `weekday` | 0 to 6 | `1` (Monday) | 0 is Sunday. |
| `hour` | 0 to 23 | `7` | Local time; the slot is `hour`:00. |
| `since` | ISO time | the moment the block was first made | No slot at or before it runs. |
| `lastRunAt` | ISO time | absent | The last run, started or failed. |
| `lastResult` | `'started' \| 'failed'` | absent | |
| `lastError` | string | absent | Why the last run failed. |

The faces get `DatesWeeklyView` = the block plus `nextRunAt` (ISO, or null
when it is off).

- `weeklyDue(weekly, now)` is true when it is on and the latest slot (that
  weekday at `hour`:00 local time, at or before `now`) is later than both
  `since` and `lastRunAt`. So nothing runs on install day until the first slot,
  and a PC that was off for three weeks runs it once, not three times. Slots
  are found on calendar days, so a clock change cannot move them. A change of
  day or hour can make a slot already past count as due; then it runs at the
  next tick.
- `nextWeeklyRun(weekly, now)`: null when off; `now` when it is due; else the
  first slot after `now`, `since` and `lastRunAt`.
- `runWeeklyCheck(): Promise<{ ok, error? }>` in `electron/dates-ipc.ts`: the
  prompt is the text of `<dataDir>/dates-weekly-prompt.md` when that file
  exists and is not empty, else `DEFAULT_WEEKLY_PROMPT`; then a line with
  today's date and the number of open lines; then `WEEKLY_HARD_RULES`, always
  last. It opens an agent pane by the same route as `openDateAgent`, named
  "Weekly dates check", submitted. Started: `markWeeklyRun('started')`. No
  window ready: nothing changes, so the next 15-minute tick tries again. Any
  other failure: `markWeeklyRun('failed', message)`, and the next try is next
  week. One run at a time.
- The tick checks `weeklyDue` at any hour; the 08:00 to 21:00 rule is only for
  alerts.
- `DEFAULT_WEEKLY_PROMPT` tells the agent to: call `dates_list` with done lines
  first; check every mailbox and account it can reach for renewals, expiries,
  contract ends, payment-plan ends, licences, tax and filing dates and booked
  holidays, in mail from the last 14 days plus anything older the list lacks;
  update a matching line when a date or amount changed, or add a line with
  kind, group, amount, a note naming the source (sender and mail date) and an
  action, `estimated: true` when the date was worked out; correct estimated
  lines when the real date is known; end with a short report: added, changed,
  could not check.
- `WEEKLY_HARD_RULES`: never delete a line; never mark a line done unless a
  mail proves it is finished (and say so in its note); read only everywhere
  else (no send, reply, delete, archive, pay, book or form); do not add the
  same thing twice (check `dates_list` first).


## Known limit

Alerts are sent by the desktop app. With the PC off, nothing fires. The missed
alert fires on the next pass after the app starts.
