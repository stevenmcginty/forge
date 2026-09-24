import { isLoneModifier, talkKeyFromCode } from '@/lib/keymap'

/**
 * The desktop's talk-key gestures, for the browser.
 *
 *   tap     start or stop
 *   hold    push-to-talk — listening begins after a short hold, and ends the
 *           moment the key comes up
 *
 * A copy of the pure part of src/lib/stt-gesture.ts (the gesture machine and
 * `attachTalkKey`) and of src/components/hub/KeyRecorder.tsx's lone-key
 * recording, because stt-gesture reads the desktop's keymap registry, which
 * reaches for `window.forgeHub`. Keep the two in step: a fix to one is a fix
 * to both. The web deck's D key (web/src/deck/VoiceBar.tsx `DeckKeys`) is the
 * only thing that feeds this real key events; `npm run voice-hotkey:check`
 * drives it with fake ones.
 *
 * Right Alt on a UK (AltGr) layout: Windows sends a fake Left Ctrl down first,
 * then Right Alt, and repeats the fake Ctrl for as long as Right Alt is held.
 * The gesture ignores other keys' auto-repeats, and the recorder drops the
 * fake Ctrl. A modifier talk key is only ever read, never swallowed, so AltGr
 * characters still type.
 *
 * Two things the desktop does not need: nothing fires while `suspended()` says
 * a field is recording a key, or while an IME composition is running.
 */

export const MODIFIER_TAP_MS = 450
export const DIRECT_PTT_MS = 700

export type GestureIntent = 'toggle' | 'ptt-start' | 'ptt-end'

export interface GestureState {
  down: boolean
  t0: number
  /** Another key landed while this one was held — it is a combo, stand down. */
  other: boolean
  /** Hold crossed the tap threshold and started (or would start) PTT. */
  ptt: boolean
  /** This press is the one that opened the mic, so a long hold can close it. */
  startedListening: boolean
}

export function idleGesture(): GestureState {
  return { down: false, t0: 0, other: false, ptt: false, startedListening: false }
}

/** Right Alt and friends — tap vs hold is a real distinction. */
export function isModifierHotkey(code: string): boolean {
  return /^(Control|Alt|Shift|Meta)(Left|Right)$/.test(code)
}

export function modifierDown(state: GestureState, now: number): GestureState {
  if (state.down) return state
  return { down: true, t0: now, other: false, ptt: false, startedListening: false }
}

export function modifierOther(state: GestureState): GestureState {
  if (!state.down) return state
  return { ...state, other: true }
}

/** Another key (or a mouse press) joined the talk key: a combo. A hold that opened the mic closes. */
export function modifierInterrupt(state: GestureState): { state: GestureState; intent: GestureIntent | null } {
  if (!state.down || state.other) return { state, intent: null }
  return { state: { ...state, other: true }, intent: state.ptt && state.startedListening ? 'ptt-end' : null }
}

/** The tap window has elapsed with the key still down. Listening already? Then it is not a PTT start. */
export function modifierHeld(
  state: GestureState,
  now: number,
  listening: boolean
): { state: GestureState; intent: GestureIntent | null } {
  if (!state.down || state.other || state.ptt) return { state, intent: null }
  if (now - state.t0 < MODIFIER_TAP_MS) return { state, intent: null }
  if (listening) return { state: { ...state, ptt: true }, intent: null }
  return { state: { ...state, ptt: true, startedListening: true }, intent: 'ptt-start' }
}

export function modifierUp(
  state: GestureState,
  now: number,
  listening: boolean
): { state: GestureState; intent: GestureIntent | null } {
  const idle = idleGesture()
  if (!state.down || state.other) return { state: idle, intent: null }
  if (state.ptt) {
    const shouldStop = listening || state.startedListening
    return { state: idle, intent: shouldStop ? 'ptt-end' : null }
  }
  if (now - state.t0 < MODIFIER_TAP_MS) return { state: idle, intent: 'toggle' }
  return { state: idle, intent: null }
}

/** F8 and friends — fire on press, ignore auto-repeat. */
export function directDown(
  state: GestureState,
  now: number,
  listening: boolean
): { state: GestureState; intent: GestureIntent | null } {
  if (state.down) return { state, intent: null }
  return {
    state: { down: true, t0: now, other: false, ptt: false, startedListening: !listening },
    intent: 'toggle'
  }
}

