import { Capacitor, registerPlugin } from '@capacitor/core'
import { isNewer, parseManifest, type UpdateManifest } from './manifest'

/**
 * Self-update, from the JS side: fetch the manifest, compare, drive the
 * native download/verify/install (ForgeUpdaterPlugin.kt) — and *never* take a
 * live terminal down with it. Every failure in this file becomes a phase with
 * a sentence attached, not an exception: an update check that throws during a
 * shell session would be the tail wagging the dog.
 *
 * Two outcomes are deliberately mundane rather than alarming:
 *  - **No network is not an error.** A phone is offline dozens of times a
 *    day; the answer is "couldn't check", shown quietly, retried on demand.
 *  - **"needs-permission" is a step, not a failure.** Android's "install
 *    unknown apps" grant has no dialog — the flow parks in `ready`, sends
 *    the user to the settings screen, and Install works on the second tap.
 *
 * Shaped as a tiny external store (subscribe/getState) rather than a hook:
 * a download must keep running while React unmounts and remounts the sheet,
 * so the state cannot live in a component. `useSyncExternalStore` in
 * components/Update.tsx is the reader.
 *
 * In a plain browser (the debug route) there is no installer; download falls
 * back to opening `apkUrl` so the whole flow stays exercisable from Chrome.
 */

interface ForgeUpdaterNative {
  canInstall(): Promise<{ allowed: boolean }>
  requestInstallPermission(): Promise<void>
  download(options: { url: string; sha256: string }): Promise<{ path: string }>
  install(options: { path: string }): Promise<void>
  openExternal(options: { url: string }): Promise<void>
  addListener(
    event: 'downloadProgress',
    fn: (progress: { received: number; total: number }) => void
  ): Promise<{ remove: () => void }>
}

const native = registerPlugin<ForgeUpdaterNative>('ForgeUpdater')

export type UpdatePhase =
  | 'idle' // never checked this session
  | 'checking'
  | 'current' // checked; this build is the newest
  | 'unreachable' // could not fetch the manifest — normal when offline
  | 'available' // a newer versionCode exists
  | 'downloading'
  | 'ready' // downloaded and hash-verified; install may need the settings grant
  | 'failed' // something concrete broke; `detail` says what

export interface UpdateState {
  phase: UpdatePhase
  manifest: UpdateManifest | null
  received: number
  total: number
  /** Verified file path from the native side; '' until `ready`. */
  path: string
  /** A human sentence for unreachable/failed/permission states. */
  detail: string
}

export const CURRENT_VERSION_CODE = __APK_VERSION_CODE__
export const CURRENT_VERSION_NAME = __APK_VERSION_NAME__

let state: UpdateState = { phase: 'idle', manifest: null, received: 0, total: 0, path: '', detail: '' }
const listeners = new Set<() => void>()

function set(next: Partial<UpdateState>): void {
  state = { ...state, ...next }
  for (const listener of listeners) listener()
}

export const updateStore = {
  subscribe(listener: () => void): () => void {
    listeners.add(listener)
    return () => listeners.delete(listener)
  },
  getState(): UpdateState {
    return state
  }
}

/** Whether this build can actually replace itself (vs the browser debug route). */
export function isNativeApp(): boolean {
  return Capacitor.isNativePlatform()
}

export async function check(): Promise<void> {
  if (state.phase === 'checking' || state.phase === 'downloading') return
  set({ phase: 'checking', detail: '' })

  let raw: unknown
  try {
    // no-store: the WebView caching an old manifest would make "check for
    // updates" a button that confirms whatever it said last time.
    const response = await fetch(__APK_MANIFEST_URL__, { cache: 'no-store' })
    if (!response.ok) {
      set({ phase: 'unreachable', detail: `The update feed answered ${response.status}.` })
      return
    }
    raw = await response.json()
  } catch {
    set({ phase: 'unreachable', detail: 'Could not reach the update feed — probably offline.' })
    return
  }

  const manifest = parseManifest(raw)
  if (!manifest) {
    // A feed that exists but does not parse is worth saying out loud — it
    // means a release went out half-formed, and silence would hide that.
    set({ phase: 'failed', manifest: null, detail: 'The update feed is malformed. Not updating from it.' })
    return
  }

  if (isNewer(manifest, CURRENT_VERSION_CODE)) {
    set({ phase: 'available', manifest, received: 0, total: manifest.sizeBytes, path: '', detail: '' })
  } else {
    set({ phase: 'current', manifest, detail: '' })
  }
}

