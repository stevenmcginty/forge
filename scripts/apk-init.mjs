/**
 * One-time (but safely re-runnable) setup of the Android shell around Forge
 * Mobile.
 *
 *   npm run apk:init
 *
 * `npx cap add android` generates a stock project; everything Forge needs on
 * top of stock is applied here as *idempotent patches* rather than one-off
 * hand edits, so `rm -rf mobile/android && npm run apk:init` reproduces the
 * exact same tree. That property is the whole design: the generated project
 * is in git, but nothing in it is sacred, because this script can always
 * rebuild it. The Kotlin sources are not embedded here — they live in
 * mobile/native/ and are copied in, so they get reviewed as code, not as
 * strings.
 *
 * The patches, and why each exists:
 *  - Kotlin gradle plugin: ForgeUpdater is written in Kotlin; the Capacitor
 *    template is Java-only out of the box.
 *  - REQUEST_INSTALL_PACKAGES + FileProvider path: self-update. See
 *    mobile/native/ForgeUpdaterPlugin.kt.
 *  - usesCleartextTraffic: the LAN route is ws:// with no certificate; on
 *    targetSdk 28+ Android blocks that at the network layer regardless of
 *    what the WebView allows. See mobile/capacitor.config.ts for the
 *    matching WebView-side flags.
 *  - local.properties: ANDROID_HOME is not set on this machine; Gradle finds
 *    the SDK through this gitignored file instead.
 *  - The television bits — a leanback launcher category, optional touchscreen,
 *    a banner — live in the shared manifest rather than being patched in by
 *    scripts/apk-tv-build.mjs at build time. They cost a phone nothing (an
 *    extra intent-filter category, two `required="false"` features and one
 *    drawable), and keeping them here means they are visible in the tree
 *    apk-check reads and diffable in review, the same argument the CAMERA
 *    permission below is declared under. A TV APK that is only a TV APK
 *    *after* a build step is one no check script can see.
 *  - The `-PforgeTv` hook in app/build.gradle: the one thing that genuinely
 *    cannot be shared, because it is the application id.
 */
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { ANDROID, MOBILE, ROOT, run, writeLocalProperties, readVersion, stampGradleVersion } from './apk-lib.mjs'
import { drawBanner } from './icon-lib.mjs'

const KOTLIN_VERSION = '1.9.25'
const MANIFEST = join(ANDROID, 'app', 'src', 'main', 'AndroidManifest.xml')
const VARIABLES_GRADLE = join(ANDROID, 'variables.gradle')
const ROOT_GRADLE = join(ANDROID, 'build.gradle')
const APP_GRADLE = join(ANDROID, 'app', 'build.gradle')
const JAVA_DIR = join(ANDROID, 'app', 'src', 'main', 'java', 'com', 'forge', 'mobile')
const XML_DIR = join(ANDROID, 'app', 'src', 'main', 'res', 'xml')
const NATIVE = join(MOBILE, 'native')
/** xhdpi, not `drawable/`: 320x180 is the banner size at that density, so a TV
 *  draws the pixels as authored instead of upscaling an mdpi copy. */
const BANNER_DIR = join(ANDROID, 'app', 'src', 'main', 'res', 'drawable-xhdpi')

const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx'

function patch(path, label, apply) {
  const before = readFileSync(path, 'utf8')
  const after = apply(before)
  if (after === before) {
    console.log(`  ok      ${label} (already applied)`)
    return
  }
  writeFileSync(path, after)
  console.log(`  patched ${label}`)
}

/* ------------------------------------------------------- 1. the project */

if (!existsSync(join(MOBILE, 'dist', 'index.html'))) {
  // `cap add` runs an initial copy of webDir; an empty dist would make that
  // step fail before anything interesting happens.
  console.log('mobile/dist is missing — building the web bundle first.')
  run(npx, ['vite', 'build', '--config', 'mobile/vite.config.ts'], { cwd: ROOT, shell: true })
}

if (!existsSync(join(ANDROID, 'app'))) {
  console.log('Generating mobile/android with Capacitor…')
  run(npx, ['cap', 'add', 'android'], { cwd: MOBILE, shell: true })
} else {
  console.log('mobile/android already exists — applying patches only.')
}

/* --------------------------------------------------- 2. machine-local SDK */

const sdk = writeLocalProperties()
console.log(`  wrote   local.properties (sdk.dir=${sdk})`)

/* -------------------------------------------------------- 3. Kotlin */

