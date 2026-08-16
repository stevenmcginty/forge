import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { app, BrowserWindow, ipcMain } from 'electron'
import { IPC } from '@shared/ipc'
import { gitFailureReason } from '@shared/tools'
import type { SourceUpdateStatus } from '@shared/types'
import { allowClose } from './quit-guard'
import { relaunchDevToolchain } from './stale-watcher'

/**
 * The everyday Forge updating itself from the repo — the checkout's answer to
 * electron-updater, and the third and final way this app admits it is out of
 * date. The other two watch what already happened locally (updater.ts a
 * packaged feed, stale-watcher.ts a rebuild on disk); this one watches the
 * *origin*, which is where a push from Forge Dev actually lands.
 *
 * The experience it exists for: push from the dev checkout, and the everyday
 * Forge — with nobody touching it — grows an "Update available" strip. One
 * click pulls, installs if the dependencies moved, and restarts through the
 * launcher. The same shape as any app's update button; the download just
 * happens to be `git pull`.
 *
 * Stable checkouts only. The dev checkout is where commits are born, so
 * origin is never meaningfully ahead of it — and an updater that pulled the
 * working tree out from under a live editing session would be helping the
 * wrong way. Packaged builds have updater.ts. Everyone gets exactly one
 * update mechanism.
 */

/** Let the window paint and the panes start before touching the network. */
const FIRST_CHECK_DELAY_MS = 30_000
/** Frequent enough that "I just pushed" and "the button is there" feel adjacent. */
const RECHECK_EVERY_MS = 5 * 60 * 1000
/** A focus-triggered check, at most this often — the moment you look is the moment it should know. */
const FOCUS_CHECK_MIN_GAP_MS = 60_000

const GIT_TIMEOUT_MS = 45_000
const INSTALL_TIMEOUT_MS = 5 * 60 * 1000

/**
 * The one remote this updater will pull from: the Forge repo itself, over
 * https — the same repo every release URL in the app already names. The pull
 * is only the first half of the update; what lands is then npm-installed and
 * run, so the transport is part of the trust decision and not a detail. An
 * ssh://, git:// or plain http:// origin is refused here even though git
 * itself would happily talk to all three.
 */
const EXPECTED_ORIGIN_URL = 'https://github.com/stevenmcginty/forge'

let status: SourceUpdateStatus = { phase: 'unsupported' }
let target: BrowserWindow | null = null
let timer: NodeJS.Timeout | null = null
let firstTimer: NodeJS.Timeout | null = null
let lastCheckAt = 0
let enabled = false

function broadcast(next: SourceUpdateStatus): void {
  status = next
  if (!target || target.isDestroyed()) return
  target.webContents.send(IPC.sourceUpdateEvent, status)
}

export function setSourceUpdateTarget(win: BrowserWindow | null): void {
  target = win
}

export function getSourceUpdateStatus(): SourceUpdateStatus {
  return status
}

/* ------------------------------------------------------------------- git */

function git(args: string[]): Promise<{ ok: boolean; out: string; err: string }> {
  return new Promise((resolve) => {
    execFile(
      'git',
      args,
      {
        cwd: app.getAppPath(),
        timeout: GIT_TIMEOUT_MS,
        windowsHide: true,
        maxBuffer: 8 * 1024 * 1024,
        // Never let a credential prompt hang a background fetch: no terminal
        // to answer it, so failing fast and showing "idle" is the right loss.
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }
      },
      (error, stdout, stderr) => {
        resolve({ ok: !error, out: `${stdout}`.trim(), err: `${stderr}`.trim() })
      }
    )
  })
}

/** `https://github.com/stevenmcginty/forge`, with or without `.git` — nothing else. */
function isTrustedOriginUrl(url: string): boolean {
  const u = url.trim().toLowerCase().replace(/\/+$/, '')
  return u === EXPECTED_ORIGIN_URL || u === `${EXPECTED_ORIGIN_URL}.git`
}

/** The version a pull would bring: origin's package.json, without touching the tree. */
async function originVersion(): Promise<string | undefined> {
  const shown = await git(['show', 'origin/master:package.json'])
  if (!shown.ok) return undefined
  try {
    const version = (JSON.parse(shown.out) as { version?: unknown }).version
    return typeof version === 'string' && version ? version : undefined
  } catch {
    return undefined
  }
}

/* ---------------------------------------------------------------- actions */

export async function checkForSourceUpdate(): Promise<SourceUpdateStatus> {
  if (!enabled) return status
  // An update mid-flight outranks a fresh look at origin.
  if (status.phase === 'updating') return status
  lastCheckAt = Date.now()

  const fetched = await git(['fetch', 'origin', 'master'])
  if (!fetched.ok) {
    // No network, or origin unreachable. Not news, and not worth a strip.
    if (status.phase !== 'available') broadcast({ phase: 'idle' })
    return status
  }

  const counted = await git(['rev-list', '--count', 'HEAD..origin/master'])
  const behind = counted.ok ? Number(counted.out) || 0 : 0
  if (behind > 0) {
    const version = await originVersion()
    broadcast({ phase: 'available', behind, ...(version ? { version } : {}) })
  } else {
    broadcast({ phase: 'idle' })
  }
  return status
}

