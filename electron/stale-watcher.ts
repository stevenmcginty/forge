import { spawn } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, statSync, watch, type FSWatcher } from 'node:fs'
import { join } from 'node:path'
import { app, BrowserWindow, ipcMain } from 'electron'
import { IPC } from '@shared/ipc'
import type { StaleBundle, StaleStatus } from '@shared/types'
import { allowClose } from './quit-guard'

/**
 * "The code on disk is newer than the app you are looking at."
 *
 * The counterpart to electron/updater.ts, and deliberately its mirror image:
 * the updater runs in packaged builds and never in a checkout; this runs in a
 * checkout and never in a packaged build. Between them, every way of running
 * Forge has exactly one way of admitting it is out of date.
 *
 * Why it has to exist. `npm run dev` gives the *renderer* hot module
 * replacement, so editing a component is on screen before you have looked up
 * from the keyboard. Main-process and preload code get nothing of the kind:
 * electron-vite rebuilds out/main and out/preload and then leaves the running
 * process alone, still executing the bundle it loaded at startup. What you get
 * is a window that looks current and is not — a settings default that changed
 * on disk but not in memory, a feature that is provably present in the source
 * and provably absent from the app. There is no way to tell from the outside,
 * which makes it twenty minutes of debugging the wrong thing.
 *
 * So: watch the two directories HMR cannot help with, compare against the
 * mtimes this process actually booted from, and say so.
 *
 * Nothing here restarts anything on its own, and that is the important part.
 * A restart takes every running pane — every Claude session, every shell, every
 * unsaved thing inside them — with it. The strip appears and then waits for a
 * click, exactly like the update banner it borrows its chrome from.
 */

/** One rebuild writes several files; wait for the writes to stop. */
const DEBOUNCE_MS = 400
/** Walking out/ is cheap, but it is not a reason to descend forever. */
const MAX_DEPTH = 4

/**
 * This file *is* out/main/index.js at runtime (commonjs — see package.json), so
 * __dirname is the main bundle's own directory and preload is its sibling.
 * Deriving both from __dirname rather than app.getAppPath() means the watcher
 * is looking at the exact bytes this process was loaded from.
 */
const DIRS: ReadonlyArray<readonly [StaleBundle, string]> = [
  ['main', __dirname],
  ['preload', join(__dirname, '..', 'preload')]
]

let watchers: FSWatcher[] = []
let timer: NodeJS.Timeout | null = null
let target: BrowserWindow | null = null
let status: StaleStatus = { stale: false, changed: [], at: null }
/** Newest mtime in each bundle *as this process booted*. The line in the sand. */
const baseline = new Map<StaleBundle, number>()

/* --------------------------------------------------------------- helpers */

/** Newest mtime anywhere under `dir`, or 0 if there is nothing to see. */
function newestIn(dir: string): number {
  if (!existsSync(dir)) return 0
  let newest = 0
  const walk = (d: string, depth: number): void => {
    if (depth > MAX_DEPTH) return
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, entry.name)
      if (entry.isDirectory()) {
        walk(p, depth + 1)
        continue
      }
      try {
        newest = Math.max(newest, statSync(p).mtimeMs)
      } catch {
        // Raced with the build writing that very file. The next event catches it.
      }
    }
  }
  try {
    walk(dir, 0)
  } catch {
    // A directory that vanished mid-walk means a build is running; same answer.
  }
  return newest
}

function same(a: StaleStatus, b: StaleStatus): boolean {
  return (
    a.stale === b.stale &&
    a.at === b.at &&
    a.changed.join() === b.changed.join() &&
    a.version === b.version
  )
}

/** dev when FORGE_CHANNEL says so; everything else is the everyday app. */
function channel(): 'dev' | 'stable' {
  return process.env['FORGE_CHANNEL'] === 'dev' ? 'dev' : 'stable'
}

/**
 * The version a restart would pick up: package.json as it sits on disk, read
 * fresh each time the bundles change. After "push to the main app" pulls the
 * checkout forward, this is the new number — the one the strip should lead
 * with — while app.getVersion() still reports the build this process booted.
 */
function versionOnDisk(): string | undefined {
  try {
    const raw = readFileSync(join(app.getAppPath(), 'package.json'), 'utf8')
    const version = (JSON.parse(raw) as { version?: unknown }).version
    return typeof version === 'string' && version ? version : undefined
  } catch {
    return undefined
  }
}

function broadcast(next: StaleStatus): void {
  if (same(next, status)) return
  status = next
  if (!target || target.isDestroyed()) return
  target.webContents.send(IPC.staleStatusEvent, status)
}

function recompute(): void {
  const changed: StaleBundle[] = []
  let at = 0
  for (const [bundle, dir] of DIRS) {
    const base = baseline.get(bundle) ?? 0
    const now = newestIn(dir)
    // A millisecond of slack: some filesystems round mtimes, and a write landing
    // in the same tick as boot is not a rebuild worth interrupting anyone for.
    if (now > base + 1) {
      changed.push(bundle)
      at = Math.max(at, now)
    }
  }
  const stale = changed.length > 0
  broadcast({
    stale,
    changed,
    at: at || null,
    channel: channel(),
    ...(stale ? { version: versionOnDisk() } : {})
  })
}

