/**
 * Dates, held to docs/DATES.md.
 *
 *   node scripts/dates-check.mjs      (npm run dates:check)
 *
 * Two halves:
 *
 * 1. THE RULES. shared/dates.ts is pure, so every rule in the contract is
 *    checked here directly: cleaning a line, day counts across month ends,
 *    leap days and both UK clock changes, the status bands, the buckets, the
 *    words, the alert keys, repeats.
 *
 * 2. THE STORE. electron/dates-store.ts driven through createDatesService on a
 *    fresh temp folder: round trip, a hand-written file, a broken file, the
 *    listeners, the alert pass's hours, batching, and the weekly block.
 *
 * 3. THE WEEKLY RUN. runWeeklyCheck from electron/dates-ipc.ts, with Electron,
 *    the main window and the pane opener (askRendererTool) stubbed: the prompt
 *    it builds, and what it records when the pane opens, when there is no
 *    window, and when the opener fails.
 *
 * The live data dir is never touched. electron/store.ts (the only route to
 * %APPDATA%\Forge) is swapped, for both dates-store.ts and dates-ipc.ts, for a
 * stub whose getDataDir throws, so a check that reached for the live list
 * would fail loudly instead of reading it. All examples are made up.
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { registerHooks } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// The clock-change cases mean something only on UK time. Set before any Date is made.
process.env.TZ = 'Europe/London'

let liveDirTouched = false
const STORE_STUB =
  'data:text/javascript,' +
  encodeURIComponent(
    "export function getDataDir(){globalThis.__datesLiveDirTouched=true;throw new Error('dates-check must never touch the live data dir')}"
  )

/** What electron/dates-ipc.ts imports, stubbed: no Electron, no window, no renderer. */
const IPC_STUBS = {
  electron:
    'export const app={focus(){}};export const BrowserWindow={getAllWindows:()=>[]};' +
    'export const ipcMain={handle(){}};export class Notification{static isSupported(){return false}}',
  './main-window': 'export function getMainWindow(){return globalThis.__datesWin ?? null}',
  './voice-agent/ipc':
    'export async function askRendererTool(name,args){(globalThis.__datesAsks ??= []).push({name,args});' +
    "const r=globalThis.__datesReply;if(r instanceof Error)throw r;return r ?? 'OK: opened'}",
  './store':
    "export function getDataDir(){globalThis.__datesLiveDirTouched=true;throw new Error('dates-check must never touch the live data dir')}" +
    'export function getProjects(){return []}export function getSettings(){return {}}',
  '@shared/agents': "export const DEFAULT_PROFILE_ID='claude'"
}

registerHooks({
  resolve(spec, context, next) {
    if (spec === './store' && context.parentURL?.endsWith('/electron/dates-store.ts')) {
      return { url: STORE_STUB, shortCircuit: true }
    }
    if (context.parentURL?.endsWith('/electron/dates-ipc.ts') && Object.hasOwn(IPC_STUBS, spec)) {
      return { url: `data:text/javascript,${encodeURIComponent(IPC_STUBS[spec])}`, shortCircuit: true }
    }
    if (spec.startsWith('@shared/')) {
      return next(new URL(`../shared/${spec.slice('@shared/'.length)}.ts`, import.meta.url).href, context)
    }
    if (spec.startsWith('.') && !/\.[a-z]+$/i.test(spec)) return next(`${spec}.ts`, context)
    return next(spec, context)
  },
  load(url, context, next) {
    if (url.endsWith('.ts')) return next(url, { ...context, format: 'module-typescript' })
    return next(url, context)
  }
})

const D = await import('../shared/dates.ts')
const S = await import('../electron/dates-store.ts')
const I = await import('../electron/dates-ipc.ts')

let pass = 0
let fail = 0
const ok = (cond, label, detail = '') => {
  if (cond) {
    pass++
    console.log(`  ✓ ${label}`)
  } else {
    fail++
    console.log(`  ✕ ${label}${detail ? ` — ${detail}` : ''}`)
  }
}
const eq = (actual, expected, label) =>
  ok(JSON.stringify(actual) === JSON.stringify(expected), label, `got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`)
const throws = (fn, label) => {
  try {
    fn()
    ok(false, label, 'did not throw')
  } catch {
    ok(true, label)
  }
}

const NOW = new Date(2026, 0, 10, 12, 0, 0)
/** A clean line with defaults, made-up content. */
const line = (fields = {}) => D.normaliseItem({ id: 'x1', title: 'Shop lease ends', date: '2026-03-01', ...fields }, NOW)

/* --------------------------------------------------------- normaliseItem */

console.log('\nnormaliseItem')
{
  const item = D.normaliseItem({ title: '  Van insurance renews ', date: '2026-05-04', colour: 'red' }, NOW)
  ok(item !== null, 'a title and a date are enough')
  eq(item.title, 'Van insurance renews', 'the title is trimmed')
  ok(typeof item.id === 'string' && item.id.length >= 6, 'a missing id is made')
  eq(
    [item.group, item.kind, item.amount, item.note, item.action, item.estimated, item.repeat, item.done, item.source],
    ['', 'other', '', '', '', false, 'none', false, 'steve'],
    'the optional fields get their defaults'
  )
  eq(item.remindDays, [30, 7, 1, 0], 'remindDays defaults to 30, 7, 1, 0')
  eq(item.alerted, [], 'alerted defaults to empty')
  ok(!('colour' in item), 'unknown fields are dropped')
  ok(!('endDate' in item) && !('doneAt' in item) && !('snoozedUntil' in item), 'absent optional days stay absent')
  eq(item.createdAt, NOW.toISOString(), 'createdAt defaults to now')
  eq(D.normaliseItem({ date: '2026-05-04' }, NOW), null, 'no title: rejected')
  eq(D.normaliseItem({ title: '   ', date: '2026-05-04' }, NOW), null, 'a blank title: rejected')
  eq(D.normaliseItem({ title: 'A', date: '2026-02-30' }, NOW), null, 'a day that does not exist: rejected')
  eq(D.normaliseItem({ title: 'A', date: '4 May 2026' }, NOW), null, 'a date in the wrong form: rejected')
  eq(D.normaliseItem({ title: 'A' }, NOW), null, 'no date: rejected')
  eq(D.normaliseItem(null, NOW), null, 'not an object: rejected')
  eq(line({ kind: 'spaceship' }).kind, 'other', 'an unknown kind becomes other')
  eq(line({ kind: 'Insurance' }).kind, 'insurance', 'a known kind in any case is kept')
  ok(!('endDate' in line({ endDate: '2026-02-01' })), 'an endDate before date is dropped')
  eq(line({ endDate: '2026-03-08' }).endDate, '2026-03-08', 'an endDate after date is kept')
  eq(line({ remindDays: [7, 30, 7, -1, 900, 1.5, 0] }).remindDays, [30, 7, 0], 'remindDays: unique, high to low, 0 to 730 whole days')
  eq(line({ title: 'x'.repeat(200) }).title.length, 120, 'the title is cut to 120 characters')
  eq(line({ repeat: 'weekly' }).repeat, 'none', 'an unknown repeat becomes none')
  eq(line({ repeat: 'quarterly' }).repeat, 'quarterly', 'quarterly is kept')
  ok(!('doneAt' in line({ done: false, doneAt: '2026-01-01T00:00:00.000Z' })), 'doneAt only on a done line')
  eq(D.DATE_KINDS.map((k) => k.label).join(','), 'Contract,Insurance,Web domain,Payment,Subscription,Licence,Holiday,To do,Other', 'DATE_KINDS order and labels')
}

