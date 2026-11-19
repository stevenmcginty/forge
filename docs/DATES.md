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
{ "version": 1, "items": [ /* DateItem */ ] }
```

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
| `remindDays` | number[] | `[30, 7, 1, 0]` | Days before `date` on which an alert fires. Unique, sorted high to low, each 0 to 730. |
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
`dates.json.bad-<timestamp>` and the list starts empty. Loading never throws.

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
- `humanWhen(item, today): string` — plain words: `today`, `tomorrow`,
  `in 12 days`, `in 5 months`, `in 2 years`, `3 days overdue`.
- `dueAlert(item, today): { key, daysLeft, threshold } | null` — see "Alerts".
- `markAlerted(item, alert): DateItem`
- `completeItem(item, now): DateItem` — see "Complete".
- `applyPatch(item, patch: DatePatch): DateItem` — checked field update. A new
  `date` drops every `alerted` key that does not start with the new date.
- `alertText(item, today): { title, body }` — the words of a notification.
- `agentPrompt(item, today): string` — the first prompt for an agent put on this line.
- `attentionCount(items, today): number` — open items that are overdue, today, or within 7 days.
- `DATES_IPC` — the IPC channel names.
- Types: `DateItem`, `DateInput` (title + date required, the rest optional),
  `DatePatch`, `DateAlert` (`{ item, daysLeft, title, body }`).

### Alerts

`dueAlert` returns at most one alert for an item on a given day.

- No alert for a done item. No alert while `today < snoozedUntil`.
- `d = daysLeft`.
- If `d >= 0`: take the smallest threshold `t` in `remindDays` with `t >= d`.
  None: no alert. Key is `<date>:<t>`. Key already in `alerted`: no alert.
  Else alert. `markAlerted` adds the key for `t` and for every larger
  threshold, so a new item that is already inside three thresholds alerts once.
- If `d < 0` and the item has no `endDate`: one alert for each 7-day block.
  Key is `<date>:late<floor((-d - 1) / 7)>`.
- If `d < 0` and the item has an `endDate`: no alert.

The alert pass acts only from 08:00 to 21:00 local time. A threshold crossed in
the night, or while the PC was off, fires on the next pass inside those hours.

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
  pass. Marks what it fires and calls the `onAlert` listeners. Outside 08:00 to
  21:00 it does nothing unless `force`.

`initDates()` in `electron/dates-ipc.ts` registers the IPC handlers, sends
changes to every renderer window, and starts the scheduler: first pass 60
seconds after start, then every 15 minutes.

Desktop alert: an Electron `Notification` with the words from `alertText`. A
click shows and focuses the Forge window and tells the renderer to open the
Dates surface.

`openDateAgent(id): Promise<{ ok: boolean; error?: string }>` in
`electron/dates-ipc.ts` opens an agent pane on the desktop with
`agentPrompt(item)` as its first prompt, by the same route as the
`open_agent_pane` tool. The phone uses it.

## Desktop renderer

`window.forgeDates` (typed accessor: `src/lib/datesApi.ts`):
`list()`, `add(input)`, `update(id, patch)`, `complete(id)`, `snooze(id, until)`,
`remove(id)`, `onChange(cb)`, `onOpen(cb)`. The last two return an unsubscribe
function. `onOpen` fires when a notification was clicked.

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
  tool), `dates-agent` `{ id }` (calls `openDateAgent`).
- Server frame `dates` `{ items }`, broadcast after every change.
- Push payload kind `date` `{ id, title, body }`. Date alerts are always
  delivered; they are not tied to a session being watched. A tap opens the
  Dates screen.

Entry: a "Dates" row in the More sheet, with `attentionCount` when it is not 0.

## Known limit

Alerts are sent by the desktop app. With the PC off, nothing fires. The missed
alert fires on the next pass after the app starts.
