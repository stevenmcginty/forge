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
 * Kept free of the DOM so `npm run dictation:check` can drive it. The hook in
 * `src/hooks/useDictation.ts` is the only thing that feeds it real key events.
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

/** Right Ctrl and friends — tap vs hold is a real distinction. */
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