/* -------------------------------------------------------------- daysLeft */

console.log('\ndaysLeft')
{
  const dl = (date, today) => D.daysLeft({ date }, today)
  eq(dl('2026-02-01', '2026-01-31'), 1, 'across a month end')
  eq(dl('2026-03-01', '2026-02-28'), 1, 'across the end of February in a common year')
  eq(dl('2027-01-01', '2026-12-31'), 1, 'across a year end')
  eq(dl('2028-03-01', '2028-02-28'), 2, 'across 29 Feb in a leap year')
  eq(dl('2028-02-29', '2028-02-28'), 1, 'to 29 Feb')
  eq(dl('2026-03-30', '2026-03-28'), 2, 'across the spring clock change (29 Mar 2026)')
  eq(dl('2026-10-26', '2026-10-24'), 2, 'across the autumn clock change (25 Oct 2026)')
  eq(dl('2026-01-08', '2026-01-10'), -2, 'negative when overdue')
  // todayOf takes the local day, whatever the hour, on both clock-change days.
  eq(D.todayOf(new Date(2026, 2, 29, 0, 30)), '2026-03-29', 'todayOf just after midnight on the spring change day')
  eq(D.todayOf(new Date(2026, 2, 29, 23, 30)), '2026-03-29', 'todayOf late on the spring change day')
  eq(D.todayOf(new Date(2026, 9, 25, 0, 30)), '2026-10-25', 'todayOf just after midnight on the autumn change day')
  eq(D.todayOf(new Date(2026, 9, 25, 23, 30)), '2026-10-25', 'todayOf late on the autumn change day')
  eq(
    D.daysLeft({ date: '2026-10-26' }, D.todayOf(new Date(2026, 9, 25, 23, 59))),
    1,
    'one day left from 23:59 on the autumn change day'
  )
}

/* -------------------------------------------------------------- statusOf */

console.log('\nstatusOf')
{
  const T = '2026-01-10'
  eq(D.statusOf(line({ date: '2026-01-09' }), T), 'overdue', 'overdue')
  eq(D.statusOf(line({ date: '2026-01-10' }), T), 'today', 'today')
  eq(D.statusOf(line({ date: '2026-01-11' }), T), 'soon', 'soon at 1 day')
  eq(D.statusOf(line({ date: '2026-02-09' }), T), 'soon', 'soon at 30 days')
  eq(D.statusOf(line({ date: '2026-02-10' }), T), 'upcoming', 'upcoming at 31 days')
  eq(D.statusOf(line({ date: '2026-07-09' }), T), 'upcoming', 'upcoming at 180 days')
  eq(D.statusOf(line({ date: '2026-07-10' }), T), 'later', 'later at 181 days')
  eq(D.statusOf(line({ date: '2026-01-09', done: true }), T), 'done', 'done wins over overdue')
  const trip = { date: '2026-01-08', endDate: '2026-01-12', kind: 'holiday' }
  eq(D.statusOf(line(trip), '2026-01-07'), 'soon', 'an endDate line before it starts: by days left')
  eq(D.statusOf(line(trip), '2026-01-08'), 'today', 'an endDate line on its first day: today')
  eq(D.statusOf(line(trip), '2026-01-10'), 'today', 'an endDate line in the middle: today, never overdue')
  eq(D.statusOf(line(trip), '2026-01-12'), 'today', 'an endDate line on its last day: today')
  eq(D.statusOf(line(trip), '2026-01-13'), 'done', 'an endDate line after its last day: done')
}

/* ------------------------------------------------------ sort and buckets */

console.log('\nsortItems and bucketsOf')
{
  const T = '2026-01-10'
  const items = [
    line({ id: 'later', date: '2027-06-01' }),
    line({ id: 'done-old', date: '2025-12-01', done: true, doneAt: '2025-12-01T10:00:00.000Z' }),
    line({ id: 'soon', date: '2026-01-20' }),
    line({ id: 'over', date: '2026-01-02' }),
    line({ id: 'done-new', date: '2025-12-20', done: true, doneAt: '2026-01-05T10:00:00.000Z' }),
    line({ id: 'today', date: '2026-01-10' }),
    line({ id: 'upcoming', date: '2026-04-01' })
  ]
  eq(
    D.sortItems(items, T).map((i) => i.id),
    ['over', 'today', 'soon', 'upcoming', 'later', 'done-new', 'done-old'],
    'open soonest first, then done newest first'
  )
  eq(
    D.bucketsOf(items, T).map((b) => b.label),
    ['Overdue', 'Today', 'Next 30 days', 'Next 6 months', 'Later', 'Done'],
    'bucket order'
  )
  eq(
    D.bucketsOf([items[0], items[3]], T).map((b) => b.label),
    ['Overdue', 'Later'],
    'empty buckets are left out'
  )
  eq(D.attentionCount(items, T), 2, 'attentionCount: overdue and today (the 10-day one is not within 7)')
  eq(D.attentionCount([...items, line({ id: 'week', date: '2026-01-17' })], T), 3, 'attentionCount counts a line 7 days away')
}

/* ------------------------------------------------------------- humanWhen */

console.log('\nhumanWhen')
{
  const T = '2026-01-10'
  const hw = (fields) => D.humanWhen(line(fields), T)
  eq(hw({ date: '2026-01-10' }), 'today', 'today')
  eq(hw({ date: '2026-01-11' }), 'tomorrow', 'tomorrow')
  eq(hw({ date: '2026-01-22' }), 'in 12 days', 'in 12 days')
  eq(hw({ date: '2026-06-10' }), 'in 5 months', 'in 5 months')
  eq(hw({ date: '2028-01-10' }), 'in 2 years', 'in 2 years')
  eq(hw({ date: '2026-01-07' }), '3 days overdue', '3 days overdue')
  eq(hw({ date: '2026-01-09' }), '1 day overdue', '1 day overdue')
}

/* -------------------------------------------------------------- dueAlert */

