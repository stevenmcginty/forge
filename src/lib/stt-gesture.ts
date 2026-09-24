/**
 * DictationMic's talk-key gestures, as a pure state machine.
 *
 * The pill Steve already trusts does two different things with one key:
 *
 *   tap     start or stop
 *   hold    push-to-talk — listening begins after a short hold, and ends
 *           the moment the key comes up
 *
 * Combos (Ctrl+C, Alt+Tab) never fire. Direct keys (F8) toggle on press and
 * stop on a long release if that press is what opened the mic.
 *
 * A modifier talk key (Right Alt for Dictate, Right Shift for the Agent key)
 * counts only when it goes down and comes back up with nothing else pressed:
 * Shift+A types a capital, Shift+click selects, and neither fires. Left and
 * right are different keys — the hook matches `KeyboardEvent.code` exactly, so
 * Left Shift never answers for Right Shift. If a hold had already opened the
 * mic when the other key lands, `modifierInterrupt` closes it again.
 *
 * Kept free of the DOM so `npm run dictation:check` can drive it. The hook in
 * `src/hooks/useDictation.ts` is the only thing that feeds it real key events.
 */

import { shortcutsSuspended } from './keymapRegistry'

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

/**
 * Another key (or a mouse press) landed while the talk key is down: this is a
 * combo, so the talk key stands down. A hold that already opened the mic is
 * closed again ('ptt-end'); nothing else fires, now or on release.
 */
export function modifierInterrupt(state: GestureState): { state: GestureState; intent: GestureIntent | null } {
  if (!state.down || state.other) return { state, intent: null }
  return { state: { ...state, other: true }, intent: state.ptt && state.startedListening ? 'ptt-end' : null }
}

/**
 * Called once the tap window has elapsed while the key is still down.
 * Listening already? Then this is not a PTT start — release will not toggle
 * either, matching DictationMic: you tap to stop, you do not hold-to-stop.
 */
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
    state: {
      down: true,
      t0: now,
      other: false,
      ptt: false,
      startedListening: !listening
    },
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
  repeat: boolean
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

/**
 * Wire one talk key to the gesture machine: listeners in the capture phase on
 * `target` (the hook passes `window`, so it runs ahead of xterm and works with
 * focus in a pane). A modifier talk key is only ever read, never swallowed, so
 * Shift+A still types "A" in the pane underneath. `code` is matched exactly
 * (ShiftRight is not ShiftLeft). Returns the unwire.
 *
 * `cancel` runs when a hold had opened the mic and then turned out to be a
 * combo (Shift held a beat too long before a capital). Without one, that is
 * treated as the hold's release ('ptt-end').
 */
export function attachTalkKey(
  target: TalkKeyTarget,
  code: string,
  listening: () => boolean,
  apply: (intent: GestureIntent) => void,
  cancel?: () => void
): (() => void) | undefined {
  if (!code) return undefined
  const modifier = isModifierHotkey(code)
  let gesture: GestureState = idleGesture()
  let holdTimer: ReturnType<typeof setTimeout> | null = null

  const clearHold = (): void => {
    if (holdTimer !== null) {
      clearTimeout(holdTimer)
      holdTimer = null
    }
  }

  /** Another key or a mouse press joined the talk key: a combo, so it stands down. */
  const interrupt = (): void => {
    if (!gesture.down) return
    clearHold()
    const next = modifierInterrupt(gesture)
    gesture = next.state
    if (!next.intent) return
    if (cancel) cancel()
    else apply(next.intent)
  }

  const onKeyDown = (e: TalkKeyEvent): void => {
    // A "press the new keys" field is recording: the key is its to take, so
    // it is neither swallowed nor allowed to start the mic.
    if (shortcutsSuspended()) {
      disarm()
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
      // This matters for Right Alt on a UK (AltGr) layout, where Windows
      // repeats a fake Left Ctrl alongside Right Alt the whole time it is
      // held; without this, every hold-to-talk ended half a second in.
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
      // The timer firing IS the tap window being over. The +1 ms is not a
      // delay: (t0 + 450) - t0 can round to 449.99…, which read as "too soon"
      // and made a hold silently do nothing now and then.
      const next = modifierHeld(gesture, gesture.t0 + MODIFIER_TAP_MS + 1, listening())
      gesture = next.state
      if (next.intent) apply(next.intent)
    }, MODIFIER_TAP_MS)
  }

  const onKeyUp = (e: TalkKeyEvent): void => {
    if (shortcutsSuspended()) {
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
    clearHold()
    gesture = idleGesture()
  }

  const disarm = (): void => {
    clearHold()
    gesture = idleGesture()
  }

  const keydown = (e: Event): void => onKeyDown(e as unknown as TalkKeyEvent)
  const keyup = (e: Event): void => onKeyUp(e as unknown as TalkKeyEvent)
  target.addEventListener('keydown', keydown, true)
  target.addEventListener('keyup', keyup, true)
  target.addEventListener('pointerdown', onPointer, true)
  target.addEventListener('blur', disarm)
  return () => {
    clearHold()
    target.removeEventListener('keydown', keydown, true)
    target.removeEventListener('keyup', keyup, true)
    target.removeEventListener('pointerdown', onPointer, true)
    target.removeEventListener('blur', disarm)
  }
}
