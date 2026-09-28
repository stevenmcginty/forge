import { useSyncExternalStore } from 'react'

/**
 * The bar's mic: a dictation whose words go into the bar's own text box.
 *
 * The Dictate key (Right Alt) is raw dictation — its words go straight into
 * whatever has focus. The bar's mic button is the phone's mic instead: press,
 * talk, press again; the words land in the bar, wait "Sending… 1.5 s" with
 * Undo (Esc undoes too), then send as the bar's Enter would. Undo keeps the
 * words in the bar to edit.
 *
 * The press that stops decides. A key dictation stopped by the key stays raw:
 * the words sit where they landed, no Enter. A key dictation stopped by the
 * bar's button is sent: the same countdown with Undo, then Enter where the
 * words landed — the pane they were typed into, or the bar when it had focus.
 *
 * Both run the one sidecar session in useDictation's engine, with whatever
 * speech engine Settings picks. This says which of them started the session
 * that is running now, and where the bar takes its words:
 *
 *   off     no bar dictation: phrases go where the key's go.
 *   armed   the mic was pressed; the sidecar has not opened it yet.
 *   live    the sidecar is listening, or writing down the last phrase.
 *
 * The engine sets the phase and hands phrases to the sink; the bar (Composer)
 * is the sink and runs the review countdown. For a key dictation the engine
 * also notes where its words landed, and whether the button stopped it.
 */

export type BarDictationPhase = 'off' | 'armed' | 'live'

export interface BarDictationSink {
  /** One finished phrase from a dictation the bar's mic started. */
  phrase: (text: string) => void
  /** That dictation is over and every phrase is in. `ok` is false when it ended in an error. */
  done: (ok: boolean) => void
  /** Is this the bar's own text box? A key phrase typed there landed in the bar. */
  ownsField: (el: Element) => boolean
  /** A key dictation the button stopped is over, every phrase in: send where its words landed. */
  sendKeyWords: (landing: KeyDictationLanding) => void
}

/**
 * Where a key dictation's last phrase landed:
 *
 *   pane       typed into that pane's prompt — the send is its Enter.
 *   bar        typed into the bar's own box — the send is the bar's.
 *   elsewhere  another field, or the clipboard — nothing to send.
 *   none       nothing heard yet.
 */
export type KeyDictationLanding =
  | { kind: 'pane'; paneId: string }
  | { kind: 'bar' }
  | { kind: 'elsewhere' }
  | { kind: 'none' }

let phase: BarDictationPhase = 'off'
let sink: BarDictationSink | null = null
let keyLanding: KeyDictationLanding = { kind: 'none' }
let keySend = false
const listeners = new Set<() => void>()

function subscribe(fn: () => void): () => void {
  listeners.add(fn)
  return () => {
    listeners.delete(fn)
  }
}

export function barDictationPhase(): BarDictationPhase {
  return phase
}

export function setBarDictationPhase(next: BarDictationPhase): void {
  if (next === phase) return
  phase = next
  listeners.forEach((fn) => fn())
}

export function useBarDictationPhase(): BarDictationPhase {
  return useSyncExternalStore(subscribe, barDictationPhase, barDictationPhase)
}

/** Where a bar dictation's words go: the bar's text box, while it is mounted. */
export function barDictationSink(): BarDictationSink | null {
  return sink
}

/** The bar takes the words while mounted. Returns the release. */
export function setBarDictationSink(next: BarDictationSink): () => void {
  sink = next
  return () => {
    if (sink === next) sink = null
  }
}

/** Where the key dictation's words landed last. */
export function keyDictationLanding(): KeyDictationLanding {
  return keyLanding
}

export function setKeyDictationLanding(next: KeyDictationLanding): void {
  keyLanding = next
}

/** The bar's button stopped the key dictation: send its words once every phrase is in. */
export function keyDictationSendsOnEnd(): boolean {
  return keySend
}

export function setKeyDictationSendsOnEnd(next: boolean): void {
  keySend = next
}