console.log('\ndueAlert and markAlerted')
{
  const base = line({ date: '2026-03-01' })
  eq(D.dueAlert(base, '2026-01-10'), null, 'far away: no alert')
  const at30 = D.dueAlert(base, '2026-01-30')
  eq(at30, { key: '2026-03-01:30', daysLeft: 30, threshold: 30 }, 'exactly on a threshold: that threshold')
  const between = D.dueAlert(base, '2026-02-10')
  eq(between?.key, '2026-03-01:30', 'between thresholds (19 days), nothing sent yet: the smallest threshold at or above, 30')
  const marked30 = D.markAlerted(base, at30)
  eq(D.dueAlert(marked30, '2026-02-10'), null, 'after the 30 alert, nothing until 7 days')
  eq(D.dueAlert(marked30, '2026-02-22')?.key, '2026-03-01:7', 'at 7 days the 7 alert fires')

  // A new line already inside three thresholds (1 day left: inside 30, 7 and 1).
  const fresh = line({ date: '2026-01-11' })
  const first = D.dueAlert(fresh, '2026-01-10')
  eq(first?.key, '2026-01-11:1', 'a new line inside three thresholds: one alert, for the smallest')
  const afterFirst = D.markAlerted(fresh, first)
  eq([...afterFirst.alerted].sort(), ['2026-01-11:1', '2026-01-11:30', '2026-01-11:7'], 'markAlerted records it and every larger threshold')
  eq(D.dueAlert(afterFirst, '2026-01-10'), null, 'then none the same day')
  eq(D.dueAlert(afterFirst, '2026-01-11')?.key, '2026-01-11:0', 'and the day itself still alerts')

  eq(D.dueAlert({ ...base, snoozedUntil: '2026-02-01' }, '2026-01-30'), null, 'snoozed: no alert')
  eq(D.dueAlert({ ...base, snoozedUntil: '2026-01-30' }, '2026-01-30')?.key, '2026-03-01:30', 'snooze ends on its day')
  eq(D.dueAlert({ ...base, done: true }, '2026-01-30'), null, 'done: no alert')

  const over = line({ date: '2026-01-01' })
  const day1 = D.dueAlert(over, '2026-01-02')
  eq(day1, { key: '2026-01-01:late0', daysLeft: -1, threshold: -1 }, 'overdue day 1: block 0')
  const overMarked = D.markAlerted(over, day1)
  eq(D.dueAlert(overMarked, '2026-01-08'), null, 'overdue day 7: same block, no alert')
  eq(D.dueAlert(overMarked, '2026-01-09')?.key, '2026-01-01:late1', 'overdue day 8: block 1 alerts')
  eq(D.dueAlert(line({ date: '2026-01-01', endDate: '2026-01-05' }), '2026-01-03'), null, 'an endDate line is never late')
  eq(D.dueAlert(line({ date: '2026-01-01', endDate: '2026-01-05' }), '2026-01-09'), null, 'nor after its end')
  // Rule B gives every line but a monthly one the 30-day threshold, so "no thresholds" is now a monthly line.
  eq(D.dueAlert(line({ date: '2026-03-01', remindDays: [], repeat: 'monthly' }), '2026-03-01'), null, 'no thresholds (a monthly line): no alert before the day')
}

/* ------------------------------------------------- rule B: the last 30 days */

console.log('\nthe 30-day rule')
{
  const l = line({ date: '2026-03-01', remindDays: [7, 1, 0] })
  eq(D.effectiveRemindDays(l), [30, 7, 1, 0], 'effectiveRemindDays adds 30')
  eq(D.effectiveRemindDays(line({ remindDays: [7], repeat: 'yearly' })), [30, 7], 'a yearly line gets the 30 too')
  eq(D.effectiveRemindDays(line({ remindDays: [7], repeat: 'monthly' })), [7], 'a monthly line does not')
  eq(D.effectiveRemindDays(line({ remindDays: [60, 30, 7] })), [60, 30, 7], 'a list that has 30 already is unchanged')
  eq(D.effectiveRemindDays(line({ remindDays: [] })), [30], 'an empty list gets the 30')
  eq(D.dueAlert(line({ date: '2026-03-01', remindDays: [] }), '2026-03-01')?.key, '2026-03-01:30', 'so a non-monthly line with no thresholds alerts once inside its last 30 days')
  eq(D.dueAlert(l, '2026-01-29'), null, '[7,1,0] at 31 days: no alert')
  const at30 = D.dueAlert(l, '2026-01-30')
  eq(at30, { key: '2026-03-01:30', daysLeft: 30, threshold: 30 }, '[7,1,0] at 30 days: alerts, though 30 is not in remindDays')
  const marked = D.markAlerted(l, at30)
  eq(D.dueAlert(marked, '2026-01-31'), null, 'not again at 29 days')
  eq(D.dueAlert(marked, '2026-02-21'), null, 'nor at 8 days')
  eq(D.dueAlert(marked, '2026-02-22')?.key, '2026-03-01:7', 'again at 7 days')
  ok(!marked.remindDays.includes(30), "the line's own remindDays are left as they were")

  const monthly = line({ date: '2026-03-01', remindDays: [7], repeat: 'monthly' })
  eq(D.dueAlert(monthly, '2026-01-30'), null, 'a monthly line never gets the 30: none at 30 days')
  eq(D.dueAlert(monthly, '2026-02-10'), null, 'nor at 19 days')
  eq(D.dueAlert(monthly, '2026-02-22')?.key, '2026-03-01:7', 'only its own 7')

  const fresh = line({ date: '2026-01-20', remindDays: [1, 0] })
  const now = D.dueAlert(fresh, '2026-01-10')
  eq(now?.key, '2026-01-20:30', 'a new line 10 days out with [1,0]: alerts once now')
  const after = D.markAlerted(fresh, now)
  ok(['2026-01-10', '2026-01-11', '2026-01-15', '2026-01-18'].every((d) => D.dueAlert(after, d) === null), 'then nothing on the days between')
  eq(D.dueAlert(after, '2026-01-19')?.key, '2026-01-20:1', 'and next at 1 day')

  const words30 = D.alertText(l, '2026-01-30')
  ok(words30.title === 'Shop lease ends — in 30 days' && words30.body.includes('30 days left.'), 'alertText at 30 days reads naturally', `${words30.title} / ${words30.body}`)
  const words29 = D.alertText(l, '2026-01-31')
  ok(words29.title.endsWith('in 29 days') && words29.body.includes('29 days left.'), 'and at 29 days', `${words29.title} / ${words29.body}`)
}

/* ---------------------------------------------- month blocks and urgency */

