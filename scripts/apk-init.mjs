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
 */
import { cpSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { ANDROID, MOBILE, ROOT, run, writeLocalProperties, readVersion, stampGradleVersion } from './apk-lib.mjs'

const KOTLIN_VERSION = '1.9.25'
const MANIFEST = join(ANDROID, 'app', 'src', 'main', 'AndroidManifest.xml')
const ROOT_GRADLE = join(ANDROID, 'build.gradle')
const APP_GRADLE = join(ANDROID, 'app', 'build.gradle')
const JAVA_DIR = join(ANDROID, 'app', 'src', 'main', 'java', 'com', 'forge', 'mobile')
const XML_DIR = join(ANDROID, 'app', 'src', 'main', 'res', 'xml')
const NATIVE = join(MOBILE, 'native')

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

patch(MANIFEST, 'REQUEST_INSTALL_PACKAGES permission', (text) => {
  if (text.includes('android.permission.REQUEST_INSTALL_PACKAGES')) return text
  return text.replace(
    /(\s*)(<uses-permission android:name="android\.permission\.INTERNET")/,
    `$1<uses-permission android:name="android.permission.REQUEST_INSTALL_PACKAGES" />$1$2`
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
