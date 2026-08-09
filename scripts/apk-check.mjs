/**
 * Headless proof of everything about the APK that a script can prove without
 * a phone.
 *
 *   npm run apk:check
 *
 * The important trick: the version-comparison and manifest-parsing checks run
 * against the *real* mobile/src/lib/manifest.ts, bundled with esbuild — the
 * same move mobile-smoke.mjs makes for the server — so the parser that
 * rejects a malformed feed here is the one that will reject it on the phone,
 * not a re-implementation that can drift. What no script can prove: that
 * DownloadManager, the FileProvider hand-off and the install prompt behave on
 * a physical handset. That part is Steve's.
 */
import { mkdirSync, existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createHash } from 'node:crypto'
import { build } from 'esbuild'
import { bakedOriginOf, readVersion, sha256File, tvOriginOf, ANDROID, DIST_APK, APK_ASSET, MOBILE } from './apk-lib.mjs'

const ROOT = resolve(import.meta.dirname, '..')
const scratch = join(ROOT, 'node_modules', '.forge-apk-check')
mkdirSync(scratch, { recursive: true })

let failures = 0
let n = 0
const log = (ok, message) => {
  n += 1
  if (!ok) failures++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${String(n).padStart(2)}  ${message}`)
}
const skip = (message) => {
  n += 1
  console.log(`SKIP  ${String(n).padStart(2)}  ${message}`)
}

/* ----------------------------------------- the real manifest logic, in Node */

await build({
  entryPoints: [join(MOBILE, 'src', 'lib', 'manifest.ts')],
  outfile: join(scratch, 'manifest.mjs'),
  bundle: true,
  platform: 'neutral',
  format: 'esm',
  logLevel: 'silent',
  absWorkingDir: ROOT
})
const { parseManifest, isNewer } = await import(pathToFileURL(join(scratch, 'manifest.mjs')).href)

const good = {
  versionCode: 7,
  versionName: '0.3.1',
  apkUrl: 'https://github.com/stevenmcginty/forge-mobile-releases/releases/download/v0.3.1/forge-mobile.apk',
  sizeBytes: 34_000_000,
  sha256: 'a'.repeat(64),
  notes: 'notes'
}

/* -------------------------------------------------- version comparison */

log(isNewer(parseManifest(good), 6) === true, 'a higher versionCode is an update')
log(isNewer(parseManifest(good), 7) === false, 'the same versionCode is up to date')
log(isNewer(parseManifest(good), 8) === false, 'an older manifest never nags a newer build to downgrade')

/* --------------------------------------------------- manifest parsing */

log(parseManifest(good) !== null, 'a well-formed manifest parses')
log(parseManifest({ ...good, notes: undefined })?.notes === '', 'missing notes default to empty, not undefined')
log(parseManifest(null) === null, 'null is rejected')
log(parseManifest('latest') === null, 'a bare string is rejected')
log(parseManifest({ ...good, versionCode: '7' }) === null, 'a stringly-typed versionCode is rejected')
log(parseManifest({ ...good, versionCode: 0 }) === null, 'versionCode 0 is rejected')
log(parseManifest({ ...good, versionCode: 1.5 }) === null, 'a fractional versionCode is rejected')
log(parseManifest({ ...good, versionName: '' }) === null, 'an empty versionName is rejected')
log(parseManifest({ ...good, apkUrl: 'http://example.com/a.apk' }) === null, 'a plain-http apkUrl is rejected — TLS is part of the trust chain')
log(parseManifest({ ...good, apkUrl: undefined }) === null, 'a missing apkUrl is rejected')
log(parseManifest({ ...good, sizeBytes: -1 }) === null, 'a negative size is rejected')
log(parseManifest({ ...good, sha256: 'a'.repeat(63) }) === null, 'a 63-char sha256 is rejected')
log(parseManifest({ ...good, sha256: 'Z'.repeat(64) }) === null, 'a non-hex sha256 is rejected')

/* ------------------------------------------------- sha256 verification */

// Known-answer test first: proves the algorithm is SHA-256 and the encoding
// is lowercase hex, not just that the same function agrees with itself.
const abc = join(scratch, 'abc.bin')
writeFileSync(abc, 'abc')
log(
  sha256File(abc) === 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
  'sha256File matches the published SHA-256 test vector for "abc"'
)

// Then the verification path itself: manifest says X; intact file passes,
// a single flipped byte fails. This is the same compare the Kotlin side does.
const payload = join(scratch, 'payload.bin')
writeFileSync(payload, Buffer.from([1, 2, 3, 4, 5, 6, 7, 8]))
const declared = sha256File(payload)
log(declared === createHash('sha256').update(Buffer.from([1, 2, 3, 4, 5, 6, 7, 8])).digest('hex'), 'file hashing agrees with buffer hashing')
writeFileSync(payload, Buffer.from([1, 2, 3, 4, 5, 6, 7, 9]))
log(sha256File(payload) !== declared, 'one corrupted byte is caught by the hash compare')

/* ------------------------------------------------ the android project */

const manifestXml = join(ANDROID, 'app', 'src', 'main', 'AndroidManifest.xml')
if (!existsSync(manifestXml)) {
  skip('mobile/android not generated — run `npm run apk:init` (remaining native checks skipped)')
} else {
  const xml = readFileSync(manifestXml, 'utf8')
  log(xml.includes('android.permission.REQUEST_INSTALL_PACKAGES'), 'AndroidManifest declares REQUEST_INSTALL_PACKAGES')
  log(xml.includes('android.permission.CAMERA'), 'AndroidManifest declares CAMERA — without it the QR scanner opens and shows black')
  log(
    /uses-feature[^>]*android\.hardware\.camera[^>]*android:required="false"/.test(xml),
    'the camera feature is optional — a camera-less device can still pair by typing'
  )
  const capSettings = join(ANDROID, 'capacitor.settings.gradle')
  log(
    existsSync(capSettings) && readFileSync(capSettings, 'utf8').includes('capacitor-barcode-scanner'),
    'cap sync wired the barcode-scanner native project into the gradle build'
  )
  log(
    /minSdkVersion = project\.hasProperty\('forgeTv'\) \? 25 : 26/.test(
      readFileSync(join(ANDROID, 'variables.gradle'), 'utf8')
    ),
    'minSdkVersion is 26 for phones and 25 for the TV build — the scanner library refuses to merge below 26, and a Fire TV Stick is API 25'
  )

  /* ------------------------------------------------------ the television
   *
   * Every one of these ships in the *phone* APK too, which is the point: a TV
   * APK that is only a TV APK after a build step is one no check can see. What
   * they guard is a class of failure that only shows up at the far end of a
   * living room — an app that installs and cannot be found on the home screen,
   * an installer that refuses the package outright, a blank tile.
   */
  log(xml.includes('android.intent.category.LEANBACK_LAUNCHER'), 'the launch activity is a LEANBACK_LAUNCHER — a TV lists nothing else')
  log(xml.includes('android.intent.category.LAUNCHER'), 'and still a plain LAUNCHER, so one APK opens on a phone too')
  log(
    /uses-feature[^>]*android\.hardware\.touchscreen[^>]*android:required="false"/.test(xml),
    'touchscreen is optional — a TV refuses to install anything that requires one'
  )
  log(
    /uses-feature[^>]*android\.software\.leanback[^>]*android:required="false"/.test(xml),
    'leanback is declared but optional, so the same APK still installs on a phone'
  )
  log(xml.includes('android:banner="@drawable/tv_banner"'), 'the application declares a banner — the TV home row shows nothing else')
  log(
    existsSync(join(ANDROID, 'app', 'src', 'main', 'res', 'drawable-xhdpi', 'tv_banner.png')),
    'the banner drawable exists at xhdpi, where a 320x180 TV banner belongs'
  )
  log(
    xml.includes('tools:overrideLibrary="com.outsystems.plugins.barcode"') && xml.includes('xmlns:tools'),
    'the scanner library’s minSdk 26 is overridden, which is what lets the API 25 TV build merge'
  )
  log(
    readFileSync(join(MOBILE, 'src', 'lib', 'scan.ts'), 'utf8').includes('!__FORGE_TV__ && Capacitor.isNativePlatform()'),
    'and canScan() is false on a TV build — overriding the floor is only safe while the library is never entered'
  )
  // Read here rather than reusing the `gradle` const below: that one is
  // declared further down, and reaching it from up here would be a temporal
  // dead zone, i.e. a check script that crashes instead of checking.
  const tvGradle = readFileSync(join(ANDROID, 'app', 'build.gradle'), 'utf8')
  log(
    tvGradle.includes("if (project.hasProperty('forgeTv'))") && tvGradle.includes('applicationId "com.forge.mobile.tv"'),
    'the TV build takes a .tv applicationId, so a phone release can never install over a television'
  )
  log(xml.includes('androidx.core.content.FileProvider'), 'AndroidManifest declares the FileProvider')
  log(xml.includes('android:grantUriPermissions="true"'), 'the FileProvider grants URI permissions')
  log(xml.includes('android:usesCleartextTraffic="true"'), 'cleartext ws:// to the LAN survives targetSdk 28+')

  const paths = readFileSync(join(ANDROID, 'app', 'src', 'main', 'res', 'xml', 'file_paths.xml'), 'utf8')
  log(paths.includes('name="updates"'), 'file_paths.xml exposes the updates dir to the provider')

  const version = readVersion()
  const gradle = readFileSync(join(ANDROID, 'app', 'build.gradle'), 'utf8')
  log(
    new RegExp(`versionCode\\s+${version.versionCode}(\\s|$)`).test(gradle),
    `gradle versionCode matches mobile/version.json (${version.versionCode})`
  )
  log(gradle.includes(`versionName "${version.versionName}"`), `gradle versionName matches mobile/version.json ("${version.versionName}")`)
  log(gradle.includes('org.jetbrains.kotlin.android'), 'the kotlin-android plugin is applied')
  log(
    gradle.includes("abiFilters 'arm64-v8a', 'armeabi-v7a'"),
    'build.gradle keeps the phone-only abiFilters — losing it is an invisible 11.6 MB of emulator libraries'
  )

  const javaDir = join(ANDROID, 'app', 'src', 'main', 'java', 'com', 'forge', 'mobile')
  const plugin = readFileSync(join(javaDir, 'ForgeUpdaterPlugin.kt'), 'utf8')
  const main = readFileSync(join(javaDir, 'MainActivity.kt'), 'utf8')
  log(main.includes('registerPlugin(ForgeUpdaterPlugin::class.java)'), 'MainActivity registers ForgeUpdater before the bridge builds')
  log(!existsSync(join(javaDir, 'MainActivity.java')), 'the generated Java MainActivity is gone (would be a duplicate class)')
  log(plugin.includes('DownloadManager'), 'the plugin downloads via DownloadManager')
  log(
    plugin.includes('checksum-mismatch') && /file\.delete\(\)[\s\S]*?checksum-mismatch/.test(plugin),
    'a hash mismatch deletes the file before rejecting — never a silent pass'
  )
  log(plugin.includes('canRequestPackageInstalls'), 'install() checks canRequestPackageInstalls on API 26+')
  log(plugin.includes('ACTION_MANAGE_UNKNOWN_APP_SOURCES'), 'a denied install routes to the per-app settings screen')
  log(/STATUS_SUCCESSFUL\s*->\s*verify\(/.test(plugin), 'a finished download goes through verify() — success alone never resolves')

  // The native templates and the copies in the android tree must be the same
  // bytes, or apk:init has drifted from what is actually building.
  for (const source of ['MainActivity.kt', 'ForgeUpdaterPlugin.kt']) {
    log(
      readFileSync(join(MOBILE, 'native', source), 'utf8') === readFileSync(join(javaDir, source), 'utf8'),
      `mobile/native/${source} matches the copy in the android tree`
    )
  }
}

/* --------------------------------------------------- capacitor config */

const capConfig = readFileSync(join(MOBILE, 'capacitor.config.js'), 'utf8')
log(capConfig.includes("androidScheme: 'https'"), 'the WebView is a secure context (androidScheme https)')
log(capConfig.includes('cleartext: true'), 'cleartext is allowed for the ws:// LAN route')
log(capConfig.includes('allowMixedContent: true'), 'mixed content is allowed (https origin → ws:// socket)')

/* -------------------------------------- the scanned payload, end to end */

// The QR path must feed the *real* decoder, so these run against secure.ts
// bundled the same way manifest.ts is above — not a re-statement of its
// rules. The check that matters most: a tunnel payload must come out with
// **no port**. `wss://host:8420` is an address nothing listens on, and it
// fails with a connection error that looks like the desktop being down —
// the exact bug toOrigin's comment records from the first time round.
// `browser`, not `neutral`: secure.ts imports @capacitor/*, whose package
// exports only resolve under a browser-shaped condition — which is also the
// platform the real bundle targets, so the check compiles what ships.
await build({
  entryPoints: [join(MOBILE, 'src', 'lib', 'secure.ts')],
  outfile: join(scratch, 'secure.mjs'),
  bundle: true,
  platform: 'browser',
  format: 'esm',
  logLevel: 'silent',
  absWorkingDir: ROOT
})
const { toOrigin, pairTokenOf } = await import(pathToFileURL(join(scratch, 'secure.mjs')).href)

const tunnelScan = 'forge://pair?host=steve.ngrok-free.dev&scheme=wss&pt=single-use-code'
log(toOrigin(tunnelScan, 8420) === 'wss://steve.ngrok-free.dev', 'a scanned tunnel payload becomes wss://<host> with no port appended')
log(!toOrigin(tunnelScan, 8420).includes(':8420'), 'the LAN default port never leaks into a tunnel origin')
log(pairTokenOf(tunnelScan) === 'single-use-code', 'the single-use code survives the same scanned payload')
log(
  toOrigin('forge://pair?host=192.168.1.10&port=8420&pt=single-use-code', 8420) === 'ws://192.168.1.10:8420',
  'a scanned LAN payload keeps its explicit port'
)
log(pairTokenOf('https://example.com/menu') === '', 'a QR that is not a Forge pairing link yields no code, so the scan is refused')

/* ------------------------------------------- the baked-in desktop origin */

// One-tap pairing rests on the address stamped into the APK being one the
// phone can actually dial. `bakedOriginOf` is the resolver apk-build really
// uses (and it runs the real normaliseNgrokDomain out of shared/mobile.ts),
// so these are checks on the shipping code path, not on a restatement of it.
// The check that matters most is the same one the QR path has: **no port.**
log(
  (await bakedOriginOf('cure-task-legroom.ngrok-free.dev')) === 'wss://cure-task-legroom.ngrok-free.dev',
  'a bare tunnel domain bakes as wss://<domain>'
)
log(
  (await bakedOriginOf('https://cure-task-legroom.ngrok-free.dev/')) === 'wss://cure-task-legroom.ngrok-free.dev',
  'a pasted https URL bakes to the same origin'
)
log(
  (await bakedOriginOf('wss://steve.ngrok-free.dev')) === 'wss://steve.ngrok-free.dev',
  'a wss paste is accepted rather than mangled'
)
log(!/:\d/.test(await bakedOriginOf('steve.ngrok-free.dev')), 'no port is ever appended to a baked origin')
log(
  (await bakedOriginOf('')) === '' && (await bakedOriginOf(undefined)) === '',
  'an absent mobileNgrokDomain bakes nothing — the build stays unstamped and works'
)
log((await bakedOriginOf('not a domain!')) === '', 'garbage never becomes a baked address')
// Round-trip through the phone's own decoder: the stamp must survive toOrigin
// verbatim, or the APK dials somewhere other than what was stamped.
log(
  toOrigin(await bakedOriginOf('steve.ngrok-free.dev'), 8420) === 'wss://steve.ngrok-free.dev',
  'the phone reads the baked origin back with no port — toOrigin’s tunnel rule holds'
)
log(toOrigin('', 8420) === '', 'an unstamped build yields no origin, so the QR/typed connect screen still renders')

/* --------------------------------------- the TV's baked origin, the opposite
 *
 * Everything above is about a tunnel: a domain, no port, wss. A television gets
 * the exact reverse — a LAN IP, an explicit port, plain http — because it is in
 * the same room as the desktop and there is no certificate on that port. The
 * check that matters here is the round trip: whatever gets stamped must come
 * back out of the phone's own `toOrigin` as a socket the TV can open, or the
 * one-tap Connect screen dials nothing.
 */
log((await tvOriginOf('192.168.4.45')) === 'http://192.168.4.45:8420', 'a bare LAN address bakes as http://<ip> with the default port added')
log((await tvOriginOf('http://192.168.4.45:8420')) === 'http://192.168.4.45:8420', 'a full http address survives verbatim')
log((await tvOriginOf('https://192.168.4.45:8420')) === '', 'https is refused — nothing on this machine serves the mobile port over TLS')
log((await tvOriginOf('')) === '' && (await tvOriginOf('not an address!')) === '', 'nothing and nonsense both bake nothing, so the build refuses rather than stamping a dud')
log(
  toOrigin(await tvOriginOf('192.168.4.45'), 8420) === 'ws://192.168.4.45:8420',
  'the TV reads its baked origin back as a ws:// LAN socket — the one-tap Connect screen dials what was stamped'
)

const viteBaked = readFileSync(join(MOBILE, 'vite.config.ts'), 'utf8')
log(
  viteBaked.includes('__BAKED_ORIGIN__') && viteBaked.includes("FORGE_BAKED_ORIGIN ?? ''"),
  'vite defines __BAKED_ORIGIN__ from FORGE_BAKED_ORIGIN, defaulting to empty'
)
log(
  readFileSync(join(MOBILE, 'src', 'App.tsx'), 'utf8').includes('__BAKED_ORIGIN__'),
  'App.tsx consumes the baked origin define'
)

/* ------------------------------------------------ version define wiring */

const viteConfig = readFileSync(join(MOBILE, 'vite.config.ts'), 'utf8')
log(
  viteConfig.includes('__APK_VERSION_CODE__') && viteConfig.includes("readFileSync(resolve(import.meta.dirname, 'version.json')"),
  'the Vite define is driven by version.json — web and native cannot drift'
)
const envDts = readFileSync(join(MOBILE, 'src', 'env.d.ts'), 'utf8')
log(
  envDts.includes('__APK_MANIFEST_URL__') && envDts.includes('__BAKED_ORIGIN__') && envDts.includes('__FORGE_TV__'),
  'the defines are declared for TypeScript'
)
log(
  viteConfig.includes("__FORGE_TV__: JSON.stringify(process.env.FORGE_TV === '1')"),
  'vite defines __FORGE_TV__ from FORGE_TV, so nothing but the TV build can set it'
)
const capTv = readFileSync(join(MOBILE, 'capacitor.config.js'), 'utf8')
log(
  viteConfig.includes("process.env.FORGE_TV === '1' ? 'dist-tv' : 'dist'") &&
    capTv.includes("process.env.FORGE_TV === '1' ? 'dist-tv' : 'dist'"),
  'a TV build writes to mobile/dist-tv, so it cannot leave the browser route serving a television'
)
// A television has no browser route and no cable; without this there is no
// devtools socket on the device and a page-level bug can only be guessed at.
log(
  /FORGE_TV === '1' \? \{ webContentsDebuggingEnabled: true \}/.test(capTv),
  'the TV build enables WebView remote debugging — the only way to inspect the page on a Fire TV'
)
log(
  readFileSync(join(MOBILE, 'src', 'lib', 'tv.ts'), 'utf8').includes('__FORGE_TV__ ||'),
  'isTv() answers from the define first — the APK has no query string to carry ?tv'
)

/* ------------------------------------------- the manifest fetch dodges CORS */

/*
 * The shipped app fetched the manifest with `fetch()` from an https://localhost
 * origin. GitHub's release-asset host sends no Access-Control-Allow-Origin, so
 * Chromium blocked every response and the app reported "probably offline" on a
 * phone that was online — an update check that could not have succeeded on any
 * network. These three assertions are what stop that regressing: the plugin
 * must offer fetchManifest, the app must call it, and it must only fall back to
 * fetch() off-device.
 */
const updateTs = readFileSync(join(MOBILE, 'src', 'lib', 'update.ts'), 'utf8')
const pluginKt = readFileSync(join(MOBILE, 'native', 'ForgeUpdaterPlugin.kt'), 'utf8')
log(
  /@PluginMethod\s+fun fetchManifest\(/.test(pluginKt),
  'the native plugin exposes fetchManifest — the WebView cannot fetch the feed itself'
)
log(
  updateTs.includes('native.fetchManifest({ url: __APK_MANIFEST_URL__ })'),
  'update.ts reads the manifest through the plugin, not through a CORS-blocked fetch'
)
log(
  /if \(isNativeApp\(\)\) \{\s*const \{ body \} = await native\.fetchManifest/.test(updateTs),
  'fetch() is the browser-debug fallback only — the APK never takes that path'
)
// And the television never takes any of it: a different application id, built
// for one LAN, whose only update path is being rebuilt and downloaded again.
// Android's install confirmation is not a dialog a remote control can answer.
log(updateTs.includes('if (__FORGE_TV__) {'), 'update.ts refuses to check an update feed on a TV build')

const androidKt = readFileSync(
  join(MOBILE, 'android', 'app', 'src', 'main', 'java', 'com', 'forge', 'mobile', 'ForgeUpdaterPlugin.kt'),
  'utf8'
)
log(
  androidKt === pluginKt,
  'the copy Gradle compiles matches mobile/native — apk:init has been run since the last edit'
)

/* -------------------------------------- no key material inside the repo */

const suspects = []
const IGNORED_DIRS = new Set(['node_modules', '.git', 'dist', 'out', 'release', 'build', '.gradle', 'dist-apk'])
const walk = (dir) => {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    const stats = statSync(full)
    if (stats.isDirectory()) {
      if (!IGNORED_DIRS.has(entry)) walk(full)
    } else if (/\.(jks|keystore)$/i.test(entry) || entry === 'keystore.properties') {
      suspects.push(full)
    }
  }
}
walk(ROOT)
log(suspects.length === 0, `no keystore or keystore.properties anywhere in the repo tree${suspects.length ? ` — FOUND: ${suspects.join(', ')}` : ''}`)

const gitignore = readFileSync(join(ROOT, '.gitignore'), 'utf8')
log(
  gitignore.includes('*.jks') && gitignore.includes('keystore.properties') && gitignore.includes('dist-apk/'),
  '.gitignore refuses the whole class of key material and build output'
)
log(gitignore.includes('mobile/android/local.properties'), '.gitignore covers the machine-local SDK pointer')

/* ------------------------------------------- built artefacts, if present */

const latestPath = join(DIST_APK, 'latest.json')
if (!existsSync(latestPath)) {
  skip('dist-apk/latest.json absent — run `npm run apk:build` to check the real artefacts')
} else {
  const manifest = parseManifest(JSON.parse(readFileSync(latestPath, 'utf8')))
  log(manifest !== null, 'the built latest.json passes the app’s own parser')
  const apk = join(DIST_APK, APK_ASSET)
  if (manifest && existsSync(apk)) {
    log(sha256File(apk) === manifest.sha256, 'latest.json sha256 matches the APK beside it')
    log(statSync(apk).size === manifest.sizeBytes, 'latest.json sizeBytes matches the APK beside it')
    log(manifest.versionCode === readVersion().versionCode, 'latest.json versionCode matches mobile/version.json')

    // Which ABIs actually shipped. Zip entry names are stored uncompressed in
    // the archive, so a plain byte scan of the APK finds `lib/<abi>/…` paths
    // with certainty — no unzip dependency, and no trusting build.gradle to
    // describe a file it might not have produced. This is the check that
    // catches `cap sync` regenerating the gradle file without the ndk block:
    // the build succeeds, the APK works, and it is silently 11.6 MB heavier.
    const bytes = readFileSync(apk)
    log(bytes.includes('lib/arm64-v8a/'), 'the built APK carries arm64-v8a native libraries')
    log(bytes.includes('lib/armeabi-v7a/'), 'the built APK carries armeabi-v7a native libraries')
    log(
      !bytes.includes('lib/x86/') && !bytes.includes('lib/x86_64/'),
      'the built APK carries no x86/x86_64 emulator libraries'
    )
  } else {
    log(false, `dist-apk/${APK_ASSET} is missing next to latest.json`)
  }
}

console.log(`\n${failures === 0 ? 'OK' : 'FAILED'} — ${n} checks, ${failures} failure${failures === 1 ? '' : 's'}.`)
process.exit(failures === 0 ? 0 : 1)