console.log('\nmonthBlocksOf and urgencyOf')
{
  const T = '2026-11-20'
  const items = [
    line({ id: 'jan', date: '2027-01-03' }),
    line({ id: 'over', date: '2026-11-10' }),
    line({ id: 'nov-late', date: '2026-11-28' }),
    line({ id: 'trip', date: '2026-10-28', endDate: '2026-11-25', kind: 'holiday' }),
    line({ id: 'dec', date: '2026-12-05' }),
    line({ id: 'nov-next', date: '2027-11-02' }),
    line({ id: 'gone', date: '2026-09-01', done: true, doneAt: '2026-09-01T10:00:00.000Z' })
  ]
  const blocks = D.monthBlocksOf(items, T)
  eq(blocks.map((b) => b.key), ['overdue', '2026-11', '2026-12', '2027-01', '2027-11', 'done'], 'block order: overdue, months in date order, done')
  eq(blocks.map((b) => b.label), ['Overdue', 'November 2026', 'December 2026', 'January 2027', 'November 2027', 'Done'], 'block labels')
  eq(blocks[1].items.map((i) => i.id), ['trip', 'nov-late'], "a running endDate line (begun in October) sits in today's month; lines by date")
  eq([blocks[3].year, blocks[3].month, blocks[3].tone], [2027, 1, 0], 'across the year end: January 2027 is year 2027, month 1, tone 0')
  ok(blocks[1].tone === 10 && blocks[4].tone === 10, 'November has the same tone in two years', `${blocks[1].tone} ${blocks[4].tone}`)
  eq(blocks[2].tone, 11, 'December is tone 11')
  eq(blocks[0].items.map((i) => i.id), ['over'], 'the overdue block')
  eq(blocks.at(-1).items.map((i) => i.id), ['gone'], 'the done block')
  ok(!('tone' in blocks[0]) && !('tone' in blocks.at(-1)), 'overdue and done carry no tone')
  eq(D.monthBlocksOf([items[0], items[4]], T).map((b) => b.key), ['2026-12', '2027-01'], 'no overdue or done block when there is none')
  eq(D.monthBlocksOf([], T), [], 'an empty list has no blocks')

  const U = '2026-01-10'
  const u = (date, fields = {}) => D.urgencyOf(line({ date, ...fields }), U)
  eq(u('2026-01-09'), 'late', 'urgency at -1: late')
  eq(u('2026-01-10'), 'today', 'urgency at 0: today')
  eq(u('2026-01-11'), 'week', 'urgency at 1: week')
  eq(u('2026-01-17'), 'week', 'urgency at 7: week')
  eq(u('2026-01-18'), 'month', 'urgency at 8: month')
  eq(u('2026-02-09'), 'month', 'urgency at 30: month')
  eq(u('2026-02-10'), 'calm', 'urgency at 31: calm')
  eq(u('2026-01-09', { done: true }), 'done', 'urgency of a done line: done')
  eq(u('2026-01-05', { endDate: '2026-01-12' }), 'today', 'urgency of a running endDate line: today')
}

/* ----------------------------------------------------------- weekly, pure */

console.log('\nweeklyDue and nextWeeklyRun')
{
  const at = (y, mo, d, h = 0, mi = 0) => new Date(y, mo - 1, d, h, mi)
  // Made on a Wednesday mid-morning; runs Mondays at 07:00 by default.
  const w = D.normaliseWeekly({ since: at(2026, 1, 7, 10).toISOString() }, NOW)
  eq([w.enabled, w.weekday, w.hour], [true, 1, 7], 'defaults: on, Monday, 07:00')
  eq(D.weeklyDue(w, at(2026, 1, 7, 10, 30)), false, 'on the day it was made: not due')
  eq(D.weeklyDue(w, at(2026, 1, 8, 12)), false, 'the day after: not due (the last slot is before since)')
  eq(D.weeklyDue(w, at(2026, 1, 12, 6, 59)), false, 'one minute before the first slot: not due')
  eq(D.weeklyDue(w, at(2026, 1, 12, 7, 0)), true, 'at the first slot: due')
  eq(D.weeklyDue(w, at(2026, 1, 12, 15, 0)), true, 'later that day, not yet run: still due')
  eq(D.nextWeeklyRun(w, at(2026, 1, 8, 12)), at(2026, 1, 12, 7).toISOString(), 'nextWeeklyRun: the first Monday 07:00')
  eq(D.nextWeeklyRun(w, at(2026, 1, 12, 9)), at(2026, 1, 12, 9).toISOString(), 'nextWeeklyRun when due: now')

  const ran = { ...w, lastRunAt: at(2026, 1, 12, 7, 5).toISOString(), lastResult: 'started' }
  eq(D.weeklyDue(ran, at(2026, 1, 12, 12)), false, 'after a run: not due')
  eq(D.weeklyDue(ran, at(2026, 1, 18, 23, 59)), false, 'nor all week')
  eq(D.weeklyDue(ran, at(2026, 1, 19, 7)), true, 'due again at the next slot')
  eq(D.nextWeeklyRun(ran, at(2026, 1, 12, 12)), at(2026, 1, 19, 7).toISOString(), 'nextWeeklyRun after a run: next Monday')

  eq(D.weeklyDue({ ...w, enabled: false }, at(2026, 1, 12, 7)), false, 'disabled: never due')
  eq(D.nextWeeklyRun({ ...w, enabled: false }, at(2026, 1, 12, 7)), null, 'disabled: no next run')

  // The PC was off for three weeks: one run, not three.
  const away = at(2026, 2, 3, 10)
  eq(D.weeklyDue(ran, away), true, 'off for three weeks: due')
  const caught = { ...ran, lastRunAt: away.toISOString() }
  eq(D.weeklyDue(caught, at(2026, 2, 3, 10, 15)), false, 'and once it ran, not due again the same day')
  eq(D.weeklyDue(caught, at(2026, 2, 8, 23)), false, 'nor before the next slot')
  eq(D.weeklyDue(caught, at(2026, 2, 9, 7)), true, 'then due at the next Monday')

  // Both UK clock changes (29 Mar 2026 and 25 Oct 2026 are Sundays).
  const spring = { ...w, lastRunAt: at(2026, 3, 23, 7, 5).toISOString() }
  eq(D.weeklyDue(spring, at(2026, 3, 30, 6, 59)), false, 'Monday after the spring change, 06:59 local: not due')
  eq(D.weeklyDue(spring, at(2026, 3, 30, 7, 0)), true, 'and at 07:00 local (BST): due')
  eq(D.nextWeeklyRun(spring, at(2026, 3, 28, 12)), '2026-03-30T06:00:00.000Z', 'nextWeeklyRun across the spring change: 07:00 BST')
  const autumn = { ...w, lastRunAt: at(2026, 10, 19, 7, 5).toISOString() }
  eq(D.weeklyDue(autumn, at(2026, 10, 26, 6, 59)), false, 'Monday after the autumn change, 06:59 local: not due')
  eq(D.weeklyDue(autumn, at(2026, 10, 26, 7, 0)), true, 'and at 07:00 local (GMT): due')
  eq(D.nextWeeklyRun(autumn, at(2026, 10, 24, 12)), '2026-10-26T07:00:00.000Z', 'nextWeeklyRun across the autumn change: 07:00 GMT')
  const sunday = { ...w, weekday: 0, lastRunAt: at(2026, 3, 22, 7, 5).toISOString() }
  eq(D.weeklyDue(sunday, at(2026, 3, 29, 6, 59)), false, 'a Sunday slot on the spring change day: not due at 06:59')
  eq(D.weeklyDue(sunday, at(2026, 3, 29, 7, 0)), true, 'and due at 07:00')
  const sundayAutumn = { ...w, weekday: 0, lastRunAt: at(2026, 10, 18, 7, 5).toISOString() }
  eq(D.weeklyDue(sundayAutumn, at(2026, 10, 25, 6, 59)), false, 'a Sunday slot on the autumn change day: not due at 06:59')
  eq(D.weeklyDue(sundayAutumn, at(2026, 10, 25, 7, 0)), true, 'and due at 07:00')

  const bad = D.normaliseWeekly({ enabled: 'yes', weekday: 9, hour: -1, since: 'soon', lastResult: 'odd', lastError: 'x' }, NOW)
  eq(bad, { enabled: true, weekday: 1, hour: 7, since: NOW.toISOString() }, 'bad values get the defaults, since is now')
  eq(D.normaliseWeekly(undefined, NOW), { enabled: true, weekday: 1, hour: 7, since: NOW.toISOString() }, 'no block at all: the defaults')
  ok(D.weeklyPatchError({ hour: 24 }) && D.weeklyPatchError({ weekday: 'mon' }) && D.weeklyPatchError({ enabled: 1 }), 'weeklyPatchError refuses a bad hour, day or switch')
  eq(D.weeklyPatchError({ enabled: false, weekday: 0, hour: 23 }), null, 'and takes good ones')

  const prompt = D.weeklyPrompt(null, '2026-01-12', 4)
  ok(prompt.startsWith(D.DEFAULT_WEEKLY_PROMPT) && prompt.endsWith(D.WEEKLY_HARD_RULES), 'weeklyPrompt: default first, hard rules last')
  ok(prompt.includes('Mon 12 Jan 2026 (2026-01-12)') && prompt.includes('4 open lines'), 'with today and the open count', prompt)
  ok(
    ['dates_list', 'include_done', '14 days', 'estimated', 'added', 'changed', 'could not check'].every((s) => D.DEFAULT_WEEKLY_PROMPT.includes(s)),
    'DEFAULT_WEEKLY_PROMPT: list first, 14 days of mail, estimated dates, the report'
  )
  ok(
    /never delete a line/i.test(D.WEEKLY_HARD_RULES) &&
      /mark a line done/i.test(D.WEEKLY_HARD_RULES) &&
      ['send', 'reply', 'delete', 'archive', 'pay', 'book', 'submit'].every((s) => D.WEEKLY_HARD_RULES.includes(s)),
    'WEEKLY_HARD_RULES: no delete, done only on proof, read only'
  )
  ok(D.weeklyPrompt('   \n ', '2026-01-12', 1).startsWith(D.DEFAULT_WEEKLY_PROMPT), 'a blank custom prompt: the default')
  ok(D.weeklyPrompt('Check the example inbox.', '2026-01-12', 1).startsWith('Check the example inbox.\n'), 'a custom prompt replaces the default')
}