export function directUp(
  state: GestureState,
  now: number,
  listening: boolean
): { state: GestureState; intent: GestureIntent | null } {
  const idle = idleGesture()
  if (!state.down) return { state: idle, intent: null }
  if (state.startedListening && listening && now - state.t0 >= DIRECT_PTT_MS) {
    return { state: idle, intent: 'ptt-end' }
  }
  return { state: idle, intent: null }
}

/* ------------------------------------------------------------ the wiring */

/** The few KeyboardEvent fields the wiring reads, so the check script can fake them. */
export interface TalkKeyEvent {
  code: string
  key?: string
  repeat: boolean
  isComposing?: boolean
  ctrlKey?: boolean
  altKey?: boolean
  shiftKey?: boolean
  metaKey?: boolean
  preventDefault(): void
  stopPropagation(): void
}

/** A modifier OTHER than the talk key's own is already held: Ctrl+Right Shift is a combo. */
function otherModifierHeld(code: string, e: TalkKeyEvent): boolean {
  const own = code.replace(/(Left|Right)$/, '')
  return (
    (own !== 'Control' && e.ctrlKey === true) ||
    (own !== 'Alt' && e.altKey === true) ||
    (own !== 'Shift' && e.shiftKey === true) ||
    (own !== 'Meta' && e.metaKey === true)
  )
}

/** `window`, or anything else that can hold listeners. */
export interface TalkKeyTarget {
  addEventListener(type: string, fn: (e: Event) => void, capture?: boolean): void
  removeEventListener(type: string, fn: (e: Event) => void, capture?: boolean): void
}

export interface TalkKeyOptions {
  /** A hold had opened the mic and turned out to be a combo. Without one, that is the hold's release. */
  cancel?: () => void
  /** A field is recording a key: the key is its to take, so nothing fires. */
  suspended?: () => boolean
}

/**
 * Wire one talk key to the gesture machine: capture-phase listeners on
 * `target` (`window`, so it runs ahead of xterm and works with focus in a
 * pane). `code` is matched exactly (AltRight is not AltLeft). Returns the
 * unwire.
 */