patch(ROOT_GRADLE, 'Kotlin gradle plugin (root build.gradle)', (text) => {
  if (text.includes('kotlin-gradle-plugin')) return text
  return text.replace(
    /(classpath\s+'com\.android\.tools\.build:gradle[^']*')/,
    `$1\n        classpath 'org.jetbrains.kotlin:kotlin-gradle-plugin:${KOTLIN_VERSION}'`
  )
})

patch(APP_GRADLE, 'kotlin-android plugin (app build.gradle)', (text) => {
  if (text.includes('org.jetbrains.kotlin.android')) return text
  return text.replace(
    /(apply plugin: 'com\.android\.application')/,
    `$1\napply plugin: 'org.jetbrains.kotlin.android'`
  )
})

/* ----------------------------------------------------- 4. the manifest */

// The television's keyboard offers a microphone only where there is something
// behind it, and this is what lets the app find out. From Android 11 an app
// cannot see another app's activities unless it declares that it wants to look:
// `queryIntentActivities` for a recogniser answers "none" on a device that has
// one, and the button is then hidden on exactly the televisions where it would
// have worked. Fire OS 8 is Android 11, so this is not hypothetical.
//
// A declaration to *look*, not a permission to use — nothing here can start a
// recogniser that the person does not choose to start. See canRecogniseSpeech
// in mobile/native/MainActivity.kt, which is the only caller.
patch(MANIFEST, '<queries> for the speech recogniser', (text) => {
  if (text.includes('android.speech.action.RECOGNIZE_SPEECH')) return text
  return text.replace(
    /(\s*)(<uses-permission android:name="android\.permission\.INTERNET")/,
    `$1<queries>$1  <intent>$1    <action android:name="android.speech.action.RECOGNIZE_SPEECH" />$1  </intent>$1</queries>$1$2`
  )
})

patch(MANIFEST, 'REQUEST_INSTALL_PACKAGES permission', (text) => {
  if (text.includes('android.permission.REQUEST_INSTALL_PACKAGES')) return text
  return text.replace(
    /(\s*)(<uses-permission android:name="android\.permission\.INTERNET")/,
    `$1<uses-permission android:name="android.permission.REQUEST_INSTALL_PACKAGES" />$1$2`
  )
})

// The QR scanner library (ionbarcode-android, inside @capacitor/barcode-
// scanner) declares minSdk 26, and the manifest merger refuses to build an
// app claiming 23 against it — rightly, since a 23 install would crash on
// first scan. 26 is Android 8.0 (2017); Capacitor 8 raises the floor there
// anyway, so this is early rather than exotic. The stock template writes 23,
// which is why this is a patch and not a hand edit that `cap add` would undo.
//
// **Except on the television.** A Fire TV Stick 4K (AFTMM) runs Fire OS on
// Android 7.1.2 — API 25 — and an APK claiming 26 is refused by the installer
// before anything of ours runs. So the TV build declares 25 and overrides the
// scanner library's floor in the manifest below. That is only defensible
// because the TV never enters the scanner: it has no camera, and `canScan()`
// in mobile/src/lib/scan.ts returns false on a TV build for exactly this
// reason. Lower the floor and keep the door shut, or neither.
//
// Read out of `ext` rather than set per-module, because the Capacitor plugin
// modules take their own minSdk from this same property — an app at 25 with a
// library module at 26 fails the merge just as loudly.
patch(VARIABLES_GRADLE, 'minSdkVersion (26 for phones, 25 for the Fire TV build)', (text) => {
  if (text.includes('forgeTv')) return text
  return text.replace(/minSdkVersion = \d+\b/, "minSdkVersion = project.hasProperty('forgeTv') ? 25 : 26")
})

// Ship phone architectures only.
//
// ML Kit's barcode reader carries a native library (`libbarhopper_v3.so`) built
// for every ABI Google supports. Measured on the v0.2.0 build: x86 and x86_64
// together were 11.6 MB of a 30.6 MB APK — architectures that exist for
// emulators, on an app that is only ever sideloaded onto a handset. Nothing
// warns about this; the APK is simply four times the size it needs to be, and
// the in-app updater re-downloads it in full on every release.
//
// A patch rather than a hand edit because `cap add`/`cap sync` regenerate the
// app's build.gradle, and the failure mode of losing it is invisible — a build
// that works perfectly and is 20 MB heavier.
patch(APP_GRADLE, 'phone ABIs only (drop x86 emulator builds)', (text) => {
  if (/abiFilters/.test(text)) return text
  return text.replace(
    /(testInstrumentationRunner "androidx\.test\.runner\.AndroidJUnitRunner")/,
    "$1\n        ndk {\n            abiFilters 'arm64-v8a', 'armeabi-v7a'\n        }"
  )
})