/* ------------------------------------------------------------ applyPatch */

console.log('\napplyPatch')
{
  const item = { ...line({ date: '2026-03-01' }), alerted: ['2026-03-01:30', '2026-03-01:7', '2026-04-01:30'] }
  const moved = D.applyPatch(item, { date: '2026-04-01' }, NOW)
  eq(moved.date, '2026-04-01', 'a new date is set')
  eq(moved.alerted, ['2026-04-01:30'], 'a new date drops the keys of the old date')
  eq(D.applyPatch(item, { note: 'Call the landlord' }, NOW).alerted, item.alerted, 'other fields keep the keys')
  throws(() => D.applyPatch(item, { date: '2026-13-01' }, NOW), 'a bad date throws')
  throws(() => D.applyPatch(item, { title: '' }, NOW), 'an empty title throws')
  throws(() => D.applyPatch(item, { endDate: '2026-02-01' }, NOW), 'an endDate before the date throws')
  ok(!('endDate' in D.applyPatch({ ...item, endDate: '2026-03-05' }, { endDate: null }, NOW)), 'endDate null clears it')
  eq(D.applyPatch(item, { kind: 'nonsense' }, NOW).kind, 'other', 'an unknown kind becomes other')
  const reopened = D.applyPatch({ ...item, done: true, doneAt: NOW.toISOString() }, { done: false }, NOW)
  ok(!reopened.done && !('doneAt' in reopened), 'done false reopens and clears doneAt')
}

/* ---------------------------------------------------------- completeItem */

console.log('\ncompleteItem')
{
  const at = new Date(2026, 0, 31, 12, 0)
  const once = D.completeItem(line({ date: '2026-01-31' }), at)
  ok(once.done === true && once.doneAt === at.toISOString(), 'repeat none: done, with doneAt')
  const monthly = D.completeItem(
    { ...line({ date: '2026-01-31', repeat: 'monthly' }), alerted: ['2026-01-31:0'], snoozedUntil: '2026-01-30' },
    at
  )
  eq(monthly.date, '2026-02-28', 'monthly on the 31st: the next month has no 31st, so its last day')
  ok(monthly.done === false && monthly.alerted.length === 0 && !('snoozedUntil' in monthly), 'monthly: stays open, alerts and snooze cleared')
  eq(D.completeItem(line({ date: '2026-01-31', repeat: 'monthly' }), new Date(2026, 2, 15, 12)).date, '2026-03-31', 'monthly done late: the next one after today')
  const leap = D.completeItem(line({ date: '2028-02-29', repeat: 'yearly' }), new Date(2028, 1, 29, 12))
  eq(leap.date, '2029-02-28', 'yearly on 29 Feb: 28 Feb the next year')
  eq(D.completeItem(line({ date: '2026-11-30', repeat: 'quarterly' }), new Date(2026, 10, 30, 12)).date, '2027-02-28', 'quarterly from 30 Nov: 28 Feb in a common year')
  eq(D.completeItem(line({ date: '2027-11-30', repeat: 'quarterly' }), new Date(2027, 10, 30, 12)).date, '2028-02-29', 'quarterly from 30 Nov: 29 Feb in a leap year')
  const lateQ = D.completeItem({ ...line({ date: '2026-01-15', repeat: 'quarterly' }), alerted: ['2026-01-15:0'], snoozedUntil: '2026-01-10' }, new Date(2026, 10, 20, 12))
  eq(lateQ.date, '2027-01-15', 'quarterly several periods overdue: the first occurrence after today, not just +3 months')
  ok(lateQ.done === false && lateQ.alerted.length === 0 && !('snoozedUntil' in lateQ), 'quarterly: stays open, alerts and snooze cleared')
  eq(D.completeItem(line({ date: '2026-08-01', endDate: '2026-08-08', repeat: 'yearly' }), new Date(2026, 7, 9)).endDate, '2027-08-08', 'a repeating endDate moves with it')
}

