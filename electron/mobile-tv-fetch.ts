import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * The ready-made Fire TV app, downloaded rather than built.
 *
 * `electron/mobile-tv.ts` builds the TV APK out of a checkout: Vite, then a
 * full Gradle assemble, against an Android SDK, a JDK and a signing keystore.
 * That is the right answer on the machine this project is developed on and no
 * answer at all anywhere else — a friend who installs Forge-setup.exe has none
 * of those things and never will.
 *
 * So there is a second source: one signed, shared APK published on the releases
 * repo, fetched here, verified, and dropped where the link server already
 * serves it from. The friend presses one button and then types one URL into
 * their television's Downloader. No toolchain, no keystore, no build.
 *
 * ## Why the shared build has no address in it
 *
 * The APK built from a checkout has the desktop's LAN address baked in (see
 * scripts/apk-tv-build.mjs), which is exactly what makes it unshareable: it is
 * correct for one house. The published one is built with no address at all, and
 * finds the desktop by asking the network instead — see the discovery block in
 * shared/mobile.ts and electron/mobile/discovery.ts. One binary, any house.
 *
 * ## What is checked before anything is installed
 *
 * The manifest names a size and a SHA-256, and both are compared against the
 * bytes that actually arrived before the file is put anywhere the server would
 * serve it from. A television installs whatever it is handed and cannot check
 * anything itself, so this is the only place that verification can happen: a
 * download that does not match is discarded with a sentence rather than passed
 * on. Signing is the second half of the same promise — Android refuses an
 * update signed with a different key than the app already installed — and that
 * key never leaves the machine that publishes.
 */

/** The stable manifest URL. `releases/latest/download` always redirects to the
 *  newest release, so publishing a release *is* flipping the switch — the same
 *  mechanism the phone's own updater watches. */
export const TV_MANIFEST_URL =
  'https://github.com/stevenmcginty/forge-tv-releases/releases/latest/download/tv-latest.json'

/** The file the link server hands to a television. Same name as a built one. */
export const TV_APK_FILE = 'forge-tv.apk'

/** What is remembered beside it, so a restart still knows what it has. */
const TV_RECORD_FILE = 'forge-tv.json'

/** A download that has not finished is not an APK. Kept out of the way. */
const TV_PART_FILE = 'forge-tv.apk.part'

/** Nothing published is anywhere near this. A redirect to a login page is. */
const MAX_APK_BYTES = 120 * 1024 * 1024

/** What the published manifest says. Mirrors the phone's `latest.json`. */
export interface TvRelease {
  versionName: string
  /** Direct download for the APK asset, pinned to that release's tag. */
  url: string
  sizeBytes: number
  sha256: string
}

/** What this machine has already downloaded, if anything. */
export interface TvDownloaded {
  path: string
  versionName: string
  sizeBytes: number
  /** When it landed, ms epoch. */
  at: number
}

export interface TvFetchDeps {
  /** Where to keep it — a directory this Forge owns, made if missing. */
  dir: string
  manifestUrl?: string
  fetchText?: (url: string) => Promise<string>
  fetchBytes?: (url: string) => Promise<Buffer>
}

/**
 * Parse a manifest, or null.
 *
 * Total, and strict about the two fields that matter: an unparseable size or a
 * hash that is not a hash means there is nothing to verify against, and a
 * download nobody can verify is not one this file will perform.
 */
