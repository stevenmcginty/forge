/**
 * Head-less proof that the lock on Forge Web's door actually locks.
 *
 * Bundles the *real* electron/web/auth.ts with esbuild and drives that exact
 * class — no mock verifier, no stubbed refusal, no "assume the JWT library
 * works". This feature puts a shell on a home PC behind a public address, so a
 * refusal path that is not tested is a refusal path that does not work
 * (docs/forge-web.md, "the security tests are not optional").
 *
 *   npm run web:auth
 *
 * Everything Google would supply is generated here instead: an RSA keypair, a
 * self-signed X.509 certificate in the shape the securetoken endpoint publishes,
 * and JWTs minted against it. The certificate is hand-rolled in DER below
 * because node:crypto can read certificates and cannot write them, and serving
 * a bare public key instead would mean the production path — parsing what Google
 * actually sends — was the one path never exercised.
 *
 * The clock is injected, so token expiry and the lockout window are crossed by
 * assignment rather than by waiting.
 *
 * Every check gets its own `source` address, because the failure lockout is per
 * source and a shared one would mean check 3's strikes silently failing check 9.
 */
import { mkdirSync, readFileSync, rmSync } from 'node:fs'
import { createSign, generateKeyPairSync } from 'node:crypto'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const ROOT = resolve(import.meta.dirname, '..')
const scratch = join(ROOT, 'node_modules', '.forge-web-auth')
rmSync(scratch, { recursive: true, force: true })
mkdirSync(scratch, { recursive: true })

// The store writes under whatever this names, so the check never goes near
// Steve's real profile. Set before the bundle is imported: store.ts resolves
// its root lazily, on the first write.
process.env['FORGE_DATA_DIR'] = join(scratch, 'data')

const PROJECT = 'forge-web-check'
const OTHER_PROJECT = 'somebody-elses-project'
const UID = 'ULFo0dLmQ1bXQ8mJ2v7hZ4pTgS93'
const OTHER_UID = 'ZZZo0dLmQ1bXQ8mJ2v7hZ4pTgS93'
const KID = 'a1b2c3d4e5f6'
const KID_ROTATED = 'f6e5d4c3b2a1'