/* ------------------------------------------------- alertText, agentPrompt */

console.log('\nalertText and agentPrompt')
{
  const item = line({ date: '2026-01-17', group: 'Main shop', amount: '250 a month', action: 'Give notice in writing', note: 'Three months notice' })
  const words = D.alertText(item, '2026-01-10')
  ok(words.title.includes('Shop lease ends'), 'alertText title has the line title', words.title)
  ok(`${words.title} ${words.body}`.includes('7 days'), 'alertText has the day count', `${words.title} / ${words.body}`)
  const prompt = D.agentPrompt(item, '2026-01-10')
  ok(prompt.includes('Shop lease ends'), 'agentPrompt has the title')
  ok(prompt.includes('7 days left'), 'agentPrompt has the day count')
  ok(['Main shop', '250 a month', 'Give notice in writing', 'Three months notice', 'Kind: Other'].every((s) => prompt.includes(s)), 'agentPrompt has group, amount, action, note and kind')
  ok(/ask Steve before/i.test(prompt) && /pay/i.test(prompt) && /form/i.test(prompt) && /message/i.test(prompt), 'agentPrompt asks before messages, payments and forms')
  ok(/recommendation/i.test(prompt) && /research/i.test(prompt), 'agentPrompt asks for research and a recommendation')
}

/* ----------------------------------------------------------------- store */

