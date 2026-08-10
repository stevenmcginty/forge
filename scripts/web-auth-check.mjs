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
 * The clock is injected, so token expiry, the approval deadline and the lockout
 * window are crossed by assignment rather than by waiting. The approval wait
 * itself runs on a real timer, injected short, exactly as scripts/mobile-smoke.mjs
 * does for the same wait.
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

  const { WebAuth, GOOGLE_JWKS_URL, CLOCK_SKEW_MS, setSettings, APPROVAL_TIMEOUT_MS, AUTH_LOCKOUT_MS, AUTH_MAX_FAILURES } =
    await import(pathToFileURL(join(scratch, 'web-auth.mjs')).href)

  const google = generateKeyPairSync('rsa', { modulusLength: 2048 })
  const impostor = generateKeyPairSync('rsa', { modulusLength: 2048 })
  const rotated = generateKeyPairSync('rsa', { modulusLength: 2048 })

  /* --------------------------------------------------------- the desktop */

  let clock = 1_760_000_000_000
  let saved = []
  /** Everything ever handed to persistence, so check 13 can search all of it. */
  const persisted = []
  let acceptUntil = 0
  const prompts = []
  const withdrawn = []
  let verdict = async () => false
  let served = { [KID]: certificateFor(google, 'securetoken.google.com') }
  // Mutable so check 16 can put the desktop back into the state it ships in.
  let projectId = PROJECT
  let uid = UID
  let jwksFetches = 0
  const jwksUrls = []

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
    acceptUntil: () => acceptUntil,
    requestApproval: (ask) => {
      prompts.push(ask)
      return verdict(ask)
    },
    cancelApproval: (requestId) => withdrawn.push(requestId),
    now: () => clock,
    // A real timer, injected short — the wait cannot be driven by a fake clock,
    // so this is the same arrangement mobile-smoke.mjs makes for the same wait.
    approvalTimeoutMs: 200,
    promptCooldownMs: 60_000
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

  const hello = (source, idToken, deviceId, deviceName = 'Chrome on Windows') => ({
    source,
    idToken,
    deviceId,
    deviceName
  })

  /* ------------------------------------------ 1. the credential that works */

  saved = [{ id: 'browser-1', name: 'Chrome', createdAt: 1, lastSeenAt: 1, revokedAt: 0 }]
  const promptsBeforeGood = prompts.length
  const admitted = await auth.authenticate(hello('10.0.0.1', mint(), 'browser-1'))
  log(admitted.ok === true, 'a correctly signed, correctly claimed token for the configured uid and an approved device is admitted')
  log(admitted.ok && admitted.claims.uid === UID, 'and the uid it verified as is handed back to the caller')
  log(prompts.length === promptsBeforeGood, 'and an already-approved browser raises no prompt')
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

  /* -------------------------------------------- 8. an unknown browser, unarmed */

  const promptsBeforeStranger = prompts.length
  const stranger = await auth.authenticate(hello('10.0.0.9', mint(), 'stranger-1', 'Safari on iPad'))
  log(stranger.ok === false && stranger.reason === 'not-approved', 'an unknown device on an unarmed desktop is not-approved')
  log(prompts.length === promptsBeforeStranger, 'and raises no prompt at all')

  /* ------------------------------------------ 9. an unknown browser, armed */

  acceptUntil = clock + 600_000
  verdict = async () => true
  const promptsBeforeArmed = prompts.length
  const shown = []
  const allowed = await auth.authenticate(hello('10.0.0.10', mint(), 'laptop-1', 'Firefox on Linux'), (pending) =>
    shown.push(pending)
  )
  log(allowed.ok === true, 'an unknown device on an armed desktop is admitted once a human presses Allow')
  log(prompts.length === promptsBeforeArmed + 1, 'and raises exactly one prompt')
  log(shown.length === 1 && /^[A-Z]+ [A-Z]+$/.test(shown[0].words), 'the browser is given a word pair to show')
  log(shown[0].words === prompts.at(-1).words, 'and it is the same string offered to the desktop prompt')
  log(shown[0].expiresAt === clock + 200, 'the pending deadline is on the injected clock')
  log(prompts.at(-1).deviceName === 'Firefox on Linux' && prompts.at(-1).uid === UID, 'the prompt names the browser and the account')
  log(withdrawn.at(-1) === prompts.at(-1).requestId, 'and the prompt is withdrawn once it has been answered')
  const record = saved.find((d) => d.id === 'laptop-1')
  log(
    !!record && record.createdAt === clock && record.revokedAt === 0,
    'Allow writes an approval record, live and stamped on the injected clock'
  )

  /* ------------------------------------------------------------ 10. Deny */

  clock += 61_000
  verdict = async () => false
  const promptsBeforeDeny = prompts.length
  const denied = await auth.authenticate(hello('10.0.0.11', mint(), 'nosy-1', 'Edge on Windows'))
  log(denied.ok === false && denied.reason === 'declined', 'the human declining gives declined')
  log(prompts.length === promptsBeforeDeny + 1, 'having raised one prompt')
  log(!saved.some((d) => d.id === 'nosy-1'), 'and nothing is persisted for a browser that was refused')

  clock += 61_000
  verdict = async () => true
  const askedAgain = await auth.authenticate(hello('10.0.0.11', mint(), 'nosy-1', 'Edge on Windows'))
  log(prompts.length === promptsBeforeDeny + 2, 'asking again raises a new prompt rather than reusing the answer')
  log(askedAgain.ok === true, 'and the new answer is the one that counts')
  log(auth.forget('nosy-1') === true, 'that browser can be forgotten again from Settings')

  /* ------------------------------------------------- 11. nobody at the desk */

  clock += 61_000
  verdict = () => new Promise(() => {})
  const promptsBeforeSilence = prompts.length
  const silence = []
  const timedOut = await auth.authenticate(hello('10.0.0.12', mint(), 'ghost-1', 'Chrome on Android'), (pending) =>
    silence.push(pending)
  )
  log(timedOut.ok === false && timedOut.reason === 'timed-out', `no answer within the approval window gives timed-out`)
  log(prompts.length === promptsBeforeSilence + 1, 'having raised one prompt')
  log(withdrawn.at(-1) === prompts.at(-1).requestId, 'and the unanswered prompt is withdrawn rather than left on screen')
  log(!saved.some((d) => d.id === 'ghost-1'), 'and nothing is persisted for a browser nobody answered about')
  log(silence[0].expiresAt === clock + 200, 'the deadline the browser was shown came off the injected clock')
  log(APPROVAL_TIMEOUT_MS === 2 * 60_000, 'the shipped window is the protocol\'s two minutes')

  /* ---------------------------------------------------------- 12. revocation */

  log(auth.revoke('browser-1') === true, 'an approved browser can be revoked')
  const promptsBeforeRevoked = prompts.length
  const revoked = await auth.authenticate(hello('10.0.0.13', mint(), 'browser-1'))
  log(revoked.ok === false && revoked.reason === 'revoked', 'a revoked device is refused with revoked, not not-approved')
  log(prompts.length === promptsBeforeRevoked, 'and raises no prompt — a revoked device that keeps knocking is a prompt storm')

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
    'an approval record is an id, a name and three timestamps — there is no credential field to leak'
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
