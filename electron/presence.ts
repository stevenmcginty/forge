import { existsSync, mkdirSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

/**
 * The client-presence marker: "Steve is at the PC".
 *
 * Claude Code reads `CLAUDE_CLIENT_PRESENCE_FILE` (v2.1.181+) and, while that
 * file exists, holds back the push notifications it would otherwise send to the
 * phone. Every Forge pane gets the variable pointed at one shared marker under
 * the data root, and Forge creates/deletes it as its windows gain and lose
 * focus. The result is the behaviour you actually want from a remote-controlled
 * session: silent while you are looking at it, and a buzz in your pocket the
 * moment you walk away and Claude needs you.
 *
 * Two deliberate details:
 *
 *  - Losing focus is *debounced*. Alt-tabbing to a browser for four seconds is
 *    not walking away, and without the grace period every window switch would
 *    open and close the push gate, which reads as a phone that buzzes at random.
 *    Gaining focus is immediate — being interrupted on the phone by something
 *    you are already watching is the worse failure.
 *
 *  - A marker left behind by a crash is deleted on init. It is a "user is here"
 *    claim with no expiry, so a stale one would silence the phone forever.
 *
 * Free of any Electron import so scripts/remote-check.mjs can drive it head-less.
 */

/** How long all windows must stay blurred before we admit Steve has gone. */
export const PRESENCE_GRACE_MS = 5000

let filePath = ''
let graceMs = PRESENCE_GRACE_MS
let clearTimer: NodeJS.Timeout | null = null

/**
 * Point the marker at `<dir>/presence` and clear anything left over from a
 * previous run. Returns the absolute path, which is what goes into pane env.
 */
export function initPresence(dir: string, grace = PRESENCE_GRACE_MS): string {
  filePath = join(dir, 'presence')
  graceMs = Math.max(0, grace)
  cancelClear()
  removeMarker()
  return filePath
}

/** The marker path, for `CLAUDE_CLIENT_PRESENCE_FILE`. Empty until init. */
export function presenceFile(): string {
  return filePath
}

export function presencePresent(): boolean {
  return Boolean(filePath) && existsSync(filePath)
}

/**
 * Report whether any Forge window currently has focus. Call from every window's
 * `focus` and `blur` handlers; the debounce is handled here.
 */
export function setPresence(focused: boolean): void {
  if (!filePath) return
  if (focused) {
    cancelClear()
    writeMarker()
    return
  }
  cancelClear()
  if (graceMs === 0) {
    removeMarker()
    return
  }
  clearTimer = setTimeout(() => {
    clearTimer = null
    removeMarker()
  }, graceMs)
  // A pending delete must never hold the app open at quit time.
  clearTimer.unref?.()
}

/** Drop the marker and any pending timer. Call on quit. */
export function disposePresence(): void {
  cancelClear()
  removeMarker()
}

/* ----------------------------------------------------------------- helpers */

function cancelClear(): void {
  if (!clearTimer) return
  clearTimeout(clearTimer)
  clearTimer = null
}

function writeMarker(): void {
  try {
    mkdirSync(dirname(filePath), { recursive: true })
    // The contents are never read by Claude — existence is the whole signal —
    // but a timestamp makes a stale marker obvious to a human.
    writeFileSync(filePath, `${new Date().toISOString()}\n`, 'utf8')
  } catch (err) {
    console.error('[presence] could not write marker:', err)
  }
}

function removeMarker(): void {
  if (!filePath) return
  try {
    unlinkSync(filePath)
  } catch {
    /* not there — which is exactly the state we wanted */
  }
}