export function parseTvManifest(text: string): TvRelease | null {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    return null
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const manifest = value as Partial<TvRelease>
  if (typeof manifest.versionName !== 'string' || !manifest.versionName) return null
  if (typeof manifest.url !== 'string' || !/^https:\/\/[\w.-]+\//.test(manifest.url)) return null
  if (!Number.isInteger(manifest.sizeBytes) || (manifest.sizeBytes as number) < 1) return null
  if ((manifest.sizeBytes as number) > MAX_APK_BYTES) return null
  if (typeof manifest.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(manifest.sha256)) return null
  return {
    versionName: manifest.versionName,
    url: manifest.url,
    sizeBytes: manifest.sizeBytes as number,
    sha256: manifest.sha256
  }
}

/**
 * What has already been downloaded here, or null.
 *
 * Read off disk every time rather than remembered: the APK can be deleted by
 * hand, and a settings page that offers a Downloader URL for a file that is no
 * longer there is a television saying "not found" with a remote in your hand.
 */
export function downloadedTv(dir: string): TvDownloaded | null {
  const apk = join(dir, TV_APK_FILE)
  if (!existsSync(apk)) return null
  let versionName = ''
  try {
    const record = JSON.parse(readFileSync(join(dir, TV_RECORD_FILE), 'utf8')) as { versionName?: unknown }
    if (typeof record.versionName === 'string') versionName = record.versionName
  } catch {
    /* a downloaded APK with no record beside it is still an APK */
  }
  const stats = statSync(apk)
  return { path: apk, versionName, sizeBytes: stats.size, at: Math.round(stats.mtimeMs) }
}

async function fetchTextReal(url: string): Promise<string> {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`the server answered ${res.status}`)
  return await res.text()
}

async function fetchBytesReal(url: string): Promise<Buffer> {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`the server answered ${res.status}`)
  return Buffer.from(await res.arrayBuffer())
}

/**
 * Fetch the published TV app into `dir`, verify it, and put it in place.
 *
 * Every failure is a sentence a person at a settings page can act on, and no
 * failure leaves a half-written file where the server would serve it: the
 * bytes land in a `.part`, are checked, and only then take the real name.
 */
export async function fetchTvApk(
  deps: TvFetchDeps,
  say: (line: string) => void = () => {}
): Promise<{ ok: true; path: string; versionName: string } | { ok: false; error: string }> {
  const manifestUrl = deps.manifestUrl ?? TV_MANIFEST_URL
  const getText = deps.fetchText ?? fetchTextReal
  const getBytes = deps.fetchBytes ?? fetchBytesReal

  say('Looking for the published TV app…')
  let manifestText: string
  try {
    manifestText = await getText(manifestUrl)
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err)
    return { ok: false, error: `Could not reach the release feed (${reason}). Check the connection and try again.` }
  }

  const release = parseTvManifest(manifestText)
  if (!release) {
    return {
      ok: false,
      error: 'The release feed did not answer with a manifest — something on the network replied in its place.'
    }
  }

  say(`Downloading Forge TV ${release.versionName} (${(release.sizeBytes / (1024 * 1024)).toFixed(1)} MB)…`)
  let bytes: Buffer
  try {
    bytes = await getBytes(release.url)
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err)
    return { ok: false, error: `The download failed (${reason}). Try again.` }
  }

  if (bytes.length !== release.sizeBytes) {
    return {
      ok: false,
      error: `The download is ${bytes.length} bytes and the release says ${release.sizeBytes}. Discarded rather than passed on to a television.`
    }
  }
  const sha = createHash('sha256').update(bytes).digest('hex')
  if (sha !== release.sha256) {
    return {
      ok: false,
      error: 'The download does not match the hash the release published, so it was discarded. Try again — and if it happens twice, do not install it.'
    }
  }

  mkdirSync(deps.dir, { recursive: true })
  const part = join(deps.dir, TV_PART_FILE)
  const apk = join(deps.dir, TV_APK_FILE)
  try {
    writeFileSync(part, bytes)
    // Rename, never write in place: the link server may be serving the old file
    // to a television at this exact moment, and a half-written APK is an
    // install that fails on the far side of the room.
    rmSync(apk, { force: true })
    renameSync(part, apk)
    writeFileSync(
      join(deps.dir, TV_RECORD_FILE),
      JSON.stringify({ versionName: release.versionName, sha256: release.sha256, sizeBytes: release.sizeBytes }, null, 2)
    )
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err)
    rmSync(part, { force: true })
    return { ok: false, error: `Downloaded it but could not save it (${reason}).` }
  }

  say(`Forge TV ${release.versionName} is ready to install.`)
  return { ok: true, path: apk, versionName: release.versionName }
}
