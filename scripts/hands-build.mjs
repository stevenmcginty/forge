/**
 * Build a signed, installable Forge Hands APK (hands/, com.forge.hands): the
 * small native helper that lets Forge agents operate Steve's phone.
 *
 *   npm run hands:build
 *
 * Gradle assembleRelease in hands/, then zipalign + apksigner with the same
 * Forge release keystore Forge Mobile uses (scripts/apk-lib.mjs), into
 * dist-apk/forge-hands.apk plus a versioned copy, and the sha256 printed.
 *
 * The version comes from hands/version.json, which hands/app/build.gradle reads
 * directly, so there is nothing to stamp. `npm run hands:ship` bumps it.
 *
 * Unlike apk:build this never creates a keystore: the key is the identity of
 * every Forge install, and only apk-build.mjs (with its loud warning) may mint
 * one. A missing key here is a refusal, not a new key.
 */
import { copyFileSync, existsSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
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

export const HANDS = join(ROOT, 'hands')
export const HANDS_VERSION_FILE = join(HANDS, 'version.json')
export const HANDS_ASSET = 'forge-hands.apk'

export function readHandsVersion() {
  const raw = JSON.parse(readFileSync(HANDS_VERSION_FILE, 'utf8'))
  if (!Number.isInteger(raw.versionCode) || raw.versionCode < 1 || typeof raw.versionName !== 'string' || !raw.versionName) {
    throw new Error(`hands/version.json is malformed: ${JSON.stringify(raw)}`)
  }
  return { versionCode: raw.versionCode, versionName: raw.versionName }
}

// Only build when run as a script; hands-ship.mjs imports the helpers above.
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  build()
}

function build() {
  const version = readHandsVersion()
  console.log(`Building Forge Hands v${version.versionName} (versionCode ${version.versionCode})`)

  /* ------------------------------------------------------- 1. the key */

  if (!existsSync(KEYSTORE) || !existsSync(KEYSTORE_PROPS)) {
    console.error(
      `The Forge release keystore is missing (${KEYSTORE} and ${KEYSTORE_PROPS}).\n` +
        'Restore both from backup. hands:build never makes a new key: a different key means\n' +
        'the installed Forge Hands can never be updated, only uninstalled.'
    )
    process.exit(1)
  }
  const props = Object.fromEntries(
    readFileSync(KEYSTORE_PROPS, 'utf8')
      .split(/\r?\n/)
      .filter((line) => line && !line.startsWith('#') && line.includes('='))
      .map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)])
  )

  /* ------------------------------------------------------- 2. gradle */

  // Machine-local and gitignored (hands/.gitignore), written every run so a
  // fresh clone or a moved SDK is a non-event.
  writeFileSync(
    join(HANDS, 'local.properties'),
    `# Machine-local, written by scripts/hands-build.mjs on every run. Never commit.\nsdk.dir=${sdkDir().replace(/\\/g, '/')}\n`
  )
  run(join(HANDS, 'gradlew.bat'), ['assembleRelease', '--no-daemon'], { cwd: HANDS, shell: true })

  const unsigned = join(HANDS, 'app', 'build', 'outputs', 'apk', 'release', 'app-release-unsigned.apk')
  if (!existsSync(unsigned)) {
    console.error(`Gradle finished but ${unsigned} is not there.`)
    process.exit(1)
  }

  /* ------------------------------------------------ 3. align and sign */

  ensureDir(DIST_APK)
  const tools = buildToolsDir()
  const aligned = join(DIST_APK, 'forge-hands-aligned.tmp.apk')
  const signed = join(DIST_APK, HANDS_ASSET)

  // zipalign before signing: the v2/v3 signature covers the whole file.
  run(join(tools, 'zipalign.exe'), ['-f', '-p', '4', unsigned, aligned], { shell: true })
  run(join(tools, 'apksigner.bat'), [
    'sign',
    '--ks', KEYSTORE,
    '--ks-key-alias', props.keyAlias,
    '--ks-pass', `pass:${props.storePassword}`,
    '--key-pass', `pass:${props.keyPassword}`,
    '--out', signed,
    aligned
  ], { shell: true })
  run(join(tools, 'apksigner.bat'), ['verify', signed], { shell: true })
  rmSync(aligned)
  copyFileSync(signed, join(DIST_APK, `forge-hands-v${version.versionName}.apk`))

  const sha256 = sha256File(signed)
  const certs = capture(join(tools, 'apksigner.bat'), ['verify', '--print-certs', signed], { shell: true })
    .split(/\r?\n/)
    .find((line) => line.includes('SHA-256'))

  console.log(`
Signed APK:  ${signed}  (${(statSync(signed).size / (1024 * 1024)).toFixed(1)} MB)
Version:     ${version.versionName} (build ${version.versionCode})
sha256:      ${sha256}
Signer:      ${certs ?? '(see apksigner verify --print-certs)'}
`)
}
