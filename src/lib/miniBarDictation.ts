/**
 * Dictation while Forge is minimised (docs/MINI-BAR.md, 4.4): every phrase,
 * from a talk key or the mini bar's mic, goes into the mini bar's box,
 * because that box is the only cursor Steve can see. Then the big bar's mic
 * flow: "Sending..." for 1.5 s with Undo, then the box's send.
 *
 * Two halves meet here, the way src/lib/barDictation.ts joins the engine and
 * the big bar:
 *
 *   sink   src/state/minibar/voice.ts, while the mini bar is up: takes the
 *          phrases and runs the countdown. useDictation's engine hands it
 *          every phrase and the end of every session.
 *   box    the mini bar host (src/state/MiniBarHost.tsx): the box's words as
 *          the host holds them, and its send.
 *
 * Both are needed. With either missing, `miniDictationSink()` is null and
 * dictation does exactly what it does with Forge up.
 */

export interface MiniDictationSink {
  /** A dictation is starting: `fromMic` when the mini bar's mic started it, else a talk key. */
  start: (fromMic: boolean) => void
  /** One finished phrase. */
  phrase: (text: string) => void
  /** The sidecar is back at rest (or failed): every phrase is in. A rest with no session behind it is ignored. */
  done: (ok: boolean) => void
}

export interface MiniBox {
  /** The box's words as the host has them now. */
  text: () => string
  /** Put these words in the box (published, so the view shows them). */
  setText: (text: string) => void
  /** Send these words to the mini bar's target, as the box's Enter does. */
  send: (text: string) => void
}

let sink: MiniDictationSink | null = null
let box: MiniBox | null = null

/** The mini bar takes the phrases, or null when dictation goes where it always goes. */
export function miniDictationSink(): MiniDictationSink | null {
  return sink && box ? sink : null
}

/** voice.ts takes the phrases while the mini bar is up. Returns the release. */
export function setMiniDictationSink(next: MiniDictationSink): () => void {
  sink = next
  return () => {
    if (sink === next) sink = null
  }
}

export function miniBox(): MiniBox | null {
  return box
}

/** The host lends the box while the mini bar is up. Returns the release. */
export function setMiniBox(next: MiniBox): () => void {
  box = next
  return () => {
    if (box === next) box = null
  }
}