// The QR pairing scanner. Declared here rather than trusted to manifest
// merging from the scanner library's AAR, so the permission is visible in the
// tree apk-check reads — a permission that only exists after a merge step is
// one a check script cannot see and a review cannot diff. The <uses-feature>
// keeps the camera optional: declaring the permission alone would implicitly
// mark the hardware required, and a camera-less device can still pair by
// typing.
patch(MANIFEST, 'CAMERA permission (QR pairing)', (text) => {
  if (text.includes('android.permission.CAMERA')) return text
  return text.replace(
    /(\s*)(<uses-permission android:name="android\.permission\.INTERNET")/,
    `$1<uses-permission android:name="android.permission.CAMERA" />$1$2`
  )
})

patch(MANIFEST, 'camera <uses-feature> marked optional', (text) => {
  if (text.includes('android.hardware.camera')) return text
  return text.replace(
    /(\s*)(<uses-permission android:name="android\.permission\.CAMERA")/,
    `$1<uses-feature android:name="android.hardware.camera" android:required="false" />$1$2`
  )
})

/* --------------------------------------------------- 4b. the television
 *
 * Four additions, all of them inert on a phone, that together make the same
 * package installable and launchable on a Fire TV. Only the application id
 * differs between the two builds (see the -PforgeTv patch below); everything
 * here ships in both.
 */

// Fire TV's launcher lists apps by LEANBACK_LAUNCHER and ignores plain
// LAUNCHER entirely — without this the APK installs and then cannot be found
// on the home screen at all. Alongside LAUNCHER rather than instead of it, so
// the one manifest still describes an app a phone can open.
patch(MANIFEST, 'LEANBACK_LAUNCHER category on the launch activity', (text) => {
  if (text.includes('LEANBACK_LAUNCHER')) return text
  return text.replace(
    /(\s*)(<category android:name="android\.intent\.category\.LAUNCHER" \/>)/,
    `$1$2$1<category android:name="android.intent.category.LEANBACK_LAUNCHER" />`
  )
})

// A television has no touchscreen. Android assumes every app requires one
// unless told otherwise, and a TV filters out anything that does — this is the
// difference between an APK that sideloads and one that is refused.
patch(MANIFEST, 'touchscreen marked optional (a TV has none)', (text) => {
  if (text.includes('android.hardware.touchscreen')) return text
  return text.replace(
    /(\s*)(<uses-feature android:name="android\.hardware\.camera")/,
    `$1<uses-feature android:name="android.hardware.touchscreen" android:required="false" />$1$2`
  )
})

// Declared optional rather than required: this is one app, and a phone must
// keep being able to install it.
patch(MANIFEST, 'leanback <uses-feature> marked optional', (text) => {
  if (text.includes('android.software.leanback')) return text
  return text.replace(
    /(\s*)(<uses-feature android:name="android\.hardware\.touchscreen")/,
    `$1<uses-feature android:name="android.software.leanback" android:required="false" />$1$2`
  )
})

// The TV home row shows a 320x180 banner and nothing else — no icon, no label
// — so an app without one is a blank tile. On the <application> so both the
// activity and anything added later inherit it; a phone launcher never reads it.
patch(MANIFEST, 'android:banner on <application>', (text) => {
  if (text.includes('android:banner')) return text
  return text.replace(/<application(\s)/, '<application\n        android:banner="@drawable/tv_banner"$1')
})

// The other half of the API-25 bargain above. `ionbarcode-android` declares
// minSdk 26 in its own AAR manifest (package com.outsystems.plugins.barcode),
// so a 25 build is refused by the merger unless it says, in writing, that it
// knows. Inert in the phone build, which is at 26 and has nothing to override.
//
// `tools:` attributes never reach the packaged manifest, so this costs the
// phone APK nothing but the namespace declaration.
patch(MANIFEST, 'tools namespace on <manifest>', (text) => {
  if (text.includes('xmlns:tools')) return text
  return text.replace(
    /<manifest xmlns:android="([^"]+)">/,
    '<manifest xmlns:android="$1"\n    xmlns:tools="http://schemas.android.com/tools">'
  )
})

