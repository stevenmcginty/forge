/**
 * Head-less proof of the desktop half of three phone features: dictation
 * streamed while Steve is still talking, the read-only project file browser,
 * and a protocol refusal that says which side is old.
 *
 *   npm run web:io
 *
 * Bundles the *real* electron/web/server.ts, electron/web/auth.ts and
 * electron/web/project-files.ts with esbuild and drives them over a real
 * WebSocket, the way scripts/web-smoke.mjs does. Google is stubbed exactly as
 * it is there (a self-signed certificate in the securetoken shape, JWTs minted
 * against it). Speech-to-text is stubbed — the check is about assembly, not
 * about Whisper — and records every call so "transcribed once" is counted.
 *
 * The file browser reads a real temporary project on this disk, with a real
 * junction pointing out of it, so the confinement is observed on real paths
 * rather than inferred from string handling.
 */
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { createSign, generateKeyPairSync } from 'node:crypto'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import { WebSocket } from 'ws'

const ROOT = resolve(import.meta.dirname, '..')
const scratch = join(ROOT, 'node_modules', '.forge-web-io')
rmSync(scratch, { recursive: true, force: true })
mkdirSync(scratch, { recursive: true })

const PORT = 8497
const BARE_PORT = 8498
const PROJECT = 'forge-web-io'
const UID = 'ULFo0dLmQ1bXQ8mJ2v7hZ4pTgS93'
const KID = 'io-kid-1'
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

/* ------------------------------------------------------ a project on disk */

const repo = join(scratch, 'repo')
const project = join(repo, 'project')
const outside = join(repo, 'outside')
const SOURCE = 'export const a = 1\n'
const BIG_BYTES = 1024 * 1024
let fileLinkMade = false

function makeProject(MAX_PROJECT_FILE_BYTES) {
  mkdirSync(join(project, 'src'), { recursive: true })
  mkdirSync(outside, { recursive: true })
  writeFileSync(join(project, 'src', 'a.ts'), SOURCE)
  writeFileSync(join(project, 'README.md'), '# io\n')
  // One megabyte of text with a two-byte character straddling the cut, so a
  // truncation that split it would end in U+FFFD.
  const big = Buffer.alloc(BIG_BYTES, 'a')
  Buffer.from('é').copy(big, MAX_PROJECT_FILE_BYTES - 1)
  writeFileSync(join(project, 'big.txt'), big)
  writeFileSync(join(project, 'bin.dat'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x00, 0x01, 0x02]))
  writeFileSync(join(outside, 'secret.txt'), 'not yours\n')
  // Junctions need no privilege on Windows; a file symlink does, and is tried.
  symlinkSync(outside, join(project, 'escape'), 'junction')
  symlinkSync(join(project, 'src'), join(project, 'inner'), 'junction')
  try {
    symlinkSync(join(outside, 'secret.txt'), join(project, 'leak.txt'), 'file')
    fileLinkMade = true
  } catch {
    fileLinkMade = false
  }
}

/* ------------------------------------------------------------------- main */

