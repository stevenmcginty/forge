/**
 * Head-less proof of the desktop half of Forge Web's "Remove project": the
 * request reaches the host with the id, an id the host does not have is
 * refused before anything is asked of the renderer, the preview says how many
 * panes would close, and the feature is announced only by a host that offers it.
 *
 *   npm run web:remove
 *
 * Bundles the *real* electron/web/server.ts and electron/web/auth.ts with
 * esbuild and drives them over a real WebSocket, the way scripts/web-io-check.mjs
 * does, with Google stubbed the same way. The host is stubbed: what the renderer
 * does with the request is `removeProject`, the rail's own action, and is not
 * what this check is about.
 */
import { mkdirSync, rmSync } from 'node:fs'
import { createSign, generateKeyPairSync } from 'node:crypto'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import { WebSocket } from 'ws'

const ROOT = resolve(import.meta.dirname, '..')
const scratch = join(ROOT, 'node_modules', '.forge-web-remove')
rmSync(scratch, { recursive: true, force: true })
mkdirSync(scratch, { recursive: true })

const PORT = 8501
const BARE_PORT = 8502
const HALF_PORT = 8503
const PROJECT = 'forge-web-remove'
const UID = 'ULFo0dLmQ1bXQ8mJ2v7hZ4pTgS93'
const KID = 'remove-kid-1'
const ORIGIN = 'https://forge-web.web.app'

