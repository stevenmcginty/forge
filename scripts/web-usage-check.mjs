/**
 * Head-less proof of Forge Web's `usage` frame: a status file that
 * `~/.claude/statusline.js` leaves for a Claude session reaches the phone as
 * the owning pane's context ring and the account's limits; a second change
 * inside two seconds is held and sent when the window passes; a browser that
 * reconnects is told the latest straight after `hello-ok`; an unmapped session
 * and a stale file say nothing; and only a host that feeds usage announces it.
 *
 *   npm run web:usage
 *
 * Bundles the *real* electron/web/server.ts, electron/web/auth.ts and
 * electron/web/agent-usage.ts with esbuild and drives them over a real
 * WebSocket, the way scripts/web-project-remove-check.mjs does, with Google
 * stubbed the same way. The status folder is a temp folder — never the real
 * `~/.claude/forge-status` — and the pane ↔ session map is a fixed stub.
 */
import { mkdirSync, rmSync, utimesSync, writeFileSync, renameSync, existsSync } from 'node:fs'
import { createSign, generateKeyPairSync } from 'node:crypto'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import { WebSocket } from 'ws'

const ROOT = resolve(import.meta.dirname, '..')
const scratch = join(ROOT, 'node_modules', '.forge-web-usage')
rmSync(scratch, { recursive: true, force: true })
mkdirSync(scratch, { recursive: true })
const STATUS_DIR = join(scratch, 'forge-status')
mkdirSync(STATUS_DIR, { recursive: true })

const PORT = 8521
const BARE_PORT = 8522
const PROJECT = 'forge-web-usage'
const UID = 'ULFo0dLmQ1bXQ8mJ2v7hZ4pTgS93'
const KID = 'usage-kid-1'
const ORIGIN = 'https://forge-web.web.app'

/** Claude session ids — real UUIDs, because anything else names no session. */
const SID_A = 'aaaaaaaa-1111-4111-8111-111111111111'
const SID_B = 'bbbbbbbb-2222-4222-8222-222222222222'
const SID_UNMAPPED = 'cccccccc-3333-4333-8333-333333333333'
const SID_STALE = 'dddddddd-4444-4444-8444-444444444444'
const SID_ANCIENT = 'eeeeeeee-5555-4555-8555-555555555555'
const OWNERS = new Map([
  [SID_A, 'pane-a'],
  [SID_B, 'pane-b'],
  [SID_STALE, 'pane-s'],
  [SID_ANCIENT, 'pane-s']
])

