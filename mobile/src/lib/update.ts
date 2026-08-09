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
  fetchManifest(options: { url: string }): Promise<{ body: string }>
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

/**
 * The manifest body, fetched the only way that works on each surface.
 *
 * On the phone that means the native side. The bundle is served from
 * `https://localhost`, so `fetch()` at the release asset is cross-origin, and
 * the host GitHub redirects to sends no `Access-Control-Allow-Origin` — the
 * response is blocked before any JS sees it and the rejection is a bare
 * TypeError. That was reported as "probably offline", which was never true:
 * the request could not have succeeded on any network, so the shipped app
 * could never see an update at all. HttpURLConnection in the plugin has no
 * such rule.
 *
 * The browser debug route keeps `fetch()`, because it has no plugin to call.
 * It is subject to the same CORS block, so a manifest check there only works
 * against a feed that allows the origin — which is a debug-route limitation
 * worth having over pretending the two surfaces behave alike.
 */
async function readManifest(): Promise<string> {
  if (isNativeApp()) {
    const { body } = await native.fetchManifest({ url: __APK_MANIFEST_URL__ })
    return body
  }
  // no-store: the WebView caching an old manifest would make "check for
  // updates" a button that confirms whatever it said last time.
  const response = await fetch(__APK_MANIFEST_URL__, { cache: 'no-store' })
  if (!response.ok) throw new Error(`The update feed answered ${response.status}.`)
  return await response.text()
}

export async function check(): Promise<void> {
  // A build with no feed stamped in it does not acquire one. That is the
  // honest answer for the this-house TV build (scripts/apk-tv-build.mjs
  // without --shared bakes one desktop's LAN address in, and no published
  // release describes *that* binary), and it must read as "nothing to do"
  // rather than as a fetch that fails forever and reports being offline.
  //
  // The television used to be in this state always, on the grounds that the
  // only feed was the phone's and Android's install confirmation could not be
  // dismissed with a remote. Both have stopped being true: `tv-latest.json` on
  // the TV releases repo describes com.forge.mobile.tv specifically, and the
  // Fire TV package installer is walked with the D-pad like anything else on
  // that device. What is left of the old objection is real but small — the
  // install grant and the confirm are Android's and cannot be automated — and
  // it is handled where it belongs, on the wall (see UpdateTile in
  // components/TvDashboard.tsx).
  if (!__APK_MANIFEST_URL__) {
    set({ phase: 'current', manifest: null, detail: '' })
    return
  }
  if (state.phase === 'checking' || state.phase === 'downloading') return
  set({ phase: 'checking', detail: '' })

  let body: string
  try {
    body = await readManifest()
  } catch (error) {
    // Now that the request is a real one, the sentence can be what actually
    // happened rather than a guess — a timeout, a DNS failure, an HTTP status.
    set({ phase: 'unreachable', detail: describe(error, 'Could not reach the update feed — probably offline.') })
    return
  }

  // Reached the feed but it is not JSON: that is a bad release, not a bad
  // network, and it belongs in the malformed branch below rather than being
  // reported as being offline.
  let raw: unknown = null
  try {
    raw = JSON.parse(body)
  } catch {
    raw = null
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

/**
 * How long to leave the installer alone after offering it once.
 *
 * Android's install confirmation is the system's, not ours, and declining it
 * leaves the verified file exactly where it was — `ready`. Without this, every
 * return to the app would raise that dialog again, which is how an app that
 * updates itself becomes an app you uninstall.
 */
const REOFFER_INSTALL_AFTER_MS = 60 * 60_000

let lastCheckedAt = 0
let lastInstallOfferedAt = 0
let autoRunning = false

/**
 * Check, download and install without being asked to.
 *
 * The version chip was reachable from the moment updating existed, and Steve
 * still could not find it — he assumed he had to *unpair* to get at it. The
 * first answer to that was for the app to check on its own and *say* when there
 * was something. That was still two taps of homework for a phone whose whole
 * job is to be picked up and used, so now the app does the work: a revision
 * lands, the phone finds it, fetches it, verifies the hash, and offers it to
 * the installer.
 *
 * What it cannot do is install silently. Android hands a sideloaded package to
 * its own confirmation dialog and there is no way around that short of being
 * device owner, so "automatic" honestly means: nothing to find, nothing to
 * download by hand, one confirm. Two things stop that confirm being a nuisance:
 * it is only raised while the app is actually in front, and only once an hour
 * (see REOFFER_INSTALL_AFTER_MS) — declining leaves the verified file ready and
 * the version chip saying so.
 *
 * If Android has not been told Forge may install packages, the flow stops at
 * `ready` rather than dragging the user into a settings screen unasked. The
 * chip says "Update", the sheet's Install button asks for the grant, and the
 * automatic path takes over from the next check onwards.
 *
 * Deliberately quiet everywhere else. A failed check leaves `unreachable`,
 * which no screen shouts about — being offline is a normal Tuesday.
 */
export function startAutoUpdate(): () => void {
  const run = (): void => {
    if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return
    void advance()
  }
  run()
  if (typeof document === 'undefined') return () => {}
  document.addEventListener('visibilitychange', run)
  return () => document.removeEventListener('visibilitychange', run)
}

/**
 * One pass of the automatic flow, from wherever it currently is.
 *
 * Written as a sequence rather than as reactions to state changes so that a
 * hand-driven download from the sheet cannot be joined halfway by this and end
 * up installing something the user was still reading the notes for.
 */
async function advance(): Promise<void> {
  if (autoRunning) return
  autoRunning = true
  // Read through a function, never as `state.phase` directly: the steps below
  // change the phase by calling `check`/`download`, and a narrowed literal type
  // held across those awaits would be the compiler asserting something this
  // function exists to disprove.
  const phase = (): UpdatePhase => state.phase
  try {
    if (phase() !== 'available' && phase() !== 'ready') {
      if (phase() === 'downloading') return
      if (lastCheckedAt && Date.now() - lastCheckedAt < RECHECK_AFTER_MS) return
      lastCheckedAt = Date.now()
      await check()
    }

    // The browser debug route has no installer; `download` there opens a tab,
    // which is not something to do to someone who did not ask.
    if (!isNativeApp()) return

    if (phase() === 'available') await download()
    if (phase() !== 'ready') return

    if (lastInstallOfferedAt && Date.now() - lastInstallOfferedAt < REOFFER_INSTALL_AFTER_MS) return
    // Asked before offering, because `install` answers a missing grant by
    // sending the user to a settings screen — the right response to a tap, and
    // the wrong one to a background check nobody asked for.
    let allowed = false
    try {
      allowed = (await native.canInstall()).allowed === true
    } catch {
      allowed = false
    }
    if (!allowed) {
      set({ detail: 'Downloaded and verified. Allow installs from Forge to finish — tap Update.' })
      return
    }
    lastInstallOfferedAt = Date.now()
    await install()
  } finally {
    autoRunning = false
  }
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
 *
 * Not on a television. A Fire TV ships no browser, so "opening the download in
 * your browser" is an instruction to look for something that is not there —
 * and the television has a better answer anyway, which is the one it used
 * before it could update itself at all.
 */
async function fallbackToBrowser(manifest: UpdateManifest, why: string): Promise<void> {
  if (__FORGE_TV__) {
    set({
      phase: 'available',
      path: '',
      detail: `${why} Install it from the desktop instead — Settings, Forge Mobile, Forge TV.`
    })
    return
  }
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
