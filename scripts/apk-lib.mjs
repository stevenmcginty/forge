/**
 * The facts the four apk-* scripts must agree on — paths, the version file,
 * the keystore location, the SDK, hashing — in one place, because the failure
 * mode this prevents is real: a versionCode stamped into build.gradle by one
 * script and read differently by another is an APK that lies about itself,
 * and an update chain that compares those lies.
 *
 * Nothing here executes on import. Each export either reads a fact or
 * performs one named step.
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

export const ROOT = resolve(import.meta.dirname, '..')
export const MOBILE = join(ROOT, 'mobile')
export const ANDROID = join(MOBILE, 'android')
export const DIST_APK = join(ROOT, 'dist-apk')
export const VERSION_FILE = join(MOBILE, 'version.json')
export const APP_GRADLE = join(ANDROID, 'app', 'build.gradle')

/** The GitHub repo releases publish to. The app's manifest URL points here. */
export const RELEASE_REPO = 'stevenmcginty/forge-mobile-releases'
/** The stable asset name — pinned-tag URLs in latest.json depend on it. */
export const APK_ASSET = 'forge-mobile.apk'

/**
 * The release keystore, outside the repo on purpose. Android will only ever
 * install an update signed with the same key as the app it replaces — so
 * this file is not a build input, it is the identity of every Forge Mobile
 * install in existence. Losing it means uninstall/reinstall on every phone;
 * leaking it means someone else can ship "updates".
 */
export const KEYSTORE_DIR = join(process.env.APPDATA ?? join(ROOT, '.forge-keys'), 'Forge', 'android')
export const KEYSTORE = join(KEYSTORE_DIR, 'forge-release.jks')
export const KEYSTORE_PROPS = join(KEYSTORE_DIR, 'keystore.properties')

/**
 * The SDK path, resolved rather than assumed: ANDROID_HOME is not set on
 * this machine (verified), so the default install location is the real
 * source of truth and the env vars are only honoured if someone sets them.
 */
export function sdkDir() {
  const candidates = [
    process.env.ANDROID_HOME,
    process.env.ANDROID_SDK_ROOT,
    process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, 'Android', 'Sdk') : null
  ].filter(Boolean)
  for (const dir of candidates) {
    if (existsSync(join(dir, 'platforms'))) return dir
  }
  throw new Error(
    'No Android SDK found. Looked at ANDROID_HOME, ANDROID_SDK_ROOT and %LOCALAPPDATA%\\Android\\Sdk.'
  )
}

/**
 * Gradle reads `sdk.dir` from local.properties, which is machine-local and
 * gitignored — writing it on every run (init *and* build) is what makes a
 * fresh clone or a moved SDK a non-event instead of a cryptic Gradle error.
 */
export function writeLocalProperties() {
  const sdk = sdkDir().replace(/\\/g, '/')
  writeFileSync(
    join(ANDROID, 'local.properties'),
    `# Machine-local, written by scripts/apk-lib.mjs on every run. Never commit.\nsdk.dir=${sdk}\n`
  )
  return sdk
}

/** Newest build-tools dir that has apksigner — zipalign/apksigner live there. */
export function buildToolsDir() {
  const base = join(sdkDir(), 'build-tools')
  const versions = existsSync(base)
    ? readdirSync(base)
        .filter((v) => existsSync(join(base, v, 'apksigner.bat')))
        .sort(compareVersionsDesc)
    : []
  if (!versions.length) throw new Error(`No build-tools with apksigner under ${base}.`)
  return join(base, versions[0])
}

function compareVersionsDesc(a, b) {
  const pa = a.split('.').map(Number)
  const pb = b.split('.').map(Number)
  for (let i = 0; i < 3; i++) {
    if ((pb[i] ?? 0) !== (pa[i] ?? 0)) return (pb[i] ?? 0) - (pa[i] ?? 0)
  }
  return 0
}

/** The single source of the app's version. Everything else is stamped from it. */
export function readVersion() {
  const raw = JSON.parse(readFileSync(VERSION_FILE, 'utf8'))
  const code = raw.versionCode
  const name = raw.versionName
  if (!Number.isInteger(code) || code < 1 || typeof name !== 'string' || !name) {
    throw new Error(`mobile/version.json is malformed: ${JSON.stringify(raw)}`)
  }
  return { versionCode: code, versionName: name }
}

export function writeVersion({ versionCode, versionName }) {
  writeFileSync(VERSION_FILE, JSON.stringify({ versionCode, versionName }, null, 2) + '\n')
}

/**
 * Stamp versionCode/versionName into app/build.gradle in place. Idempotent —
 * a plain regex over the two lines the Capacitor template always has — so the
 * web bundle (stamped by Vite define from the same version.json) and the
 * native package cannot drift.
 */
