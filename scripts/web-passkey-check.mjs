/**
 * Head-less proof that a phone's passkey can unlock Forge Web in place of the
 * PIN — and that every way of getting a passkey wrong is a wrong PIN.
 *
 *   npm run web:passkey
 *
 * Bundles the *real* electron/web/server.ts, electron/web/auth.ts and
 * electron/web/passkey.ts with esbuild and drives them over a real WebSocket,
 * the way scripts/web-smoke.mjs does. Google is stubbed exactly as it is there
 * (a self-signed certificate in the securetoken shape, JWTs minted against
 * it), and the phone's platform authenticator is stubbed here: a P-256 key (and
 * an RSA one, for the RS256 path) with hand-built authenticator data,
 * clientDataJSON and a `fmt: 'none'` attestation object in CBOR — the bytes a
 * browser would hand the page, so the desktop's parser meets the real shape.
 *
 * The store is the real file store, in a scratch folder, so "the PIN changed
 * and the passkeys were wiped" is observed on disk rather than inferred.
 */
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { createHash, createSign, generateKeyPairSync, randomBytes, sign } from 'node:crypto'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import { WebSocket } from 'ws'

const ROOT = resolve(import.meta.dirname, '..')
const scratch = join(ROOT, 'node_modules', '.forge-web-passkey')
rmSync(scratch, { recursive: true, force: true })
mkdirSync(scratch, { recursive: true })

const PORT = 8487
const PROJECT = 'forge-web-passkey'
const UID = 'ULFo0dLmQ1bXQ8mJ2v7hZ4pTgS93'
const KID = 'passkey-kid-1'
const ORIGIN = 'https://forge-web.web.app'
/** A second page this desktop also serves — Firebase gives every site two. */
const ORIGIN2 = 'https://forge-web.firebaseapp.com'
const RP_ID = 'forge-web.web.app'
const PIN = '4826'
const PIN2 = '9173'

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
const sha256 = (data) => createHash('sha256').update(data).digest()

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

/* ------------------------------------------------------------ a CBOR writer */

function cborHead(major, n) {
  if (n < 24) return Buffer.from([(major << 5) | n])
  if (n < 0x100) return Buffer.from([(major << 5) | 24, n])
  if (n < 0x10000) {
    const b = Buffer.alloc(3)
    b[0] = (major << 5) | 25
    b.writeUInt16BE(n, 1)
    return b
  }
  const b = Buffer.alloc(5)
  b[0] = (major << 5) | 26
  b.writeUInt32BE(n, 1)
  return b
}
function cbor(value) {
  if (typeof value === 'number') return value >= 0 ? cborHead(0, value) : cborHead(1, -1 - value)
  if (Buffer.isBuffer(value)) return Buffer.concat([cborHead(2, value.length), value])
  if (typeof value === 'string') {
    const bytes = Buffer.from(value, 'utf8')
    return Buffer.concat([cborHead(3, bytes.length), bytes])
  }
  if (Array.isArray(value)) return Buffer.concat([cborHead(4, value.length), ...value.map(cbor)])
  if (value instanceof Map) {
    const parts = [cborHead(5, value.size)]
    for (const [k, v] of value) parts.push(cbor(k), cbor(v))
    return Buffer.concat(parts)
  }
  throw new Error(`cannot encode ${typeof value}`)
}

/* --------------------------------------------- a phone's platform authenticator */

const UP = 0x01
const UV = 0x04
const AT = 0x40

/**
 * One passkey on one phone. `counting` is whether its signature counter
 * moves: hardware keys count, most synced passkeys send zero forever, and the
 * desktop has to accept both.
 */
