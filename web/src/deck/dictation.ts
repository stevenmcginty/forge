import { useSyncExternalStore } from 'react'
import { isDictationSupported } from '../lib/dictate'
import { dictationSeat, subscribeDictationSeat } from '../lib/dictation-seat'

/**
 * D: the phone's dictation, from a desktop browser.
 *
 * Not a copy of it: D drives the deck's own SessionComposer, which lends its
 * mic through ../lib/dictation-seat — the same code the phone's mic runs, end
 * to end. `startRecording` with the pane as its target, the silence check,
 * `transcribeOnDesktop` with its 75 s ceiling, the opt-in auto-stop, the
 * desktop's choice of speech engine; then a short whole utterance that is a
 * command ("stop", "yes", "option two", "next tab") acts at once, and anything
 * else lands in the composer with the review countdown ("Sending… 1.2 s",
 * Undo; Esc undoes too) and then sends into the pane with Enter. Undo keeps
 * the words in the box to edit.
 *
 * The one thing kept here is `starting` — the microphone opening, which the
 * composer's own phases do not show — so Listen's mic is held shut from the
 * press, not from the first recorded word.
 */

export type DeckDictationPhase = 'idle' | 'starting' | 'recording' | 'transcribing' | 'review'

/** A press is waiting on the microphone (the browser may be asking permission). */
let opening = false
const listeners = new Set<() => void>()

function notify(): void {
  listeners.forEach((fn) => fn())
}

function subscribe(fn: () => void): () => void {
  listeners.add(fn)
  const off = subscribeDictationSeat(fn)
  return () => {
    listeners.delete(fn)
    off()
  }
}

export function deckDictationPhase(): DeckDictationPhase {
  if (opening) return 'starting'
  return dictationSeat()?.state().phase ?? 'idle'
}

export function useDeckDictation(): DeckDictationPhase {
  return useSyncExternalStore(subscribe, deckDictationPhase, deckDictationPhase)
}

export const deckDictationSupported = isDictationSupported

/** Throw the recording (or the wait for its words) away; over a review, Undo. Nothing is sent. */
export function cancelDeckDictation(): void {
  dictationSeat()?.cancel()
}

/** Undo the review countdown: no send, the words stay in the composer. */
export function undoDeckDictation(): void {
  dictationSeat()?.undo()
}

/**
 * Press D: start, or stop and send it to be written down. A press while the
 * words are on their way does nothing — a second tap of D's key must not
 * throw a sentence away. A press over a review records more, and the new
 * words join the ones waiting, as the phone's mic does.
 */
export function toggleDeckDictation(canStart: boolean): void {
  const seat = dictationSeat()
  if (!seat) return
  const phase = deckDictationPhase()
  if (phase === 'starting' || phase === 'recording') {
    seat.stop()
    return
  }
  if (phase === 'transcribing' || !canStart) return
  opening = true
  notify()
  void seat.start().finally(() => {
    opening = false
    notify()
  })
}