patch(MANIFEST, 'uses-sdk override for the scanner library (the API 25 TV)', (text) => {
  if (text.includes('tools:overrideLibrary')) return text
  return text.replace(
    /(\s*)(<application)/,
    `$1<uses-sdk tools:overrideLibrary="com.outsystems.plugins.barcode" />$1$2`
  )
})

const banner = join(BANNER_DIR, 'tv_banner.png')
mkdirSync(BANNER_DIR, { recursive: true })
const bannerBytes = drawBanner(320, 180)
if (!existsSync(banner) || !readFileSync(banner).equals(bannerBytes)) {
  writeFileSync(banner, bannerBytes)
  console.log(`  wrote   res/drawable-xhdpi/tv_banner.png  (${bannerBytes.length} bytes)`)
} else {
  console.log('  ok      res/drawable-xhdpi/tv_banner.png (current)')
}

// The one thing the TV build cannot share: its identity.
//
// A distinct application id is what keeps the two builds from ever being
// mistaken for one another. They are signed with the same key and carry the
// same versionCode, so a shared id would let the phone's GitHub release —
// which is a *phone* build, stamped with a tunnel address — install straight
// over the television, and would make the TV's own rebuilds compete with an
// OTA feed it is not supposed to have. Different ids, and neither can touch
// the other, whatever any feed says.
//
// A gradle property rather than a product flavour: a flavour renames every
// task in the project (assembleTvRelease), which is a rewrite of the phone
// pipeline to buy nothing it needs.
patch(APP_GRADLE, 'applicationId hook for -PforgeTv (the TV build)', (text) => {
  if (text.includes('forgeTv')) return text
  return text.replace(
    /(applicationId "com\.forge\.mobile")/,
    `$1\n        if (project.hasProperty('forgeTv')) {\n            applicationId "com.forge.mobile.tv"\n        }`
  )
})

patch(MANIFEST, 'usesCleartextTraffic on <application>', (text) => {
  if (text.includes('android:usesCleartextTraffic')) return text
  return text.replace(/<application(\s)/, '<application\n        android:usesCleartextTraffic="true"$1')
})

patch(MANIFEST, 'FileProvider declaration', (text) => {
  if (text.includes('androidx.core.content.FileProvider')) return text
  const provider = [
    '',
    '        <provider',
    '            android:name="androidx.core.content.FileProvider"',
    '            android:authorities="${applicationId}.fileprovider"',
    '            android:exported="false"',
    '            android:grantUriPermissions="true">',
    '            <meta-data',
    '                android:name="android.support.FILE_PROVIDER_PATHS"',
    '                android:resource="@xml/file_paths" />',
    '        </provider>',
    ''
  ].join('\n')
  return text.replace(/(\s*)<\/application>/, `${provider}$1</application>`)
})

/* ------------------------------------------------ 5. provider paths XML */

const filePaths = join(XML_DIR, 'file_paths.xml')
if (!existsSync(filePaths)) {
  cpSync(join(NATIVE, 'file_paths.xml'), filePaths)
  console.log('  wrote   res/xml/file_paths.xml')
} else {
  patch(filePaths, 'updates entry in file_paths.xml', (text) => {
    if (text.includes('name="updates"')) return text
    return text.replace(/(\s*)<\/paths>/, `$1  <external-files-path name="updates" path="updates/" />$1</paths>`)
  })
}

/* -------------------------------------------------- 6. Kotlin sources */

// The generated Java MainActivity is replaced with the Kotlin one that
// registers ForgeUpdater; leaving both would be a duplicate-class error.
const generatedMain = join(JAVA_DIR, 'MainActivity.java')
if (existsSync(generatedMain)) {
  rmSync(generatedMain)
  console.log('  removed generated MainActivity.java')
}
for (const source of ['MainActivity.kt', 'ForgeUpdaterPlugin.kt']) {
  const target = join(JAVA_DIR, source)
  const fresh = readFileSync(join(NATIVE, source), 'utf8')
  if (!existsSync(target) || readFileSync(target, 'utf8') !== fresh) {
    writeFileSync(target, fresh)
    console.log(`  copied  ${source}`)
  } else {
    console.log(`  ok      ${source} (current)`)
  }
}

/* ------------------------------------------------------- 7. the version */

stampGradleVersion(readVersion())
console.log('  stamped versionCode/versionName from mobile/version.json')

console.log('\napk:init complete. Next: npm run apk:build')
