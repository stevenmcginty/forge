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
import { createSign, generateKeyPairSync, randomBytes } from 'node:crypto'
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

  /* ===================================================== 22. remembered phones
   *
   * RESUME_IDLE_MS in shared/web.ts: every unlock under a PIN is handed a
   * single-use ticket that answers the question on the next hello, for a week
   * of non-use, across a restart, until the PIN changes. Each case gets its own
   * WebAuth over an in-memory stand-in for `web-remembered.json`, on the fake
   * clock, so a week passes by assignment and a restart is a second instance
   * over the same file.
   */

  const ORIGIN = 'https://forge-web-check.web.app'
  const DAY = 24 * 60 * 60 * 1000
  const isTicket = (t) => typeof t === 'string' && Buffer.from(t, 'base64url').length === 32
  function memoryFile() {
    const file = { text: '', read: () => file.text, write: (text) => (file.text = text) }
    return file
  }
  const ticketsIn = (file) => (file.text ? JSON.parse(file.text).tickets : {})
  function desk(file, lines = []) {
    return new WebAuth({
      fetchJwks: async () => ({ body: JSON.stringify(served), cacheControl: 'public, max-age=21600' }),
      projectId: () => projectId,
      uid: () => uid,
      pinHash: () => pinHash,
      resumes: file,
      now: () => clock,
      log: (line) => lines.push(line)
    })
  }
  const door = (a, deviceId, extra = {}) =>
    a.authenticate(hello('10.9.0.1', mint(), deviceId, `Phone ${deviceId}`, { origin: ORIGIN, ...extra }))
  const refusedWhy = (lines) => lines.filter((l) => l.startsWith('web auth: remembered-phone ticket refused')).at(-1) ?? ''

  // 22a. Earned by a PIN, spent with a passkey's rights, good for a week.
  {
    const lines = []
    const a = desk(memoryFile(), lines)
    const byPin = await door(a, 'phone-1', { pin: PIN })
    log(byPin.ok && isTicket(byPin.resume) && byPin.device.unlock?.by === 'pin', 'a PIN unlock is handed a remembered-phone ticket')
    const noOrigin = await a.authenticate(hello('10.9.0.1', mint(), 'phone-1', 'Phone', { pin: PIN }))
    log(noOrigin.ok && !('resume' in noOrigin), 'but not a socket with no page origin to bind it to')
    const savedPin = pinHash
    pinHash = ''
    const noPin = await door(a, 'phone-1')
    pinHash = savedPin
    log(noPin.ok && !('resume' in noPin), 'and nothing at all with no PIN set')

    a.resumeClosed(byPin.resume)
    clock += 6 * DAY
    const sixDays = await door(a, 'phone-1', { resume: byPin.resume })
    log(
      sixDays.ok && sixDays.device.unlock?.by === 'passkey' && isTicket(sixDays.resume) && sixDays.resume !== byPin.resume,
      "6 days after its socket closed the ticket admits with a passkey's rights (never a PIN's), and a fresh ticket"
    )
    log(lines.some((l) => l.includes('admitted') && l.includes('with a remembered-phone ticket')), 'and the log says so')

    a.resumeClosed(sixDays.resume)
    clock += 7 * DAY
    const sevenDays = await door(a, 'phone-1', { resume: sixDays.resume })
    log(sevenDays.ok && isTicket(sevenDays.resume), 'exactly 7 days after its socket closed it still admits')
    const twice = await door(a, 'phone-1', { resume: byPin.resume })
    log(
      !twice.ok && twice.reason === 'pin-required' && refusedWhy(lines).includes('already spent'),
      'once the ticket it was rotated to has been used, a ticket is spent'
    )
    a.resumeClosed(sevenDays.resume)
    clock += 7 * DAY + 1
    const late = await door(a, 'phone-1', { resume: sevenDays.resume })
    log(
      !late.ok && late.reason === 'pin-required' && refusedWhy(lines).endsWith('expired'),
      `7 days + 1 ms after its socket closed it is asked for the PIN (${refusedWhy(lines)})`
    )
  }

  // 22b. A restart: the same file under a new instance.
  {
    const file = memoryFile()
    const lines = []
    const before = desk(file, lines)
    const stillOpen = await door(before, 'phone-2', { pin: PIN })
    const alsoOpen = await door(before, 'phone-3', { pin: PIN })
    const closed = await door(before, 'phone-4', { pin: PIN })
    before.resumeClosed(closed.resume)
    const closedAt = clock
    log(
      [stillOpen, alsoOpen, closed].every((o) => o.ok && !file.text.includes(o.resume)),
      'the file holds no ticket itself, only digests'
    )
    clock += DAY
    const loadedAt = clock
    const after = desk(file, lines)
    const listed = after.rememberedList()
    const byDevice = (id) => Object.values(ticketsIn(file)).find((t) => t.deviceId === id)
    log(
      byDevice('phone-2')?.closedAt === loadedAt && byDevice('phone-3')?.closedAt === loadedAt,
      'a ticket whose socket was open at the restart has its idle clock started at load time'
    )
    log(byDevice('phone-4')?.closedAt === closedAt, 'while a closed one keeps the time it closed')
    log(listed.length === 3, `the restarted desktop lists all three phones (${listed.length})`)
    const survived = await door(after, 'phone-4', { resume: closed.resume })
    log(survived.ok && isTicket(survived.resume), 'a ticket survives the restart and admits')
    clock = loadedAt + 7 * DAY
    const edge = await door(after, 'phone-2', { resume: stillOpen.resume })
    log(edge.ok, '7 days after the load an open-at-restart ticket still admits')
    clock = loadedAt + 7 * DAY + 1
    const past = await door(after, 'phone-3', { resume: alsoOpen.resume })
    log(!past.ok && past.reason === 'pin-required' && refusedWhy(lines).endsWith('expired'), 'and 1 ms later it is asked')
  }

  // 22c. Changing the PIN voids every ticket, and the list hides them.
  {
    const lines = []
    const a = desk(memoryFile(), lines)
    const earned = await door(a, 'phone-5', { pin: PIN })
    a.resumeClosed(earned.resume)
    log(a.rememberedList().length === 1, 'the phone is listed')
    const savedPin = pinHash
    pinHash = hashPin('24681357')
    const voided = await door(a, 'phone-5', { resume: earned.resume })
    log(
      !voided.ok && voided.reason === 'pin-required' && refusedWhy(lines).endsWith('the PIN has changed'),
      `after the PIN changes its ticket is asked for the PIN (${refusedWhy(lines)})`
    )
    const other = await door(a, 'phone-6', { pin: '24681357' })
    pinHash = savedPin
    log(other.ok && a.rememberedList().length === 0, 'and a ticket earned under the other PIN is hidden once it changes back')
  }

  // 22d. Forgetting one phone, and all of them.
  {
    const file = memoryFile()
    const a = desk(file)
    const first = await door(a, 'phone-7', { pin: PIN })
    const second = await door(a, 'phone-7', { pin: PIN })
    const eight = await door(a, 'phone-8', { pin: PIN })
    const nine = await door(a, 'phone-9', { pin: PIN })
    for (const o of [first, second, eight, nine]) {
      a.resumeClosed(o.resume)
      clock += 1000
    }
    const rows = a.rememberedList()
    log(rows.length === 3 && rows.filter((r) => r.deviceId === 'phone-7').length === 1, 'one row per phone, however many tickets it holds')
    log(rows[0].deviceName === 'Phone phone-9', "each row carries the phone's name")
    log(a.rememberedForget('phone-7') === 2 && a.rememberedList().length === 2, 'forgetting a phone drops every ticket it holds')
    const forgotten = await door(a, 'phone-7', { resume: second.resume })
    log(!forgotten.ok && forgotten.reason === 'pin-required', 'and its next hello is asked for the PIN')
    log(a.rememberedForgetAll() === 2 && a.rememberedList().length === 0, 'forget all empties the list')
    const gone = await door(a, 'phone-8', { resume: eight.resume })
    log(!gone.ok && gone.reason === 'pin-required' && Object.keys(ticketsIn(file)).length === 0, 'and the file, and every ticket is refused')
  }

  // 22e. The per-phone cap and the global ceiling drop the oldest, never the newest.
  {
    const lines = []
    const a = desk(memoryFile(), lines)
    const issued = []
    for (let i = 0; i < 10; i++) {
      const o = await door(a, 'phone-10', { pin: PIN })
      a.resumeClosed(o.resume)
      issued.push(o.resume)
      clock += 1000
    }
    const oldest = await door(a, 'phone-10', { resume: issued[0] })
    const next = await door(a, 'phone-10', { resume: issued[1] })
    log(
      !oldest.ok && !next.ok && refusedWhy(lines).includes('unknown'),
      'past 8 tickets on one phone its two oldest are dropped'
    )
    const newest = await door(a, 'phone-10', { resume: issued[9] })
    const third = await door(a, 'phone-10', { resume: issued[2] })
    log(newest.ok && third.ok, 'while its newest and the 8th-newest are kept')

    const file = memoryFile()
    const b = desk(file)
    const keep = await door(b, 'phone-keep', { pin: PIN })
    b.resumeClosed(keep.resume)
    const real = Object.values(ticketsIn(file))[0]
    const crowd = { ...ticketsIn(file) }
    for (let i = 0; i < 300; i++) {
      crowd[randomBytes(32).toString('base64url')] = {
        ...real,
        deviceId: `crowd-${i}`,
        deviceName: `Crowd ${i}`,
        issuedAt: clock - DAY - i,
        lastUsedAt: clock - DAY - i,
        closedAt: clock - DAY - i
      }
    }
    file.text = JSON.stringify({ version: 1, tickets: crowd })
    const c = desk(file)
    const kept = await door(c, 'phone-keep', { resume: keep.resume })
    const left = Object.values(ticketsIn(file))
    log(
      kept.ok && left.length <= 256 && left.some((t) => t.deviceId === 'phone-keep'),
      `a file of 301 tickets loads down to the ceiling keeping the most recent, and that phone still gets in (${left.length} kept)`
    )
    log(!left.some((t) => t.deviceId === 'crowd-299'), 'the least recently used went first')
  }

  // 22f. A bad ticket is never struck.
  {
    const a = desk(memoryFile())
    let asked = 0
    for (let i = 0; i < AUTH_MAX_FAILURES + 2; i++) {
      const junk = await door(a, 'phone-11', { resume: i % 2 ? randomBytes(32).toString('base64url') : 'not a ticket' })
      if (!junk.ok && junk.reason === 'pin-required') asked++
    }
    log(asked === AUTH_MAX_FAILURES + 2, `${AUTH_MAX_FAILURES + 2} bad tickets are each asked for the PIN, none struck`)
    const pinAfter = await door(a, 'phone-11', { pin: PIN })
    log(pinAfter.ok, 'and the correct PIN still gets in afterwards')
  }

  /* 22g. A rotated ticket stays good until its successor is used.
   *
   * The successor travels in a `hello-ok` that a dying socket may never
   * deliver, and the phone keeps the ticket it holds until the desktop
   * answers, so it presents the old one again. That must not cost a PIN.
   */
  const pair = async (a, deviceId) => {
    const first = await door(a, deviceId, { pin: PIN })
    a.resumeClosed(first.resume)
    const second = await door(a, deviceId, { resume: first.resume })
    a.resumeClosed(second.resume)
    return { first, second }
  }

  // (a) and (b): a lost successor, then its replacement used.
  {
    const lines = []
    const a = desk(memoryFile(), lines)
    const { first, second: lost } = await pair(a, 'phone-12')
    clock += DAY
    const again = await door(a, 'phone-12', { resume: first.resume })
    log(
      lost.ok &&
        again.ok &&
        again.device.unlock?.by === 'passkey' &&
        isTicket(again.resume) &&
        ![first.resume, lost.resume].includes(again.resume),
      "a ticket whose successor never reached the phone is admitted again, no PIN, with a passkey's rights, and a third ticket"
    )
    log(
      lines.includes('web auth: re-accepted a remembered-phone ticket — the last one never reached the phone'),
      'and the log says the last one never reached the phone'
    )
    log(a.rememberedList().length === 1, 'the rotated pair is one row in the list')
    const undelivered = await door(a, 'phone-12', { resume: lost.resume })
    log(
      !undelivered.ok && undelivered.reason === 'pin-required' && refusedWhy(lines).includes('already spent'),
      'the undelivered successor it replaced is gone'
    )
    a.resumeClosed(again.resume)
    const third = await door(a, 'phone-12', { resume: again.resume })
    const firstAgain = await door(a, 'phone-12', { resume: first.resume })
    log(
      third.ok && !firstAgain.ok && firstAgain.reason === 'pin-required' && refusedWhy(lines).includes('unknown or already spent'),
      'once the third ticket is used, the first is refused'
    )
  }

  // (c): the successor used normally, or its socket heard from.
  {
    const lines = []
    const a = desk(memoryFile(), lines)
    const { first, second } = await pair(a, 'phone-13')
    const next = await door(a, 'phone-13', { resume: second.resume })
    const back = await door(a, 'phone-13', { resume: first.resume })
    log(
      next.ok && !back.ok && back.reason === 'pin-required' && refusedWhy(lines).includes('unknown or already spent'),
      'a successor used normally spends the ticket it replaced'
    )
    const heard = await door(a, 'phone-14', { pin: PIN })
    const rotated = await door(a, 'phone-14', { resume: heard.resume })
    a.resumeDelivered(rotated.resume)
    const stale = await door(a, 'phone-14', { resume: heard.resume })
    log(
      rotated.ok && !stale.ok && refusedWhy(lines).includes('unknown or already spent'),
      'a successor whose socket has been heard from spends the one it replaced before it is ever presented'
    )
  }

  // (d): a PIN change voids the stand-in and its successor alike.
  {
    const file = memoryFile()
    const a = desk(file)
    const { first, second } = await pair(a, 'phone-15')
    const savedPin = pinHash
    pinHash = hashPin('24681357')
    const listed = a.rememberedList()
    const left = Object.keys(ticketsIn(file)).length
    pinHash = savedPin
    const one = await door(a, 'phone-15', { resume: first.resume })
    const two = await door(a, 'phone-15', { resume: second.resume })
    log(
      listed.length === 0 && left === 0 && !one.ok && !two.ok && one.reason === 'pin-required' && two.reason === 'pin-required',
      `a PIN change voids a rotated ticket and its successor alike (${left} left in the file)`
    )
  }

  // (e): forgetting the phone removes both.
  {
    const file = memoryFile()
    const a = desk(file)
    const { first, second } = await pair(a, 'phone-16')
    const gone = a.rememberedForget('phone-16')
    const one = await door(a, 'phone-16', { resume: first.resume })
    const two = await door(a, 'phone-16', { resume: second.resume })
    log(
      gone === 2 && Object.keys(ticketsIn(file)).length === 0 && !one.ok && !two.ok,
      `forgetting a phone removes a rotated ticket with its successor (${gone} went)`
    )
  }

  // (f): a file written before tickets were linked loads, and its tickets rotate.
  {
    const file = memoryFile()
    const a = desk(file)
    const earned = await door(a, 'phone-17', { pin: PIN })
    a.resumeClosed(earned.resume)
    const oldFormat = {}
    for (const [key, t] of Object.entries(ticketsIn(file))) {
      const { uid: u, deviceId, deviceName, origin, pinDigest, issuedAt, lastUsedAt, closedAt } = t
      oldFormat[key] = { uid: u, deviceId, deviceName, origin, pinDigest, issuedAt, lastUsedAt, closedAt }
    }
    file.text = JSON.stringify({ version: 1, tickets: oldFormat })
    const b = desk(file)
    const loaded = await door(b, 'phone-17', { resume: earned.resume })
    const linked = Object.values(ticketsIn(file))
    const again = await door(b, 'phone-17', { resume: earned.resume })
    log(
      Object.keys(oldFormat).length === 1 && loaded.ok && again.ok && isTicket(again.resume),
      'a remembered-phone file with no link fields loads, its ticket admits, and it rotates like any other'
    )
    log(
      linked.some((t) => typeof t.next === 'string') &&
        linked.some((t) => typeof t.prev === 'string') &&
        ![earned.resume, loaded.resume, again.resume].some((t) => file.text.includes(t)),
      'the links are written as digests, never ticket text'
    )
  }

  // (g): a stand-in is held to every check the ticket was.
  {
    const lines = []
    const a = desk(memoryFile(), lines)
    const acct = await pair(a, 'phone-18')
    uid = OTHER_UID
    const otherAccount = await a.authenticate(
      hello('10.9.0.1', mint({ sub: OTHER_UID }), 'phone-18', 'Phone phone-18', { origin: ORIGIN, resume: acct.first.resume })
    )
    uid = UID
    const acctWhy = refusedWhy(lines)
    const acctKept = await door(a, 'phone-18', { resume: acct.second.resume })
    log(
      !otherAccount.ok && otherAccount.reason === 'pin-required' && acctWhy.endsWith('another account') && acctKept.ok,
      `a rotated ticket from another account is refused (${acctWhy}), and its successor is still good`
    )
    const dev = await pair(a, 'phone-19')
    const otherDevice = await door(a, 'phone-19-other', { resume: dev.first.resume })
    log(
      !otherDevice.ok && otherDevice.reason === 'pin-required' && refusedWhy(lines).endsWith('another browser'),
      `a rotated ticket from another browser is refused (${refusedWhy(lines)})`
    )
    const page = await pair(a, 'phone-20')
    const otherPage = await door(a, 'phone-20', { resume: page.first.resume, origin: 'https://elsewhere.example' })
    log(
      !otherPage.ok && otherPage.reason === 'pin-required' && refusedWhy(lines).endsWith('another page'),
      `a rotated ticket from another page is refused (${refusedWhy(lines)})`
    )
  }

  // (h): a stand-in lives and lapses on its successor's clock, not its own.
  {
    const lines = []
    const a = desk(memoryFile(), lines)
    const earned = await door(a, 'phone-21', { pin: PIN })
    a.resumeClosed(earned.resume)
    clock += 6 * DAY
    const lost = await door(a, 'phone-21', { resume: earned.resume })
    a.resumeClosed(lost.resume)
    clock += 7 * DAY
    const late = await door(a, 'phone-21', { resume: earned.resume })
    log(lost.ok && late.ok, "13 days after its own socket closed, but 7 after its successor's, a rotated ticket still admits")

    const { first } = await pair(a, 'phone-22')
    clock += 7 * DAY + 1
    const lapsed = await door(a, 'phone-22', { resume: first.resume })
    log(
      !lapsed.ok && lapsed.reason === 'pin-required' && refusedWhy(lines).endsWith('expired'),
      `7 days + 1 ms after its successor's socket closed it lapses with it (${refusedWhy(lines)})`
    )
  }

  // (i): the per-phone cap never evicts the pair being linked.
  {
    const a = desk(memoryFile())
    const issued = []
    for (let i = 0; i < 8; i++) {
      const o = await door(a, 'phone-23', { pin: PIN })
      a.resumeClosed(o.resume)
      issued.push(o.resume)
      clock += 1000
    }
    const oldest = await door(a, 'phone-23', { resume: issued[0] })
    const again = await door(a, 'phone-23', { resume: issued[0] })
    const second = await door(a, 'phone-23', { resume: issued[1] })
    log(oldest.ok && again.ok && second.ok, "at the phone's cap its oldest ticket rotates and is re-accepted, and nothing else is lost")
  }
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
