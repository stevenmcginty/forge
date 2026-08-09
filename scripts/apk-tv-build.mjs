/**
 * Build the Fire TV APK — the same Forge Mobile web app, wrapped for a
 * television and pointed at one desktop on one LAN.
 *
 *   node scripts/apk-tv-build.mjs http://192.168.4.45:8420
 *   node scripts/apk-tv-build.mjs 192.168.4.45        # port defaults to 8420
 *
 * Output is always `dist-apk/forge-tv.apk`, overwritten each run. That stable
 * name is not tidiness: the desktop serves the file at a fixed URL
 * (`http://<lan-ip>:8420/forge-tv.apk`, see electron/mobile/server.ts) and the
 * TV's Downloader app is a box you type a URL into with a remote. A name that
 * moved would mean retyping it.
 *
 * ## Why this is a separate script and not a flag on apk-build
 *
 * apk-build ships a *product*: it bumps a version, writes `latest.json`, keeps
 * a versioned copy, and stamps a permanent `wss://` tunnel address so a phone
 * anywhere in the world can reach home. None of that is true here. This build
 * has no release, no feed, and an address (`http://192.168.x.x:8420`) that is
 * correct only while the TV and the desktop are on the same wifi and only
 * until the router hands out a different lease — which is exactly why the
 * button that runs it lives in Settings, next to the address it bakes.
 *
 * ## What makes it a TV build
 *
 * Three stamps and one gradle property:
 *
 *   FORGE_TV=1                 -> `__FORGE_TV__`, which is the whole of how
 *                                 mobile/src/lib/tv.ts decides to draw the
 *                                 dashboard instead of the phone screens.
 *   FORGE_BAKED_ORIGIN=<lan>   -> the one-tap Connect address.
 *                                 FORGE_TV=1 also selects the television's own
 *                                 update feed in mobile/vite.config.ts —
 *                                 tv-latest.json, which describes
 *                                 com.forge.mobile.tv and nothing else. Both
 *                                 builds get it, including this one: an
 *                                 update replaces a baked address with the
 *                                 shared build's network discovery, which
 *                                 finds the same desktop and survives the
 *                                 lease changing, and the alternative is a
 *                                 television that can never update itself.
 *   -PforgeTv                  -> applicationId com.forge.mobile.tv, so the
 *                                 television and the phone are two apps that
 *                                 can never install over one another.
 *
 * Everything else — the leanback launcher category, the optional touchscreen,
 * the banner — is in the shared manifest and shipped by both builds. See the
 * header of scripts/apk-init.mjs for why that is the right place for it.
 *
 * Signing is the phone's release keystore, unchanged: same key, so a rebuilt
 * TV APK installs *over* the one already on the television instead of being
 * refused. This script will not create that keystore — apk-build owns that,
 * warnings and all, and one file that can never be regenerated should have
 * exactly one thing able to bring it into existence.
 *
 * ## What it does not touch
 *
 * `mobile/dist`. That directory is the browser route — electron/mobile/server.ts
 * serves it to any phone pointed at the desktop — so a TV bundle landing there
 * would silently turn that route into a television. FORGE_TV=1 sends both Vite
 * and Capacitor to `mobile/dist-tv` instead (see the comments in
 * mobile/vite.config.ts and mobile/capacitor.config.js), which means the phone's
 * bundle is not overwritten and then restored, it is never written at all.
 */