/**
 * How long before a foregrounded app bothers asking again. Long, because the
 * answer changes about once a fortnight and a phone is foregrounded dozens of
 * times a day.
 */
const RECHECK_AFTER_MS = 30 * 60_000

let lastCheckedAt = 0

/**
 * Ask about updates without being asked to.
 *
 * The version chip was reachable from the moment updating existed, and Steve
 * still could not find it — he assumed he had to *unpair* to get at it. The
 * lesson is not that the button needed to be bigger. It is that a self-updating
 * app which waits to be interrogated will never be interrogated: nobody opens a
 * terminal client wondering what version it is. So the app checks on its own
 * and *says* when there is something, and the chip stops being the discovery
 * mechanism and becomes merely the way in.
 *
 * Deliberately quiet. A failed check leaves `unreachable`, which no screen
 * shouts about — being offline is a normal Tuesday, not a problem to report.
 * It never runs while a download is in flight or a verified file is waiting to
 * install, because re-checking would discard the path that was just hashed.
 */
export function startAutoCheck(): () => void {
  const run = (): void => {
    if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return
    if (state.phase === 'downloading' || state.phase === 'ready') return
    if (lastCheckedAt && Date.now() - lastCheckedAt < RECHECK_AFTER_MS) return
    lastCheckedAt = Date.now()
    void check()
  }
  run()
  if (typeof document === 'undefined') return () => {}
  document.addEventListener('visibilitychange', run)
  return () => document.removeEventListener('visibilitychange', run)
}

export async function download(): Promise<void> {
  const manifest = state.manifest
  if (!manifest || state.phase !== 'available') return

  if (!isNativeApp()) {
    // Browser debug route: no DownloadManager, no installer. Hand the URL to
    // the tab so the flow still ends somewhere useful.
    window.open(manifest.apkUrl, '_blank', 'noopener')
    set({ detail: 'Opened the APK in the browser — this build cannot install it itself.' })
    return
  }

  set({ phase: 'downloading', received: 0, total: manifest.sizeBytes, detail: '' })
  const progress = await native.addListener('downloadProgress', ({ received, total }) => {
    set({ received, total: total > 0 ? total : manifest.sizeBytes })
  })

  try {
    const { path } = await native.download({ url: manifest.apkUrl, sha256: manifest.sha256 })
    set({ phase: 'ready', path, received: manifest.sizeBytes, detail: '' })
  } catch (error) {
    // Includes the loud checksum-mismatch case: the native side has already
    // deleted the file, so all that is left to do here is tell the truth and
    // offer the browser as the way that still works.
    await fallbackToBrowser(manifest, describe(error, 'The download failed.'))
  } finally {
    progress.remove()
  }
}

export async function install(): Promise<void> {
  const manifest = state.manifest
  if (state.phase !== 'ready' || !state.path || !manifest) return
  try {
    await native.install({ path: state.path })
    // The system installer takes over from here; if the user cancels it we
    // simply remain `ready` and the button still works.
    set({ detail: '' })
  } catch (error) {
    if (codeOf(error) === 'needs-permission') {
      set({ detail: 'Allow installs from Forge on the next screen, then tap Install again.' })
      try {
        await native.requestInstallPermission()
      } catch {
        await fallbackToBrowser(manifest, 'Could not open the install-permission settings.')
      }
      return
    }
    await fallbackToBrowser(manifest, describe(error, 'The installer refused the file.'))
  }
}

/**
 * The floor under every failure: open `apkUrl` in the system browser so
 * Chrome downloads it and the user taps the notification. Android verifies
 * the signature at install time either way — the sha check is what this path
 * gives up, and the message says so by naming the fallback.
 */
async function fallbackToBrowser(manifest: UpdateManifest, why: string): Promise<void> {
  set({ phase: 'available', path: '', detail: `${why} Opening the download in your browser instead.` })
  try {
    await native.openExternal({ url: manifest.apkUrl })
  } catch {
    set({ detail: `${why} And no browser could be opened — download it manually: ${manifest.apkUrl}` })
  }
}

function codeOf(error: unknown): string {
  return typeof error === 'object' && error !== null && 'code' in error ? String((error as { code: unknown }).code) : ''
}

function describe(error: unknown, fallback: string): string {
  if (typeof error === 'object' && error !== null && 'message' in error) {
    const message = String((error as { message: unknown }).message)
    if (message) return message
  }
  return fallback
}