function makeAuthenticator(kind, { counting, bits = 2048, exponent, padModulus = false }) {
  const pair =
    kind === 'ec' ? generateKeyPairSync('ec', { namedCurve: 'P-256' }) : generateKeyPairSync('rsa', { modulusLength: bits })
  const id = randomBytes(16)
  let counter = 0
  let userHandle = ''
  const cose = () => {
    const jwk = pair.publicKey.export({ format: 'jwk' })
    const bytes = (s) => Buffer.from(s, 'base64url')
    // `exponent` and `padModulus` forge a key the desktop must refuse: a
    // weak public exponent, or a short modulus zero-padded to 256 bytes.
    if (kind === 'ec') return new Map([[1, 2], [3, -7], [-1, 1], [-2, bytes(jwk.x)], [-3, bytes(jwk.y)]])
    const n = padModulus ? Buffer.concat([Buffer.from([0]), bytes(jwk.n)]) : bytes(jwk.n)
    return new Map([[1, 3], [3, -257], [-1, n], [-2, exponent ?? bytes(jwk.e)]])
  }
  const u32 = (n) => {
    const b = Buffer.alloc(4)
    b.writeUInt32BE(n)
    return b
  }
  return {
    id: b64url(id),
    /** `navigator.credentials.create`, as the phone would answer it. */
    create(options, { origin = ORIGIN, flags = UP | UV | AT, challenge = options.challenge } = {}) {
      userHandle = options.user.id
      const idLength = Buffer.alloc(2)
      idLength.writeUInt16BE(id.length)
      const authData = Buffer.concat([
        sha256(options.rp.id),
        Buffer.from([flags]),
        u32(counter),
        Buffer.alloc(16),
        idLength,
        id,
        cbor(cose())
      ])
      const clientDataJSON = JSON.stringify({ type: 'webauthn.create', challenge, origin, crossOrigin: false })
      const attestationObject = cbor(new Map([['fmt', 'none'], ['attStmt', new Map()], ['authData', authData]]))
      return { clientDataJSON: b64url(clientDataJSON), attestationObject: b64url(attestationObject) }
    },
    /** `navigator.credentials.get`, as the phone would answer it. */
    get(
      options,
      { origin = ORIGIN, flags = UP | UV, challenge = options.challenge, badSignature = false, signCount, handle = userHandle } = {}
    ) {
      if (counting) counter += 1
      const authData = Buffer.concat([sha256(options.rpId), Buffer.from([flags]), u32(signCount ?? counter)])
      const clientDataJSON = Buffer.from(JSON.stringify({ type: 'webauthn.get', challenge, origin, crossOrigin: false }))
      const signature = sign('sha256', Buffer.concat([authData, sha256(clientDataJSON)]), pair.privateKey)
      if (badSignature) signature[signature.length - 1] ^= 0x01
      return {
        credentialId: b64url(id),
        authenticatorData: b64url(authData),
        clientDataJSON: b64url(clientDataJSON),
        signature: b64url(signature),
        userHandle: handle
      }
    }
  }
}

/** The same assertion with one bit of its signature flipped. */
function tampered(assertion) {
  const signature = Buffer.from(assertion.signature, 'base64url')
  signature[signature.length - 1] ^= 0x01
  return { ...assertion, signature: b64url(signature) }
}

/* ------------------------------------------------------------------- main */