export function stampGradleVersion({ versionCode, versionName }) {
  let gradle = readFileSync(APP_GRADLE, 'utf8')
  const before = gradle
  gradle = gradle.replace(/versionCode\s+\d+/, `versionCode ${versionCode}`)
  gradle = gradle.replace(/versionName\s+"[^"]*"/, `versionName "${versionName}"`)
  if (!/versionCode\s+\d+/.test(gradle) || !/versionName\s+"/.test(gradle)) {
    throw new Error('Could not find versionCode/versionName in app/build.gradle to stamp.')
  }
  if (gradle !== before) writeFileSync(APP_GRADLE, gradle)
}

/**
 * The desktop origin stamped into an APK at build time: `wss://<domain>`, or
 * '' when there is nothing sane to stamp — and '' is a working build, one that
 * pairs by QR and typing instead of by one tap.
 *
 * The domain rule is not restated here. It is the *real*
 * `normaliseNgrokDomain` out of shared/mobile.ts, bundled with esbuild the
 * same way apk-check runs the phone's real manifest parser — because a copy
 * of the rule is how the desktop's settings and the build script would come
 * to disagree about what a valid domain is, and the disagreement would ship
 * inside a signed APK. The only addition is stripping a `ws(s)://` prefix
 * first: `--host wss://x` is a plausible paste, and mobile.ts only strips
 * http(s).
 *
 * No port, ever. The tunnel answers on the implicit 443; `wss://<domain>:8420`
 * is an address nothing listens on, and it fails with a connection error that
 * looks like the desktop being down (see toOrigin in mobile/src/lib/secure.ts).
 */
export async function bakedOriginOf(raw) {
  const { normaliseNgrokDomain } = await sharedMobile()
  const host = normaliseNgrokDomain(String(raw ?? '').replace(/^wss?:\/\//i, ''))
  return host ? `wss://${host}` : ''
}

/** shared/mobile.ts as importable ESM, bundled once per process on first use. */
let sharedMobilePromise = null
function sharedMobile() {
  sharedMobilePromise ??= (async () => {
    const { build } = await import('esbuild')
    const outfile = join(ROOT, 'node_modules', '.forge-apk-check', 'shared-mobile.mjs')
    mkdirSync(join(ROOT, 'node_modules', '.forge-apk-check'), { recursive: true })
    await build({
      entryPoints: [join(ROOT, 'shared', 'mobile.ts')],
      outfile,
      bundle: true,
      platform: 'neutral',
      format: 'esm',
      logLevel: 'silent',
      absWorkingDir: ROOT
    })
    return import(pathToFileURL(outfile).href)
  })()
  return sharedMobilePromise
}

/** Streaming SHA-256 of a file, lowercase hex — the same shape the manifest carries. */
export function sha256File(path) {
  const hash = createHash('sha256')
  hash.update(readFileSync(path))
  return hash.digest('hex')
}

/**
 * Quote arguments that are about to be handed to cmd.exe.
 *
 * `shell: true` is unavoidable for the `.bat` and `.cmd` entry points this
 * build leans on — gradlew, apksigner, npx — because Node has refused to spawn
 * those directly since the CVE-2024-27980 fix. But with a shell, Node
 * *concatenates* the argument array into one command line instead of escaping
 * it, which Node itself now warns about (DEP0190). The concrete bill for that
 * was a release published with `--title Forge Mobile v0.1.0`, where gh read the
 * last two words as asset filenames.
 *
 * Nothing here has a space today. The Android SDK sitting under a path that
 * does — `C:\Program Files\…` is the obvious one — is all it would take, and
 * the failure would surface as a missing-file error naming half a path.
 */
function quoteForShell(args) {
  return args.map((arg) => {
    const value = String(arg)
    if (!/[\s&|^<>()]/.test(value)) return value
    return value.startsWith('"') && value.endsWith('"') ? value : `"${value}"`
  })
}

/**
 * Run a command, inheriting stdio so Gradle's progress is visible, and treat
 * a non-zero exit as fatal — a build script that soldiers on past a failed
 * step ships whatever the previous run left on disk.
 */
export function run(cmd, args, options = {}) {
  const settings = { stdio: 'inherit', shell: false, ...options }
  const safe = settings.shell ? quoteForShell(args) : args
  const result = spawnSync(cmd, safe, settings)
  if (result.error) throw result.error
  if (result.status !== 0) {
    throw new Error(`${cmd} ${args.join(' ')} exited with ${result.status}`)
  }
}

/** Run and capture stdout, for the few places the output is the answer. */
export function capture(cmd, args, options = {}) {
  const safe = options.shell ? quoteForShell(args) : args
  return execFileSync(cmd, safe, { encoding: 'utf8', ...options }).trim()
}

export function ensureDir(dir) {
  mkdirSync(dir, { recursive: true })
}