async function main() {
  await build({
    stdin: {
      contents: [
        "export { WebServer } from './electron/web/server'",
        "export { WebAuth } from './electron/web/auth'",
        'export { WEB_PROTO, WEB_SUBPROTOCOL, WEB_WS_PATH, WEB_FEATURE_DICTATE_STREAM, WEB_FEATURE_FILES,',
        '  DICTATION_STREAM_IDLE_MS, MAX_DICTATION_BYTES, MAX_FILE_CHUNK_BYTES, MAX_PROJECT_FILE_BYTES } from "./shared/web"'
      ].join('\n'),
      resolveDir: ROOT,
      sourcefile: 'web-io-entry.ts',
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

  const {
    WebServer,
    WebAuth,
    WEB_PROTO,
    WEB_SUBPROTOCOL,
    WEB_WS_PATH,
    WEB_FEATURE_DICTATE_STREAM,
    WEB_FEATURE_FILES,
    DICTATION_STREAM_IDLE_MS,
    MAX_DICTATION_BYTES,
    MAX_FILE_CHUNK_BYTES,
    MAX_PROJECT_FILE_BYTES
  } = await import(pathToFileURL(join(scratch, 'web.mjs')).href)

  makeProject(MAX_PROJECT_FILE_BYTES)

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

  /** Moved forward to ride out the idle timeout without sleeping. */
  let skew = 0
  /** Every call the stubbed speech-to-text received. */
  const heard = []
  const makeAuth = () =>
    new WebAuth({
      fetchJwks: async () => ({ body: JSON.stringify(served), cacheControl: 'public, max-age=21600' }),
      projectId: () => PROJECT,
      uid: () => UID
    })
  const baseHost = {
    appVersion: '0.0.0-io',
    desktopName: () => 'IO-PC',
    allowedOrigins: () => [ORIGIN],
    sessions: () => [{ id: 'w1', cwd: project, cols: 80, rows: 24, startedAt: 0 }],
    replay: () => '',
    write: () => true,
    resize: () => false,
    snapshot: () => ({ projects: [], profiles: [], workspaces: {} }),
    layout: async () => null,
    log: () => {}
  }
  const server = new WebServer({
    ...baseHost,
    auth: makeAuth(),
    now: () => Date.now() + skew,
    transcribeAudio: async (bytes, mime) => {
      heard.push({ bytes: Buffer.from(bytes), mime })
      return { ok: true, text: `heard ${bytes.length} bytes` }
    },
    projectRoot: (id) => (id === 'p1' ? project : null),
    // The repository root sits one folder above the project, as it does for a
    // project that is a subfolder of a bigger repo.
    gitStatus: async (id) => (id === 'p1' ? { projectId: 'p1', repoRoot: repo, files: [] } : null)
  })
  await server.start({ host: '127.0.0.1', port: PORT })
  // An older-shaped desktop: no speech-to-text, no project roots. It must
  // announce neither feature and answer both requests `unsupported`.
  const bare = new WebServer({ ...baseHost, auth: makeAuth() })
  await bare.start({ host: '127.0.0.1', port: BARE_PORT })

  const open = []
  function connect(port = PORT) {
    const socket = new WebSocket(`ws://127.0.0.1:${port}${WEB_WS_PATH}`, [WEB_SUBPROTOCOL], { origin: ORIGIN })
    const browser = {
      socket,
      frames: [],
      closed: null,
      send: (frame) => socket.send(JSON.stringify(frame)),
      first: (type) => browser.frames.find((f) => f.type === type)
    }
    open.push(browser)
    socket.on('message', (raw) => browser.frames.push(JSON.parse(String(raw))))
    socket.on('close', (code) => (browser.closed = code))
    return new Promise((resolvePromise, reject) => {
      socket.on('open', () => resolvePromise(browser))
      socket.on('error', reject)
    })
  }

  async function hello(extra = {}, port = PORT) {
    const browser = await connect(port)
    browser.send({ type: 'hello', proto: WEB_PROTO, idToken: mint(), client: 'io-check', deviceId: 'dev-1', deviceName: 'Pixel', ...extra })
    await waitFor(() => browser.first('hello-ok') || browser.first('refused'), 5000, 'an answer to hello')
    return { browser, frame: browser.first('hello-ok') ?? browser.first('refused') }
  }

  let rid = 0
  async function request(browser, body) {
    // Held under MAX_INPUT_PER_SECOND, which counts `request` frames: a check
    // that flooded the budget would be timing out on the limiter, not on
    // anything it is here to prove.
    await new Promise((r) => setTimeout(r, 10))
    const id = `r${++rid}`
    browser.send({ type: 'request', rid: id, body })
    await waitFor(() => browser.frames.some((f) => f.type === 'result' && f.rid === id), 10000, `result ${id}`)
    return browser.frames.find((f) => f.type === 'result' && f.rid === id).body
  }

  const MIME = 'audio/webm;codecs=opus'
  const slice = (n, size = 1000) => Buffer.alloc(size, n)
  const stream = (browser, dictationId, op, extra = {}) =>
    request(browser, { kind: 'dictate-stream', op, dictationId, ...extra })
  const append = (browser, dictationId, seqNo, bytes) =>
    stream(browser, dictationId, 'append', { seq: seqNo, data: Buffer.from(bytes).toString('base64') })

  try {
    const { browser, frame } = await hello()

    /* ---------------------------------------------------- announcements */
    log(frame.type === 'hello-ok', 'the phone is admitted')
    log(
      Array.isArray(frame.features) &&
        frame.features.includes(WEB_FEATURE_DICTATE_STREAM) &&
        frame.features.includes(WEB_FEATURE_FILES),
      `hello-ok announces dictate-stream and files (${JSON.stringify(frame.features)})`
    )

    /* ------------------------------------------- streamed dictation, in order */
    {
      const started = await stream(browser, 'd1', 'start', { sessionId: 'w1', mime: MIME })
      log(started.kind === 'ok', 'a streamed dictation starts')
      const parts = [0, 1, 2, 3, 4].map((n) => slice(n + 1, 1000 + n))
      let allOk = true
      for (let i = 0; i < parts.length; i++) allOk = (await append(browser, 'd1', i, parts[i])).kind === 'ok' && allOk
      log(allOk, 'five slices are appended while "recording"')
      log(heard.length === 0, 'nothing is transcribed before done')
      const done = await stream(browser, 'd1', 'done', { chunks: 5 })
      log(
        done.kind === 'dictation' && done.text === `heard ${Buffer.concat(parts).length} bytes`,
        `done answers dictation (${done.kind}: ${done.text ?? done.message})`
      )
      log(
        heard.length === 1 && heard[0].bytes.equals(Buffer.concat(parts)) && heard[0].mime === MIME,
        'transcribed exactly once, on the five slices in order, with the recorder mime'
      )
      const again = await stream(browser, 'd1', 'done', { chunks: 5 })
      log(again.kind === 'failed' && heard.length === 1, `a second done is told the recording is gone (${again.message})`)
    }

    /* ------------------------------------- out of order, and a duplicate */
    {
      heard.length = 0
      await stream(browser, 'd2', 'start', { sessionId: 'w1', mime: MIME })
      const s0 = slice(10)
      const s0b = slice(11, 1200)
      const s1 = slice(12)
      const s2 = slice(13)
      await append(browser, 'd2', 2, s2)
      await append(browser, 'd2', 0, s0)
      await append(browser, 'd2', 1, s1)
      const dup = await append(browser, 'd2', 0, s0b)
      log(dup.kind === 'ok', 'a repeated seq is accepted')
      const done = await stream(browser, 'd2', 'done', { chunks: 3 })
      log(
        done.kind === 'dictation' && heard.length === 1 && heard[0].bytes.equals(Buffer.concat([s0b, s1, s2])),
        'slices sent 2,0,1,0 assemble as 0,1,2 with the repeated seq replacing the first'
      )
    }

    /* --------------------------------------------------- a missing slice */
    {
      heard.length = 0
      await stream(browser, 'd3', 'start', { sessionId: 'w1', mime: MIME })
      await append(browser, 'd3', 0, slice(1))
      await append(browser, 'd3', 2, slice(3))
      const done = await stream(browser, 'd3', 'done', { chunks: 3 })
      log(
        done.kind === 'failed' && done.code === 'bad-frame' && /Missing slice 1 of 3/.test(done.message) && heard.length === 0,
        `a gap is refused and nothing is transcribed (${done.message})`
      )
      const extra = await stream(browser, 'd3b', 'start', { sessionId: 'w1', mime: MIME })
      await append(browser, 'd3b', 0, slice(1))
      await append(browser, 'd3b', 5, slice(1))
      const over = await stream(browser, 'd3b', 'done', { chunks: 1 })
      log(extra.kind === 'ok' && over.kind === 'failed' && over.code === 'bad-frame', `a slice past the count is refused (${over.message})`)
    }

    /* ------------------------------------------------------ over the cap */
    {
      heard.length = 0
      await stream(browser, 'd4', 'start', { sessionId: 'w1', mime: MIME })
      const full = Buffer.alloc(MAX_FILE_CHUNK_BYTES, 7)
      const fits = MAX_DICTATION_BYTES / MAX_FILE_CHUNK_BYTES
      let allOk = true
      for (let i = 0; i < fits; i++) allOk = (await append(browser, 'd4', i, full)).kind === 'ok' && allOk
      log(allOk, `exactly MAX_DICTATION_BYTES (${fits} full slices) is accepted`)
      const past = await append(browser, 'd4', fits, Buffer.alloc(1, 7))
      log(past.kind === 'failed' && past.code === 'limit', `one byte past the cap is refused limit (${past.message})`)
      const after = await append(browser, 'd4', fits + 1, slice(1))
      log(after.kind === 'failed' && after.code === 'failed', 'and the recording is dropped')
      const oversized = await stream(browser, 'd4b', 'start', { sessionId: 'w1', mime: MIME })
      const big = await append(browser, 'd4b', 0, Buffer.alloc(MAX_FILE_CHUNK_BYTES + 16 * 1024, 1))
      log(oversized.kind === 'ok' && big.kind === 'failed' && big.code === 'limit', 'a single slice over the chunk ceiling is refused limit')
      await stream(browser, 'd4b', 'cancel')
    }

    /* ------------------------------------------------------------- cancel */
    {
      heard.length = 0
      await stream(browser, 'd5', 'start', { sessionId: 'w1', mime: MIME })
      await append(browser, 'd5', 0, slice(1))
      const cancelled = await stream(browser, 'd5', 'cancel')
      log(cancelled.kind === 'ok', 'cancel is answered ok')
      const done = await stream(browser, 'd5', 'done', { chunks: 1 })
      log(done.kind === 'failed' && heard.length === 0, 'a cancelled recording is gone and never transcribed')
      const unknown = await stream(browser, 'never', 'cancel')
      log(unknown.kind === 'ok', 'cancelling an id the desktop never held is still ok')
    }

    /* ------------------------------------------------------- idle timeout */
    {
      heard.length = 0
      await stream(browser, 'd6', 'start', { sessionId: 'w1', mime: MIME })
      await append(browser, 'd6', 0, slice(1))
      skew += DICTATION_STREAM_IDLE_MS - 10_000
      const still = await append(browser, 'd6', 1, slice(2))
      log(still.kind === 'ok', 'a recording idle for less than the timeout is kept')
      skew += DICTATION_STREAM_IDLE_MS + 1_000
      const late = await append(browser, 'd6', 2, slice(3))
      log(late.kind === 'failed' && /idle/.test(late.message), `one idle past DICTATION_STREAM_IDLE_MS is dropped (${late.message})`)
      const done = await stream(browser, 'd6', 'done', { chunks: 3 })
      log(done.kind === 'failed' && heard.length === 0, 'and cannot be finished')
    }

    /* ----------------------------------------------------- start refusals */
    {
      const pane = await stream(browser, 'd7', 'start', { sessionId: 'nope', mime: MIME })
      log(pane.kind === 'failed' && pane.code === 'unknown-session', 'a start for a pane that is gone is unknown-session')
      const mime = await stream(browser, 'd7', 'start', { sessionId: 'w1', mime: 'text/html' })
      log(mime.kind === 'failed' && mime.code === 'bad-frame', 'a start with a non-audio mime is bad-frame')
      const orphan = await append(browser, 'd7', 0, slice(1))
      log(orphan.kind === 'failed', 'an append to a recording never started is refused')
    }

    /* ------------------------------------------- the old N-of-M dictation */
    {
      heard.length = 0
      const parts = [slice(21), slice(22), slice(23)]
      const answers = []
      for (let i = 0; i < parts.length; i++) {
        answers.push(
          await request(browser, {
            kind: 'dictate',
            uploadId: 'old-1',
            sessionId: 'w1',
            mime: MIME,
            index: i,
            totalChunks: parts.length,
            data: parts[i].toString('base64')
          })
        )
      }
      log(
        answers[0].kind === 'ok' && answers[1].kind === 'ok' && answers[2].kind === 'dictation',
        'the old N-of-M dictate still answers ok, ok, dictation'
      )
      log(heard.length === 1 && heard[0].bytes.equals(Buffer.concat(parts)), 'and is transcribed once, in order')
    }

    /* ------------------------------------------------------ project files */
    {
      const top = await request(browser, { kind: 'project-files', projectId: 'p1' })
      const names = (top.entries ?? []).map((e) => `${e.dir ? 'd' : 'f'}:${e.name}`)
      log(
        top.kind === 'project-files' && top.path === '' && top.truncated === false,
        `the project's top folder is listed (${names.join(' ')})`
      )
      log(
        JSON.stringify(names.slice(0, 2)) === '["d:inner","d:src"]' && names.includes('f:README.md') && names.includes('f:big.txt'),
        'folders first, then files, by name — a link inside the project is listed as what it points at'
      )
      log(!names.some((n) => n.endsWith(':escape')), 'a junction pointing out of the project is left out of the list')
      if (fileLinkMade) log(!names.some((n) => n.endsWith(':leak.txt')), 'a file symlink pointing out of the project is left out too')
      const big = top.entries?.find((e) => e.name === 'big.txt')
      log(big?.size === BIG_BYTES && big.mtime > 0, 'entries carry size and mtime')

      const src = await request(browser, { kind: 'project-files', projectId: 'p1', path: 'src' })
      log(
        src.kind === 'project-files' && src.path === 'src' && src.entries.length === 1 && src.entries[0].name === 'a.ts' && src.entries[0].size === SOURCE.length,
        'a subfolder lists its file'
      )
      const read = await request(browser, { kind: 'project-file', projectId: 'p1', path: 'src/a.ts' })
      log(
        read.kind === 'project-file' && read.content === SOURCE && read.truncated === false && read.path === 'src/a.ts' && read.size === SOURCE.length,
        'a text file inside the project is read whole'
      )
      const back = await request(browser, { kind: 'project-file', projectId: 'p1', path: 'src\\a.ts' })
      log(back.kind === 'project-file' && back.path === 'src/a.ts', 'a backslash path is read too, and answered with /')
      const inner = await request(browser, { kind: 'project-file', projectId: 'p1', path: 'inner/a.ts' })
      log(inner.kind === 'project-file' && inner.content === SOURCE, 'a link that stays inside the project may be read through')

      const climbs = [
        '..',
        '../outside/secret.txt',
        'src/../../outside/secret.txt',
        'src/../README.md'
      ]
      for (const path of climbs) {
        const r = await request(browser, { kind: 'project-file', projectId: 'p1', path })
        log(r.kind === 'failed' && r.code === 'failed' && /climbs/.test(r.message), `"${path}" is refused (${r.message})`)
      }
      const listClimb = await request(browser, { kind: 'project-files', projectId: 'p1', path: '..' })
      log(listClimb.kind === 'failed', 'listing ".." is refused')
      for (const path of [join(outside, 'secret.txt'), '/etc/passwd', '\\\\server\\share\\x', 'C:secret.txt']) {
        const r = await request(browser, { kind: 'project-file', projectId: 'p1', path })
        log(r.kind === 'failed' && /absolute/.test(r.message), `absolute "${path}" is refused (${r.message})`)
      }
      const ads = await request(browser, { kind: 'project-file', projectId: 'p1', path: 'README.md:hidden' })
      log(ads.kind === 'failed', 'an alternate data stream name is refused')
      const escRead = await request(browser, { kind: 'project-file', projectId: 'p1', path: 'escape/secret.txt' })
      log(escRead.kind === 'failed' && /outside the project/.test(escRead.message), `a read through a junction out of the project is refused (${escRead.message})`)
      const escList = await request(browser, { kind: 'project-files', projectId: 'p1', path: 'escape' })
      log(escList.kind === 'failed' && /outside the project/.test(escList.message), 'and so is listing it')
      if (fileLinkMade) {
        const leak = await request(browser, { kind: 'project-file', projectId: 'p1', path: 'leak.txt' })
        log(leak.kind === 'failed' && /outside the project/.test(leak.message), 'a file symlink out of the project is refused')
      } else {
        console.log('SKIP  file symlink escape: this account may not create file symlinks (the junction cases above cover the realpath check)')
      }

      const bin = await request(browser, { kind: 'project-file', projectId: 'p1', path: 'bin.dat' })
      log(bin.kind === 'failed' && /binary/.test(bin.message), `a binary file is refused in a sentence (${bin.message})`)
      const huge = await request(browser, { kind: 'project-file', projectId: 'p1', path: 'big.txt' })
      const hugeBytes = Buffer.byteLength(huge.content ?? '', 'utf8')
      log(
        huge.kind === 'project-file' &&
          huge.truncated === true &&
          huge.size === BIG_BYTES &&
          hugeBytes <= MAX_PROJECT_FILE_BYTES &&
          hugeBytes >= MAX_PROJECT_FILE_BYTES - 3 &&
          !huge.content.includes('�'),
        `a 1 MB text file is cut to ${hugeBytes} bytes on a character boundary with truncated set`
      )
      const dir = await request(browser, { kind: 'project-file', projectId: 'p1', path: 'src' })
      log(dir.kind === 'failed', 'reading a folder is refused')
      const notDir = await request(browser, { kind: 'project-files', projectId: 'p1', path: 'README.md' })
      log(notDir.kind === 'failed', 'listing a file is refused')
      const missing = await request(browser, { kind: 'project-file', projectId: 'p1', path: 'nope.txt' })
      log(missing.kind === 'failed' && /moved or deleted/.test(missing.message), 'a file that is not there is a sentence')
      const unknown = await request(browser, { kind: 'project-files', projectId: 'p9' })
      log(unknown.kind === 'failed' && unknown.code === 'unknown-project', 'a project the desktop does not have is unknown-project')

      const git = await request(browser, { kind: 'project-file', projectId: 'p1', path: 'project/src/a.ts', git: true })
      log(
        git.kind === 'project-file' && git.content === SOURCE && git.path === 'src/a.ts',
        `a git-status path (repo-relative) is read and answered project-relative (${git.path ?? git.message})`
      )
      const gitOut = await request(browser, { kind: 'project-file', projectId: 'p1', path: 'outside/secret.txt', git: true })
      log(gitOut.kind === 'failed' && /outside the project/.test(gitOut.message), 'a git-status path outside the project is refused')
    }

    /* -------------------------------------------- the older-shaped desktop */
    {
      const { browser: old, frame: oldHello } = await hello({}, BARE_PORT)
      log(oldHello.type === 'hello-ok' && !('features' in oldHello), 'a desktop with neither hook announces no features field at all')
      const d = await request(old, { kind: 'dictate-stream', op: 'start', dictationId: 'x', sessionId: 'w1', mime: MIME })
      const f = await request(old, { kind: 'project-files', projectId: 'p1' })
      log(d.code === 'unsupported' && f.code === 'unsupported', 'and answers both requests unsupported')
    }

    /* ---------------------------------------------------- proto refusal */
    {
      const newer = await hello({ proto: WEB_PROTO + 1 })
      log(
        newer.frame.type === 'refused' &&
          newer.frame.reason === 'proto' &&
          newer.frame.appVersion === '0.0.0-io' &&
          newer.frame.proto === WEB_PROTO,
        `a newer page is refused proto with the desktop's version and proto (${newer.frame.appVersion}, ${newer.frame.proto})`
      )
      log(/Restart Forge on the desktop/.test(newer.frame.message), `and told the desktop is the old side ("${newer.frame.message}")`)
      await waitFor(() => newer.browser.closed !== null, 3000, 'the refused socket to close')
      log(newer.browser.closed === 4002, 'the socket closes with CLOSE_PROTO')
      const older = await hello({ proto: WEB_PROTO - 1 })
      log(
        older.frame.reason === 'proto' && /Reload the page/.test(older.frame.message) && older.frame.proto === WEB_PROTO,
        `an older page is told to reload ("${older.frame.message}")`
      )
      // A refusal sentence past the 123-byte WebSocket close-reason limit must
      // still close the socket: `ws` throws on a long reason, and the full
      // sentence belongs in the frame, not the close.
      const far = await hello({ proto: 123456789012345 })
      await waitFor(() => far.browser.closed !== null, 3000, 'a long proto refusal to close').catch(() => {})
      log(
        far.frame.reason === 'proto' && Buffer.byteLength(far.frame.message) > 123 && far.browser.closed === 4002,
        `a refusal whose sentence is ${Buffer.byteLength(far.frame.message)} bytes still closes the socket (${far.browser.closed})`
      )
      const ok = await hello()
      log(ok.frame.type === 'hello-ok' && !('appVersion' in (ok.browser.first('refused') ?? {})), 'a matching page is still admitted')
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

  rmSync(scratch, { recursive: true, force: true })
  console.log(failures ? `\n${failures} check(s) FAILED` : '\nall io checks passed')
  process.exit(failures ? 1 : 0)
}

main().catch((err) => {
  console.error(err)
  rmSync(scratch, { recursive: true, force: true })
  process.exit(1)
})
