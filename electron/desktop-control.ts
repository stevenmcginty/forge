import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'

/**
 * The voice agent's hands on the rest of the desktop — tier two of the JARVIS
 * build-out.
 *
 * Tier one gave the agent Forge: tabs, panes, projects, prompts. The first
 * thing Steve asked it to do after that was open Spotify, and the honest
 * answer was that it could not touch anything outside the app. This module is
 * the touching: list what is installed, launch it, see which windows are open,
 * bring one forward, type into it, open a file or a link, close a window.
 * Combined with `take_screenshot` (its eyes) that is a real, verifiable
 * act-look-act loop on the whole machine.
 *
 * ## Why PowerShell rather than a native module
 *
 * Everything here is a short-lived `powershell.exe -Command`. That is slower
 * than user32 bindings by tens of milliseconds, and it is worth it: no native
 * dependency to build, nothing new to package, and every capability is exactly
 * the line a person would type — auditable by reading. `Get-StartApps` in
 * particular is the ONLY complete answer to "what can I launch" on modern
 * Windows: it enumerates Store/UWP apps and classic shortcuts alike, which no
 * amount of walking Program Files gets right.
 *
 * ## Deliberately Electron-free
 *
 * Same rule as voice-agent/host.ts, which imports this: plain Node only, so
 * the headless smoke test can load the host without an Electron binary.
 *
 * ## Safety shape
 *
 * Launching, focusing and listing are harmless. The two that are not —
 * `sendKeys` (types into whatever is focused) and `closeWindow` — are still
 * graceful by construction: keys go through SendWait to a window this module
 * just activated by pid, and close is `CloseMainWindow()`, the same polite
 * message the ✕ button sends, never `Stop-Process`. The persona layer owns
 * "confirm before you do it"; this layer's job is that nothing here can be
 * more destructive than a human at the same keyboard.
 */

/* ------------------------------------------------------------------ shells */

const PS_TIMEOUT_MS = 15_000

/** Run one PowerShell command line and hand back stdout. */
function ps(command: string, timeoutMs = PS_TIMEOUT_MS): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', command],
      { timeout: timeoutMs, windowsHide: true, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) {
          reject(new Error((stderr || err.message || 'PowerShell failed').trim().slice(0, 400)))
          return
        }
        resolve(stdout ?? '')
      }
    )
  })
}