/**
 * The click. Pull, install if the dependency files moved, restart through the
 * launcher. Fast-forward only: a stable checkout with local commits or a
 * dirty tree is a situation for a human, not for an updater with a timer.
 */
export async function applySourceUpdate(): Promise<boolean> {
  if (!enabled || status.phase !== 'available') return false
  const version = status.version
  broadcast({ phase: 'updating', step: 'pull', ...(version ? { version } : {}) })

  // Where the code would come from. A pull here is followed by npm install and
  // a restart — by running whatever origin sends — so origin has to be the
  // Forge repo over https. Anything else (an ssh remote, a renamed fork, a
  // file:// clone) is a checkout this updater has no business updating.
  const originUrl = await git(['remote', 'get-url', 'origin'])
  if (!originUrl.ok || !isTrustedOriginUrl(originUrl.out)) {
    broadcast({
      phase: 'error',
      error: `this checkout does not update from ${EXPECTED_ORIGIN_URL} over https — update it by hand`
    })
    return false
  }

  // Ask before jumping. A dirty tree is the failure this updater actually hits
  // — the stable checkout gets edited, by Steve or by an agent working in it —
  // and catching it here means the message is a known sentence rather than
  // whatever git happened to print. The parser below is the backstop for
  // everything else; this is the case that must never be guessed at.
  const dirty = await git(['status', '--porcelain', '--untracked-files=no'])
  if (dirty.ok && dirty.out.length > 0) {
    const count = dirty.out.split('\n').filter((line) => line.trim().length > 0).length
    broadcast({
      phase: 'error',
      error: `${count} uncommitted file${count === 1 ? '' : 's'} in the Forge folder — commit or stash them, then update`
    })
    return false
  }

  const before = await git(['rev-parse', 'HEAD'])
  const pulled = await git(['pull', '--ff-only', 'origin', 'master'])
  if (!pulled.ok) {
    broadcast({ phase: 'error', error: gitFailureReason(pulled.err, pulled.out) })
    return false
  }

  const changed = before.ok
    ? await git(['diff', '--name-only', `${before.out}..HEAD`, '--', 'package.json', 'package-lock.json'])
    : { ok: false, out: '', err: '' }
  if (changed.ok && changed.out.length > 0) {
    broadcast({ phase: 'updating', step: 'install', ...(version ? { version } : {}) })
    const installed = await new Promise<boolean>((resolve) => {
      execFile(
        process.env['ComSpec'] ?? 'cmd.exe',
        ['/d', '/s', '/c', 'npm install'],
        { cwd: app.getAppPath(), timeout: INSTALL_TIMEOUT_MS, windowsHide: true, maxBuffer: 16 * 1024 * 1024 },
        (error) => resolve(!error)
      )
    })
    if (!installed) {
      // The pull already landed; only the dependencies are suspect. Say so
      // rather than restarting into a broken node_modules.
      broadcast({ phase: 'error', error: 'npm install failed — run it in the forge folder, then restart' })
      return false
    }
  }

  // Same exit as the stale strip's Restart: the button was the confirmation.
  allowClose()
  relaunchDevToolchain()
  app.quit()
  return true
}

/* ------------------------------------------------------------- lifecycle */

export function initSourceUpdater(): void {
  // One update mechanism per way of running Forge: packaged builds have
  // electron-updater, the dev checkout has its own editor. Only the stable
  // checkout — a git repo being used as an app — self-updates from origin.
  if (app.isPackaged) return
  if (process.env['FORGE_CHANNEL'] === 'dev') return
  if (!existsSync(join(app.getAppPath(), '.git'))) return

  enabled = true
  status = { phase: 'idle' }

  firstTimer = setTimeout(() => {
    void checkForSourceUpdate()
  }, FIRST_CHECK_DELAY_MS)
  timer = setInterval(() => {
    void checkForSourceUpdate()
  }, RECHECK_EVERY_MS)
}

/**
 * Wire the focus-triggered check: cheap, throttled, and exactly when you look.
 * No `enabled` guard here — the window exists before initSourceUpdater() runs,
 * and checkForSourceUpdate() is already a no-op when the updater is off.
 */
export function watchFocusForSourceUpdate(win: BrowserWindow): void {
  win.on('focus', () => {
    if (Date.now() - lastCheckAt < FOCUS_CHECK_MIN_GAP_MS) return
    void checkForSourceUpdate()
  })
}

export function registerSourceUpdateHandlers(): void {
  ipcMain.handle(IPC.sourceUpdateStatus, () => getSourceUpdateStatus())
  ipcMain.handle(IPC.sourceUpdateCheck, () => checkForSourceUpdate())
  ipcMain.handle(IPC.sourceUpdateApply, () => applySourceUpdate())
}

export function disposeSourceUpdater(): void {
  if (timer) clearInterval(timer)
  if (firstTimer) clearTimeout(firstTimer)
  timer = null
  firstTimer = null
  target = null
}
