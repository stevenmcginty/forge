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
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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
const dataDir = join(scratch, 'data')
process.env['FORGE_DATA_DIR'] = dataDir

/*
 * A settings.json as an upgrading desktop's actually is: written by a Forge
 * that still kept a list of approved browsers, and never touched since. Laid
 * down here, before the store has read anything, so check 13 exercises the real
 * load path rather than a patch — the claim is about what happens to a file
 * somebody already has on disk, and a check that fed the key in through
 * `setSettings` would be proving something easier.
 */
mkdirSync(dataDir, { recursive: true })
writeFileSync(
  join(dataDir, 'settings.json'),
  JSON.stringify({
    webProjectId: 'forge-web-check',
    webDevices: [
      { id: 'browser-1', name: 'Chrome', createdAt: 1, lastSeenAt: 1, revokedAt: 0 },
      { id: 'gone-1', name: 'Old Chrome', createdAt: 1, lastSeenAt: 1, revokedAt: 2 }
    ]
  }),
  'utf8'
)

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

  const admitted = await auth.authenticate(hello('10.0.0.1', mint(), 'browser-1'))
  log(admitted.ok === true, 'a correctly signed, correctly claimed token for the configured uid is admitted')
  log(admitted.ok && admitted.claims.uid === UID, 'and the uid it verified as is handed back to the caller')
  log(
    admitted.ok && admitted.device.id === 'browser-1' && admitted.device.name === 'Chrome on Windows',
    "and the browser's own two strings come back for the socket to be logged under"
  )
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
  log(
    stranger.ok && stranger.device.name === 'Chrome on macOS',
    'and it is named for the length of the socket, which is the only thing that name is for'
  )

  /* ---------------------------------- 9. a browser that names itself nothing */

  const nameless = await auth.authenticate(hello('10.0.0.10', mint(), '', 'Anonymous'))
  log(
    nameless.ok === false && nameless.reason === 'not-approved',
    'a hello with a blank device id is not-approved — a page that cannot mint one has no storage, and should be told so'
  )

  /* -------------------------- 10. there is no list, and nothing to revoke on
   *
   * The claim Steve asked for, asserted against the class rather than against
   * prose: access is the account plus the PIN, from any browser in the world,
   * and there is no second mechanism sitting beside that which could disagree
   * with it or go stale.
   */

  log(
    typeof auth.devices !== 'function' && typeof auth.revoke !== 'function' && typeof auth.forget !== 'function',
    'the class has no device list, no revoke and no forget — the machinery is gone rather than merely unused'
  )

  /* ---------------------------- 11. every connection is judged from scratch */

  const again = await auth.authenticate(hello('10.0.0.12', mint(), 'laptop-1', 'Firefox on Linux'))
  log(again.ok === true, 'a second browser nobody has ever seen is admitted the same way')
  const returning = await auth.authenticate(hello('10.0.0.12', mint(), 'laptop-1', 'Firefox on Linux'))
  log(
    returning.ok === true && returning.device.id === again.device.id,
    'and coming back is the same answer on the same terms — nothing was remembered between the two'
  )

  /* ---------------------- 12. a browser the desktop has never seen, from anywhere */

  const strangerAgain = await auth.authenticate(hello('203.0.113.7', mint(), 'phone-in-a-hotel', 'Safari on iOS'))
  log(
    strangerAgain.ok === true,
    'a brand-new browser at a brand-new address is admitted on the account alone — which is the whole point of removing the list'
  )

  /* ------------------------------------------------ 13. nothing to steal on disk
   *
   * There is nothing left for this module to persist, so the assertion moved to
   * the file: the store is driven exactly as the Electron host drives it, and
   * the settings.json that lands on disk is read back and searched.
   */

  const everyToken = [good, tampered, mint()]
  const written = setSettings({ webUid: UID, webProjectId: PROJECT })
  const settingsPath = join(dataDir, 'settings.json')
  const onDisk = readFileSync(settingsPath, 'utf8')
  log(
    everyToken.every((token) => !onDisk.includes(token)) && !onDisk.includes('eyJ'),
    'the settings.json actually written to disk holds no ID token and nothing shaped like one'
  )
  log(
    written.webProjectId === PROJECT && written.webUid === UID && written.webEnabled === false,
    'the project and uid survive normalisation while the master switch stays off'
  )
  log(written.webPin === '', 'and this desktop still has no unlock PIN, which is the state it ships in')

  /* ------------------------------- 13b. the upgrade, off a real settings.json
   *
   * The file this check laid down before the store had read anything carries a
   * `webDevices` list, exactly as an upgrading desktop's does. Nothing migrates
   * it deliberately: `normaliseSettings` builds a fresh object out of the keys
   * it knows, so a key it no longer knows is dropped on the way in and gone from
   * the file on the next write. This is the assertion that says so, because
   * "unknown keys are dropped" is a property of that function that nothing else
   * would notice losing.
   */

  log(written.webDevices === undefined, 'a settings.json carrying the old webDevices list loses it on load')
  log(!onDisk.includes('webDevices'), 'and the next write leaves no trace of it on disk')
  log(!onDisk.includes('gone-1') && !onDisk.includes('Old Chrome'), 'so no stale browser row survives the upgrade')

  /* ------------------------------------- 14. bad tokens never lock anybody out
   *
   * There is no address bucket. Behind the tunnel every caller on earth shares
   * this machine's loopback, so striking bad tokens per address handed any
   * stranger a way to lock the owner out for a renewable minute. A JWT is not a
   * guessable secret, so counting them bought nothing; the only bucket is the
   * account's, and the only thing that fills it is a wrong PIN (see 17d).
   */

  const junk = 'not.a.token'
  let lockedOut = null
  for (let i = 0; i < AUTH_MAX_FAILURES * 3; i++) {
    const outcome = await auth.authenticate(hello('10.9.9.9', junk, 'browser-1'))
    if (outcome.reason !== 'bad-token') lockedOut = outcome
  }
  log(lockedOut === null, `${AUTH_MAX_FAILURES * 3} bad tokens from one source are each answered bad-token — none is ever busy`)
  const unbothered = await auth.authenticate(hello('10.9.9.9', mint(), 'laptop-1'))
  log(unbothered.ok === true, "and the owner signing in from that same address is admitted — a stranger's junk cannot lock the door")
  const refreshJunk = await auth.verifyToken(junk, '10.9.9.9', UID)
  log(refreshJunk.ok === false && refreshJunk.reason === 'bad-token', "a bad token on an open socket's refresh is bad-token, not busy")
  const refreshGood = await auth.verifyToken(mint(), '10.9.9.9', UID)
  log(refreshGood.ok === true, 'and a good one still verifies afterwards — refresh failures strike nothing either')

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

  /* -------------------- 17b. and answering it buys the socket and nothing else */

  const spent = await auth.authenticate(hello('10.4.0.7', mint(), 'pin-browser', 'Chrome'))
  log(
    spent.ok === false && spent.reason === 'pin-required',
    'a browser that answered the PIN a moment ago is asked again on its next connection — there is no trust window and nothing that remembers it'
  )

  /* --------------------------------------------- 17c. a wrong PIN is a failure */

  const wrongPin = await auth.authenticate(hello('10.4.0.2', mint(), 'pin-browser', 'Chrome', { pin: WRONG_PIN }))
  log(wrongPin.ok === false && wrongPin.reason === 'pin-invalid', 'a wrong PIN is pin-invalid')
  const notAPin = await auth.authenticate(hello('10.4.0.2', mint(), 'pin-browser', 'Chrome', { pin: 'letmein' }))
  log(
    notAPin.ok === false && notAPin.reason === 'pin-invalid' && notAPin.message === wrongPin.message,
    'and so is something that is not a PIN at all, in the same sentence — the door never says which half was wrong'
  )

  /* ---------------- 17d. the lockout is what makes four digits defensible
   *
   * Wrong PINs strike the ACCOUNT bucket, not the source address — every
   * browser a tunnel funnels onto loopback shares one address, so a per-source
   * bucket is a bucket the whole internet holds with the owner. The two
   * strikes 17c just spent land on that account bucket regardless of source,
   * so expire the window first and prove the count from a clean slate.
   */

  clock += AUTH_LOCKOUT_MS + 1000
  let lockedByPins = null
  for (let i = 0; i < AUTH_MAX_FAILURES; i++) {
    const outcome = await auth.authenticate(hello('10.4.0.3', mint(), 'pin-browser', 'Chrome', { pin: WRONG_PIN }))
    if (outcome.reason !== 'pin-invalid') lockedByPins = outcome
  }
  log(lockedByPins === null, `${AUTH_MAX_FAILURES} wrong PINs from one account are each answered on their own merits`)
  const pinLockout = await auth.authenticate(hello('10.4.0.3', mint(), 'pin-browser', 'Chrome', { pin: PIN }))
  log(
    pinLockout.ok === false && pinLockout.reason === 'busy' && pinLockout.retryAfterMs > 0,
    'and the next attempt is refused with busy and a retry hint, even holding the right PIN — guessing runs out, not the guesser'
  )
  clock += AUTH_LOCKOUT_MS + 1000
  const pinForgiven = await auth.authenticate(hello('10.4.0.3', mint(), 'pin-browser', 'Chrome', { pin: PIN }))
  log(pinForgiven.ok === true, 'the lockout expires on the injected clock, and the right PIN then works')

  /* -------------------- 17e. a browser nobody has ever seen still needs the PIN */

  const newcomerAsked = await auth.authenticate(hello('10.4.0.4', mint(), 'never-seen-before', 'Chrome'))
  log(
    newcomerAsked.ok === false && newcomerAsked.reason === 'pin-required',
    'a browser this desktop has never seen is asked for the PIN like every other one — being new is neither a pass nor a bar'
  )
  const newcomerIn = await auth.authenticate(hello('10.4.0.5', mint(), 'never-seen-before', 'Chrome', { pin: PIN }))
  log(newcomerIn.ok === true, 'and the PIN is the whole of what it needs')

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

  const afterPin = setSettings({ webPin: pinHash })
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

  /* ================ 21. the old key cannot be written back in by anybody
   *
   * Check 13b proved an existing settings.json loses it. This is the other
   * direction and the one that would rot quietly: a caller — a stale renderer
   * posting its whole settings object, a hand-edit — putting the key back. The
   * store is the only writer, and it drops what it does not know, so the answer
   * has to be the same however the key arrives.
   */

  const smuggled = setSettings({
    webDevices: [{ id: 'smuggled-in', name: 'Chrome', createdAt: 1, lastSeenAt: 1, revokedAt: 0 }]
  })
  log(smuggled.webDevices === undefined, 'a caller handing the store a webDevices list gets it dropped rather than kept')
  log(
    !readFileSync(settingsPath, 'utf8').includes('smuggled-in'),
    'and nothing about it reaches settings.json — there is no way back to a device list'
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
