/**
 * Build a signed, installable Forge Mobile APK plus the `latest.json` the
 * shipped app polls for updates.
 *
 *   npm run apk:build                  # build the version in mobile/version.json
 *   npm run apk:build -- --bump        # bump versionCode/patch first, then build
 *   npm run apk:build -- --bump minor  # a feature release: 0.1.3 → 0.2.0
 *
 * The order matters and is the point of scripting it: version.json is the
 * single source of truth, so the web bundle (Vite define), the native
 * versionCode/versionName (build.gradle) and the manifest are all stamped
 * from it *in the same run*. Any two of those disagreeing is an update
 * mechanism that lies to itself.
 *
 * ## Signing, which is forever
 *
 * Android will only install an update over an existing app if both are
 * signed with the **same key** — a debug-signed install can never be
 * upgraded by a release build; the install just fails with an error that
 * blames nothing useful. So this script signs every build with one stable
 * release keystore kept *outside the repo* at %APPDATA%\Forge\android\.
 * First run generates it (keytool, 25-year validity) and prints the warning
 * that cannot be printed loudly enough: that file is the only thing that can
 * ever ship an update to an installed Forge Mobile. Signing happens here
 * with apksigner rather than inside build.gradle so the gradle files stay
 * stock (regenerable by apk:init) and no path to key material ever appears
 * in the repo tree.
 */
import { randomBytes } from 'node:crypto'
import { copyFileSync, existsSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  ANDROID,
  APK_ASSET,
  DIST_APK,
  KEYSTORE,
  KEYSTORE_DIR,
  KEYSTORE_PROPS,
  MOBILE,
  RELEASE_REPO,
  ROOT,
  buildToolsDir,
  capture,
  ensureDir,
  readVersion,
  run,
  sha256File,
  stampGradleVersion,
  writeLocalProperties,
  writeVersion
} from './apk-lib.mjs'

const args = process.argv.slice(2)
const bump = args.includes('--bump')
// `--bump` alone is a patch; `--bump minor` zeroes the patch as semver
// expects, so a feature release reads as 0.2.0 rather than a 0.1.x that
// happens to contain a feature. Anything else after --bump is refused loudly:
// silently treating a typo as "patch" would stamp the wrong number into an
// APK that then ships.
const bumpPart = (() => {
  const next = args[args.indexOf('--bump') + 1] ?? ''
  if (!bump || next.startsWith('--') || next === '') return 'patch'
  if (next === 'patch' || next === 'minor') return next
  console.error(`--bump takes "patch" (default) or "minor", not "${next}".`)
  process.exit(1)
})()
const notesArg = (() => {
  const at = args.indexOf('--notes')
  return at !== -1 ? (args[at + 1] ?? '') : ''
})()

if (!existsSync(join(ANDROID, 'app'))) {
  console.error('mobile/android does not exist yet — run `npm run apk:init` first.')
  process.exit(1)
}

/* ----------------------------------------------------------- 1. version */

let version = readVersion()
if (bump) {
  const parts = version.versionName.split('.')
  if (bumpPart === 'minor' && parts.length >= 2) {
    parts[parts.length - 2] = String(Number(parts[parts.length - 2] ?? 0) + 1)
    parts[parts.length - 1] = '0'
  } else {
    parts[parts.length - 1] = String(Number(parts[parts.length - 1] ?? 0) + 1)
  }
  version = { versionCode: version.versionCode + 1, versionName: parts.join('.') }
  writeVersion(version)
  console.log(`Bumped to v${version.versionName} (build ${version.versionCode}).`)
}
console.log(`Building Forge Mobile v${version.versionName} (versionCode ${version.versionCode})`)
stampGradleVersion(version)

/* ---------------------------------------------------------- 2. keystore */

