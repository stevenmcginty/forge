import { globalShortcut, type BrowserWindow } from 'electron'
import { IPC } from '@shared/ipc'

/**
 * The Copilot key as a Listen key: F24 toggles the main agent's voice from
 * any app, with Forge up or minimised to the mini bar.
 *
 * The laptop's Copilot key sends LWin+LShift+F23. PowerToys Keyboard Manager
 * on Steve's PC swallows that chord and presses a plain F24 instead; this
 * file only reacts to the F24. It never starts Forge: with Forge closed there
 * is no registration and F24 does nothing.
 *
 * Opt-in (`copilotKeyListen`, off by default): Forge ships to PCs with no
 * Copilot key, and a registered F24 is taken from every other app. While the
 * setting is off, nothing is registered.
 *
 * Electron `globalShortcut` (RegisterHotKey), not the uiohook hook in
 * electron/global-keys.ts: the hotkey takes F24 off the input stream, so a
 * focused Forge window never sees it a second time; it hears this one key and
 * no other keystroke; and it works whatever state the window is in.
 *
 * There is no key-up, so every accepted press is a tap: intent 'toggle', the
 * same as a tap on the Listen key (src/lib/stt-gesture.ts). The host renderer
 * takes it down the Listen command's own path (src/hooks/useDictation.ts).
 */

export const LISTEN_ACCELERATOR = 'F24'

/**
 * A press this soon after the previous one (accepted or not) is the OS
 * auto-repeat of a held key, and is dropped. The hotkey fires on every repeat
 * (no MOD_NOREPEAT), and Windows waits about 500 ms (KeyboardDelay 1, the
 * default) before the first repeat, so the gap must be longer than that.
 * Measured from the last press, so a steady repeat stream never gets through.
 */
export const REPEAT_GAP_MS = 600

/**
 * The repeat filter, pure: true when a press at `now` (ms) is a new press.
 * Each call, accepted or not, restarts the gap.
 */
export function createRepeatGate(gapMs: number = REPEAT_GAP_MS): (now: number) => boolean {
  let last = Number.NEGATIVE_INFINITY
  return (now) => {
    const fresh = now - last >= gapMs
    last = now
    return fresh
  }
}

let registered = false
let warned = false

/**
 * F24 registered when `on`, let go when not (after app ready; again whenever
 * `copilotKeyListen` changes). `getHost` returns the main window, the one that
 * owns the agent; with no live host a press is dropped. A failed registration
 * (another app owns F24) is logged once and never throws.
 */
export function syncCopilotKey(on: boolean, getHost: () => BrowserWindow | null, now: () => number = Date.now): void {
  if (!on) {
    disposeCopilotKey()
    return
  }
  if (registered) return
  const fresh = createRepeatGate()
  const onPress = (): void => {
    if (!fresh(now())) return
    const host = getHost()
    if (!host || host.isDestroyed()) return
    host.webContents.send(IPC.voiceListenToggle)
  }
  try {
    registered = globalShortcut.register(LISTEN_ACCELERATOR, onPress)
  } catch (err) {
    registered = false
    if (!warned) console.warn(`[copilot-key] ${LISTEN_ACCELERATOR} could not be registered:`, err)
    warned = true
    return
  }
  if (!registered && !warned) {
    console.warn(`[copilot-key] ${LISTEN_ACCELERATOR} is taken by another app; the Copilot key will not start Listen`)
    warned = true
  }
}

/** Let go of F24 (the setting turned off, or before-quit). */
export function disposeCopilotKey(): void {
  if (!registered) return
  registered = false
  try {
    globalShortcut.unregister(LISTEN_ACCELERATOR)
  } catch (err) {
    console.warn(`[copilot-key] ${LISTEN_ACCELERATOR} could not be unregistered:`, err)
  }
}