let failures = 0
const log = (ok, message) => {
  if (!ok) failures++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${message}`)
}

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
        'export { WEB_PROTO, WEB_SUBPROTOCOL, WEB_WS_PATH, WEB_FEATURE_PROJECT_REMOVE } from "./shared/web"'
      ].join('\n'),
      resolveDir: ROOT,
      sourcefile: 'web-remove-entry.ts',
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

  const { WebServer, WebAuth, WEB_PROTO, WEB_SUBPROTOCOL, WEB_WS_PATH, WEB_FEATURE_PROJECT_REMOVE } = await import(
    pathToFileURL(join(scratch, 'web.mjs')).href
  )

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

  /** Every `projectRemove` the stubbed host received. */
  const removed = []
  /** What the stubbed renderer answers next — null is "done". */
  let rendererSays = null
  const makeAuth = () =>
    new WebAuth({
      fetchJwks: async () => ({ body: JSON.stringify(served), cacheControl: 'public, max-age=21600' }),
      projectId: () => PROJECT,
      uid: () => UID
    })
  const baseHost = {
    appVersion: '0.0.0-remove',
    desktopName: () => 'REMOVE-PC',
    allowedOrigins: () => [ORIGIN],
    sessions: () => [],
    replay: () => '',
    write: () => true,
    resize: () => false,
    snapshot: () => ({ projects: [], profiles: [], workspaces: {} }),
    layout: async () => null,
    log: () => {}
  }
  const projectRemovePreview = (id) => (id === 'p1' ? { name: 'Forge', panes: 3 } : null)
  const projectRemove = async (id, deviceName) => {
    removed.push({ id, deviceName })
    return rendererSays
  }
  const server = new WebServer({ ...baseHost, auth: makeAuth(), projectRemovePreview, projectRemove })
  await server.start({ host: '127.0.0.1', port: PORT })
  // An older-shaped desktop: no remove at all. It must not announce the
  // feature and must answer both requests `unsupported`.
  const bare = new WebServer({ ...baseHost, auth: makeAuth() })
  await bare.start({ host: '127.0.0.1', port: BARE_PORT })
  // Half a host — remove without its preview — must not announce it either.
  const half = new WebServer({ ...baseHost, auth: makeAuth(), projectRemove })
  await half.start({ host: '127.0.0.1', port: HALF_PORT })

  const open = []
  function connect(port) {
    const socket = new WebSocket(`ws://127.0.0.1:${port}${WEB_WS_PATH}`, [WEB_SUBPROTOCOL], { origin: ORIGIN })
    const browser = {
      socket,
      frames: [],
      send: (frame) => socket.send(JSON.stringify(frame)),
      first: (type) => browser.frames.find((f) => f.type === type)
    }
    open.push(browser)
    socket.on('message', (raw) => browser.frames.push(JSON.parse(String(raw))))
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
      client: 'remove-check',
      deviceId: 'dev-1',
      deviceName: 'Pixel'
    })
    await waitFor(() => browser.first('hello-ok') || browser.first('refused'), 5000, 'an answer to hello')
    return { browser, frame: browser.first('hello-ok') ?? browser.first('refused') }
  }

  let rid = 0
  async function request(browser, body) {
    // Held under MAX_INPUT_PER_SECOND, as scripts/web-io-check.mjs explains.
    await new Promise((r) => setTimeout(r, 10))
    const id = `r${++rid}`
    browser.send({ type: 'request', rid: id, body })
    await waitFor(() => browser.frames.some((f) => f.type === 'result' && f.rid === id), 10000, `result ${id}`)
    return browser.frames.find((f) => f.type === 'result' && f.rid === id).body
  }

  try {
    const { browser, frame } = await hello()

    /* ---------------------------------------------------- announcement */
    log(frame.type === 'hello-ok', 'the phone is admitted')
    log(
      WEB_FEATURE_PROJECT_REMOVE === 'project-remove' &&
        Array.isArray(frame.features) &&
        frame.features.includes(WEB_FEATURE_PROJECT_REMOVE),
      `hello-ok announces project-remove (${JSON.stringify(frame.features)})`
    )

    /* --------------------------------------------------------- preview */
    {
      const preview = await request(browser, { kind: 'project-remove-preview', projectId: 'p1' })
      log(
        preview.kind === 'project-remove-preview' &&
          preview.projectId === 'p1' &&
          preview.name === 'Forge' &&
          preview.panes === 3,
        `the preview names the project and its running panes (${JSON.stringify(preview)})`
      )
      const unknown = await request(browser, { kind: 'project-remove-preview', projectId: 'nope' })
      log(
        unknown.kind === 'failed' && unknown.code === 'unknown-project',
        `a preview of an unknown project is unknown-project (${unknown.code})`
      )
      log(removed.length === 0, 'a preview removes nothing')
    }

    /* ---------------------------------------------------------- remove */
    {
      const done = await request(browser, { kind: 'project-remove', projectId: 'p1' })
      log(done.kind === 'ok', `removing p1 answers ok (${done.kind})`)
      log(
        removed.length === 1 && removed[0].id === 'p1' && removed[0].deviceName === 'Pixel',
        `the host was asked once, with the id and the device (${JSON.stringify(removed)})`
      )

      const unknown = await request(browser, { kind: 'project-remove', projectId: 'nope' })
      log(
        unknown.kind === 'failed' && unknown.code === 'unknown-project',
        `an unknown project is unknown-project (${unknown.code})`
      )
      log(removed.length === 1, 'an unknown project never reaches the host')

      const empty = await request(browser, { kind: 'project-remove' })
      log(
        empty.kind === 'failed' && empty.code === 'bad-frame' && removed.length === 1,
        `no projectId is bad-frame (${empty.code})`
      )

      const odd = await request(browser, { kind: 'project-remove', projectId: 42 })
      log(
        odd.kind === 'failed' && odd.code === 'bad-frame' && removed.length === 1,
        `a non-string projectId is bad-frame (${odd.code})`
      )

      rendererSays = 'Forge has no window open on the desktop, so it cannot remove a project.'
      const noWindow = await request(browser, { kind: 'project-remove', projectId: 'p1' })
      log(
        noWindow.kind === 'failed' && noWindow.code === 'no-window' && noWindow.message === rendererSays,
        `a desktop with no window is no-window, with its sentence (${noWindow.code}: ${noWindow.message})`
      )
      rendererSays = null
    }

    /* ---------------------------------------------------- older desktops */
    {
      const old = await hello(BARE_PORT)
      log(
        old.frame.type === 'hello-ok' && !(old.frame.features ?? []).includes(WEB_FEATURE_PROJECT_REMOVE),
        `a desktop without the hook does not announce it (${JSON.stringify(old.frame.features)})`
      )
      const r1 = await request(old.browser, { kind: 'project-remove', projectId: 'p1' })
      const r2 = await request(old.browser, { kind: 'project-remove-preview', projectId: 'p1' })
      log(
        r1.code === 'unsupported' && r2.code === 'unsupported',
        `and answers both unsupported (${r1.code}, ${r2.code})`
      )

      const before = removed.length
      const halfway = await hello(HALF_PORT)
      log(
        halfway.frame.type === 'hello-ok' && !(halfway.frame.features ?? []).includes(WEB_FEATURE_PROJECT_REMOVE),
        'a host with remove but no preview does not announce it'
      )
      const r3 = await request(halfway.browser, { kind: 'project-remove', projectId: 'p1' })
      log(
        r3.code === 'unsupported' && removed.length === before,
        `and answers unsupported without asking the host (${r3.code})`
      )
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
    await half.stop?.({ reason: 'quit', message: 'check over' })
  }

  rmSync(scratch, { recursive: true, force: true })
  console.log(failures ? `\n${failures} check(s) FAILED` : '\nall remove checks passed')
  process.exit(failures ? 1 : 0)
}

main().catch((err) => {
  console.error(err)
  rmSync(scratch, { recursive: true, force: true })
  process.exit(1)
})
