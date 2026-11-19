/**
 * Dates on the phone (Forge Web), held to docs/DATES.md ("Phone").
 *
 *   node scripts/dates-web-check.mjs      (npm run dates-web:check)
 *
 * Four parts, each against a fresh temp-folder Dates service from
 * `createDatesService`:
 *
 * 1. THE REQUESTS. The real electron/web/server.ts and electron/web/auth.ts,
 *    bundled with esbuild and driven over a real WebSocket the way
 *    scripts/web-project-remove-check.mjs does, with Google stubbed the same
 *    way: `dates`, `dates-add`, `dates-update` and `dates-agent` through the
 *    real request handler; a socket that has not been let in is refused a
 *    write as it is refused everything else; a host with no Dates answers
 *    `unsupported`.
 * 2. THE FRAME. Each change, from a phone or from the desk, reaches every
 *    admitted browser as exactly one `dates` frame carrying the new list and
 *    the weekly check's state; `dates-weekly` runs or changes that check; each
 *    alert also reaches every browser as a `date-alert` frame.
 * 3. THE PUSH. An alert from the service becomes one `date` payload
 *    (electron/web/dates-link.ts), and `planPush` (electron/web/push.ts) sends
 *    it to every subscription even where the same "who is looking" and flap
 *    guard hold an attention push back. Three or more in one pass become one
 *    summary payload with no id.
 * 4. THE WORKER. web/public/sw.js, run over a fake `self`: a `date` push shows
 *    the alert's words under a per-line tag (`date:summary` for a summary), and
 *    its tap opens Dates — a message to an open tab, `/?dates=1` when there is
 *    none.
 *
 * The live data dir is never touched: every `./store` import in the bundle is
 * a stub whose getDataDir throws. All examples are made up.
 */
import { createSign, generateKeyPairSync } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { builtinModules } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import { WebSocket } from 'ws'

const ROOT = resolve(import.meta.dirname, '..')
const scratch = mkdtempSync(join(tmpdir(), 'forge-dates-web-'))
const datesDir = join(scratch, 'dates')
process.on('exit', () => {
  try {
    rmSync(scratch, { recursive: true, force: true })
  } catch {
    /* already gone */
  }
})

const PORT = 8547
const BARE_PORT = 8548
const PROJECT = 'forge-dates-web'
const UID = 'DatesWebCheckUid0000000000001'
const KID = 'dates-web-kid-1'
const ORIGIN = 'https://forge-web.web.app'
/** Midday on a made-up day, inside the alert pass's hours. */
const NOW = new Date(2026, 0, 10, 12, 0, 0)

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
const section = (name) => console.log(`\n${name}`)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function waitFor(predicate, timeoutMs, label) {
  return new Promise((resolvePromise, reject) => {
    const started = Date.now()
    const tick = () => {
      if (predicate()) return resolvePromise()
      if (Date.now() - started > timeoutMs) return reject(new Error(`timed out waiting for ${label}`))
      setTimeout(tick, 20)
    }
    tick()
  })
}

/* ------------------------------------------- Google, as web-smoke stubs it */

const b64url = (value) => Buffer.from(value).toString('base64url')
function derLength(n) {
  if (n < 0x80) return Buffer.from([n])
  const bytes = []
  let value = n
  while (value > 0) {
    bytes.unshift(value & 0xff)
    value = Math.floor(value / 256)
  }
  return Buffer.from([0x80 | bytes.length, ...bytes])
}
const tlv = (tag, body) => Buffer.concat([Buffer.from([tag]), derLength(body.length), body])
const seq = (...parts) => tlv(0x30, Buffer.concat(parts))
const set = (...parts) => tlv(0x31, Buffer.concat(parts))
const SHA256_RSA = Buffer.from('300d06092a864886f70d01010b0500', 'hex')
const OID_CN = Buffer.from('0603550403', 'hex')
function utcTime(date) {
  const pad = (n) => String(n).padStart(2, '0')
  const text =
    `${pad(date.getUTCFullYear() % 100)}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}` +
    `${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}Z`
  return tlv(0x17, Buffer.from(text, 'ascii'))
}
function certificateFor(pair, commonName) {
  const name = seq(set(seq(OID_CN, tlv(0x13, Buffer.from(commonName, 'ascii')))))
  const now = Date.now()
  const tbs = seq(
    tlv(0x02, Buffer.from([0x01])),
    SHA256_RSA,
    name,
    seq(utcTime(new Date(now - 86_400_000)), utcTime(new Date(now + 86_400_000))),
    name,
    pair.publicKey.export({ type: 'spki', format: 'der' })
  )
  const signature = createSign('RSA-SHA256').update(tbs).sign(pair.privateKey)
  const der = seq(tbs, SHA256_RSA, tlv(0x03, Buffer.concat([Buffer.from([0x00]), signature])))
  const body = der.toString('base64').replace(/(.{64})/g, '$1\n')
  return `-----BEGIN CERTIFICATE-----\n${body}\n-----END CERTIFICATE-----\n`
}