let failures = 0
const log = (ok, message) => {
  if (!ok) failures++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${message}`)
}
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

/** What statusline.js writes, the way it writes it: temp name, then rename. */
function writeStatus(sid, { pct, tokens, size = 1_000_000, limits }) {
  const body = {
    session_id: sid,
    context_window: {
      used_percentage: pct,
      context_window_size: size,
      current_usage: {
        input_tokens: 1000,
        output_tokens: 2000,
        cache_creation_input_tokens: 3000,
        cache_read_input_tokens: tokens - 6000
      }
    },
    ...(limits ? { rate_limits: limits } : {}),
    model: 'claude-opus-5-5',
    at: Date.now()
  }
  const file = join(STATUS_DIR, `${sid}.json`)
  writeFileSync(`${file}.tmp`, JSON.stringify(body))
  renameSync(`${file}.tmp`, file)
  return file
}

const b64url = (value) => Buffer.from(value).toString('base64url')

/* ------------------------------------------- Google, as web-smoke stubs it */

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

/* ------------------------------------------------------------------- main */

async function main() {
  await build({
    stdin: {
      contents: [
        "export { WebServer } from './electron/web/server'",
        "export { WebAuth } from './electron/web/auth'",
        "export { startAgentUsage } from './electron/web/agent-usage'",
        'export { WEB_PROTO, WEB_SUBPROTOCOL, WEB_WS_PATH, WEB_FEATURE_USAGE } from "./shared/web"'
      ].join('\n'),
      resolveDir: ROOT,
      sourcefile: 'web-usage-entry.ts',
      loader: 'ts'
    },
    outfile: join(scratch, 'web.mjs'),
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    external: ['@lydell/node-pty', 'ws'],
    alias: { '@shared': join(ROOT, 'shared') },
    logLevel: 'silent',
    absWorkingDir: ROOT
  })

  const { WebServer, WebAuth, startAgentUsage, WEB_PROTO, WEB_SUBPROTOCOL, WEB_WS_PATH, WEB_FEATURE_USAGE } =
    await import(pathToFileURL(join(scratch, 'web.mjs')).href)

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

  const makeAuth = () =>
    new WebAuth({
      fetchJwks: async () => ({ body: JSON.stringify(served), cacheControl: 'public, max-age=21600' }),
      projectId: () => PROJECT,
      uid: () => UID
    })
  const pane = (id) => ({ id, cwd: 'C:/work', cols: 80, rows: 24, bootstrapCommand: 'claude', startedAt: 1 })
  const baseHost = {
    appVersion: '0.0.0-usage',
    desktopName: () => 'USAGE-PC',
    allowedOrigins: () => [ORIGIN],
    sessions: () => [pane('pane-a'), pane('pane-b'), pane('pane-s')],
    replay: () => '',
    write: () => true,
    resize: () => false,
    snapshot: () => ({ projects: [], profiles: [], workspaces: {} }),
    layout: async () => null,
    log: () => {}
  }
  const server = new WebServer({ ...baseHost, auth: makeAuth(), usage: true })
  await server.start({ host: '127.0.0.1', port: PORT })
  // A host that does not feed usage must not announce it.
  const bare = new WebServer({ ...baseHost, auth: makeAuth() })
  await bare.start({ host: '127.0.0.1', port: BARE_PORT })

  // Files that must say nothing, on disk before the watch starts: a session no
  // live pane owns, one older than six hours, and one old enough to be pruned.
  writeStatus(SID_UNMAPPED, { pct: 11, tokens: 110_000, limits: { five_hour: { used_percentage: 99 } } })
  const staleFile = writeStatus(SID_STALE, { pct: 77, tokens: 770_000 })
  const sevenHoursAgo = new Date(Date.now() - 7 * 60 * 60 * 1000)
  utimesSync(staleFile, sevenHoursAgo, sevenHoursAgo)
  const ancientFile = writeStatus(SID_ANCIENT, { pct: 5, tokens: 50_000 })
  const eightDaysAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000)
  utimesSync(ancientFile, eightDaysAgo, eightDaysAgo)

  const handed = []
  const usage = startAgentUsage({
    dir: STATUS_DIR,
    panes: () => OWNERS,
    pollMs: 300,
    onUsage: (frame) => {
      handed.push(frame)
      server.pushUsage(frame)
    }
  })

  const open = []
  function connect(port) {
    const socket = new WebSocket(`ws://127.0.0.1:${port}${WEB_WS_PATH}`, [WEB_SUBPROTOCOL], { origin: ORIGIN })
    const browser = {
      socket,
      frames: [],
      send: (frame) => socket.send(JSON.stringify(frame)),
      first: (type) => browser.frames.find((f) => f.type === type),
      usage: (paneId) => browser.frames.filter((f) => f.type === 'usage' && (!paneId || f.sessionId === paneId))
    }
    open.push(browser)
    socket.on('message', (raw) => {
      const frame = JSON.parse(String(raw))
      frame.__at = Date.now()
      browser.frames.push(frame)
    })
    return new Promise((resolvePromise, reject) => {
      socket.on('open', () => resolvePromise(browser))
      socket.on('error', reject)
    })
  }

  async function hello(port = PORT) {
    const browser = await connect(port)
    browser.send({
      type: 'hello',
      proto: WEB_PROTO,
      idToken: mint(),
      client: 'usage-check',
      deviceId: 'dev-1',
      deviceName: 'Pixel'
    })
    await waitFor(() => browser.first('hello-ok') || browser.first('refused'), 5000, 'an answer to hello')
    return { browser, frame: browser.first('hello-ok') ?? browser.first('refused') }
  }

  const LIMITS = {
    five_hour: { used_percentage: 17, resets_at: 1790000000 },
    seven_day: { used_percentage: 63, resets_at: 1790500000 }
  }

  try {
    /* ---------------------------------------------------- announcement */
    const { browser, frame } = await hello()
    log(frame.type === 'hello-ok', 'the phone is admitted')
    log(
      WEB_FEATURE_USAGE === 'usage' && Array.isArray(frame.features) && frame.features.includes('usage'),
      `hello-ok announces usage (${JSON.stringify(frame.features)})`
    )
    {
      const old = await hello(BARE_PORT)
      log(
        old.frame.type === 'hello-ok' && !(old.frame.features ?? []).includes('usage'),
        `a host that does not feed usage does not announce it (${JSON.stringify(old.frame.features)})`
      )
    }

    /* ------------------------------------------- nothing from the wrong files */
    await sleep(900) // three polls over the unmapped, stale and ancient files
    log(browser.usage().length === 0, `an unmapped session and a stale file produce nothing (${browser.usage().length} frames)`)
    log(handed.length === 0, `and nothing is even handed to the server (${handed.length})`)
    log(!existsSync(ancientFile), 'a file older than a week is pruned')
    log(existsSync(staleFile), 'a file between six hours and a week old is left alone')

    /* ------------------------------------------------- a mapped session */
    writeStatus(SID_A, { pct: 42, tokens: 420_000, limits: LIMITS })
    await waitFor(() => browser.usage('pane-a').length >= 1, 3000, 'the first usage frame for pane-a')
    const first = browser.usage('pane-a')[0]
    log(
      first.source === 'claude-statusline' &&
        first.context?.usedPct === 42 &&
        first.context?.usedTokens === 420_000 &&
        first.context?.windowTokens === 1_000_000,
      `pane-a's context is 42% of 420000/1000000 (${JSON.stringify(first.context)})`
    )
    log(
      first.limits?.fiveHour?.usedPct === 17 &&
        first.limits?.fiveHour?.resetsAt === 1790000000 &&
        first.limits?.week?.usedPct === 63 &&
        first.limits?.week?.resetsAt === 1790500000,
      `the limits are 5h 17% and week 63% with their resets (${JSON.stringify(first.limits)})`
    )
    log(typeof first.at === 'number' && Math.abs(first.at - Date.now()) < 10_000, `at is epoch ms (${first.at})`)
    log(
      browser.usage().every((f) => f.sessionId === 'pane-a' || f.sessionId === 'pane-b'),
      'no frame names the unmapped session or the stale pane'
    )

    /* --------------------------------------------------------- throttle */
    await sleep(50)
    writeStatus(SID_A, { pct: 55, tokens: 550_000, limits: LIMITS })
    await sleep(1200)
    log(
      browser.usage('pane-a').length === 1,
      `a second change inside two seconds is held (${browser.usage('pane-a').length} frame(s) after 1.2s)`
    )
    log(handed.filter((f) => f.sessionId === 'pane-a').length === 2, 'though the watcher did see it')
    await waitFor(() => browser.usage('pane-a').length >= 2, 3000, 'the held frame for pane-a')
    const second = browser.usage('pane-a')[1]
    const gap = second.__at - first.__at
    log(second.context?.usedPct === 55, `the held frame goes out with the newest numbers (${second.context?.usedPct}%)`)
    log(gap >= 1900, `and not before the window passed (${gap}ms apart)`)

    /* --------------------------------------------- limits for every pane */
    writeStatus(SID_B, { pct: 8, tokens: 80_000 })
    await waitFor(() => browser.usage('pane-b').length >= 1, 3000, 'a usage frame for pane-b')
    const b = browser.usage('pane-b')[0]
    log(
      b.context?.usedPct === 8 && b.limits?.fiveHour?.usedPct === 17 && b.limits?.week?.usedPct === 63,
      `a pane whose own file has no limits carries the newest file's (${JSON.stringify(b)})`
    )

    /* ---------------------------------------------------------- replay */
    await sleep(400)
    const before = handed.length
    const again = await hello()
    await sleep(300)
    const afterHello = again.browser.frames.slice(again.browser.frames.indexOf(again.frame) + 1)
    const replayA = afterHello.find((f) => f.type === 'usage' && f.sessionId === 'pane-a')
    const replayB = afterHello.find((f) => f.type === 'usage' && f.sessionId === 'pane-b')
    log(
      replayA?.context?.usedPct === 55 && replayB?.context?.usedPct === 8,
      `a reconnecting browser is told each pane's latest right after hello-ok (a ${replayA?.context?.usedPct}%, b ${replayB?.context?.usedPct}%)`
    )
    log(handed.length === before, 'and that came from the server, not from a fresh file')
    log(
      !afterHello.some((f) => f.type === 'usage' && f.sessionId === 'pane-s'),
      'the stale pane is not replayed'
    )

    /* -------------------------------------------------------- exit forgets */
    server.pushExit('pane-b', 0)
    const third = await hello()
    await sleep(300)
    const afterThird = third.browser.frames.slice(third.browser.frames.indexOf(third.frame) + 1)
    log(
      afterThird.some((f) => f.type === 'usage' && f.sessionId === 'pane-a') &&
        !afterThird.some((f) => f.type === 'usage' && f.sessionId === 'pane-b'),
      'a pane that exited is not replayed'
    )
  } finally {
    usage.stop()
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

  rmSync(scratch, { recursive: true, force: true })
  console.log(failures ? `\n${failures} check(s) FAILED` : '\nall usage checks passed')
  process.exit(failures ? 1 : 0)
}

main().catch((err) => {
  console.error(err)
  rmSync(scratch, { recursive: true, force: true })
  process.exit(1)
})