async function main() {
  await build({
    stdin: {
      contents: [
        "export { WebServer } from './electron/web/server'",
        "export { WebAuth } from './electron/web/auth'",
        "export { hashPin } from './electron/web/pin'",
        "export { filePasskeyStorage } from './electron/web/passkey'",
        "export { WEB_PROTO, WEB_SUBPROTOCOL, WEB_WS_PATH, WEB_FEATURE_PASSKEY } from './shared/web'",
        "export { AUTH_MAX_FAILURES, AUTH_LOCKOUT_MS } from './shared/mobile'"
      ].join('\n'),
      resolveDir: ROOT,
      sourcefile: 'web-passkey-entry.ts',
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
    hashPin,
    filePasskeyStorage,
    WEB_PROTO,
    WEB_SUBPROTOCOL,
    WEB_WS_PATH,
    WEB_FEATURE_PASSKEY,
    AUTH_MAX_FAILURES,
    AUTH_LOCKOUT_MS
  } = await import(pathToFileURL(join(scratch, 'web.mjs')).href)

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

  let pinHash = ''
  /** Moved forward to ride out a lockout or a challenge's life without sleeping. */
  let skew = 0
  const storeFile = join(scratch, 'data', 'web-passkeys.json')
  const logLines = []
  const auth = new WebAuth({
    fetchJwks: async () => ({ body: JSON.stringify(served), cacheControl: 'public, max-age=21600' }),
    projectId: () => PROJECT,
    uid: () => UID,
    pinHash: () => pinHash,
    passkeys: filePasskeyStorage(storeFile),
    now: () => Date.now() + skew,
    log: (line) => logLines.push(line)
  })
  const mirrorEdges = []
  /** The server's own log, read only to know it has noticed a socket close. */
  const serverLines = []
  const server = new WebServer({
    auth,
    appVersion: '0.0.0-passkey',
    desktopName: () => 'PASSKEY-PC',
    allowedOrigins: () => [ORIGIN, ORIGIN2],
    sessions: () => [],
    replay: () => '',
    write: () => false,
    resize: () => false,
    snapshot: () => ({ projects: [], profiles: [], workspaces: {} }),
    layout: async () => null,
    // What electron/web-host.ts's `startMirror` does with the PIN, minus the
    // settings toggle and the window: the fresh check, passkey included.
    mirrorStart: (pin, who, passkey) => {
      const fresh = auth.checkFreshPin(pin, who, passkey)
      if (!fresh.ok) {
        return { error: fresh.message, ...(fresh.needed ? { needsPin: true } : {}), ...(fresh.passkey ? { passkey: fresh.passkey } : {}) }
      }
      return null
    },
    onMirror: (watching) => mirrorEdges.push(watching),
    log: (line) => serverLines.push(line)
  })
  await server.start({ host: '127.0.0.1', port: PORT })

  const open = []
  function connect(origin = ORIGIN) {
    const socket = new WebSocket(`ws://127.0.0.1:${PORT}${WEB_WS_PATH}`, [WEB_SUBPROTOCOL], { origin })
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

  /** One `hello`, answered: the browser plus the `hello-ok` or `refused` it got. */
  async function hello(extra = {}, origin = ORIGIN) {
    const browser = await connect(origin)
    browser.send({ type: 'hello', proto: WEB_PROTO, idToken: mint(), client: 'passkey-check', deviceId: 'dev-1', deviceName: 'Pixel', ...extra })
    await waitFor(() => browser.first('hello-ok') || browser.first('refused'), 5000, 'an answer to hello')
    return { browser, frame: browser.first('hello-ok') ?? browser.first('refused') }
  }

  let rid = 0
  async function request(browser, body) {
    const id = `r${++rid}`
    browser.send({ type: 'request', rid: id, body })
    await waitFor(() => browser.frames.some((f) => f.type === 'result' && f.rid === id), 5000, `result ${id}`)
    return browser.frames.find((f) => f.type === 'result' && f.rid === id).body
  }

  /**
   * Hang an admitted browser up and wait until the desktop has noticed — the
   * moment a resume ticket's PASSKEY_RESUME_MS starts. Named, because other
   * sockets may be closing at the same time.
   */
  async function hangUp(browser, name) {
    browser.socket.close()
    await waitFor(() => serverLines.some((l) => l.includes(`${name} disconnected`)), 5000, `${name} to be noticed gone`)
  }

  /** A fresh set of request options, off the `pin-required` refusal a PIN-less hello gets. */
  async function unlockOptions() {
    const { frame } = await hello()
    return frame
  }

  /** Why the desktop said no to the last passkey — the log line the browser never sees. */
  const why = () => logLines.filter((l) => l.startsWith('web auth: passkey refused')).at(-1) ?? ''
  /** Why the desktop said no to the last resume ticket — also the log's alone. */
  const whyResume = () => logLines.filter((l) => l.startsWith('web auth: resume ticket refused')).at(-1) ?? ''
  /** Log lines saying a correct answer over a stale challenge was asked again. */
  const retries = () => logLines.filter((l) => l.includes('correctly — asking again')).length

  /** One `mirror-start`, answered: `started`, or the `mirror-stop` it got. */
  async function mirrorTry(browser, extra = {}) {
    const stops = () => browser.frames.filter((f) => f.type === 'mirror-stop')
    const starts = () => mirrorEdges.filter((edge) => edge === true).length
    const stopsBefore = stops().length
    const startsBefore = starts()
    browser.send({ type: 'mirror-start', ...extra })
    await waitFor(() => stops().length > stopsBefore || starts() > startsBefore, 5000, 'an answer to mirror-start')
    const stop = stops()[stopsBefore]
    return { started: !stop, stop }
  }

  const onDisk = () => (existsSync(storeFile) ? JSON.parse(readFileSync(storeFile, 'utf8')) : null)
  const phoneA = makeAuthenticator('ec', { counting: true })
  const phoneB = makeAuthenticator('rsa', { counting: false })

  try {
    /* ---------------------------------------- no PIN set: nothing to enrol under */
    {
      const { browser, frame } = await hello()
      log(frame.type === 'hello-ok', 'with no PIN set the account alone is admitted, as before')
      log(
        Array.isArray(frame.features) && frame.features.includes(WEB_FEATURE_PASSKEY),
        `hello-ok announces the passkey feature (${JSON.stringify(frame.features)})`
      )
      const listed = await request(browser, { kind: 'passkey-list' })
      log(listed.kind === 'passkeys' && listed.canRegister === false, 'a socket that never passed a PIN is told it may not enrol')
      const begun = await request(browser, { kind: 'passkey-register-begin' })
      log(
        begun.kind === 'failed' && begun.code === 'unsupported',
        `registering on a socket that has not passed the PIN is refused (${begun.kind}: ${begun.message ?? ''})`
      )
      browser.socket.close()
    }

    pinHash = hashPin(PIN)

    /* ------------------------------------------------ the old PIN door, unchanged */
    let unlocked
    {
      const { frame } = await hello()
      log(frame.type === 'refused' && frame.reason === 'pin-required', 'a PIN-less hello is asked for the PIN')
      log(!('passkey' in frame), 'and, with no passkeys enrolled, is offered no passkey')
      const second = await hello({ pin: PIN })
      log(second.frame.type === 'hello-ok', 'an old-style hello carrying the PIN is admitted unchanged')
      unlocked = second.browser
    }

    /* ----------------------------------------------------------- enrolment */
    {
      const listed = await request(unlocked, { kind: 'passkey-list' })
      log(listed.canRegister === true && listed.passkeys.length === 0, 'a PIN-unlocked socket may enrol, and has nothing yet')

      const begun = await request(unlocked, { kind: 'passkey-register-begin' })
      const o = begun.options ?? {}
      log(begun.kind === 'passkey-options', 'registration begins on an unlocked socket')
      log(
        o.rp?.id === RP_ID && o.rp?.name === 'Forge' && Buffer.from(o.challenge ?? '', 'base64url').length === 32,
        `creation options name this page as the RP (${o.rp?.id}) with a 32-byte challenge`
      )
      log(
        JSON.stringify(o.pubKeyCredParams?.map((p) => p.alg)) === '[-7,-257]' &&
          o.authenticatorSelection?.authenticatorAttachment === 'platform' &&
          o.authenticatorSelection?.userVerification === 'required' &&
          o.authenticatorSelection?.residentKey === 'preferred' &&
          o.attestation === 'none' &&
          Array.isArray(o.excludeCredentials) &&
          o.excludeCredentials.length === 0,
        'ES256 then RS256, platform, UV required, resident preferred, attestation none, nothing excluded'
      )
      log(
        typeof o.user?.id === 'string' && o.user.id.length > 0 && !o.user.id.includes(UID) && !String(o.user.name).includes('@'),
        'the WebAuthn user id is opaque — neither the uid nor an email'
      )

      const noUv = phoneA.create(o, { flags: UP | AT })
      const refusedNoUv = await request(unlocked, { kind: 'passkey-register-finish', ...noUv })
      log(refusedNoUv.kind === 'failed', 'a registration without the UV flag is refused')

      const again = await request(unlocked, { kind: 'passkey-register-begin' })
      const madeA = phoneA.create(again.options)
      const finished = await request(unlocked, { kind: 'passkey-register-finish', ...madeA, deviceName: 'Pixel 9' })
      log(
        finished.kind === 'passkeys' && finished.passkeys.length === 1 && finished.passkeys[0].credentialId === phoneA.id,
        'an ES256 passkey registers on an unlocked socket'
      )
      const replayedRegistration = await request(unlocked, { kind: 'passkey-register-finish', ...madeA })
      log(replayedRegistration.kind === 'failed', 'the same registration presented twice is refused (its challenge is spent)')
      const stored = onDisk()?.accounts?.[UID]
      log(
        stored?.length === 1 && stored[0].alg === -7 && typeof stored[0].publicKey === 'string' && stored[0].deviceName === 'Pixel 9',
        'and is written to the store file with its key, algorithm and name'
      )

      const third = await request(unlocked, { kind: 'passkey-register-begin' })
      log(
        third.options?.excludeCredentials?.some((c) => c.id === phoneA.id),
        'a later registration excludes the passkey already enrolled'
      )
      const madeB = phoneB.create(third.options)
      const finishedB = await request(unlocked, { kind: 'passkey-register-finish', ...madeB, deviceName: 'iPhone' })
      log(finishedB.kind === 'passkeys' && finishedB.passkeys.length === 2, 'an RS256 passkey registers beside it')

      // Weak RSA keys: refused at the door of the store, not later.
      const weak = [
        ['e = 1', makeAuthenticator('rsa', { counting: false, exponent: Buffer.from([1]) })],
        ['e = 65536', makeAuthenticator('rsa', { counting: false, exponent: Buffer.from([1, 0, 0]) })],
        ['a 2040-bit modulus zero-padded to 256 bytes', makeAuthenticator('rsa', { counting: false, bits: 2040, padModulus: true })]
      ]
      for (const [label, phone] of weak) {
        const begunWeak = await request(unlocked, { kind: 'passkey-register-begin' })
        const madeWeak = await request(unlocked, { kind: 'passkey-register-finish', ...phone.create(begunWeak.options) })
        const line = logLines.filter((l) => l.startsWith('web auth: passkey enrolment refused')).at(-1) ?? ''
        log(
          madeWeak.kind === 'failed' && line.includes('not ES256 or RS256'),
          `an RS256 key with ${label} is refused at enrolment (${line})`
        )
      }
      const afterWeak = await request(unlocked, { kind: 'passkey-list' })
      log(afterWeak.passkeys.length === 2, 'and none of them reached the store')
      unlocked.socket.close()
    }

    /* -------------------------------------------------------------- unlock */
    {
      const asked = await unlockOptions()
      const p = asked.passkey
      log(
        asked.reason === 'pin-required' && p?.rpId === RP_ID && p?.userVerification === 'required' && typeof p?.timeout === 'number',
        'pin-required now carries passkey request options for this page'
      )
      log(
        p?.allowCredentials?.length === 2 && p.allowCredentials.some((c) => c.id === phoneA.id),
        'naming both of this account’s passkeys'
      )
      const { browser, frame } = await hello({ passkey: phoneA.get(p) })
      log(frame.type === 'hello-ok', 'a valid ES256 assertion unlocks — hello-ok, exactly as a correct PIN')
      // A passkey may not mint or remove another: only the PIN changes the set.
      const listed = await request(browser, { kind: 'passkey-list' })
      log(
        listed.kind === 'passkeys' && listed.passkeys.length === 2 && listed.canRegister === false,
        'a passkey-unlocked socket may list the passkeys, and is told it may not enrol'
      )
      const begun = await request(browser, { kind: 'passkey-register-begin' })
      log(begun.kind === 'failed' && begun.code === 'unsupported', `a passkey-unlocked socket is refused enrolment (${begun.kind})`)
      const forget = await request(browser, { kind: 'passkey-forget', credentialId: phoneB.id })
      const still = await request(browser, { kind: 'passkey-list' })
      log(
        forget.kind === 'failed' && forget.code === 'unsupported' && still.passkeys.length === 2,
        `a passkey-unlocked socket is refused forgetting one (${forget.kind}, ${still.passkeys.length} left)`
      )
      browser.socket.close()
    }

    /* ------------------------------------------------------ resume tickets */
    {
      const isTicket = (t) => typeof t === 'string' && Buffer.from(t, 'base64url').length === 32
      const asked = (frame) => frame.type === 'refused' && frame.reason === 'pin-required'
      const first = await hello({ passkey: phoneA.get((await unlockOptions()).passkey), deviceName: 'Resume-1' })
      log(first.frame.type === 'hello-ok' && isTicket(first.frame.resume), 'a passkey hello-ok carries a 32-byte resume ticket')
      const byPin = await hello({ pin: PIN })
      log(byPin.frame.type === 'hello-ok' && !('resume' in byPin.frame), 'a PIN hello-ok carries no ticket')
      byPin.browser.socket.close()

      // The desktop has not noticed the phone's old socket die yet: still good.
      const whileOpen = await hello({ resume: first.frame.resume, deviceName: 'Resume-2' })
      log(
        whileOpen.frame.type === 'hello-ok' && isTicket(whileOpen.frame.resume) && whileOpen.frame.resume !== first.frame.resume,
        'a ticket whose socket is still open is admitted, and handed a new ticket'
      )
      await hangUp(first.browser, 'Resume-1')
      await hangUp(whileOpen.browser, 'Resume-2')

      skew += 29_000
      const resumed = await hello({ resume: whileOpen.frame.resume, deviceName: 'Resume-3' })
      log(
        resumed.frame.type === 'hello-ok' && isTicket(resumed.frame.resume) && resumed.frame.resume !== whileOpen.frame.resume,
        `a ticket 29 s after its socket closed is admitted with no PIN and no passkey, and handed a new, different one (${resumed.frame.type})`
      )
      log(logLines.some((l) => l.includes('"Resume-3" admitted') && l.includes('with a resume ticket')), 'and the desk log says it came in on a ticket')
      const listed = await request(resumed.browser, { kind: 'passkey-list' })
      const begun = await request(resumed.browser, { kind: 'passkey-register-begin' })
      log(
        listed.kind === 'passkeys' && listed.canRegister === false && begun.kind === 'failed' && begun.code === 'unsupported',
        `a ticket-admitted socket may not enrol a passkey, exactly as a passkey-admitted one (${begun.kind})`
      )

      const twice = await hello({ resume: whileOpen.frame.resume })
      log(
        asked(twice.frame) && twice.frame.passkey?.allowCredentials?.length === 2 && whyResume().includes('already spent'),
        `the same ticket twice: the second is asked for the PIN, passkey options and all (${whyResume()})`
      )

      await hangUp(resumed.browser, 'Resume-3')
      skew += 31_000
      const late = await hello({ resume: resumed.frame.resume })
      log(asked(late.frame) && whyResume().endsWith('expired'), `a ticket 31 s after its socket closed is asked for the PIN (${whyResume()})`)

      const fresh = await hello({ passkey: phoneA.get((await unlockOptions()).passkey) })
      const otherDevice = await hello({ resume: fresh.frame.resume, deviceId: 'dev-2' })
      log(asked(otherDevice.frame) && whyResume().endsWith('another browser'), `a ticket from another browser is asked for the PIN (${whyResume()})`)
      const spent = await hello({ resume: fresh.frame.resume })
      log(asked(spent.frame) && whyResume().includes('already spent'), `and that attempt spent it: its own browser is asked too (${whyResume()})`)
      fresh.browser.socket.close()

      const fresh2 = await hello({ passkey: phoneA.get((await unlockOptions()).passkey) })
      const otherPage = await hello({ resume: fresh2.frame.resume }, ORIGIN2)
      log(asked(otherPage.frame) && whyResume().endsWith('another page'), `a ticket presented from another page is asked for the PIN (${whyResume()})`)
      fresh2.browser.socket.close()

      let neverStruck = true
      for (let i = 0; i < AUTH_MAX_FAILURES + 2; i++) {
        const junk = await hello({ resume: i % 2 ? b64url(randomBytes(32)) : 'not a ticket at all' })
        if (!asked(junk.frame)) neverStruck = false
      }
      log(neverStruck, `${AUTH_MAX_FAILURES + 2} garbage and unknown tickets are each asked for the PIN, none pin-invalid`)
      const pinAfter = await hello({ pin: PIN })
      log(pinAfter.frame.type === 'hello-ok', `and struck nothing: the correct PIN still gets in (${pinAfter.frame.type})`)
      pinAfter.browser.socket.close()
    }

    /* -------------------------------------------- failures are wrong PINs */
    {
      const optionsB = (await unlockOptions()).passkey
      const answerB = phoneB.get(optionsB)
      const first = await hello({ passkey: answerB })
      log(first.frame.type === 'hello-ok', 'a valid RS256 assertion from a non-counting authenticator unlocks')
      first.browser.socket.close()
      // A retry after a lost hello-ok: the right key over a spent challenge.
      // Not admitted, not struck — asked again with a fresh challenge.
      const retriesBefore = retries()
      const replay = await hello({ passkey: answerB })
      log(
        replay.frame.type === 'refused' &&
          replay.frame.reason === 'pin-required' &&
          typeof replay.frame.passkey?.challenge === 'string' &&
          replay.frame.passkey.challenge !== optionsB.challenge &&
          retries() === retriesBefore + 1,
        `a valid assertion over a spent challenge is not admitted: pin-required with a fresh challenge (${replay.frame.reason})`
      )
      // …but the same spent challenge with a signature that does not verify
      // is a guess, and is struck (1 of 5).
      const replayForged = await hello({ passkey: tampered(answerB) })
      log(
        replayForged.frame.reason === 'pin-invalid' &&
          why().includes('already-used challenge') &&
          why().includes('signature does not verify'),
        `an invalid signature over a spent challenge is refused as pin-invalid (${why()})`
      )

      const wrongOrigin = await hello({ passkey: phoneA.get((await unlockOptions()).passkey, { origin: 'https://evil.example' }) })
      log(
        wrongOrigin.frame.reason === 'pin-invalid' && why().includes('clientData origin https://evil.example'),
        `an assertion whose clientData names another origin is refused as pin-invalid (${why()})`
      )

      const optionsForOne = (await unlockOptions()).passkey
      const otherPage = await hello({ passkey: phoneA.get(optionsForOne, { origin: ORIGIN2 }) }, ORIGIN2)
      log(
        otherPage.frame.reason === 'pin-invalid' && why().includes(`not ${ORIGIN2}`),
        `a challenge issued to one page and answered from another is refused as pin-invalid (${why()})`
      )

      const noUv = await hello({ passkey: phoneA.get((await unlockOptions()).passkey, { flags: UP }) })
      log(
        noUv.frame.reason === 'pin-invalid' && why().includes('user verification flag missing'),
        `an assertion without the UV flag is refused as pin-invalid (${why()})`
      )

      const badSig = await hello({ passkey: phoneA.get((await unlockOptions()).passkey, { badSignature: true }) })
      log(
        badSig.frame.reason === 'pin-invalid' && why().includes('signature does not verify'),
        `an assertion with a wrong signature is refused as pin-invalid (${why()})`
      )

      const locked = await hello({ pin: PIN })
      log(
        locked.frame.type === 'refused' && locked.frame.reason === 'busy',
        `after ${AUTH_MAX_FAILURES} bad assertions even the correct PIN is locked out (${locked.frame.reason}) — the same bucket a wrong PIN strikes`
      )

      skew += AUTH_LOCKOUT_MS + 1000
      const after = await hello({ pin: PIN })
      log(after.frame.type === 'hello-ok', 'and once the lockout lapses the PIN opens the door again')
      after.browser.socket.close()

      // A slow fingerprint: the right answer, too late. Asked again, unstruck.
      const stale = (await unlockOptions()).passkey
      skew += 2 * 60_000 + 1000
      const expired = await hello({ passkey: phoneA.get(stale) })
      log(
        expired.frame.type === 'refused' &&
          expired.frame.reason === 'pin-required' &&
          expired.frame.passkey?.challenge &&
          expired.frame.passkey.challenge !== stale.challenge &&
          (logLines.filter((l) => l.includes('correctly — asking again')).at(-1) ?? '').includes('expired challenge'),
        `a valid assertion over a challenge older than two minutes is not admitted: pin-required, fresh challenge (${expired.frame.reason})`
      )
    }

    /* ------------------- a correct answer retried never locks the door (F1) */
    {
      skew += AUTH_LOCKOUT_MS + 1000
      const options = (await unlockOptions()).passkey
      const answer = phoneA.get(options)
      const first = await hello({ passkey: answer })
      log(first.frame.type === 'hello-ok', 'a counting ES256 passkey unlocks')
      first.browser.socket.close()
      // Five retries of that same answer, as a phone whose hello-ok kept
      // getting lost would send. Five wrong PINs would lock the door.
      let fresh = null
      let allAsked = true
      const seen = new Set([options.challenge])
      for (let i = 0; i < AUTH_MAX_FAILURES; i++) {
        const retry = await hello({ passkey: answer })
        const c = retry.frame.passkey?.challenge
        if (retry.frame.type !== 'refused' || retry.frame.reason !== 'pin-required' || !c || seen.has(c)) allAsked = false
        seen.add(c)
        fresh = retry.frame.passkey
      }
      log(allAsked, `${AUTH_MAX_FAILURES} retries of a spent correct answer are each asked again with a new challenge, none admitted`)
      const pinAfter = await hello({ pin: PIN })
      log(pinAfter.frame.type === 'hello-ok', `and struck nothing: the correct PIN still gets in (${pinAfter.frame.type})`)
      pinAfter.browser.socket.close()
      const answered = await hello({ passkey: phoneA.get(fresh) })
      log(answered.frame.type === 'hello-ok', 'and answering the fresh challenge a retry was handed unlocks')
      answered.browser.socket.close()
    }

    /* ---------- counter, user handle, crossed purposes, a failed fresh check */
    {
      skew += AUTH_LOCKOUT_MS + 1000
      // phoneA has signed and been recorded several times; 1 is behind it. (strike 1)
      const backwards = await hello({ passkey: phoneA.get((await unlockOptions()).passkey, { signCount: 1 }) })
      log(
        backwards.frame.reason === 'pin-invalid' && why().includes('did not advance'),
        `a signCount that went backwards is refused as pin-invalid (${why()})`
      )
      // The desktop checks userHandle when the phone sends one. (strike 2)
      const otherUser = await hello({
        passkey: phoneA.get((await unlockOptions()).passkey, { handle: b64url(randomBytes(32)) })
      })
      log(
        otherUser.frame.reason === 'pin-invalid' && why().includes('userHandle is not this account'),
        `an assertion naming another account's userHandle is refused as pin-invalid (${why()})`
      )

      const { browser } = await hello({ pin: PIN })
      // A get challenge answered on the fresh path. (strike 3)
      const getOnFresh = await mirrorTry(browser, { passkey: phoneA.get((await unlockOptions()).passkey) })
      log(
        !getOnFresh.started && getOnFresh.stop.reason === 'That PIN was not accepted.' && !getOnFresh.stop.needsPin && why().includes('for get, not fresh'),
        `a get challenge presented to the fresh check is refused (${why()})`
      )
      // A fresh challenge answered at the door. (strike 4)
      const asked = await mirrorTry(browser)
      const freshAtDoor = await hello({ passkey: phoneA.get(asked.stop.passkey) })
      log(
        freshAtDoor.frame.reason === 'pin-invalid' && why().includes('for fresh, not get'),
        `a fresh-check challenge presented at hello is refused (${why()})`
      )
      const fourStruck = await hello({ pin: PIN })
      log(fourStruck.frame.type === 'hello-ok', 'four strikes so far: the PIN still gets in')
      fourStruck.browser.socket.close()
      // A failed fresh check strikes like a wrong PIN: this is the fifth.
      const askedAgain = await mirrorTry(browser)
      const badFresh = await mirrorTry(browser, { passkey: phoneA.get(askedAgain.stop.passkey, { badSignature: true }) })
      log(
        !badFresh.started && badFresh.stop.reason === 'That PIN was not accepted.' && !badFresh.stop.needsPin,
        'a fresh check with a bad signature is refused as a wrong PIN'
      )
      const locked = await hello({ pin: PIN })
      log(locked.frame.reason === 'busy', `and it struck: the fifth strike locks out the PIN (${locked.frame.reason})`)
      browser.socket.close()
    }

    /* ------------------- enrolment begins cannot evict a pending get (F2) */
    {
      skew += AUTH_LOCKOUT_MS + 1000
      const pending = (await unlockOptions()).passkey
      const { browser } = await hello({ pin: PIN })
      let begun = 0
      for (let i = 0; i < 64; i++) {
        if ((await request(browser, { kind: 'passkey-register-begin' })).kind === 'passkey-options') begun++
      }
      browser.socket.close()
      const answered = await hello({ passkey: phoneA.get(pending) })
      log(
        begun === 64 && answered.frame.type === 'hello-ok',
        `64 enrolment begins leave a pending get challenge answerable (${answered.frame.type}${answered.frame.reason ? ` ${answered.frame.reason}` : ''})`
      )
      answered.browser.socket.close()
    }

    /* ------------------------------------------------- the fresh check */
    let keeper
    {
      const { browser } = await hello({ pin: PIN })
      keeper = browser
      browser.send({ type: 'mirror-start' })
      await waitFor(() => browser.first('mirror-stop'), 5000, 'mirror-stop')
      const stop = browser.first('mirror-stop')
      log(stop.needsPin === true && stop.passkey?.allowCredentials?.length === 2, 'a fresh-PIN check offers a passkey with its own challenge')
      browser.send({ type: 'mirror-start', passkey: phoneA.get(stop.passkey) })
      await waitFor(() => mirrorEdges.includes(true), 5000, 'the mirror to start')
      log(mirrorEdges.includes(true), 'and a valid assertion over it passes the fresh check')
      browser.send({ type: 'mirror-stop' })
      await waitFor(() => mirrorEdges.at(-1) === false, 5000, 'the mirror to stop')
    }

    /* ------------------------- the fresh check: retries never strike (F1) */
    {
      skew += AUTH_LOCKOUT_MS + 1000
      const { browser } = await hello({ pin: PIN })
      const asked = await mirrorTry(browser)
      const answer = phoneA.get(asked.stop.passkey)
      const first = await mirrorTry(browser, { passkey: answer })
      log(first.started, 'a valid assertion starts the mirror')
      browser.send({ type: 'mirror-stop' })
      await waitFor(() => mirrorEdges.at(-1) === false, 5000, 'the mirror to stop')
      let allAsked = true
      for (let i = 0; i < AUTH_MAX_FAILURES; i++) {
        const retry = await mirrorTry(browser, { passkey: answer })
        const c = retry.stop?.passkey?.challenge
        if (retry.started || retry.stop.needsPin !== true || !c || c === asked.stop.passkey.challenge) allAsked = false
      }
      log(allAsked, `${AUTH_MAX_FAILURES} retries of a spent correct answer to the fresh check are each asked again (needsPin + a new challenge), none started`)
      const pinAfter = await hello({ pin: PIN })
      log(pinAfter.frame.type === 'hello-ok', `and struck nothing: the correct PIN still gets in (${pinAfter.frame.type})`)
      pinAfter.browser.socket.close()
      let allStruck = true
      for (let i = 0; i < AUTH_MAX_FAILURES; i++) {
        const forged = await mirrorTry(browser, { passkey: tampered(answer) })
        if (forged.started || forged.stop.needsPin || forged.stop.reason !== 'That PIN was not accepted.') allStruck = false
      }
      log(
        allStruck && why().includes('already-used challenge') && why().includes('signature does not verify'),
        `an invalid signature over a spent fresh challenge is refused as a wrong PIN (${why()})`
      )
      const locked = await hello({ pin: PIN })
      log(locked.frame.reason === 'busy', `and ${AUTH_MAX_FAILURES} of them lock out the PIN (${locked.frame.reason})`)
      browser.socket.close()
      skew += AUTH_LOCKOUT_MS + 1000
    }

    /* -------------------------------------------------------------- forget */
    {
      const optionsBefore = (await unlockOptions()).passkey
      const forgot = await request(keeper, { kind: 'passkey-forget', credentialId: phoneA.id })
      log(
        forgot.kind === 'passkeys' && forgot.passkeys.length === 1 && forgot.passkeys[0].credentialId === phoneB.id,
        'an unlocked socket forgets one passkey, leaving the other'
      )
      const forgotten = await hello({ passkey: phoneA.get(optionsBefore) })
      log(
        forgotten.frame.reason === 'pin-invalid' && why().includes('unknown credential'),
        `the forgotten passkey no longer unlocks (${why()})`
      )
      const asked = await unlockOptions()
      log(
        asked.passkey?.allowCredentials?.length === 1 && asked.passkey.allowCredentials[0].id === phoneB.id,
        'and is no longer offered'
      )
      const stillB = await hello({ passkey: phoneB.get(asked.passkey) })
      log(stillB.frame.type === 'hello-ok', 'while the one left still does')
      stillB.browser.socket.close()
    }

    /* --------------------------------------------------------- PIN change */
    {
      const ticketed = await hello({ passkey: phoneB.get((await unlockOptions()).passkey) })
      log(ticketed.frame.type === 'hello-ok' && typeof ticketed.frame.resume === 'string', 'a passkey unlock under the old PIN is handed a ticket')
      const optionsBefore = (await unlockOptions()).passkey
      pinHash = hashPin(PIN2)
      const oldTicket = await hello({ resume: ticketed.frame.resume })
      log(
        oldTicket.frame.type === 'refused' && oldTicket.frame.reason === 'pin-required' && whyResume().endsWith('the PIN has changed'),
        `after the PIN changes a ticket issued under the old one is asked for the PIN (${whyResume()})`
      )
      ticketed.browser.socket.close()
      const old = await hello({ passkey: phoneB.get(optionsBefore) })
      log(
        old.frame.reason === 'pin-invalid' && why().includes('unknown credential'),
        `after the PIN changes an old passkey is refused (${why()})`
      )
      const file = onDisk()
      log(
        file !== null && Object.keys(file.accounts ?? {}).length === 0,
        `and the store file has been wiped (${JSON.stringify(file?.accounts)})`
      )
      const asked = await unlockOptions()
      log(asked.reason === 'pin-required' && !('passkey' in asked), 'a PIN-less hello is offered no passkey any more')
      const listed = await request(keeper, { kind: 'passkey-list' })
      log(listed.canRegister === false, 'a socket unlocked under the old PIN may no longer enrol')
      const byNewPin = await hello({ pin: PIN2 })
      log(byNewPin.frame.type === 'hello-ok', 'and the new PIN opens the door')
      byNewPin.browser.socket.close()
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
  }

  rmSync(scratch, { recursive: true, force: true })
  console.log(failures ? `\n${failures} check(s) FAILED` : '\nall passkey checks passed')
  process.exit(failures ? 1 : 0)
}

main().catch((err) => {
  console.error(err)
  rmSync(scratch, { recursive: true, force: true })
  process.exit(1)
})