/* ------------------------------------------------------------- the bundle */

/**
 * Packages stay outside the bundle and are imported by absolute URL, so the
 * bundle can live in a temp folder; `@shared/*` is the repo's folder; every
 * `./store` or `../store` (electron/store.ts, the route to the live data dir)
 * is a stub that throws.
 */
const resolvePlugin = {
  name: 'dates-web-check',
  setup(b) {
    b.onResolve({ filter: /^\.\.?\/store$/ }, () => ({ path: 'store', namespace: 'stub' }))
    b.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({
      loader: 'js',
      contents:
        "export function getDataDir(){throw new Error('dates-web-check must never touch the live data dir')}\n" +
        "export function getSettings(){return { webEmail: '' }}\n"
    }))
    b.onResolve({ filter: /^@shared\// }, (args) => ({ path: join(ROOT, 'shared', `${args.path.slice(8)}.ts`) }))
    b.onResolve({ filter: /^[^./]/ }, (args) => {
      if (args.path.startsWith('node:') || builtinModules.includes(args.path)) return { path: args.path, external: true }
      return { path: import.meta.resolve(args.path), external: true }
    })
  }
}

async function load() {
  const outfile = join(scratch, 'dates-web.mjs')
  await build({
    stdin: {
      contents: [
        "export { WebServer } from './electron/web/server'",
        "export { WebAuth } from './electron/web/auth'",
        "export { createDatesService } from './electron/dates-store'",
        "export { linkDateAlerts } from './electron/web/dates-link'",
        "export { planPush } from './electron/web/push'",
        "export { alertText, todayOf } from './shared/dates'",
        "export { WEB_PROTO, WEB_SUBPROTOCOL, WEB_WS_PATH } from './shared/web'"
      ].join('\n'),
      resolveDir: ROOT,
      sourcefile: 'dates-web-entry.ts',
      loader: 'ts'
    },
    outfile,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    plugins: [resolvePlugin],
    logLevel: 'silent',
    absWorkingDir: ROOT
  })
  return import(pathToFileURL(outfile).href)
}

/* ------------------------------------------------------------------- main */

async function main() {
  const M = await load()
  const { WebServer, WebAuth, WEB_PROTO, WEB_SUBPROTOCOL, WEB_WS_PATH } = M

  const google = generateKeyPairSync('rsa', { modulusLength: 2048 })
  const served = { [KID]: certificateFor(google, 'securetoken.google.com') }
  const nowSec = () => Math.floor(Date.now() / 1000)
  function mint() {
    const header = b64url(JSON.stringify({ alg: 'RS256', kid: KID, typ: 'JWT' }))
    const payload = b64url(
      JSON.stringify({
        aud: PROJECT,
        iss: `https://securetoken.google.com/${PROJECT}`,
        sub: UID,
        auth_time: nowSec() - 300,
        iat: nowSec() - 60,
        exp: nowSec() + 3600
      })
    )
    const signature = createSign('RSA-SHA256').update(`${header}.${payload}`).sign(google.privateKey)
    return `${header}.${payload}.${signature.toString('base64url')}`
  }

  /* ------------------------------------------------------- the desktop */

  const dates = M.createDatesService({ dir: datesDir, now: () => NOW })
  /** Every id `datesAgent` was asked for. */
  const agentAsks = []
  const datesAgent = async (id) => {
    agentAsks.push(id)
    return dates.list().some((i) => i.id === id) ? { ok: true } : { ok: false, error: 'There is no date with that id.' }
  }
  const makeAuth = () =>
    new WebAuth({
      fetchJwks: async () => ({ body: JSON.stringify(served), cacheControl: 'public, max-age=21600' }),
      projectId: () => PROJECT,
      uid: () => UID
    })
  const baseHost = {
    appVersion: '0.0.0-dates',
    desktopName: () => 'DATES-PC',
    allowedOrigins: () => [ORIGIN],
    sessions: () => [],
    replay: () => '',
    write: () => true,
    resize: () => false,
    snapshot: () => ({ projects: [], profiles: [], workspaces: {} }),
    layout: async () => null,
    log: () => {}
  }
  /** The service as the server sees it, counting the change subscriptions it holds. */
  let watching = 0
  let alertWatching = 0
  let weeklyWatching = 0
  /** How many times the server asked for a weekly run, and whether the next one fails. */
  let weeklyRuns = 0
  let weeklyRunFails = false
  const hostDates = {
    list: () => dates.list(),
    add: (input, source) => dates.add(input, source),
    update: (id, patch) => dates.update(id, patch),
    complete: (id) => dates.complete(id),
    snooze: (id, until) => dates.snooze(id, until),
    remove: (id) => dates.remove(id),
    onAlert: (cb) => {
      alertWatching++
      const off = dates.onAlert(cb)
      return () => {
        alertWatching--
        off()
      }
    },
    onChange: (cb) => {
      watching++
      const off = dates.onChange(cb)
      return () => {
        watching--
        off()
      }
    }
  }
  /** The weekly check as web-host.ts wires it, with runWeeklyCheck stood in for: it records `started`, as the real one does. */
  const datesWeekly = {
    get: () => dates.getWeekly(),
    set: (patch) => dates.setWeekly(patch),
    run: async () => {
      weeklyRuns++
      if (weeklyRunFails) return { ok: false, error: 'The Forge window on the desktop is not ready.' }
      dates.markWeeklyRun('started')
      return { ok: true }
    },
    onChange: (cb) => {
      weeklyWatching++
      const off = dates.onWeekly(cb)
      return () => {
        weeklyWatching--
        off()
      }
    }
  }
  const server = new WebServer({ ...baseHost, auth: makeAuth(), dates: hostDates, datesAgent, datesWeekly })
  await server.start({ host: '127.0.0.1', port: PORT })
  // An older-shaped desktop: no Dates at all.
  const bare = new WebServer({ ...baseHost, auth: makeAuth() })
  await bare.start({ host: '127.0.0.1', port: BARE_PORT })

  const open = []
  function connect(port) {
    const socket = new WebSocket(`ws://127.0.0.1:${port}${WEB_WS_PATH}`, [WEB_SUBPROTOCOL], { origin: ORIGIN })
    const browser = {
      socket,
      frames: [],
      closed: false,
      send: (frame) => socket.send(JSON.stringify(frame)),
      first: (type) => browser.frames.find((f) => f.type === type),
      datesFrames: () => browser.frames.filter((f) => f.type === 'dates'),
      alertFrames: () => browser.frames.filter((f) => f.type === 'date-alert')
    }
    open.push(browser)
    socket.on('message', (raw) => browser.frames.push(JSON.parse(String(raw))))
    socket.on('close', () => {
      browser.closed = true
    })
    return new Promise((resolvePromise, reject) => {
      socket.on('open', () => resolvePromise(browser))
      socket.on('error', reject)
    })
  }
  async function hello(port, deviceId) {
    const browser = await connect(port)
    browser.send({ type: 'hello', proto: WEB_PROTO, idToken: mint(), client: 'dates-web-check', deviceId, deviceName: 'Pixel' })
    await waitFor(() => browser.first('hello-ok') || browser.first('refused'), 5000, 'an answer to hello')
    return { browser, frame: browser.first('hello-ok') ?? browser.first('refused') }
  }
  let rid = 0
  async function request(browser, body) {
    // Held under MAX_INPUT_PER_SECOND, as scripts/web-io-check.mjs explains.
    await sleep(10)
    const id = `r${++rid}`
    browser.send({ type: 'request', rid: id, body })
    await waitFor(() => browser.frames.some((f) => f.type === 'result' && f.rid === id), 10000, `result ${id}`)
    return browser.frames.find((f) => f.type === 'result' && f.rid === id).body
  }
  /** How many `dates` frames `browser` gets from `act`, and the last one. Waits a beat for strays. */
  async function framesFrom(browser, act) {
    const before = browser.datesFrames().length
    const result = await act()
    await sleep(150)
    const frames = browser.datesFrames().slice(before)
    return { result, count: frames.length, last: frames.at(-1) }
  }

  try {
    ok(watching === 1, 'a listening server holds one subscription to the list', `${watching}`)
    ok(alertWatching === 1 && weeklyWatching === 1, 'and one to the alerts and one to the weekly check', `${alertWatching} ${weeklyWatching}`)
    const { browser: phone, frame: phoneHello } = await hello(PORT, 'dev-phone')
    const { browser: other, frame: otherHello } = await hello(PORT, 'dev-laptop')
    ok(phoneHello.type === 'hello-ok' && otherHello.type === 'hello-ok', 'two browsers are admitted')

    /* -------------------------------------------------------- requests */
    section('requests')
    {
      const read = await request(phone, { kind: 'dates' })
      ok(read.kind === 'dates' && Array.isArray(read.items) && read.items.length === 0, 'dates reads the empty list', JSON.stringify(read))
      ok(
        read.weekly?.enabled === true && read.weekly.weekday === 1 && read.weekly.hour === 7 && typeof read.weekly.since === 'string' && typeof read.weekly.nextRunAt === 'string',
        'the dates result carries the weekly check, with nextRunAt',
        JSON.stringify(read.weekly)
      )

      const { result: added, count, last } = await framesFrom(other, () =>
        request(phone, {
          kind: 'dates-add',
          input: { title: 'Shop lease ends', date: '2026-03-01', kind: 'contract', group: 'Example Shop', remind_days: [30, 7], note: 'Three months notice' }
        })
      )
      const item = added.item
      ok(added.kind === 'dates' && item?.title === 'Shop lease ends', 'dates-add answers the new line', JSON.stringify(added))
      ok(
        item?.kind === 'contract' && item.group === 'Example Shop' && JSON.stringify(item.remindDays) === '[30,7]' && item.source === 'steve',
        'dates-add maps the snake_case fields onto the line',
        JSON.stringify(item)
      )
      ok(added.items?.length === 1 && dates.list()[0]?.id === item?.id, 'the line is in the service and in the answer')
      ok(count === 1 && last?.items?.length === 1 && last.items[0].id === item?.id, 'the other browser got one dates frame with the new list', `count ${count}`)

      const id = item.id
      const bad = await framesFrom(other, () => request(phone, { kind: 'dates-add', input: { title: 'No real day', date: '2026-02-30' } }))
      ok(bad.result.kind === 'failed' && /real day/.test(bad.result.message), 'a bad day is refused with the store\'s sentence', JSON.stringify(bad.result))
      ok(bad.count === 0 && dates.list().length === 1, 'and changes nothing, so no frame')
      const untitled = await request(phone, { kind: 'dates-add', input: { date: '2026-04-01' } })
      ok(untitled.kind === 'failed' && dates.list().length === 1, 'a line with no title is refused', JSON.stringify(untitled))

      const edit = await framesFrom(other, () =>
        request(phone, { kind: 'dates-update', id, patch: { title: 'Shop lease renewal', end_date: '2026-03-05', remind_days: [14] } })
      )
      const edited = edit.result.item
      ok(
        edit.result.kind === 'dates' && edited?.title === 'Shop lease renewal' && edited.endDate === '2026-03-05' && JSON.stringify(edited.remindDays) === '[14]',
        'dates-update maps title, end_date and remind_days',
        JSON.stringify(edited)
      )
      ok(edit.count === 1 && edit.last?.items[0]?.title === 'Shop lease renewal', 'one dates frame for the change', `count ${edit.count}`)

      // The shared mapper snoozes as a second store call, so this is a frame per call; the last one is the truth.
      const snoozed = await framesFrom(other, () => request(phone, { kind: 'dates-update', id, patch: { snooze_until: '2026-02-01' } }))
      ok(
        snoozed.result.kind === 'dates' && snoozed.result.item?.snoozedUntil === '2026-02-01' && snoozed.count === 1 && snoozed.last.items[0]?.snoozedUntil === '2026-02-01',
        'snooze_until snoozes the line, in one dates frame',
        `${JSON.stringify(snoozed.result.item)} count ${snoozed.count}`
      )

      const cleared = await request(phone, { kind: 'dates-update', id, patch: { end_date: null, snooze_until: null } })
      ok(cleared.kind === 'dates' && cleared.item && !('endDate' in cleared.item) && !('snoozedUntil' in cleared.item), 'null clears end_date and snooze_until', JSON.stringify(cleared.item))

      const done = await request(phone, { kind: 'dates-update', id, patch: { done: true } })
      ok(done.kind === 'dates' && done.item?.done === true && typeof done.item.doneAt === 'string', 'done: true completes the line', JSON.stringify(done.item))
      const reopened = await request(phone, { kind: 'dates-update', id, patch: { done: false } })
      ok(reopened.kind === 'dates' && reopened.item?.done === false && !('doneAt' in reopened.item), 'done: false opens it again')

      const monthly = await request(phone, { kind: 'dates-add', input: { title: 'Card payment', date: '2026-01-10', repeat: 'quarterly' } })
      const moved = await request(phone, { kind: 'dates-update', id: monthly.item.id, patch: { done: true } })
      ok(moved.item?.done === false && moved.item.date === '2026-04-10', 'done: true on a quarterly line moves it on 3 months', JSON.stringify(moved.item))

      const unknown = await request(phone, { kind: 'dates-update', id: 'nope', patch: { title: 'x' } })
      ok(unknown.kind === 'failed' && /No date has the id "nope"/.test(unknown.message), 'an unknown id is refused with a sentence', JSON.stringify(unknown))
      const badReminders = await request(phone, { kind: 'dates-update', id, patch: { remind_days: 'soon' } })
      ok(
        badReminders.kind === 'failed' && /list of days/.test(badReminders.message) && JSON.stringify(dates.list().find((i) => i.id === id)?.remindDays) === '[14]',
        'remind_days that is not a list is refused and changes nothing',
        JSON.stringify(badReminders)
      )
      const empty = await request(phone, { kind: 'dates-update', id, patch: {} })
      ok(empty.kind === 'failed' && /Nothing to change/.test(empty.message), 'a change with nothing in it is refused', JSON.stringify(empty))
      const badRepeat = await request(phone, { kind: 'dates-update', id, patch: { repeat: 'weekly' } })
      ok(badRepeat.kind === 'failed' && dates.list().find((i) => i.id === id)?.repeat === 'none', 'an unknown repeat is refused and changes nothing', JSON.stringify(badRepeat))
      const noId = await request(phone, { kind: 'dates-update', patch: { title: 'x' } })
      ok(noId.kind === 'failed', 'a change with no id is refused')

      const agent = await request(phone, { kind: 'dates-agent', id })
      ok(agent.kind === 'ok' && agentAsks.at(-1) === id, 'dates-agent asks the host for that line and answers ok', JSON.stringify(agent))
      const agentGone = await request(phone, { kind: 'dates-agent', id: 'nope' })
      ok(agentGone.kind === 'failed' && agentGone.message === 'There is no date with that id.', 'a refused agent comes back as the host\'s sentence', JSON.stringify(agentGone))
      const asksBefore = agentAsks.length
      const agentNoId = await request(phone, { kind: 'dates-agent' })
      ok(agentNoId.kind === 'failed' && agentNoId.code === 'bad-frame' && agentAsks.length === asksBefore, 'dates-agent with no id never reaches the host')

      const gone = await framesFrom(other, () => request(phone, { kind: 'dates-update', id, patch: { delete: true, title: 'ignored' } }))
      ok(gone.result.kind === 'dates' && !gone.result.item && !dates.list().some((i) => i.id === id), 'delete: true removes the line', JSON.stringify(gone.result))
      ok(gone.count === 1 && !gone.last.items.some((i) => i.id === id), 'one dates frame without it')
      const goneAgain = await request(phone, { kind: 'dates-update', id, patch: { delete: true } })
      ok(goneAgain.kind === 'failed', 'deleting it again is refused')
    }

    /* ----------------------------------------------------------- frame */
    section('the dates frame')
    {
      const phoneBefore = phone.datesFrames().length
      const { count, last } = await framesFrom(other, async () => dates.add({ title: 'Domain renews', date: '2026-06-01', kind: 'domain' }, 'agent'))
      const phoneGot = phone.datesFrames().slice(phoneBefore)
      ok(count === 1 && phoneGot.length === 1, 'a change made on the desk reaches every browser once', `other ${count}, phone ${phoneGot.length}`)
      ok(JSON.stringify(last?.items) === JSON.stringify(dates.list()), 'carrying the whole new list')
      ok(JSON.stringify(last?.weekly) === JSON.stringify(dates.getWeekly()), 'and the weekly check', JSON.stringify(last?.weekly))
    }

    /* --------------------------------------------------- weekly check */
    section('the weekly check')
    {
      const runsBefore = weeklyRuns
      const run = await framesFrom(other, () => request(phone, { kind: 'dates-weekly', action: 'run' }))
      ok(run.result.kind === 'dates' && run.result.weekly?.lastResult === 'started' && weeklyRuns === runsBefore + 1, 'dates-weekly run asks the host once and answers the new state', JSON.stringify(run.result.weekly))
      ok(run.count === 1 && run.last?.weekly?.lastResult === 'started', 'the other browser gets one dates frame with it', `count ${run.count}`)

      weeklyRunFails = true
      const runFailed = await framesFrom(other, () => request(phone, { kind: 'dates-weekly', action: 'run' }))
      weeklyRunFails = false
      ok(runFailed.result.kind === 'failed' && /not ready/.test(runFailed.result.message), 'a run that did not start comes back as the host\'s sentence', JSON.stringify(runFailed.result))
      ok(runFailed.count === 0, 'and sends no frame')

      const set = await framesFrom(other, () => request(phone, { kind: 'dates-weekly', action: 'set', weekday: 3, hour: 9, enabled: false }))
      ok(
        set.result.kind === 'dates' && set.result.weekly?.weekday === 3 && set.result.weekly.hour === 9 && set.result.weekly.enabled === false && set.result.weekly.nextRunAt === null,
        'dates-weekly set changes day, hour and switch (off: no next run)',
        JSON.stringify(set.result.weekly)
      )
      ok(set.count === 1 && set.last?.weekly?.weekday === 3, 'one dates frame for the change', `count ${set.count}`)
      const badHour = await framesFrom(other, () => request(phone, { kind: 'dates-weekly', action: 'set', hour: 24 }))
      ok(badHour.result.kind === 'failed' && /hour/.test(badHour.result.message) && dates.getWeekly().hour === 9 && badHour.count === 0, 'a bad hour is refused with a sentence and changes nothing', JSON.stringify(badHour.result))
      const badDay = await request(phone, { kind: 'dates-weekly', action: 'set', weekday: 'Monday' })
      ok(badDay.kind === 'failed' && dates.getWeekly().weekday === 3, 'a day that is not a number is refused', JSON.stringify(badDay))
      const nothing = await request(phone, { kind: 'dates-weekly', action: 'set' })
      ok(nothing.kind === 'failed' && /Nothing to change/.test(nothing.message), 'a set with nothing in it is refused', JSON.stringify(nothing))
      const noAction = await request(phone, { kind: 'dates-weekly' })
      ok(noAction.kind === 'failed' && noAction.code === 'bad-frame', 'a weekly request with no action is refused', JSON.stringify(noAction))
      const back = await request(phone, { kind: 'dates-weekly', action: 'set', enabled: true, weekday: 1, hour: 7 })
      ok(back.kind === 'dates' && back.weekly?.enabled === true && typeof back.weekly.nextRunAt === 'string', 'and set back on, it has a next run again')
    }

    /* -------------------------------------------------------- refusals */
    section('refusals')
    {
      const before = JSON.stringify(dates.list())
      const stranger = await connect(PORT)
      stranger.send({ type: 'request', rid: 'x1', body: { kind: 'dates-add', input: { title: 'Sneaky line', date: '2026-05-01' } } })
      await waitFor(() => stranger.closed, 5000, 'the stranger to be dropped')
      const refusal = stranger.first('error')
      ok(
        refusal?.code === 'bad-frame' && /Nothing but hello/.test(refusal.message) && !stranger.first('result'),
        'a socket that was not let in is refused a write and dropped, like every other frame',
        JSON.stringify(stranger.frames)
      )
      ok(JSON.stringify(dates.list()) === before, 'and the list is unchanged')

      const sneak = await connect(PORT)
      sneak.send({ type: 'request', rid: 'x2', body: { kind: 'dates-weekly', action: 'set', enabled: false } })
      await waitFor(() => sneak.closed, 5000, 'the second stranger to be dropped')
      ok(
        sneak.first('error')?.code === 'bad-frame' && !sneak.first('result') && dates.getWeekly().enabled === true,
        'a socket that was not let in is refused dates-weekly the same way, and the weekly check is unchanged',
        JSON.stringify(sneak.frames)
      )

      const { browser: old } = await hello(BARE_PORT, 'dev-old')
      const answers = [
        await request(old, { kind: 'dates' }),
        await request(old, { kind: 'dates-add', input: { title: 'x', date: '2026-05-01' } }),
        await request(old, { kind: 'dates-update', id: 'x', patch: {} }),
        await request(old, { kind: 'dates-agent', id: 'x' })
      ]
      ok(answers.every((a) => a.kind === 'failed' && a.code === 'unsupported'), 'a host with no Dates answers all four unsupported', answers.map((a) => a.code).join(', '))
      const oldWeekly = await request(old, { kind: 'dates-weekly', action: 'run' })
      ok(oldWeekly.kind === 'failed' && oldWeekly.code === 'unsupported', 'and dates-weekly unsupported too', JSON.stringify(oldWeekly))
      const oldRead = await request(old, { kind: 'dates' })
      ok(!('weekly' in oldRead), 'a host without the weekly check sends no weekly field')
    }

    /* ------------------------------------------------------------ push */
    section('alert push')
    {
      const payloads = []
      const off = M.linkDateAlerts(dates, (payload) => payloads.push(payload))
      // Seven days out, so the 7-day reminder is due today.
      const line = dates.add({ title: 'Van insurance renews', date: '2026-01-17', kind: 'insurance', remindDays: [7] })
      const fired = dates.checkNow(NOW, { force: true })
      const mine = payloads.filter((p) => p.id === line.id)
      ok(fired.some((a) => a.item.id === line.id) && mine.length === 1, 'an alert produces one push payload', JSON.stringify(payloads))
      const words = M.alertText(dates.list().find((i) => i.id === line.id), M.todayOf(NOW))
      ok(
        mine[0]?.kind === 'date' && mine[0].title === words.title && mine[0].body === words.body && Object.keys(mine[0]).sort().join() === 'body,id,kind,title',
        'of kind date, with the id and alertText\'s words and nothing else',
        JSON.stringify(mine[0])
      )
      await waitFor(() => phone.alertFrames().some((f) => f.id === line.id), 3000, 'a date-alert frame').catch(() => undefined)
      const alertFrame = phone.alertFrames().find((f) => f.id === line.id)
      ok(
        alertFrame?.title === words.title && alertFrame.body === words.body && !('summary' in alertFrame) && other.alertFrames().some((f) => f.id === line.id),
        'the alert also reaches every browser as a date-alert frame, with its id and words',
        JSON.stringify(alertFrame)
      )
      dates.checkNow(NOW, { force: true })
      ok(payloads.filter((p) => p.id === line.id).length === 1, 'the same alert is not pushed twice')

      // Every device says it is looking, and a push went out a second ago.
      const subs = [{ deviceId: 'dev-phone' }, { deviceId: '' }]
      const seen = { visibleDevices: new Set(['dev-phone']), anyVisible: true }
      const now = Date.now()
      const last = { at: now - 1000, state: 'asking' }
      const attention = { kind: 'attention', sessionId: 's1', state: 'asking', title: 'Forge', desktopName: 'DATES-PC' }
      ok(M.planPush(attention, subs, seen, last, now) === null, 'the same moment holds an attention push back (seen and flap guard)')
      ok(M.planPush(attention, subs, seen, undefined, now) === null, 'and holds it back on "seen" alone')
      const plan = M.planPush(mine[0], subs, seen, last, now)
      ok(plan?.targets.length === 2 && plan.onScreen === 0, 'but a date push goes to every subscription', JSON.stringify(plan))
      ok(M.planPush(mine[0], [], seen, undefined, now) === null, 'and to nobody when nothing is subscribed')

      off()
      dates.add({ title: 'Tax form due', date: '2026-01-10', kind: 'task', remindDays: [0] })
      dates.checkNow(NOW, { force: true })
      ok(payloads.length === 1, 'after the unsubscribe, alerts push nothing')
    }

    /* ---------------------------------------------------- summary push */
    section('summary push')
    {
      const payloads = []
      const off = M.linkDateAlerts(dates, (payload) => payloads.push(payload))
      // Let the last section's frame (its after-unsubscribe alert) land first.
      await sleep(150)
      const alertsBefore = phone.alertFrames().length
      for (const [title, date] of [['Shop insurance renews', '2026-01-12'], ['Phone plan ends', '2026-01-13'], ['Licence renews', '2026-01-14']]) {
        dates.add({ title, date, remindDays: [7] })
      }
      const fired = dates.checkNow(NOW, { force: true })
      ok(fired.length === 3 && payloads.length === 1, 'three alerts in one pass give one push', `${fired.length} fired, ${payloads.length} pushed`)
      const sum = payloads[0]
      ok(
        sum?.kind === 'date' && sum.summary === true && !('id' in sum) && sum.title === '3 dates are coming up' && sum.body.includes('Shop insurance renews'),
        'a summary push: kind date, summary, no id, the summary\'s words',
        JSON.stringify(sum)
      )
      const subs = [{ deviceId: 'dev-phone' }, { deviceId: 'dev-laptop' }]
      const seen = { visibleDevices: new Set(['dev-phone', 'dev-laptop']), anyVisible: true }
      ok(M.planPush(sum, subs, seen, undefined, Date.now())?.targets.length === 2, 'and goes to every subscription')
      await waitFor(() => phone.alertFrames().length > alertsBefore, 3000, 'the summary date-alert frame').catch(() => undefined)
      await sleep(150)
      const got = phone.alertFrames().slice(alertsBefore)
      ok(got.length === 1 && got[0].summary === true && !('id' in got[0]) && got[0].title === sum?.title, 'and one date-alert frame, a summary with no id', JSON.stringify(got))
      off()
    }

    /* ------------------------------------------------------------ stop */
    section('stop')
    {
      await server.stop({ reason: 'quit', message: 'check over' })
      ok(watching === 0, 'a stopped server lets go of the list', `${watching}`)
      ok(alertWatching === 0 && weeklyWatching === 0, 'and of the alerts and the weekly check', `${alertWatching} ${weeklyWatching}`)
    }
  } finally {
    for (const browser of open) {
      try {
        browser.socket.terminate()
      } catch {
        /* gone */
      }
    }
    await server.stop?.({ reason: 'quit', message: 'check over' })
    await bare.stop?.({ reason: 'quit', message: 'check over' })
  }

  await workerChecks()
}

/* ---------------------------------------------------------- the worker */

/**
 * Run web/public/sw.js as a classic script over a fake `self`, the way
 * scripts/pwa-check.mjs runs the mobile one, and fire its two events.
 */
function loadWorker() {
  const listeners = new Map()
  const shown = []
  const opened = []
  const self = {
    location: { origin: ORIGIN, href: `${ORIGIN}/sw.js?v=9.9.9` },
    addEventListener: (type, fn) => listeners.set(type, fn),
    skipWaiting: () => {},
    registration: {
      getNotifications: async () => [],
      showNotification: async (title, options) => {
        shown.push({ title, ...options })
      }
    },
    clients: {
      windows: [],
      claim: async () => {},
      matchAll: async () => self.clients.windows,
      openWindow: async (url) => {
        opened.push(url)
      }
    }
  }
  const source = readFileSync(join(ROOT, 'web', 'public', 'sw.js'), 'utf8')
  new Function('self', 'URL', source)(self, URL)
  async function fire(type, event) {
    const waits = []
    listeners.get(type)?.({ ...event, waitUntil: (p) => waits.push(p) })
    await Promise.all(waits)
  }
  return { self, shown, opened, fire }
}

function windowAt(url) {
  const win = { url, posted: [], focused: 0, postMessage: (m) => win.posted.push(m), focus: async () => void win.focused++ }
  return win
}

async function workerChecks() {
  section('service worker')
  const w = loadWorker()
  const push = (payload) => w.fire('push', { data: { json: () => payload } })
  const click = (note) => w.fire('notificationclick', { notification: { close: () => {}, data: note.data } })

  await push({ kind: 'date', id: 'abc123', title: 'Shop lease ends in 7 days', body: 'Example Shop. Three months notice.' })
  const note = w.shown.at(-1)
  ok(
    note?.title === 'Shop lease ends in 7 days' && note.body === 'Example Shop. Three months notice.',
    'a date push shows the alert\'s own words',
    JSON.stringify(note)
  )
  ok(note?.tag === 'date:abc123' && note.data?.dates === true, 'tagged by the line, so a newer alert replaces it', `${note?.tag}`)
  await push({ kind: 'date', id: 'abc123', title: 'Shop lease ends tomorrow', body: 'Example Shop.' })
  ok(w.shown.at(-1)?.tag === note.tag && w.shown.at(-1).renotify === true, 'the next alert for that line reuses the tag and still buzzes')

  const tab = windowAt(`${ORIGIN}/`)
  w.self.clients.windows = [windowAt('https://elsewhere.example/'), tab]
  await click(note)
  ok(tab.posted.length === 1 && tab.posted[0].type === 'forge-open-dates' && tab.focused === 1, 'a tap tells the open Forge tab to open Dates, and focuses it', JSON.stringify(tab.posted))
  ok(w.opened.length === 0, 'and opens no second window')

  w.self.clients.windows = []
  await click(note)
  ok(JSON.stringify(w.opened) === '["/?dates=1"]', 'with no tab open, a tap opens /?dates=1', JSON.stringify(w.opened))

  // The attention push is unchanged beside it.
  await push({ kind: 'attention', sessionId: 's1', state: 'asking', title: 'Forge — main', prompt: 'Proceed?', desktopName: 'DATES-PC' })
  const asking = w.shown.at(-1)
  ok(asking?.tag === 's1' && asking.title === 'Forge — main needs you' && asking.data?.dates === false, 'an attention push still shows as before')
  const tab2 = windowAt(`${ORIGIN}/`)
  w.self.clients.windows = [tab2]
  await click(asking)
  ok(tab2.posted[0]?.type === 'forge-open-session' && tab2.posted[0].sessionId === 's1', 'and its tap still opens the pane')

  await push({ kind: 'date', title: 'no id' })
  ok(w.shown.at(-1)?.tag === 'forge', 'a date push with no id falls back to the generic notification')

  await push({ kind: 'date', summary: true, title: '3 dates are coming up', body: 'Shop lease ends: in 7 days\nVan tax due: tomorrow\nDomain renews: today' })
  const summary = w.shown.at(-1)
  ok(
    summary?.tag === 'date:summary' && summary.title === '3 dates are coming up' && summary.body.startsWith('Shop lease ends') && summary.data?.dates === true,
    'a summary push (no id) shows its words under its own tag',
    JSON.stringify(summary)
  )
  w.self.clients.windows = []
  const openedBefore = w.opened.length
  await click(summary)
  ok(w.opened.length === openedBefore + 1 && w.opened.at(-1) === '/?dates=1', 'and its tap opens Dates', JSON.stringify(w.opened))


  // The page half of the tap: state.tsx listens for the message and the URL the worker uses.
  const state = readFileSync(join(ROOT, 'web', 'src', 'state.tsx'), 'utf8')
  ok(state.includes("'forge-open-dates'") && /params\.has\('dates'\)/.test(state), 'the page listens for forge-open-dates and reads ?dates=')
}

main()
  .catch((err) => {
    fail++
    console.error(`\n  ✕ ${err?.stack ?? err}`)
  })
  .finally(() => {
    console.log(`\ndates-web: ${pass} passed, ${fail} failed`)
    process.exit(fail === 0 ? 0 : 1)
  })