console.log('\nstore')
const tmp = mkdtempSync(join(tmpdir(), 'forge-dates-check-'))
try {
  let clock = new Date(2026, 0, 10, 12, 0)
  const dir1 = join(tmp, 'round')
  const svc = S.createDatesService({ dir: dir1, now: () => clock })
  let changes = 0
  let lastChange = null
  const offChange = svc.onChange((items) => {
    changes++
    lastChange = items
  })
  const alerts = []
  svc.onAlert((a) => alerts.push(a))

  eq(svc.list(), [], 'a missing file is an empty list')
  const a = svc.add({ title: 'Domain expires', date: '2026-01-11', kind: 'domain' })
  const b = svc.add({ title: 'Boiler service due', date: '2026-06-01', repeat: 'yearly', amount: '90' }, 'agent')
  eq([a.source, b.source], ['steve', 'agent'], 'add sets the source')
  ok(a.id !== b.id, 'add makes distinct ids')
  ok(existsSync(join(dir1, 'dates.json')), 'add writes dates.json')
  ok(!existsSync(join(dir1, 'dates.json.tmp')), 'no temp file is left behind')
  eq(changes, 2, 'onChange fires on every add')
  eq(lastChange?.length, 2, 'onChange gets the whole list')
  throws(() => svc.add({ title: '', date: '2026-01-01' }), 'add without a title throws')
  throws(() => svc.add({ title: 'A', date: 'soon' }), 'add with a bad date throws')
  throws(() => svc.add({ title: 'A', date: '2026-01-05', endDate: '2026-01-01' }), 'add with endDate before date throws')

  eq(svc.update(a.id, { note: 'Renew with the registrar' })?.note, 'Renew with the registrar', 'update changes a field')
  eq(svc.update('nope', { note: 'x' }), null, 'update of an unknown id is null')
  eq(svc.complete(b.id)?.date, '2027-06-01', 'complete moves a yearly line on')
  eq(svc.snooze(a.id, '2026-01-11')?.snoozedUntil, '2026-01-11', 'snooze sets snoozedUntil')
  throws(() => svc.snooze(a.id, 'tomorrow'), 'snooze to a bad day throws')
  const c = svc.add({ title: 'Temporary', date: '2026-02-01' })
  ok(svc.remove(c.id) === true && svc.remove(c.id) === false, 'remove answers true once, then false')

  const reloaded = S.createDatesService({ dir: dir1, now: () => clock })
  eq(reloaded.list(), svc.list(), 'a reload reads back exactly the same list')
  const onDisk = JSON.parse(readFileSync(join(dir1, 'dates.json'), 'utf8'))
  ok(onDisk.version === 1 && Array.isArray(onDisk.items), 'the file is { version: 1, items }')

  // The alert pass: hours, force, once a day.
  svc.update(a.id, { snoozedUntil: null })
  const before = changes
  eq(svc.checkNow(new Date(2026, 0, 10, 3, 0)).length, 0, 'checkNow at 03:00 fires nothing')
  eq(changes, before, 'and changes nothing')
  eq(svc.checkNow(new Date(2026, 0, 10, 21, 0)).length, 0, 'checkNow at 21:00 fires nothing')
  const forced = svc.checkNow(new Date(2026, 0, 10, 3, 0), { force: true })
  eq(forced.map((x) => x.item.title), ['Domain expires'], 'checkNow at 03:00 with force fires the due line')
  eq(alerts.length, 1, 'onAlert fires')
  ok(alerts[0].daysLeft === 1 && alerts[0].title.includes('Domain expires') && typeof alerts[0].body === 'string', 'the alert carries days left and words')
  eq(svc.checkNow(new Date(2026, 0, 10, 14, 0)).length, 0, 'a second checkNow the same day fires nothing')
  eq(alerts.length, 1, 'and no more alerts are heard')
  const afterAlert = S.createDatesService({ dir: dir1, now: () => clock })
  eq(afterAlert.checkNow(new Date(2026, 0, 10, 14, 0)).length, 0, 'the alerted keys survive a reload')
  eq(svc.checkNow(new Date(2026, 0, 11, 9, 0)).length, 1, 'the next day, the day-itself alert fires inside the hours')
  offChange()
  const n = changes
  svc.update(a.id, { note: 'again' })
  eq(changes, n, 'onChange unsubscribe works')

  // A hand-written file with missing fields.
  const dir2 = join(tmp, 'hand')
  rmSync(dir2, { recursive: true, force: true })
  mkdirSync(dir2, { recursive: true })
  writeFileSync(
    join(dir2, 'dates.json'),
    JSON.stringify({
      items: [
        { title: 'Car tax due', date: '2026-04-01' },
        { title: 'No date at all' },
        { title: 'Same id', date: '2026-05-01', id: 'dup' },
        { title: 'Same id again', date: '2026-05-02', id: 'dup', kind: 'whatever', wibble: 1 }
      ]
    }),
    'utf8'
  )
  const origWarn = console.warn
  const warnings = []
  console.warn = (...args) => warnings.push(args.join(' '))
  const hand = S.createDatesService({ dir: dir2, now: () => clock })
  console.warn = origWarn
  const handItems = hand.list()
  eq(handItems.map((i) => i.title), ['Car tax due', 'Same id', 'Same id again'], 'good lines load, a line with no date is dropped')
  eq(warnings.length, 1, 'one log line for the dropped line')
  ok(handItems.every((i) => i.id && i.remindDays.length === 4 && i.kind && i.createdAt), 'missing fields get defaults')
  eq(new Set(handItems.map((i) => i.id)).size, 3, 'a duplicate id gets a new one')
  ok(!('wibble' in handItems[2]) && handItems[2].kind === 'other', 'unknown fields dropped, unknown kind is other')

  // Broken JSON: moved aside, empty list, never throws.
  const dir3 = join(tmp, 'broken')
  mkdirSync(dir3, { recursive: true })
  writeFileSync(join(dir3, 'dates.json'), '{ "items": [ { "title": "half', 'utf8')
  const origErr = console.error
  console.error = () => {}
  let broken = null
  try {
    broken = S.createDatesService({ dir: dir3, now: () => clock })
  } catch {
    broken = null
  }
  console.error = origErr
  ok(broken !== null, 'a broken file never throws')
  eq(broken?.list(), [], 'a broken file starts an empty list')
  const bad = readdirSync(dir3).filter((f) => f.startsWith('dates.json.bad-'))
  eq(bad.length, 1, 'the broken file is left on disk as dates.json.bad-<timestamp>')
  ok(bad.length === 1 && readFileSync(join(dir3, bad[0]), 'utf8').includes('"half'), 'with its contents untouched')

  // Batching: 1 or 2 alerts in a pass are heard one by one; 3 or more as one summary.
  const dir4 = join(tmp, 'batch')
  const batch = S.createDatesService({ dir: dir4, now: () => clock })
  const heard = []
  batch.onAlert((x) => heard.push(x))
  const at9 = new Date(2026, 0, 10, 9, 0)
  batch.add({ title: 'Van tax due', date: '2026-01-12' })
  batch.add({ title: 'Phone plan ends', date: '2026-01-14' })
  eq(batch.checkNow(at9).length, 2, 'a pass with 2 alerts fires 2')
  ok(heard.length === 2 && heard.every((x) => !x.summary && !('items' in x)), '2 alerts: 2 calls, neither a summary', JSON.stringify(heard.map((x) => x.title)))
  heard.length = 0
  const three = [
    batch.add({ title: 'Shop insurance renews', date: '2026-01-20' }),
    batch.add({ title: 'Web domain expires', date: '2026-01-11' }),
    batch.add({ title: 'Boiler cover ends', date: '2026-01-25' })
  ]
  const fired3 = batch.checkNow(at9)
  eq(fired3.length, 3, 'a pass with 3 alerts still returns one per line')
  eq(heard.length, 1, '3 alerts: 1 call')
  const sum = heard[0]
  ok(sum?.summary === true && sum.items?.length === 3, 'the call is a summary carrying the three lines', JSON.stringify(sum))
  eq(sum?.title, '3 dates are coming up', 'summary title')
  eq(
    sum?.body,
    'Web domain expires: tomorrow\nShop insurance renews: in 10 days\nBoiler cover ends: in 15 days',
    'summary body names the three lines, soonest first'
  )
  eq(sum?.item.id, three[1].id, "the summary's item is the soonest line")
  ok(three.every((t) => D.dueAlert(batch.list().find((i) => i.id === t.id), D.todayOf(at9)) === null), 'all three are marked')
  heard.length = 0
  for (const t of ['Lease break notice', 'Card expires', 'Licence renews', 'Holiday deposit', 'Tax form due']) {
    batch.add({ title: t, date: '2026-01-13' })
  }
  batch.checkNow(at9)
  ok(heard.length === 1 && heard[0].title === '5 dates are coming up', '5 alerts: one summary', JSON.stringify(heard.map((x) => x.title)))
  ok(heard[0]?.body.split('\n').length === 4 && heard[0].body.endsWith('\nand 2 more'), 'naming three, then "and 2 more"', heard[0]?.body)
  eq(D.dateNoticeOf(heard[0]), { title: heard[0].title, body: heard[0].body, summary: true }, 'dateNoticeOf a summary: no id')
  eq(D.dateNoticeOf(fired3[0]), { id: fired3[0].item.id, title: fired3[0].title, body: fired3[0].body }, 'dateNoticeOf one alert: its id')

  // The weekly block on disk.
  const dir5 = join(tmp, 'weekly')
  mkdirSync(dir5, { recursive: true })
  writeFileSync(join(dir5, 'dates.json'), JSON.stringify({ version: 1, items: [{ title: 'Car tax due', date: '2026-04-01' }] }), 'utf8')
  let wClock = new Date(2026, 0, 7, 10, 0)
  const wsvc = S.createDatesService({ dir: dir5, now: () => wClock })
  const wv = wsvc.getWeekly()
  eq([wv.enabled, wv.weekday, wv.hour, wv.since], [true, 1, 7, wClock.toISOString()], 'a file without weekly: the defaults, since = now')
  eq(wv.nextRunAt, new Date(2026, 0, 12, 7).toISOString(), 'with nextRunAt')
  const wDisk = JSON.parse(readFileSync(join(dir5, 'dates.json'), 'utf8'))
  ok(wDisk.version === 1 && wDisk.weekly?.since === wClock.toISOString() && wDisk.items.length === 1, 'the block is saved at once, version stays 1')
  wClock = new Date(2026, 0, 9, 10, 0)
  eq(S.createDatesService({ dir: dir5, now: () => wClock }).getWeekly().since, new Date(2026, 0, 7, 10, 0).toISOString(), 'since holds across a reload')
  const wHeard = []
  wsvc.onWeekly((x) => wHeard.push(x))
  eq([wsvc.setWeekly({ weekday: 3, hour: 9 }).weekday, wsvc.getWeekly().hour], [3, 9], 'setWeekly changes the day and hour')
  eq(wHeard.length, 1, 'onWeekly hears the change')
  ok(typeof wHeard[0]?.nextRunAt === 'string', 'with nextRunAt')
  throws(() => wsvc.setWeekly({ hour: 24 }), 'setWeekly refuses hour 24')
  throws(() => wsvc.setWeekly({ weekday: 7 }), 'setWeekly refuses day 7')
  throws(() => wsvc.setWeekly({ enabled: 'no' }), 'setWeekly refuses a switch that is not true or false')
  eq(wHeard.length, 1, 'a refused change tells nobody')
  const failedRun = wsvc.markWeeklyRun('failed', 'No agent answered')
  ok(failedRun.lastResult === 'failed' && failedRun.lastError === 'No agent answered' && failedRun.lastRunAt === wClock.toISOString(), 'markWeeklyRun failed: result, error, time')
  const okRun = wsvc.markWeeklyRun('started')
  ok(okRun.lastResult === 'started' && !('lastError' in okRun), 'markWeeklyRun started clears the error')
  eq(S.createDatesService({ dir: dir5, now: () => wClock }).getWeekly().weekday, 3, 'the weekly block survives a reload')

  const dir6 = join(tmp, 'weekly-bad')
  mkdirSync(dir6, { recursive: true })
  writeFileSync(join(dir6, 'dates.json'), JSON.stringify({ version: 1, items: [], weekly: { enabled: 'on', weekday: 12, hour: 'seven' } }), 'utf8')
  let badSvc = null
  try {
    badSvc = S.createDatesService({ dir: dir6, now: () => wClock })
  } catch {
    badSvc = null
  }
  ok(badSvc !== null, 'bad weekly values never throw')
  eq([badSvc?.getWeekly().enabled, badSvc?.getWeekly().weekday, badSvc?.getWeekly().hour], [true, 1, 7], 'and get the defaults')
  const dir7 = join(tmp, 'weekly-array')
  mkdirSync(dir7, { recursive: true })
  writeFileSync(join(dir7, 'dates.json'), JSON.stringify([{ title: 'Old shape', date: '2026-04-01' }]), 'utf8')
  eq(S.createDatesService({ dir: dir7, now: () => wClock }).getWeekly().weekday, 1, 'an old bare-list file gets the defaults too')

  /* ------------------------------------------------------- the weekly run */

  console.log('\nrunWeeklyCheck')
  const dir8 = join(tmp, 'weekly-run')
  const rsvc = S.createDatesService({ dir: dir8, now: () => wClock })
  rsvc.add({ title: 'Shop lease ends', date: '2027-03-01' })
  rsvc.complete(rsvc.add({ title: 'Old form', date: '2026-01-01' }).id)
  globalThis.__datesAsks = []
  globalThis.__datesWin = { webContents: { isLoading: () => false } }
  globalThis.__datesReply = 'OK: opened the pane'
  const today = D.todayOf(new Date())
  const r1 = await I.runWeeklyCheck({ dates: rsvc })
  const ask1 = globalThis.__datesAsks[0]
  ok(r1.ok === true && globalThis.__datesAsks.length === 1, 'with a window, it opens one pane', JSON.stringify(r1))
  ok(
    ask1?.name === 'open_agent_pane' && ask1.args.name === 'Weekly dates check' && ask1.args.submit === true && ask1.args.agent === 'claude',
    'by the open_agent_pane route, named "Weekly dates check", submitted',
    JSON.stringify(ask1?.args && { ...ask1.args, prompt: '…' })
  )
  const p1 = ask1?.args.prompt ?? ''
  ok(p1.startsWith(D.DEFAULT_WEEKLY_PROMPT), 'no prompt file: the default prompt')
  ok(p1.includes(`(${today})`) && p1.includes('1 open line.'), 'then today and the number of open lines', p1.slice(D.DEFAULT_WEEKLY_PROMPT.length, D.DEFAULT_WEEKLY_PROMPT.length + 120))
  ok(p1.endsWith(D.WEEKLY_HARD_RULES), 'hard rules last')
  ok(rsvc.getWeekly().lastResult === 'started' && rsvc.getWeekly().lastRunAt === wClock.toISOString(), 'recorded as started')

  writeFileSync(join(dir8, 'dates-weekly-prompt.md'), 'Check the example mailbox for renewals.\n', 'utf8')
  await I.runWeeklyCheck({ dates: rsvc })
  const p2 = globalThis.__datesAsks[1]?.args.prompt ?? ''
  ok(p2.startsWith('Check the example mailbox for renewals.\n') && !p2.includes(D.DEFAULT_WEEKLY_PROMPT), 'a prompt file replaces the default')
  ok(p2.endsWith(D.WEEKLY_HARD_RULES), 'and the hard rules are still last')
  writeFileSync(join(dir8, 'dates-weekly-prompt.md'), '  \n\n', 'utf8')
  await I.runWeeklyCheck({ dates: rsvc })
  ok((globalThis.__datesAsks[2]?.args.prompt ?? '').startsWith(D.DEFAULT_WEEKLY_PROMPT), 'an empty prompt file: the default')

  const asksBefore = globalThis.__datesAsks.length
  const lastBefore = rsvc.getWeekly().lastRunAt
  wClock = new Date(2026, 0, 19, 7, 30)
  globalThis.__datesWin = null
  const r3 = await I.runWeeklyCheck({ dates: rsvc })
  ok(r3.ok === false && /not ready/.test(r3.error), 'no window: not ok, with the reason', JSON.stringify(r3))
  ok(rsvc.getWeekly().lastRunAt === lastBefore && rsvc.getWeekly().lastResult === 'started', 'and lastRunAt is unchanged, so the next tick tries again')
  globalThis.__datesWin = { webContents: { isLoading: () => true } }
  await I.runWeeklyCheck({ dates: rsvc })
  ok(globalThis.__datesAsks.length === asksBefore && rsvc.getWeekly().lastRunAt === lastBefore, 'a window still loading: the same, and no pane asked for')

  globalThis.__datesWin = { webContents: { isLoading: () => false } }
  globalThis.__datesReply = 'FAILED: there is no agent called claude'
  const r4 = await I.runWeeklyCheck({ dates: rsvc })
  const w4 = rsvc.getWeekly()
  ok(
    r4.ok === false && w4.lastResult === 'failed' && w4.lastError?.includes('no agent called') && w4.lastRunAt === wClock.toISOString(),
    'the opener fails: recorded as failed, with its sentence',
    JSON.stringify(w4)
  )
  ok(!D.weeklyDue(w4, new Date(2026, 0, 19, 12)), 'so the next try is next week')
  globalThis.__datesReply = new Error('The renderer went away')
  const r5 = await I.runWeeklyCheck({ dates: rsvc })
  ok(r5.ok === false && rsvc.getWeekly().lastError === 'The renderer went away', 'the opener throws: recorded as failed too')
} finally {

  rmSync(tmp, { recursive: true, force: true })
}

liveDirTouched = globalThis.__datesLiveDirTouched === true
ok(!liveDirTouched, 'no check reached the live data dir (electron/store.ts was stubbed and never asked)')

/* -------------------------------------------------------------- summary */

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} passed, ${fail} failed\n`)
process.exit(fail === 0 ? 0 : 1)
