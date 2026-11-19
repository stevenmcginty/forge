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
 *    listeners, and the alert pass's hours.
 *
 * The live data dir is never touched. electron/store.ts (the only route to
 * %APPDATA%\Forge) is swapped for a stub whose getDataDir throws, so a check
 * that reached for the live list would fail loudly instead of reading it.
 * All examples are made up.
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

registerHooks({
  resolve(spec, context, next) {
    if (spec === './store' && context.parentURL?.endsWith('/electron/dates-store.ts')) {
      return { url: STORE_STUB, shortCircuit: true }
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
  eq(D.dueAlert(line({ date: '2026-03-01', remindDays: [] }), '2026-03-01'), null, 'no thresholds: no alert before the day')
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
} finally {
  rmSync(tmp, { recursive: true, force: true })
}

liveDirTouched = globalThis.__datesLiveDirTouched === true
ok(!liveDirTouched, 'no check reached the live data dir (electron/store.ts was stubbed and never asked)')

/* -------------------------------------------------------------- summary */

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} passed, ${fail} failed\n`)
process.exit(fail === 0 ? 0 : 1)