import { existsSync, readFileSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import {
  ANDROID,
  DIST_APK,
  KEYSTORE,
  KEYSTORE_PROPS,
  MOBILE,
  ROOT,
  buildToolsDir,
  capture,
  ensureDir,
  readVersion,
  run,
  stampGradleVersion,
  tvOriginOf,
  writeLocalProperties
} from './apk-lib.mjs'

/** The stable name the desktop serves. Also in electron/mobile/server.ts. */
const TV_APK = 'forge-tv.apk'

/**
 * The shared build's own file name.
 *
 * Kept apart from `forge-tv.apk` on purpose: that name is what this machine's
 * own Forge serves to this house's television, and a shared build written over
 * it would silently swap an app addressed to this desktop for one that has to
 * go looking. Two files, two jobs. `scripts/apk-tv-release.mjs` publishes this
 * one; nothing serves it locally.
 */
const TV_SHARED_APK = 'forge-tv-shared.apk'

/* -------------------------------------------------------- 1. the address */

/**
 * `--shared` builds the APK that goes on GitHub: **no address inside it at
 * all.**
 *
 * A baked address is what makes the ordinary build unshareable — it is correct
 * for exactly one house, and wrong in a way nobody on a sofa can diagnose. The
 * shared build finds its desktop instead, by asking the network (see the
 * discovery block in shared/mobile.ts, mobile/src/components/TvConnect.tsx and
 * electron/mobile/discovery.ts). One binary, anybody's wifi, and the only thing
 * anyone has to do is press OK on the desktop that answers.
 */
const shared = process.argv.includes('--shared')
const origin = shared ? '' : await tvOriginOf(process.argv[2])
if (!shared && !origin) {
  console.error(
    `Usage: node scripts/apk-tv-build.mjs <desktop address>\n` +
      `       node scripts/apk-tv-build.mjs --shared    # no address baked in; finds it on the network\n` +
      `  e.g. node scripts/apk-tv-build.mjs http://192.168.4.45:8420\n\n` +
      `"${process.argv[2] ?? ''}" is not an address this TV could dial. It must be plain http on the\n` +
      `LAN — nothing on this machine serves the mobile port over TLS, so an https address would be\n` +
      `baked into a signed APK and fail on the television looking like the desktop was off.`
  )
  process.exit(1)
}

/* ------------------------------------------------------- 2. the preflight */

// Everything below is applied by apk:init, and every one of them fails in a
// way that is expensive to diagnose from the far end: an APK that installs and
// cannot be found on the home screen, or one that installs over the phone app.
// Cheaper to refuse here, by name.
const required = [
  [join(ANDROID, 'app'), 'mobile/android does not exist yet'],
  [KEYSTORE, `no release keystore at ${KEYSTORE}`],
  [KEYSTORE_PROPS, `no ${KEYSTORE_PROPS} beside the keystore`]
]
for (const [path, why] of required) {
  if (!existsSync(path)) {
    console.error(`${why} — run \`npm run apk:init\` and then \`npm run apk:build\` once first.`)
    process.exit(1)
  }
}

const manifestXml = readFileSync(join(ANDROID, 'app', 'src', 'main', 'AndroidManifest.xml'), 'utf8')
const appGradle = readFileSync(join(ANDROID, 'app', 'build.gradle'), 'utf8')
const missing = [
  [manifestXml.includes('LEANBACK_LAUNCHER'), 'the LEANBACK_LAUNCHER category (a TV would not list the app at all)'],
  [manifestXml.includes('android.hardware.touchscreen'), 'the optional-touchscreen feature (a TV would refuse the install)'],
  [manifestXml.includes('android:banner'), 'the android:banner (the TV home row would show a blank tile)'],
  [appGradle.includes('forgeTv'), 'the -PforgeTv applicationId hook in app/build.gradle']
].filter(([present]) => !present)
if (missing.length > 0) {
  console.error(
    `The android project is missing:\n${missing.map(([, what]) => `  - ${what}`).join('\n')}\n` +
      `Run \`npm run apk:init\` — it applies all of these idempotently.`
  )
  process.exit(1)
}

/* -------------------------------------------------- 3. web bundle + sync */

const version = readVersion()
console.log(`Building Forge TV v${version.versionName} (versionCode ${version.versionCode})`)
console.log(shared ? 'Baked-in desktop: none — this build finds one on the network' : `Baked-in desktop: ${origin}`)
stampGradleVersion(version)

const npx = 'npx'
const tvEnv = {
  ...process.env,
  FORGE_APK_VERSION_CODE: String(version.versionCode),
  FORGE_APK_VERSION_NAME: version.versionName,
  FORGE_BAKED_ORIGIN: origin,
  FORGE_TV: '1'
  // No FORGE_APK_MANIFEST_URL here on purpose. mobile/vite.config.ts picks the
  // television's own feed when FORGE_TV is 1, so the URL is decided by the
  // thing that also decides the applicationId rather than by this script
  // remembering to pass one. Setting it to '' is still how a build is given no
  // feed at all, and update.ts reads an empty URL as "nothing to check".
}
run(npx, ['vite', 'build', '--config', 'mobile/vite.config.ts'], { cwd: ROOT, env: tvEnv, shell: true })
run(npx, ['cap', 'sync', 'android'], { cwd: MOBILE, env: tvEnv, shell: true })

/* ------------------------------------------------------------ 4. gradle */

writeLocalProperties()
run(join(ANDROID, 'gradlew.bat'), ['assembleRelease', '-PforgeTv', '--no-daemon'], { cwd: ANDROID, shell: true })

const unsigned = join(ANDROID, 'app', 'build', 'outputs', 'apk', 'release', 'app-release-unsigned.apk')
if (!existsSync(unsigned)) {
  console.error(`Gradle finished but ${unsigned} is not there.`)
  process.exit(1)
}

/* -------------------------------------------------- 5. align, sign, verify */

const props = Object.fromEntries(
  readFileSync(KEYSTORE_PROPS, 'utf8')
    .split(/\r?\n/)
    .filter((line) => line && !line.startsWith('#') && line.includes('='))
    .map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)])
)

ensureDir(DIST_APK)
const tools = buildToolsDir()
const aligned = join(DIST_APK, 'forge-tv-aligned.tmp.apk')
const signed = join(DIST_APK, shared ? TV_SHARED_APK : TV_APK)

// zipalign before signing, as in apk-build: the v2/v3 signature covers the
// whole file, so aligning afterwards would invalidate it.
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

const sizeBytes = statSync(signed).size
const certs = capture(join(tools, 'apksigner.bat'), ['verify', '--print-certs', signed], { shell: true })
  .split(/\r?\n/)
  .find((line) => line.includes('SHA-256'))

console.log(
  shared
    ? `
Signed APK:  ${signed}  (${(sizeBytes / (1024 * 1024)).toFixed(1)} MB)
Desktop:     none — it asks the network which Forge is there
Signer:      ${certs ?? '(see apksigner verify --print-certs)'}

Publish it with:  npm run apk:tv:release
`
    : `
Signed APK:  ${signed}  (${(sizeBytes / (1024 * 1024)).toFixed(1)} MB)
Desktop:     ${origin}
Signer:      ${certs ?? '(see apksigner verify --print-certs)'}

On the Fire TV, open Downloader and type:  ${origin}/${TV_APK}
`
)
