import { useEffect, useSyncExternalStore } from 'react'
import type { VoiceState } from './dictate'

/**
 * One composer's dictation, lent to a control elsewhere on the page.
 *
 * The deck face's D button (web/src/deck/dictation.ts) runs the phone's whole
 * dictation — spoken commands, the review countdown with Undo, the send — by
 * driving the deck's own SessionComposer, not a second copy of that logic. The
 * composer lends its mic here; the phone's composer never does.
 */
export interface DictationSeat {
  /** A press on an idle mic. Resolves once the microphone is open, or refused. */
  start: () => Promise<void>
  /** Stop and send to the desktop's ears: a command acts, other words go to review. */
  stop: () => void
  /** Throw the recording (or the wait for its words) away; over a review, Undo. */
  cancel: () => void
  /** Stop the review countdown; the words stay in the box to edit. */
  undo: () => void
  /** Where the dictation is now — read live, not as of the last render. */
  state: () => VoiceState
}

let seat: DictationSeat | null = null
const listeners = new Set<() => void>()

function notify(): void {
  listeners.forEach((fn) => fn())
}

export function subscribeDictationSeat(fn: () => void): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

/** The lent dictation, if a composer has lent one. */
export function dictationSeat(): DictationSeat | null {
  return seat
}

export function useDictationSeat(): DictationSeat | null {
  return useSyncExternalStore(subscribeDictationSeat, dictationSeat, dictationSeat)
}

/** Lend this composer's dictation while mounted; `null` lends nothing. */
export function useLendDictation(next: DictationSeat | null): void {
  useEffect(() => {
    if (!next) return undefined
    seat = next
    notify()
    return () => {
      if (seat !== next) return
      seat = null
      notify()
    }
  }, [next])
}
