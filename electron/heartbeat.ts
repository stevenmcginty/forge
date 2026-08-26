import { mkdirSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * The main-process heartbeat: "Forge is alive and its event loop is turning".
 *
 * scripts/watchdog.mjs runs outside Forge for the life of the Windows session
 * and reads this file's age. It is the one signal that covers every way Forge
 * has stranded the phone:
 *
 *  - the process died (crash, `app.exit`, Task Manager) — the beat stops
 *  - the main event loop hung — a setInterval cannot fire, so the beat stops
 *  - Forge was never started after a reboot — there is no fresh file at all
 *
 * A renderer that is dead while main is fine is handled inside Forge by
 * electron/renderer-watchdog.ts; this file deliberately says nothing about it.
 *
 * Deleted on a clean quit so the watchdog can act at once instead of waiting
 * for the file to age out. Electron-free so scripts can drive it head-less.
 */

export const HEARTBEAT_FILE = 'heartbeat'
export const HEARTBEAT_INTERVAL_MS = 5_000

let filePath = ''
let timer: NodeJS.Timeout | null = null

function beat(): void {
  try {
    writeFileSync(filePath, `${process.pid} ${Date.now()}\n`)
  } catch {
    // A locked or unwritable data root must never take Forge down; the
    // watchdog will read the stale age and do the only thing it can.
  }
}

/** Start beating into `<dir>/heartbeat`. Returns the marker path. */
export function startHeartbeat(dir: string, intervalMs = HEARTBEAT_INTERVAL_MS): string {
  stopHeartbeat()
  mkdirSync(dir, { recursive: true })
  filePath = join(dir, HEARTBEAT_FILE)
  beat()
  timer = setInterval(beat, Math.max(500, intervalMs))
  timer.unref()
  return filePath
}

/** Stop beating and remove the marker — a clean quit says so explicitly. */
export function stopHeartbeat(): void {
  if (timer) clearInterval(timer)
  timer = null
  if (!filePath) return
  try {
    unlinkSync(filePath)
  } catch {
    /* already gone */
  }
  filePath = ''
}

export function heartbeatFile(): string {
  return filePath
}
