/**
 * Head-less proof that Forge Mobile's settings.json never holds a raw token.
 *
 * electron/mobile/auth.ts's header states the rule: settings.json holds a
 * SHA-256 of each device token and never the token itself. That is a claim
 * about the *file on disk*, so this proves it against the file on disk —
 * bundling the *real* electron/mobile/auth.ts and electron/store.ts with
 * esbuild, pairing a device for real through `MobileAuth`, persisting the
 * result through the real `setSettings`, and reading `settings.json` back off
 * the disk it was written to. No mock verifier, no stubbed persistence.
 *
 *   npm run mobile:auth
 *
 * This is stronger than check 12 in scripts/mobile-smoke.mjs, which scans
 * strings *handed to* persistence (the `save` callback's argument) — proof
 * the app never tried to hand a token to the store, but not proof of what
 * ended up in the file, since a bug in normalisation or serialisation
 * downstream of `save` would slip past it. Reading the file back off disk is
 * the same instinct as scripts/secrets-audit.mjs, aimed at one file instead
 * of the whole tree.
 *
 * The store is pointed at a throwaway data directory via FORGE_DATA_DIR, set
 * before the bundle is imported (store.ts resolves its root lazily, on the
 * first write), so this never reads or writes Steve's real profile. The clock
 * is injected because MobileAuth stamps createdAt/lastSeenAt from it.
 */
import { mkdirSync, readFileSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const ROOT = resolve(import.meta.dirname, '..')
const scratch = join(ROOT, 'node_modules', '.forge-mobile-auth')
rmSync(scratch, { recursive: true, force: true })
mkdirSync(scratch, { recursive: true })

// The store writes under whatever this names, so the check never goes near
// Steve's real profile. Set before the bundle is imported: store.ts resolves
// its root lazily, on the first write.
process.env['FORGE_DATA_DIR'] = join(scratch, 'data')

let failures = 0
const log = (ok, message) => {
  if (!ok) failures++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${message}`)
}

async function main() {
  await build({
    entryPoints: [join(ROOT, 'scripts', 'fixtures', 'mobile-auth-entry.ts')],
    outfile: join(scratch, 'mobile-auth.mjs'),
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    alias: { '@shared': join(ROOT, 'shared') },
    logLevel: 'silent',
    absWorkingDir: ROOT
  })

  const { MobileAuth, hashToken, setSettings } = await import(pathToFileURL(join(scratch, 'mobile-auth.mjs')).href)

  const clock = 1_760_000_000_000
  let saved = []
  const auth = new MobileAuth({
    load: () => saved,
    save: (devices) => {
      saved = devices
    },
    now: () => clock
  })

  /* ------------------------------------------------- 1. pair a real device */

  const offer = auth.offerPairing()
  const pairToken = offer.token
  const paired = auth.authenticate({ source: '10.0.0.1', deviceId: 'phone-1', deviceName: 'Pixel 8', pairToken })
  log(paired.ok === true, 'pairing with a fresh offer succeeds')
  const issuedToken = paired.ok ? paired.issuedToken : ''
  log(!!issuedToken, 'and hands back a raw device token')
  const expectedHash = hashToken(issuedToken)
  log(paired.ok && paired.device.tokenHash === expectedHash, "the record MobileAuth persisted holds that token's SHA-256")

  /* -------------------------------------------- 2. persist through setSettings */

  const written = setSettings({ mobileDevices: saved })
  log(
    written.mobileDevices.length === saved.length && written.mobileDevices[0]?.id === 'phone-1',
    'the real store round-trips the paired device'
  )

  /* ----------------------------------------------- 3. read settings.json back */

  const settingsPath = join(scratch, 'data', 'settings.json')
  const onDisk = readFileSync(settingsPath, 'utf8')

  log(!onDisk.includes(issuedToken), 'the raw device token does not appear anywhere in settings.json')
  log(!onDisk.includes(pairToken), 'and neither does the raw pairing token')
  log(
    onDisk.includes(expectedHash),
    "but the token's SHA-256 digest does — proof the record was actually written, not proof of nothing being saved"
  )
  log(
    written.mobileDevices.every((d) => Object.keys(d).sort().join(',') === 'createdAt,id,lastSeenAt,name,tokenHash'),
    'each persisted device record is exactly id, name, tokenHash and two timestamps — no other credential field'
  )

  /* ------------------------------------------------------------- 4. revoke */

  log(auth.revoke('phone-1') === true, 'a paired device can be revoked')
  const afterRevoke = setSettings({ mobileDevices: saved })
  const onDiskAfterRevoke = readFileSync(settingsPath, 'utf8')
  log(afterRevoke.mobileDevices.every((d) => d.id !== 'phone-1'), 'the revoked device is gone from the persisted list')
  log(!onDiskAfterRevoke.includes(issuedToken), 'and its raw token is not left behind in settings.json either')
  log(!onDiskAfterRevoke.includes(expectedHash), 'nor is its hash — a revoked device leaves nothing on disk to steal')
}

main()
  .catch((err) => {
    failures++
    console.error(`\nFAIL  ${err?.stack ?? err}`)
  })
  .finally(() => {
    rmSync(scratch, { recursive: true, force: true })
    console.log(failures === 0 ? '\nmobile:auth — all checks passed' : `\nmobile:auth — ${failures} FAILED`)
    process.exit(failures === 0 ? 0 : 1)
  })