export function attachTalkKey(
  target: TalkKeyTarget,
  code: string,
  listening: () => boolean,
  apply: (intent: GestureIntent) => void,
  opts: TalkKeyOptions = {}
): (() => void) | undefined {
  if (!code) return undefined
  const modifier = isModifierHotkey(code)
  let gesture: GestureState = idleGesture()
  let holdTimer: ReturnType<typeof setTimeout> | null = null
  let composing = false

  const clearHold = (): void => {
    if (holdTimer !== null) {
      clearTimeout(holdTimer)
      holdTimer = null
    }
  }

  const disarm = (): void => {
    clearHold()
    gesture = idleGesture()
  }

  const interrupt = (): void => {
    if (!gesture.down) return
    clearHold()
    const next = modifierInterrupt(gesture)
    gesture = next.state
    if (!next.intent) return
    if (opts.cancel) opts.cancel()
    else apply(next.intent)
  }

  /** An IME is composing a character: every key is its, and a held talk key stands down. */
  const imeBusy = (e: TalkKeyEvent): boolean => composing || e.isComposing === true || e.key === 'Process'

  const onKeyDown = (e: TalkKeyEvent): void => {
    if (opts.suspended?.()) {
      disarm()
      return
    }
    if (imeBusy(e)) {
      interrupt()
      return
    }
    if (!modifier) {
      if (e.code !== code) return
      if (e.repeat) return
      e.preventDefault()
      e.stopPropagation()
      const next = directDown(gesture, performance.now(), listening())
      gesture = next.state
      if (next.intent) apply(next.intent)
      return
    }
    if (e.code !== code) {
      // An auto-repeat is not a new key: its first press already counted.
      // Right Alt on a UK (AltGr) layout repeats a fake Left Ctrl beside it
      // the whole time it is held; without this, every hold ended half a
      // second in.
      if (e.repeat) return
      interrupt()
      return
    }
    if (e.repeat) return
    gesture = modifierDown(gesture, performance.now())
    clearHold()
    if (otherModifierHeld(code, e)) {
      gesture = modifierOther(gesture)
      return
    }
    holdTimer = setTimeout(() => {
      holdTimer = null
      // The timer firing IS the tap window being over; the +1 ms keeps
      // (t0 + 450) - t0 from rounding to 449.99… and reading as "too soon".
      const next = modifierHeld(gesture, gesture.t0 + MODIFIER_TAP_MS + 1, listening())
      gesture = next.state
      if (next.intent) apply(next.intent)
    }, MODIFIER_TAP_MS)
  }

  const onKeyUp = (e: TalkKeyEvent): void => {
    if (opts.suspended?.()) {
      disarm()
      return
    }
    if (!modifier) {
      if (e.code !== code) return
      const next = directUp(gesture, performance.now(), listening())
      gesture = next.state
      if (next.intent) apply(next.intent)
      return
    }
    if (e.code !== code) return
    clearHold()
    const next = modifierUp(gesture, performance.now(), listening())
    gesture = next.state
    if (next.intent) apply(next.intent)
  }

  const onPointer = (): void => {
    if (modifier) {
      interrupt()
      return
    }
    disarm()
  }

  const onCompositionStart = (): void => {
    composing = true
    interrupt()
  }
  const onCompositionEnd = (): void => {
    composing = false
  }

  const keydown = (e: Event): void => onKeyDown(e as unknown as TalkKeyEvent)
  const keyup = (e: Event): void => onKeyUp(e as unknown as TalkKeyEvent)
  target.addEventListener('keydown', keydown, true)
  target.addEventListener('keyup', keyup, true)
  target.addEventListener('pointerdown', onPointer, true)
  target.addEventListener('compositionstart', onCompositionStart, true)
  target.addEventListener('compositionend', onCompositionEnd, true)
  target.addEventListener('blur', disarm)
  return () => {
    clearHold()
    target.removeEventListener('keydown', keydown, true)
    target.removeEventListener('keyup', keyup, true)
    target.removeEventListener('pointerdown', onPointer, true)
    target.removeEventListener('compositionstart', onCompositionStart, true)
    target.removeEventListener('compositionend', onCompositionEnd, true)
    target.removeEventListener('blur', disarm)
  }
}

/* ------------------------------------------------------------ recording */

/** The lone modifier that is down in the recorder right now, and whether another key joined it. */
export interface HeldKey {
  code: string
  other: boolean
}

export interface RecordStep {
  held: HeldKey | null
  /** A talk key was recorded (a KeyboardEvent.code). */
  key?: string
  /** Not a key that can be a talk key (a letter, a combo). */
  refused?: boolean
  /** Ignore this event entirely: it is AltGr's fake Left Ctrl. */
  ignored?: boolean
}

type RecordKeyEvent = Pick<TalkKeyEvent, 'code' | 'repeat' | 'ctrlKey' | 'altKey' | 'shiftKey' | 'metaKey'>

/**
 * A key down in a "press the new key" field. A lone modifier counts on the
 * way back up (see `recordKeyUp`); F-keys, Scroll Lock and Pause count at once.
 */
export function recordKeyDown(held: HeldKey | null, e: RecordKeyEvent): RecordStep {
  if (e.repeat) return { held }
  let h = held
  // Right Alt on a UK (AltGr) layout: the fake Left Ctrl that came first is replaced.
  if (e.code === 'AltRight' && h?.code === 'ControlLeft' && !h.other) h = null
  if (isLoneModifier(e.code)) return { held: h ? { ...h, other: true } : { code: e.code, other: false } }
  if (h) h = { ...h, other: true }
  const key = !h && !e.ctrlKey && !e.altKey && !e.shiftKey && !e.metaKey ? talkKeyFromCode(e.code) : null
  return key ? { held: h, key } : { held: h, refused: true }
}

/** A key up in the recorder: a lone modifier coming back up with nothing pressed alongside it. */
export function recordKeyUp(held: HeldKey | null, code: string): RecordStep {
  // The fake Left Ctrl of AltGr comes up before Right Alt does: not ours.
  if (held?.code === 'AltRight' && code === 'ControlLeft') return { held, ignored: true }
  if (!held || held.code !== code) return { held }
  if (held.other) return { held: null }
  return { held: null, key: held.code }
}