ensureDir(KEYSTORE_DIR)
if (!existsSync(KEYSTORE)) {
  console.log('\nNo release keystore found — generating one.')
  const storePass = randomBytes(24).toString('base64url')
  const props = [
    '# Forge Mobile release signing. Written once by scripts/apk-build.mjs.',
    '# The .jks next to this file is the ONLY key that can update the app.',
    `storeFile=${KEYSTORE.replace(/\\/g, '/')}`,
    `storePassword=${storePass}`,
    `keyPassword=${storePass}`,
    'keyAlias=forge'
  ].join('\n')
  // No shell: keytool.exe takes the args directly, which is what keeps the
  // spaces inside -dname as one argument instead of six.
  run('keytool', [
    '-genkeypair',
    '-keystore', KEYSTORE,
    '-alias', 'forge',
    '-keyalg', 'RSA',
    '-keysize', '4096',
    '-validity', '9125', // 25 years — Android refuses installs past expiry.
    '-storepass', storePass,
    '-keypass', storePass,
    '-dname', 'CN=Forge Mobile, OU=Forge, O=Forge, C=GB'
  ])
  writeFileSync(KEYSTORE_PROPS, props + '\n')
  const banner = '!'.repeat(74)
  console.log(`
${banner}
!!  A NEW RELEASE KEYSTORE WAS JUST CREATED:
!!    ${KEYSTORE}
!!    ${KEYSTORE_PROPS}
!!
!!  This keystore is the ONLY thing that can ever ship an update to any
!!  phone this APK is installed on. Android refuses updates signed with a
!!  different key — lose these two files and every install is orphaned:
!!  the only path forward is uninstall (losing the pairing) and reinstall.
!!
!!  BACK BOTH FILES UP NOW, somewhere that is not this machine.
!!  Never commit them; .gitignore already refuses the whole class.
${banner}
`)
}
if (!existsSync(KEYSTORE_PROPS)) {
  console.error(`The keystore exists but ${KEYSTORE_PROPS} is missing — restore it from backup; without the passwords nothing can be signed.`)
  process.exit(1)
}
const props = Object.fromEntries(
  readFileSync(KEYSTORE_PROPS, 'utf8')
    .split(/\r?\n/)
    .filter((line) => line && !line.startsWith('#') && line.includes('='))
    .map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)])
)

/* ------------------------------------------- 3. web bundle + native sync */

// The FORGE_APK_* envs make the defines byte-certain even though version.json
// was just written — the bundle must describe the build it is inside.
const env = {
  ...process.env,
  FORGE_APK_VERSION_CODE: String(version.versionCode),
  FORGE_APK_VERSION_NAME: version.versionName
}
const npx = 'npx'
run(npx, ['vite', 'build', '--config', 'mobile/vite.config.ts'], { cwd: ROOT, env, shell: true })
run(npx, ['cap', 'sync', 'android'], { cwd: MOBILE, env, shell: true })

/* -------------------------------------------------------- 4. gradle */

writeLocalProperties()
run(join(ANDROID, 'gradlew.bat'), ['assembleRelease', '--no-daemon'], { cwd: ANDROID, shell: true })

const unsigned = join(ANDROID, 'app', 'build', 'outputs', 'apk', 'release', 'app-release-unsigned.apk')
if (!existsSync(unsigned)) {
  console.error(`Gradle finished but ${unsigned} is not there.`)
  process.exit(1)
}

/* ---------------------------------------------------- 5. align and sign */

ensureDir(DIST_APK)
const tools = buildToolsDir()
const aligned = join(DIST_APK, 'forge-mobile-aligned.tmp.apk')
const signed = join(DIST_APK, APK_ASSET)

// zipalign before signing: the v2/v3 signature covers the whole file, so
// aligning afterwards would invalidate it.
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
// A versioned copy alongside the stable-named upload asset, so old builds
// remain identifiable on disk after the next one overwrites forge-mobile.apk.
copyFileSync(signed, join(DIST_APK, `forge-mobile-v${version.versionName}.apk`))

/* -------------------------------------------------------- 6. latest.json */

// apkUrl is pinned to this release's tag, not to `latest/download`: the
// sha256 below is a promise about one exact file, and a floating URL could
// point somewhere else by the time a slow phone gets round to downloading.
const manifest = {
  versionCode: version.versionCode,
  versionName: version.versionName,
  apkUrl: `https://github.com/${RELEASE_REPO}/releases/download/v${version.versionName}/${APK_ASSET}`,
  sizeBytes: statSync(signed).size,
  sha256: sha256File(signed),
  notes: notesArg || `Forge Mobile v${version.versionName}.`
}
writeFileSync(join(DIST_APK, 'latest.json'), JSON.stringify(manifest, null, 2) + '\n')

const certs = capture(join(tools, 'apksigner.bat'), ['verify', '--print-certs', signed], { shell: true })
  .split(/\r?\n/)
  .find((line) => line.includes('SHA-256'))

console.log(`
Signed APK:  ${signed}  (${(manifest.sizeBytes / (1024 * 1024)).toFixed(1)} MB)
Manifest:    ${join(DIST_APK, 'latest.json')}
sha256:      ${manifest.sha256}
Signer:      ${certs ?? '(see apksigner verify --print-certs)'}

Publish with: npm run apk:release
`)