let failures = 0
const log = (ok, message) => {
  if (!ok) failures++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${message}`)
}

/* -------------------------------------------------- a certificate authority
 *
 * Minimal DER, and minimal on purpose: a v1 certificate is a serial, an
 * algorithm, a name, a validity window and the SPKI — which node:crypto will
 * hand over ready-made. Everything below is the ASN.1 wrapping around it.
 */

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

/** AlgorithmIdentifier for sha256WithRSAEncryption, with its NULL parameters. */
const SHA256_RSA = Buffer.from('300d06092a864886f70d01010b0500', 'hex')
/** OID 2.5.4.3 — commonName. */
const OID_CN = Buffer.from('0603550403', 'hex')

function utcTime(date) {
  const pad = (n) => String(n).padStart(2, '0')
  const text =
    `${pad(date.getUTCFullYear() % 100)}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}` +
    `${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}Z`
  return tlv(0x17, Buffer.from(text, 'ascii'))
}

/** A self-signed certificate carrying `pair.publicKey`, PEM-armoured. */
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

/* ------------------------------------------------------------ minting tokens */

const b64url = (value) => Buffer.from(value).toString('base64url')

async function main() {
  await build({
    entryPoints: [join(ROOT, 'scripts', 'fixtures', 'web-auth-entry.ts')],
    outfile: join(scratch, 'web-auth.mjs'),
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    alias: { '@shared': join(ROOT, 'shared') },
    logLevel: 'silent',
    absWorkingDir: ROOT
  })

  const {
    WebAuth,
    GOOGLE_JWKS_URL,
    CLOCK_SKEW_MS,
    setSettings,
    AUTH_LOCKOUT_MS,
    AUTH_MAX_FAILURES,
    PIN_MAX_DIGITS,
    PIN_MIN_DIGITS,
    hashPin,
    isValidPin,
    verifyPin
  } = await import(pathToFileURL(join(scratch, 'web-auth.mjs')).href)

  const google = generateKeyPairSync('rsa', { modulusLength: 2048 })
  const impostor = generateKeyPairSync('rsa', { modulusLength: 2048 })
  const rotated = generateKeyPairSync('rsa', { modulusLength: 2048 })

  /* --------------------------------------------------------- the desktop */

  let clock = 1_760_000_000_000
  let saved = []
  /** Everything ever handed to persistence, so check 13 can search all of it. */
  const persisted = []
  let served = { [KID]: certificateFor(google, 'securetoken.google.com') }
  // Mutable so check 16 can put the desktop back into the state it ships in.
  let projectId = PROJECT
  let uid = UID
  let jwksFetches = 0
  const jwksUrls = []
  /**
   * The unlock PIN, exactly as the Electron host holds it: the stored hash and
   * never the digits. Blank until check 17 sets one, which is also the state
   * the desktop ships in — so checks 1–16 are the account-only door and 17
   * onwards are the door with a PIN on it. Mutable rather than two `WebAuth`s,
   * so the same object is proved to behave both ways; a second instance would
   * prove two constructions agree, which is not the claim.
   */
  let pinHash = ''

  const auth = new WebAuth({
    load: () => saved,
    save: (devices) => {
      saved = devices
      persisted.push(JSON.stringify(devices))
    },
    fetchJwks: async (url) => {
      jwksFetches++
      jwksUrls.push(url)
      return { body: JSON.stringify(served), cacheControl: 'public, max-age=21600, must-revalidate' }
    },
    projectId: () => projectId,
    uid: () => uid,
    pinHash: () => pinHash,
    now: () => clock
  })

  const nowSec = () => Math.floor(clock / 1000)

  /** A Firebase ID token, correct in every way unless told otherwise. */
  function mint(overrides = {}, key = google.privateKey, kid = KID) {
    const header = b64url(JSON.stringify({ alg: overrides.alg ?? 'RS256', kid, typ: 'JWT' }))
    const claims = {
      aud: PROJECT,
      iss: `https://securetoken.google.com/${PROJECT}`,
      sub: UID,
      auth_time: nowSec() - 300,
      iat: nowSec() - 60,
      exp: nowSec() + 3600,
      ...overrides
    }
    delete claims.alg
    const payload = b64url(JSON.stringify(claims))
    const signature = createSign('RSA-SHA256').update(`${header}.${payload}`).sign(key)
    return `${header}.${payload}.${signature.toString('base64url')}`
  }

  const hello = (source, idToken, deviceId, deviceName = 'Chrome on Windows', extra = {}) => ({
    source,
    idToken,
    deviceId,
    deviceName,
    ...extra
  })

  /* ------------------------------------------ 1. the credential that works */

  saved = [{ id: 'browser-1', name: 'Chrome', createdAt: 1, lastSeenAt: 1, revokedAt: 0 }]
  const admitted = await auth.authenticate(hello('10.0.0.1', mint(), 'browser-1'))
  log(admitted.ok === true, 'a correctly signed, correctly claimed token for the configured uid and a known device is admitted')
  log(admitted.ok && admitted.claims.uid === UID, 'and the uid it verified as is handed back to the caller')
  log(saved.find((d) => d.id === 'browser-1')?.lastSeenAt === clock, 'and its last-seen is bumped on the injected clock')
  log(jwksUrls[0] === GOOGLE_JWKS_URL, "the keys were fetched from Google's published endpoint")

  /* ------------------------------------------------- 2. a broken signature */

  const good = mint()
  const [h, p, s] = good.split('.')
  const tampered = `${h}.${p}.${(s[0] === 'a' ? 'b' : 'a')}${s.slice(1)}`
  const brokenSig = await auth.authenticate(hello('10.0.0.2', tampered, 'browser-1'))
  log(brokenSig.ok === false && brokenSig.reason === 'bad-token', 'a token with a broken signature is bad-token')

  /* -------------------------------------------------------- 3. an old token */

  const expired = await auth.authenticate(
    hello('10.0.0.3', mint({ exp: nowSec() - 3600, iat: nowSec() - 7200, auth_time: nowSec() - 7200 }), 'browser-1')
  )
  log(expired.ok === false && expired.reason === 'bad-token', 'an expired token is bad-token')

  const nearlyExpired = await auth.authenticate(
    hello('10.0.0.4', mint({ exp: nowSec() - Math.floor(CLOCK_SKEW_MS / 1000) - 5 }), 'browser-1')
  )
  log(
    nearlyExpired.ok === false && nearlyExpired.reason === 'bad-token',
    'and one that expired just past the clock-skew allowance is still bad-token'
  )

  const futureAuth = await auth.authenticate(hello('10.0.0.17', mint({ auth_time: nowSec() + 3600 }), 'browser-1'))
  log(
    futureAuth.ok === false && futureAuth.reason === 'bad-token',
    'a token claiming it was authenticated in the future is bad-token'
  )

  /* ------------------------------------------------- 3b. algorithm confusion
   *
   * The header says one thing and the signature is another. Both of these are
   * signed with Google's real key, so the only thing that can refuse them is
   * the `alg` check itself.
   */

  const claimsNone = await auth.authenticate(hello('10.0.0.18', mint({ alg: 'none' }), 'browser-1'))
  log(claimsNone.ok === false && claimsNone.reason === 'bad-token', "a token whose header claims alg 'none' is bad-token")
  const claimsHs256 = await auth.authenticate(hello('10.0.0.19', mint({ alg: 'HS256' }), 'browser-1'))
  log(claimsHs256.ok === false && claimsHs256.reason === 'bad-token', 'a token whose header claims a symmetric alg is bad-token')

  /* ---------------------------------------------------- 4. somebody else's key */

  const wrongKey = await auth.authenticate(hello('10.0.0.5', mint({}, impostor.privateKey), 'browser-1'))
  log(wrongKey.ok === false && wrongKey.reason === 'bad-token', 'a token signed by a different key is bad-token')

  /* ------------------------------------- 5 & 6. somebody else's Firebase project
   *
   * Asserted separately, and this is the pair that matters most: a verifier that
   * checks the signature and forgets the audience passes every other check in
   * this file.
   */

  const wrongAud = await auth.authenticate(hello('10.0.0.6', mint({ aud: OTHER_PROJECT }), 'browser-1'))
  log(wrongAud.ok === false && wrongAud.reason === 'bad-token', "a valid token whose aud is another Firebase project's is bad-token")

  const wrongIss = await auth.authenticate(
    hello('10.0.0.7', mint({ iss: `https://securetoken.google.com/${OTHER_PROJECT}` }), 'browser-1')
  )
  log(wrongIss.ok === false && wrongIss.reason === 'bad-token', 'a valid token whose iss is for another Firebase project is bad-token')

  /* ------------------------------------------------------- 7. another account */

  const otherAccount = await auth.authenticate(hello('10.0.0.8', mint({ sub: OTHER_UID }), 'browser-1'))
  log(
    otherAccount.ok === false && otherAccount.reason === 'wrong-account',
    'a valid token for a different uid is wrong-account, not bad-token'
  )

  /* ====================== 8. no PIN set: the account is the whole credential
   *
   * The shipped state — `webPin` defaults to '' — and the claim is a browser
   * nobody has ever seen, from an address nobody has armed anything for,
   * getting in with nobody at the machine.
   */

  const stranger = await auth.authenticate(hello('10.0.0.9', mint(), 'hotel-laptop', 'Chrome on macOS'))
  log(stranger.ok === true, 'with no PIN set, a verified token for the configured uid admits a browser on its own')
  const record = saved.find((d) => d.id === 'hotel-laptop')
  log(
    !!record && record.name === 'Chrome on macOS' && record.createdAt === clock && record.revokedAt === 0,
    'and the browser is recorded, named and stamped — visibility is what this mode trades friction for'
  )
  log(auth.devices().some((d) => d.id === 'hotel-laptop'), 'and it is in the list Settings draws, so it can be revoked')

  /* ---------------------------------- 9. a browser that names itself nothing */

  const nameless = await auth.authenticate(hello('10.0.0.10', mint(), '', 'Anonymous'))
  log(
    nameless.ok === false && nameless.reason === 'not-approved',
    'a hello with a blank device id is not-approved — there is nothing to record an admission against'
  )
  log(!saved.some((d) => d.id === ''), 'and no row is written for it')

  /* ------------------------------------------ 10. revocation, in this mode */

  log(auth.revoke('hotel-laptop') === true, 'a browser admitted on the account alone can still be revoked')
  const revokedOpen = await auth.authenticate(hello('10.0.0.11', mint(), 'hotel-laptop'))
  log(
    revokedOpen.ok === false && revokedOpen.reason === 'revoked',
    'and is then refused with revoked — the one answer this permissive mode must not soften'
  )
  log(auth.forget('hotel-laptop') === true, 'and it can be forgotten outright from Settings')

  /* ---------------------------- 11. an admitted browser is admitted again */

  const again = await auth.authenticate(hello('10.0.0.12', mint(), 'laptop-1', 'Firefox on Linux'))
  log(again.ok === true, 'a second unknown browser is admitted the same way')
  const rows = saved.filter((d) => d.id === 'laptop-1')
  const returning = await auth.authenticate(hello('10.0.0.12', mint(), 'laptop-1', 'Firefox on Linux'))
  log(
    returning.ok === true && saved.filter((d) => d.id === 'laptop-1').length === rows.length,
    'and coming back updates its row rather than growing a second one with the same id'
  )

  /* ---------------------------------------------------------- 12. revocation */

  log(auth.revoke('browser-1') === true, 'an admitted browser can be revoked')
  const revoked = await auth.authenticate(hello('10.0.0.13', mint(), 'browser-1'))
  log(revoked.ok === false && revoked.reason === 'revoked', 'a revoked device is refused with revoked, not not-approved')

  /* ------------------------------------------------ 13. nothing to steal on disk */

  const everyToken = [good, tampered, mint()]
  log(
    persisted.length > 0 && persisted.every((json) => everyToken.every((token) => !json.includes(token))),
    'no ID token was ever handed to persistence'
  )
  log(
    persisted.every((json) => !json.includes('eyJ')),
    'and nothing shaped like a JWT reached it either'
  )
  log(
    saved.every((d) => Object.keys(d).sort().join(',') === 'createdAt,id,lastSeenAt,name,revokedAt'),
    'a device record is an id, a name and three timestamps — there is no credential field to leak'
  )

  // The same guarantee, asserted against the file rather than the array: the
  // real settings writer, the real normaliser, read back off disk.
  const written = setSettings({ webDevices: saved, webUid: UID, webProjectId: PROJECT })
  const settingsPath = join(scratch, 'data', 'settings.json')
  const onDisk = readFileSync(settingsPath, 'utf8')
  log(
    everyToken.every((token) => !onDisk.includes(token)) && !onDisk.includes('eyJ'),
    'and the settings.json actually written to disk holds no token either'
  )
  log(
    written.webDevices.length === saved.length && written.webDevices.every((d) => d.revokedAt !== undefined),
    'the store round-trips the web device list, tombstones and all'
  )
  log(
    written.webProjectId === PROJECT && written.webUid === UID && written.webEnabled === false,
    'and the project and uid survive normalisation while the master switch stays off'
  )
  log(written.webPin === '', 'and this desktop still has no unlock PIN, which is the state it ships in')

  /* -------------------------------------------------------------- 14. lockout */

  const junk = 'not.a.token'
  let lockedOut = null
  for (let i = 0; i < AUTH_MAX_FAILURES; i++) {
    const outcome = await auth.authenticate(hello('10.9.9.9', junk, 'browser-1'))
    if (outcome.reason !== 'bad-token') lockedOut = outcome
  }
  log(lockedOut === null, `${AUTH_MAX_FAILURES} bad tokens from one source are each answered on their own merits`)
  const locked = await auth.authenticate(hello('10.9.9.9', mint(), 'laptop-1'))
  log(
    locked.ok === false && locked.reason === 'busy' && locked.retryAfterMs > 0,
    'the next attempt from that source is refused with busy and a retry hint, even holding a good token'
  )
  clock += AUTH_LOCKOUT_MS + 1000
  const forgiven = await auth.authenticate(hello('10.9.9.9', mint(), 'laptop-1'))
  log(forgiven.ok === true, 'and the lockout expires on the injected clock')

  /* --------------------------------------------------- 15. Google's key set */

  const fetchesBeforeRotation = jwksFetches
  await auth.authenticate(hello('10.0.0.14', mint(), 'laptop-1'))
  log(jwksFetches === fetchesBeforeRotation, 'the cached key set is reused rather than re-fetched per connection')

  const unknownKid = await auth.authenticate(hello('10.0.0.15', mint({}, rotated.privateKey, KID_ROTATED), 'laptop-1'))
  log(unknownKid.ok === false && unknownKid.reason === 'bad-token', 'a token signed with a key Google has not published is bad-token')

  served = { ...served, [KID_ROTATED]: certificateFor(rotated, 'securetoken.google.com') }
  clock += 61_000
  const fetchesBeforeRotated = jwksFetches
  const afterRotation = await auth.authenticate(hello('10.0.0.16', mint({}, rotated.privateKey, KID_ROTATED), 'laptop-1'))
  log(jwksFetches === fetchesBeforeRotated + 1, 'an unknown kid re-fetches the key set, once the refetch floor has passed')
  log(afterRotation.ok === true, 'and a token signed with the rotated key then verifies')

  /* -------------------------------------- 16. the state this desktop ships in
   *
   * `webProjectId` and `webUid` default to '' — see defaultSettings() in
   * electron/store.ts — and this is the assertion that says what that means: an
   * unconfigured desktop admits nobody, holding a token that is correct in every
   * other way.
   */

  projectId = ''
  uid = ''
  const unconfigured = await auth.authenticate(hello('10.0.0.20', mint(), 'laptop-1'))
  log(unconfigured.ok === false, 'a desktop with no project and no uid configured admits nobody, however good the token')
  log(
    unconfigured.reason === 'busy' && unconfigured.retryAfterMs > 0,
    'and says so with a back-off rather than bad-token, which would loop the page on a correct credential'
  )
  projectId = PROJECT
  uid = UID

  /* ================================================ 17. the unlock PIN
   *
   * Everything above ran with no PIN set, which is what this desktop ships as.
   * From here one is set, and the claim is the whole of the second factor: a
   * browser holding a perfect token for the right account gets nowhere without
   * the digits somebody typed into Settings.
   */

  const PIN = '81547309'
  const WRONG_PIN = '00000000'
  pinHash = hashPin(PIN)
  log(pinHash.startsWith('scrypt$1$'), 'setting a PIN stores a versioned scrypt string')
  log(!pinHash.includes(PIN), 'and the digits are nowhere in it')
  log(hashPin(PIN) !== pinHash, 'hashing the same PIN twice gives a different string, so the salt is real')

  /* ---------------------- 17a. asking is not failing, and never locks anybody out */

  const asked = []
  for (let i = 0; i < AUTH_MAX_FAILURES + 2; i++) {
    asked.push(await auth.authenticate(hello('10.4.0.1', mint(), 'pin-browser', 'Chrome')))
  }
  log(
    asked.every((outcome) => outcome.ok === false && outcome.reason === 'pin-required'),
    `with a PIN set, every hello carrying none is pin-required (${asked.length} of them)`
  )
  log(
    asked.every((outcome) => outcome.message.length > 0),
    'each with a sentence the browser can put above a PIN box'
  )
  const stillWelcome = await auth.authenticate(hello('10.4.0.1', mint(), 'pin-browser', 'Chrome', { pin: PIN }))
  log(
    stillWelcome.ok === true,
    `${AUTH_MAX_FAILURES + 2} of those in a row do not lock the source — being asked is the first half of every ordinary sign-in`
  )

  /* ------------------------------------- 17b. and the browser is recorded */

  const pinRecord = saved.find((d) => d.id === 'pin-browser')
  log(
    !!pinRecord && pinRecord.createdAt === clock && pinRecord.revokedAt === 0,
    'a browser that answers the PIN is recorded, live and stamped on the injected clock'
  )

  /* --------------------------------------------- 17c. a wrong PIN is a failure */

  const wrongPin = await auth.authenticate(hello('10.4.0.2', mint(), 'pin-browser', 'Chrome', { pin: WRONG_PIN }))
  log(wrongPin.ok === false && wrongPin.reason === 'pin-invalid', 'a wrong PIN is pin-invalid')
  const notAPin = await auth.authenticate(hello('10.4.0.2', mint(), 'pin-browser', 'Chrome', { pin: 'letmein' }))
  log(
    notAPin.ok === false && notAPin.reason === 'pin-invalid' && notAPin.message === wrongPin.message,
    'and so is something that is not a PIN at all, in the same sentence — the door never says which half was wrong'
  )

  /* ---------------- 17d. the lockout is what makes four digits defensible */

  let lockedByPins = null
  for (let i = 0; i < AUTH_MAX_FAILURES; i++) {
    const outcome = await auth.authenticate(hello('10.4.0.3', mint(), 'pin-browser', 'Chrome', { pin: WRONG_PIN }))
    if (outcome.reason !== 'pin-invalid') lockedByPins = outcome
  }
  log(lockedByPins === null, `${AUTH_MAX_FAILURES} wrong PINs from one source are each answered on their own merits`)
  const pinLockout = await auth.authenticate(hello('10.4.0.3', mint(), 'pin-browser', 'Chrome', { pin: PIN }))
  log(
    pinLockout.ok === false && pinLockout.reason === 'busy' && pinLockout.retryAfterMs > 0,
    'and the next attempt is refused with busy and a retry hint, even holding the right PIN — guessing runs out, not the guesser'
  )
  clock += AUTH_LOCKOUT_MS + 1000
  const pinForgiven = await auth.authenticate(hello('10.4.0.3', mint(), 'pin-browser', 'Chrome', { pin: PIN }))
  log(pinForgiven.ok === true, 'the lockout expires on the injected clock, and the right PIN then works')

  /* ------------------- 17e. a revoked browser is never invited to guess */

  saved = [...saved, { id: 'ex-browser', name: 'Old Chrome', createdAt: 1, lastSeenAt: 1, revokedAt: 2 }]
  const revokedBeforePin = await auth.authenticate(hello('10.4.0.4', mint(), 'ex-browser', 'Old Chrome'))
  log(
    revokedBeforePin.ok === false && revokedBeforePin.reason === 'revoked',
    'a revoked browser is refused with revoked before the PIN is asked for — there is nothing a correct one could buy it'
  )
  const revokedWithPin = await auth.authenticate(hello('10.4.0.5', mint(), 'ex-browser', 'Old Chrome', { pin: PIN }))
  log(
    revokedWithPin.ok === false && revokedWithPin.reason === 'revoked',
    'and holding the right PIN does not change that answer'
  )

  /* -------------------- 17f. the account is still the first half of the door */

  const pinWithWrongAccount = await auth.authenticate(
    hello('10.4.0.6', mint({ sub: OTHER_UID }), 'pin-browser', 'Chrome', { pin: PIN })
  )
  log(
    pinWithWrongAccount.ok === false && pinWithWrongAccount.reason === 'wrong-account',
    'the right PIN on a token for another account is wrong-account — the PIN is a second factor, not a password'
  )

  /* ================================ 18. the fresh PIN the screen mirror wants
   *
   * The same secret, asked again for something that happens *inside* an
   * authenticated session. `needed` is what tells a browser to draw a PIN box
   * rather than an apology.
   */

  pinHash = ''
  log(
    auth.checkFreshPin('').ok === true,
    'on a desktop with no PIN set, a fresh-PIN check says yes — what refuses control there is canControl in electron/web-host.ts, which is false without a PIN'
  )

  pinHash = hashPin(PIN)
  const missing = auth.checkFreshPin('')
  log(missing.ok === false && missing.needed === true, 'with one set, presenting none is a question rather than a failure')
  const freshWrong = auth.checkFreshPin(WRONG_PIN)
  log(freshWrong.ok === false && freshWrong.needed === false, 'a wrong one is a failure rather than a question')
  log(freshWrong.message === wrongPin.message, 'and gets the same sentence a wrong PIN gets at hello')
  log(auth.checkFreshPin(PIN).ok === true, 'and the right one unlocks it')

  /* ============================= 19. nothing readable on disk, again
   *
   * The same instinct as check 13 and as scripts/mobile-auth-check.mjs, pointed
   * at the PIN: the real settings writer, the real normaliser, and the file read
   * back off the disk it was written to.
   */

  const afterPin = setSettings({ webPin: pinHash, webDevices: saved })
  const diskWithPin = readFileSync(settingsPath, 'utf8')
  log(!diskWithPin.includes(PIN), 'the PIN itself appears nowhere in settings.json')
  log(diskWithPin.includes('scrypt$1$'), 'what is there instead is the versioned scrypt string')
  log(afterPin.webPin === pinHash, 'which the store round-trips unchanged')
  log(
    setSettings({ webPin: PIN }).webPin === '',
    'and a PIN written into settings.json in the clear by hand degrades to "no PIN" rather than becoming one'
  )
  setSettings({ webPin: pinHash })

  /* ================================== 20. the shape of a PIN, and totality
   *
   * `isValidPin` decides what somebody may set; `verifyPin` decides what opens
   * the door. Both are handed junk here, because both are handed junk in
   * production — one off a settings panel, one off a public socket.
   */

  log(isValidPin('1234') && isValidPin('123456789012'), `${PIN_MIN_DIGITS} and ${PIN_MAX_DIGITS} digits are both a PIN`)
  log(
    ['123', '1234567890123', '12ab', '', '12 34', '1234\n', ' 1234'].every((bad) => isValidPin(bad) === false),
    'too short, too long, not digits, blank and padded are all refused'
  )
  log(
    [null, undefined, 1234, {}, [], true].every((bad) => isValidPin(bad) === false),
    'and so is anything that is not a string at all'
  )
  log(hashPin('12ab') === '' && hashPin('') === '', 'hashing something that is not a PIN gives nothing to store')

  const rubbishStores = [
    '',
    'nonsense',
    'scrypt$1$',
    'scrypt$1$abc',
    'scrypt$2$YWJj$YWJj',
    'scrypt$1$!!!$???',
    'scrypt$1$YWJj$YWJj',
    '$$$$',
    'scrypt$1$YWJj$YWJj$extra',
    'x'.repeat(10_000)
  ]
  let threw = null
  for (const stored of rubbishStores) {
    try {
      if (verifyPin(PIN, stored) !== false) threw = `opened by ${JSON.stringify(stored)}`
    } catch (err) {
      threw = `threw on ${JSON.stringify(stored)}: ${String(err)}`
    }
  }
  log(threw === null, `a stored value that is not a PIN hash never verifies and never throws (${threw ?? 'none did'})`)

  let inputThrew = null
  for (const bad of ['', 'letmein', '123', '1'.repeat(5000), null, undefined, 1234, {}, []]) {
    try {
      if (verifyPin(bad, pinHash) !== false) inputThrew = `opened by ${JSON.stringify(bad)}`
    } catch (err) {
      inputThrew = `threw on ${JSON.stringify(bad)}: ${String(err)}`
    }
  }
  log(inputThrew === null, `and neither does junk presented against a real one (${inputThrew ?? 'none did'})`)
  log(verifyPin(PIN, pinHash) === true, 'while the PIN that was hashed still opens it')

  /* ================ 21. a tombstone cannot be squeezed off the device list
   *
   * The store caps the device list at twenty. A browser with no row is
   * *admitted* once it answers the PIN, so a revocation that fell off the end of
   * that list would be an un-revocation performed by a `slice` — which is why
   * the cap spends its budget on live rows and keeps every tombstone.
   */

  const crowd = []
  for (let i = 0; i < 40; i++) {
    crowd.push({ id: `filler-${i}`, name: 'Filler', createdAt: 1, lastSeenAt: 1, revokedAt: 0 })
  }
  // Last, which is exactly where a plain `slice(0, 20)` would have lost it.
  crowd.push({ id: 'revoked-long-ago', name: 'Old', createdAt: 1, lastSeenAt: 1, revokedAt: 2 })

  const capped = setSettings({ webDevices: crowd }).webDevices
  log(capped.length === 20, 'a device list far over the cap is trimmed to twenty rows')
  log(
    capped.some((d) => d.id === 'revoked-long-ago'),
    'and the revoked row survives from the far end of it — a tombstone is never what the cap throws away'
  )
  const order = capped.map((d) => crowd.findIndex((c) => c.id === d.id))
  log(
    order.every((position, i) => i === 0 || position > order[i - 1]),
    'and the rows that are kept stay in the order the panel drew them'
  )
  log(
    capped.every((d) => Object.keys(d).sort().join(',') === 'createdAt,id,lastSeenAt,name,revokedAt'),
    'and every row that comes back off disk is still an id, a name and three timestamps'
  )
}

main()
  .catch((err) => {
    failures++
    console.error(`\nFAIL  ${err?.stack ?? err}`)
  })
  .finally(() => {
    rmSync(scratch, { recursive: true, force: true })
    console.log(failures === 0 ? '\nweb:auth — all checks passed' : `\nweb:auth — ${failures} FAILED`)
    process.exit(failures === 0 ? 0 : 1)
  })
