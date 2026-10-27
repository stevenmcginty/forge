/**
 * Auto-send for the TV's typing box: dictation sends itself.
 *
 * Steve: "when I dictate ... send the message straight away." The rule is Agent
 * Box's (agent-box HANDOFF, "Auto-send", default On): a change that adds 3 or
 * more characters at once is a dictation burst — River Keys' Dictate strip, the
 * Fire OS keyboard's mic, or a `forge:voice-text` segment — and arms a 1.2 s
 * quiet timer. A key press or a small change (typing) disarms it. When it
 * fires, the line is sent exactly as the Send/Enter cap sends it.
 *
 * Timers are passed in, so scripts/auto-send-check.mjs can drive it with a fake
 * clock.
 */

export const AUTO_SEND_MS = 1200
export const AUTO_SEND_MIN_CHARS = 3
export const AUTO_SEND_KEY = 'forge.tv.autoSend'

/** A change from `prev` to `next` that adds `AUTO_SEND_MIN_CHARS`+ at once. */
export function isBurst(prev: string, next: string): boolean {
  return next.length - prev.length >= AUTO_SEND_MIN_CHARS
}

/**
 * Keys the Android IME reports while it composes or commits text: they are the
 * dictation itself, not somebody pressing a key, and must not disarm it.
 */
export function isImeKey(event: { key?: string; keyCode?: number }): boolean {
  return event.keyCode === 229 || event.key === 'Unidentified' || event.key === 'Process'
}

export interface AutoSendDeps {
  send: () => void
  setTimer?: (fn: () => void, ms: number) => unknown
  clearTimer?: (handle: unknown) => void
  delayMs?: number
}

export interface AutoSend {
  /** The box changed from `prev` to `next` (typing or a burst). */
  change: (prev: string, next: string) => void
  /** Words arrived all at once (a voice segment): arm, if there are enough. */
  burst: (text: string) => void
  /** A key was pressed, the line was sent, the box closed, the setting went off. */
  cancel: () => void
  armed: () => boolean
}

export function createAutoSend(deps: AutoSendDeps): AutoSend {
  const setTimer = deps.setTimer ?? ((fn, ms) => window.setTimeout(fn, ms))
  const clearTimer = deps.clearTimer ?? ((h) => window.clearTimeout(h as number))
  const delay = deps.delayMs ?? AUTO_SEND_MS
  let handle: unknown = null

  const cancel = (): void => {
    if (handle !== null) clearTimer(handle)
    handle = null
  }
  const arm = (): void => {
    cancel()
    handle = setTimer(() => {
      handle = null
      deps.send()
    }, delay)
  }
  return {
    change: (prev, next) => (isBurst(prev, next) ? arm() : cancel()),
    burst: (text) => (text.trim().length >= AUTO_SEND_MIN_CHARS ? arm() : undefined),
    cancel,
    armed: () => handle !== null
  }
}

/** The setting, default On. Storage can be missing or throw on the TV. */
export function readAutoSend(): boolean {
  try {
    return localStorage.getItem(AUTO_SEND_KEY) !== 'off'
  } catch {
    return true
  }
}

export function writeAutoSend(on: boolean): void {
  try {
    localStorage.setItem(AUTO_SEND_KEY, on ? 'on' : 'off')
  } catch {
    /* the setting lasts for this visit only */
  }
}