/** Single-quote a value into a PowerShell string literal. The one escape rule. */
function psQuote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`
}

/* ------------------------------------------------------------ installed apps */

export interface DesktopApp {
  name: string
  appId: string
}

let appsCache: { at: number; apps: DesktopApp[] } | null = null
const APPS_CACHE_MS = 60_000

/**
 * Everything the Start menu can launch. Cached for a minute — installing an
 * app mid-sentence is not a case worth a two-second enumeration per question.
 */
export async function listDesktopApps(): Promise<DesktopApp[]> {
  if (appsCache && Date.now() - appsCache.at < APPS_CACHE_MS) return appsCache.apps
  const raw = await ps('Get-StartApps | ConvertTo-Json -Compress')
  const parsed = JSON.parse(raw.trim() || '[]') as Array<{ Name?: string; AppID?: string }> | { Name?: string; AppID?: string }
  const rows = Array.isArray(parsed) ? parsed : [parsed]
  const apps = rows
    .map((r) => ({ name: String(r.Name ?? '').trim(), appId: String(r.AppID ?? '').trim() }))
    .filter((a) => a.name && a.appId)
    .sort((a, b) => a.name.localeCompare(b.name))
  appsCache = { at: Date.now(), apps }
  return apps
}

/**
 * Find the app somebody *said*. Exact beats starts-with beats contains, all
 * case-insensitive — "spotify" must find Spotify, "chrome" must find Google
 * Chrome, and "code" should prefer an app actually called Code over a dozen
 * things containing the word.
 */
export function matchApp(apps: DesktopApp[], query: string): { hit: DesktopApp | null; near: DesktopApp[] } {
  const q = query.trim().toLowerCase()
  if (!q) return { hit: null, near: [] }
  const exact = apps.filter((a) => a.name.toLowerCase() === q)
  if (exact.length) return { hit: exact[0] as DesktopApp, near: [] }
  const starts = apps.filter((a) => a.name.toLowerCase().startsWith(q))
  if (starts.length) return { hit: starts[0] as DesktopApp, near: starts.slice(1, 4) }
  const contains = apps.filter((a) => a.name.toLowerCase().includes(q))
  if (contains.length === 1) return { hit: contains[0] as DesktopApp, near: [] }
  return { hit: null, near: contains.slice(0, 5) }
}

/** Launch an installed app by spoken name. Returns what actually launched. */
export async function launchDesktopApp(query: string): Promise<string> {
  const apps = await listDesktopApps()
  const { hit, near } = matchApp(apps, query)
  if (!hit) {
    if (near.length) {
      return `Nothing is called "${query}". Close matches: ${near.map((a) => a.name).join(', ')}. Say which one.`
    }
    return `Nothing installed matches "${query}". Use list_desktop_apps to see what there is.`
  }
  // shell:AppsFolder launches UWP and classic entries alike — it is the same
  // door the Start menu itself goes through.
  await ps(`Start-Process ${psQuote(`shell:AppsFolder\\${hit.appId}`)}`)
  return `Launched ${hit.name}.`
}

/* ---------------------------------------------------------------- windows */

export interface DesktopWindow {
  pid: number
  process: string
  title: string
}

/** Every top-level window with a title — what a person means by "open". */
export async function listOpenWindows(): Promise<DesktopWindow[]> {
  const raw = await ps(
    'Get-Process | Where-Object { $_.MainWindowTitle } | ' +
      'Select-Object Id,ProcessName,MainWindowTitle | ConvertTo-Json -Compress'
  )
  const parsed = JSON.parse(raw.trim() || '[]') as
    | Array<{ Id?: number; ProcessName?: string; MainWindowTitle?: string }>
    | { Id?: number; ProcessName?: string; MainWindowTitle?: string }
  const rows = Array.isArray(parsed) ? parsed : [parsed]
  return rows
    .map((r) => ({
      pid: Number(r.Id ?? 0),
      process: String(r.ProcessName ?? '').trim(),
      title: String(r.MainWindowTitle ?? '').trim()
    }))
    .filter((w) => w.pid > 0 && w.title)
}

/** Title first, then process name — "the spotify window" matches either way. */
export function matchWindow(windows: DesktopWindow[], query: string): { hit: DesktopWindow | null; near: DesktopWindow[] } {
  const q = query.trim().toLowerCase()
  if (!q) return { hit: null, near: [] }
  const byTitle = windows.filter((w) => w.title.toLowerCase().includes(q))
  if (byTitle.length) return { hit: byTitle[0] as DesktopWindow, near: byTitle.slice(1, 4) }
  const byProcess = windows.filter((w) => w.process.toLowerCase().includes(q))
  if (byProcess.length) return { hit: byProcess[0] as DesktopWindow, near: byProcess.slice(1, 4) }
  return { hit: null, near: [] }
}

async function findWindow(query: string): Promise<{ hit: DesktopWindow | null; error: string }> {
  const windows = await listOpenWindows()
  const { hit } = matchWindow(windows, query)
  if (hit) return { hit, error: '' }
  const titles = windows
    .slice(0, 8)
    .map((w) => w.title)
    .join('; ')
  return { hit: null, error: `No open window matches "${query}". Open now: ${titles || 'nothing with a window'}.` }
}

/** Bring a window to the front. */
export async function focusDesktopWindow(query: string): Promise<string> {
  const { hit, error } = await findWindow(query)
  if (!hit) return error
  const ok = (
    await ps(`(New-Object -ComObject WScript.Shell).AppActivate(${hit.pid})`)
  ).trim()
  return ok.toLowerCase().includes('true')
    ? `Focused ${hit.title}.`
    : `Windows would not bring "${hit.title}" forward — it may be minimised to the tray or elevated.`
}

/** Ask a window to close — the ✕ button, never a kill. */
export async function closeDesktopWindow(query: string): Promise<string> {
  const { hit, error } = await findWindow(query)
  if (!hit) return error
  const ok = (await ps(`(Get-Process -Id ${hit.pid}).CloseMainWindow()`)).trim()
  return ok.toLowerCase().includes('true')
    ? `Asked ${hit.title} to close. If it has unsaved work it will ask first.`
    : `"${hit.title}" refused the close message.`
}

/* --------------------------------------------------------------- typing */

/** The characters SendKeys treats as syntax when they appear in literal text. */
function escapeSendKeys(text: string): string {
  return text.replace(/[+^%~(){}[\]]/g, (c) => `{${c}}`)
}

/**
 * Focus a window and type into it.
 *
 * `text` is typed literally — its SendKeys metacharacters are escaped here so
 * the model cannot smuggle key chords through a "text" field. `keys` is raw
 * SendKeys syntax (`{ENTER}`, `^s`, `%{F4}`) for when a chord is exactly what
 * was asked for. Both go through one activation so the keystrokes cannot land
 * on the wrong window between two calls.
 */
export async function sendKeysToWindow(query: string, text: string, keys: string): Promise<string> {
  const payload = `${escapeSendKeys(text ?? '')}${(keys ?? '').trim()}`
  if (!payload) return 'Nothing to type — give text, keys, or both.'
  const { hit, error } = await findWindow(query)
  if (!hit) return error
  const script =
    `$ws = New-Object -ComObject WScript.Shell; ` +
    `if (-not $ws.AppActivate(${hit.pid})) { 'NOFOCUS'; exit }; ` +
    `Start-Sleep -Milliseconds 250; ` +
    `Add-Type -AssemblyName System.Windows.Forms; ` +
    `[System.Windows.Forms.SendKeys]::SendWait(${psQuote(payload)}); 'SENT'`
  const out = (await ps(script)).trim()
  if (out.includes('NOFOCUS')) {
    return `Could not put the focus on "${hit.title}", so nothing was typed.`
  }
  return `Typed into ${hit.title}.`
}

/* ---------------------------------------------------------------- opening */

/**
 * Open a file, a folder or a link with whatever Windows has registered for it.
 * URLs are restricted to http(s) — `Start-Process` on other schemes is a
 * grab-bag nobody hands to a hands-free agent — and paths must exist, so a
 * hallucinated one is an answer rather than an error dialog.
 */
export async function openDesktopTarget(target: string): Promise<string> {
  const t = (target ?? '').trim()
  if (!t) return 'Nothing to open.'
  const isUrl = /^https?:\/\//i.test(t)
  if (!isUrl) {
    if (/^[a-z]+:/i.test(t)) return `Only http(s) links and file paths can be opened, not "${t.split(':')[0]}:" URIs.`
    if (!existsSync(t)) return `There is no file or folder at ${t}.`
  }
  await ps(`Start-Process ${psQuote(t)}`)
  return `Opened ${t}.`
}