/* ------------------------------------------------------------------ api */

export function setStaleTarget(win: BrowserWindow | null): void {
  target = win
}

export function getStaleStatus(): StaleStatus {
  return status
}

export function initStaleWatcher(): void {
  // The mirror of updater.ts's guard. In a packaged build the bundles cannot
  // change underneath the process that is running them, so there is nothing to
  // watch and the strip can never appear — which is why this is safe to call
  // unconditionally from main.ts, the same way initUpdater() is.
  if (app.isPackaged) return

  for (const [bundle, dir] of DIRS) baseline.set(bundle, newestIn(dir))

  for (const [, dir] of DIRS) {
    if (!existsSync(dir)) continue
    try {
      watchers.push(
        watch(dir, { recursive: true }, () => {
          if (timer) clearTimeout(timer)
          timer = setTimeout(recompute, DEBOUNCE_MS)
        })
      )
    } catch {
      // Watching is a convenience. It never gets to stop the app from booting.
    }
  }
}

/**
 * Come back after quitting — which is two different problems.
 *
 * `app.relaunch()` re-runs *this executable* with the same argv, and that is
 * right for a packaged Forge. Under `electron-vite dev` it is not: the renderer
 * is loaded from a Vite dev server (`ELECTRON_RENDERER_URL`), and that server
 * belongs to the `npm run dev` process which is Electron's *parent*. Quitting
 * takes the server down with it, so the relaunched Electron opens a window
 * pointing at a URL that no longer answers — a blank screen you have to close
 * and start again by hand.
 *
 * So in a dev run the whole toolchain is restarted rather than the app — with
 * a detached `npm run dev`. Detached because it has to outlive the process
 * starting it, and delayed a couple of seconds because the outgoing dev server
 * still holds its port for a moment and a fight over it is a slower recovery
 * than a short wait.
 *
 * `cmd.exe /c` rather than `shell: true`: spawning a `.cmd` needs a shell on
 * Windows either way, and naming the interpreter avoids the DEP0190 warning
 * that `shell: true` now raises (see POLISH.md #6).
 */
export function relaunchDevToolchain(): void {
  const devServer = process.env['ELECTRON_RENDERER_URL']
  if (app.isPackaged || !devServer) {
    app.relaunch()
    return
  }

  const root = app.getAppPath()

  // The respawned toolchain must not inherit this run's identity or wiring:
  // dev.mjs prefers an inherited FORGE_DATA_DIR over the checkout's own marker,
  // and a stale ELECTRON_RENDERER_URL / ELECTRON_EXEC_PATH points the new run
  // at servers and binaries that belong to the process currently dying. The
  // launcher re-derives all of these from the checkout itself.
  const {
    FORGE_DATA_DIR: _dataDir,
    FORGE_CHANNEL: _channel,
    ELECTRON_RENDERER_URL: _rendererUrl,
    ELECTRON_EXEC_PATH: _execPath,
    ...cleanEnv
  } = process.env

  // Do not launch the VBS shortcut from here. That creates a second Windows
  // Script Host inside the first shutdown/restart race; on some Windows builds
  // it fails with the misleading "not enough memory resources" dialog before
  // npm ever gets a chance to start. The normal shortcut may still use VBS,
  // but an in-app restart has no reason to involve it.
  try {
    const child =
      process.platform === 'win32'
        ? spawn('cmd.exe', ['/d', '/s', '/c', 'timeout /t 2 /nobreak >nul & npm run dev'], {
            cwd: root,
            env: cleanEnv,
            detached: true,
            stdio: 'ignore',
            windowsHide: true
          })
        : spawn('sh', ['-c', 'sleep 2; npm run dev'], {
            cwd: root,
            env: cleanEnv,
            detached: true,
            stdio: 'ignore'
          })
    child.unref()
  } catch (err) {
    // Falling back is better than not coming back at all, even though this is
    // the path that produces the blank window.
    console.error('[stale] dev relaunch failed, falling back to app.relaunch():', err)
    app.relaunch()
  }
}

export function registerStaleHandlers(): void {
  ipcMain.handle(IPC.staleStatus, () => status)

  ipcMain.handle(IPC.staleRestart, () => {
    // Same guard again rather than trusting the renderer: a packaged build has
    // no business relaunching itself from a strip that cannot appear in it.
    if (app.isPackaged) return false
    // relaunch() queues the new process; quit() runs `before-quit`, which is
    // where the PTY host, the presence marker and the rest are disposed of
    // properly. Panes die, but they die cleanly rather than being orphaned —
    // and Claude panes come back where they left off, because their session
    // ids are saved with the layout (see electron/bridge/claude-session.ts).
    //
    // The Restart button *is* the confirmation, so the close dialog is waived.
    allowClose()
    relaunchDevToolchain()
    app.quit()
    return true
  })
}

export function disposeStaleWatcher(): void {
  if (timer) clearTimeout(timer)
  timer = null
  for (const w of watchers) {
    try {
      w.close()
    } catch {
      // Already gone.
    }
  }
  watchers = []
  target = null
}
