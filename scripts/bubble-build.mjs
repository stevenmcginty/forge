/**
 * Build a signed, installable Forge Bubble APK (bubble/, com.forge.bubble):
 * Forge Web in a Trusted Web Activity plus the floating voice bubble.
 *
 *   npm run bubble:build
 *
 * Gradle assembleRelease in bubble/, then zipalign + apksigner with the same
 * Forge release keystore Forge Mobile and Forge Hands use (scripts/apk-lib.mjs),
 * into dist-apk/forge-bubble.apk plus a versioned copy, and the sha256 printed.
 * The signer must match web/public/well-known/assetlinks.json, or the TWA shows
 * a browser bar: this script checks that.
 *
 * The version comes from bubble/version.json, which bubble/app/build.gradle
 * reads directly. The Forge Web config comes from web/public/config.json
 * (git-ignored); without it the APK builds but cannot sign in, so this warns.
 *
 * Like hands:build this never creates a keystore. The passwords go to apksigner
 * through the environment (`env:`), never on a command line or in a log.
 */
import { copyFileSync, existsSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  DIST_APK,
  KEYSTORE,
  KEYSTORE_PROPS,
  ROOT,
  buildToolsDir,
  capture,
  ensureDir,
  run,
  sdkDir,
  sha256File
} from './apk-lib.mjs'

const BUBBLE = join(ROOT, 'bubble')
const VERSION_FILE = join(BUBBLE, 'version.json')
const WEB_CONFIG = join(ROOT, 'web', 'public', 'config.json')
const ASSETLINKS = join(ROOT, 'web', 'public', 'well-known', 'assetlinks.json')
const ASSET = 'forge-bubble.apk'
const PACKAGE = 'com.forge.bubble'

const version = JSON.parse(readFileSync(VERSION_FILE, 'utf8'))
if (!Number.isInteger(version.versionCode) || version.versionCode < 1 || typeof version.versionName !== 'string' || !version.versionName) {
  throw new Error(`bubble/version.json is malformed: ${JSON.stringify(version)}`)
}
console.log(`Building Forge Bubble v${version.versionName} (versionCode ${version.versionCode})`)

/* ------------------------------------------------------------- 1. the key */

if (!existsSync(KEYSTORE) || !existsSync(KEYSTORE_PROPS)) {
  console.error(
    `The Forge release keystore is missing (${KEYSTORE} and ${KEYSTORE_PROPS}).\n` +
      'Restore both from backup. bubble:build never makes a new key: a different key means\n' +
      'the installed Forge Bubble can never be updated, and the TWA loses its verified origin.'
  )
  process.exit(1)
}
const props = Object.fromEntries(
  readFileSync(KEYSTORE_PROPS, 'utf8')
    .split(/\r?\n/)
    .filter((line) => line && !line.startsWith('#') && line.includes('='))
    .map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)])
)

if (!existsSync(WEB_CONFIG)) {
  console.warn(
    'WARNING: web/public/config.json is missing (it is git-ignored). The APK will build with an\n' +
      'empty Forge Web config and say "This build has no Forge Web config" instead of signing in.'
  )
}

/* ---------------------------------------------------------------- 2. gradle */

writeFileSync(
  join(BUBBLE, 'local.properties'),
  `# Machine-local, written by scripts/bubble-build.mjs on every run. Never commit.\nsdk.dir=${sdkDir().replace(/\\/g, '/')}\n`
)
run(join(BUBBLE, 'gradlew.bat'), ['assembleRelease', '--no-daemon'], { cwd: BUBBLE, shell: true })

const unsigned = join(BUBBLE, 'app', 'build', 'outputs', 'apk', 'release', 'app-release-unsigned.apk')
if (!existsSync(unsigned)) {
  console.error(`Gradle finished but ${unsigned} is not there.`)
  process.exit(1)
}

/* ------------------------------------------------------- 3. align and sign */

ensureDir(DIST_APK)
const tools = buildToolsDir()
const aligned = join(DIST_APK, 'forge-bubble-aligned.tmp.apk')
const signed = join(DIST_APK, ASSET)

// zipalign before signing: the v2/v3 signature covers the whole file.
run(join(tools, 'zipalign.exe'), ['-f', '-p', '4', unsigned, aligned], { shell: true })
run(join(tools, 'apksigner.bat'), [
  'sign',
  '--ks', KEYSTORE,
  '--ks-key-alias', props.keyAlias,
  '--ks-pass', 'env:FORGE_BUBBLE_KS_PASS',
  '--key-pass', 'env:FORGE_BUBBLE_KEY_PASS',
  '--out', signed,
  aligned
], { shell: true, env: { ...process.env, FORGE_BUBBLE_KS_PASS: props.storePassword, FORGE_BUBBLE_KEY_PASS: props.keyPassword } })
run(join(tools, 'apksigner.bat'), ['verify', signed], { shell: true })
rmSync(aligned)
copyFileSync(signed, join(DIST_APK, `forge-bubble-v${version.versionName}.apk`))

/* ------------------------------------------- 4. the signer vs assetlinks */

const certLine = capture(join(tools, 'apksigner.bat'), ['verify', '--print-certs', signed], { shell: true })
  .split(/\r?\n/)
  .find((line) => line.includes('SHA-256'))
const signerHex = (certLine ?? '').split(':').pop().trim().toUpperCase()
const linked = JSON.parse(readFileSync(ASSETLINKS, 'utf8'))
  .filter((s) => s.target?.package_name === PACKAGE)
  .flatMap((s) => s.target.sha256_cert_fingerprints ?? [])
  .map((f) => f.replace(/:/g, '').toUpperCase())
const matches = signerHex !== '' && linked.includes(signerHex)

const sha256 = sha256File(signed)
console.log(`
Signed APK:  ${signed}  (${(statSync(signed).size / (1024 * 1024)).toFixed(1)} MB)
Version:     ${version.versionName} (build ${version.versionCode})
sha256:      ${sha256}
Signer:      ${certLine ?? '(see apksigner verify --print-certs)'}
Assetlinks:  ${matches ? 'signer matches web/public/well-known/assetlinks.json' : 'MISMATCH - the TWA will not verify'}
`)
if (!matches) process.exit(1)
