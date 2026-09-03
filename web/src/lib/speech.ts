import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

/**
 * Voice for the browser — the page's own speech recognition, not the desktop's.
 *
 * Decision 7 in docs/forge-web.md kept dictation out of Forge Web because a
 * browser tab has no microphone worth plumbing back to the PC. It still does
 * not: the Parakeet sidecar, the wake word and the voice agent stay on the
 * desktop. What this is instead is the Web Speech API — Chrome, Edge and
 * Safari each ship a recogniser, and it turns a spoken sentence into words in
 * the composer's box with nothing crossing the tunnel that a typed sentence
 * would not. Firefox has none, and `supported` says so up front.
 *
 * The recogniser is a fussy thing to hold open. Chrome ends a session on its
 * own after a stretch of silence or about a minute of speech, Android ends it
 * after every phrase, and every one of those comes through `onend` looking the
 * same as the user pressing stop. `wanted` is the one truth this hook keeps:
 * while it is true an `onend` is restarted, and `stop()` clears it before
 * hanging up so the restart stands down.
 *
 * Results arrive twice — as interim guesses that are rewritten as you speak,
 * then once as final — and the two callbacks keep that distinction so the
 * composer can paint the guess without committing to it.
 */

/* --------------------------------------------------------- the DOM types */

/*
 * TypeScript's DOM lib still has no SpeechRecognition, so the slice this file
 * uses is declared here. Only what is called — not the whole spec.
 */
interface RecognitionAlternative {
  transcript: string
}
interface RecognitionResult {
  isFinal: boolean
  readonly length: number
  [index: number]: RecognitionAlternative
}
interface RecognitionResultList {
  readonly length: number
  [index: number]: RecognitionResult
}
interface RecognitionResultEvent extends Event {
  resultIndex: number
  results: RecognitionResultList
}
interface RecognitionErrorEvent extends Event {
  error: string
  message?: string
}
interface Recognition extends EventTarget {
  lang: string
  continuous: boolean
  interimResults: boolean
  maxAlternatives: number
  start(): void
  stop(): void
  abort(): void
  onresult: ((event: RecognitionResultEvent) => void) | null
  onerror: ((event: RecognitionErrorEvent) => void) | null
  onend: (() => void) | null
  onstart: (() => void) | null
}
type RecognitionCtor = new () => Recognition

function recognitionCtor(): RecognitionCtor | null {
  if (typeof window === 'undefined') return null
  const w = window as unknown as { SpeechRecognition?: RecognitionCtor; webkitSpeechRecognition?: RecognitionCtor }
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null
}

/** Does this browser have a recogniser at all? Read once; it does not change. */
export const SPEECH_SUPPORTED = recognitionCtor() !== null

/** What a recogniser failure means to the person in front of it. */
export function speechErrorMessage(code: string): string {
  switch (code) {
    case 'not-allowed':
    case 'service-not-allowed':
      return 'Microphone blocked — allow it for this site in the address bar, then try again.'
    case 'audio-capture':
      return 'No microphone found on this computer.'
    case 'network':
      return 'Speech recognition needs the network, and it could not reach it.'
    case 'language-not-supported':
      return 'Speech recognition does not know this language.'
    case 'unsupported':
      return 'This browser has no speech recognition. Chrome, Edge or Safari do.'
    default:
      return 'Speech recognition stopped unexpectedly.'
  }
}

/*
 * Errors after which restarting is pointless — the microphone is refused or
 * missing, and asking again every second is a prompt storm, not persistence.
 */
const FATAL = new Set(['not-allowed', 'service-not-allowed', 'audio-capture', 'language-not-supported'])

/** Chrome fires `no-speech` after ~8s of silence and ends; that is a restart, not a failure. */
const QUIET = new Set(['no-speech', 'aborted'])

export interface Speech {
  supported: boolean
  listening: boolean
  /** The last failure, in the user's words; cleared on the next start. */
  error: string | null
  start(): void
  stop(): void
  toggle(): void
}

export function useSpeech({
  onInterim,
  onFinal,
  lang
}: {
  /** The recogniser's current guess for the phrase in flight. Empty once it is final. */
  onInterim: (text: string) => void
  /** A phrase the recogniser has settled on. */
  onFinal: (text: string) => void
  /** BCP 47; the page's language when absent. */
  lang?: string
}): Speech {
  const [listening, setListening] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const rec = useRef<Recognition | null>(null)
  const wanted = useRef(false)
  const restartTimer = useRef(0)
  const interimRef = useRef(onInterim)
  const finalRef = useRef(onFinal)
  interimRef.current = onInterim
  finalRef.current = onFinal

  const hangUp = useCallback(() => {
    window.clearTimeout(restartTimer.current)
    const r = rec.current
    rec.current = null
    if (!r) return
    r.onresult = null
    r.onerror = null
    r.onend = null
    r.onstart = null
    try {
      r.abort()
    } catch {
      /* already closed */
    }
  }, [])

  const open = useCallback((): void => {
    const Ctor = recognitionCtor()
    if (!Ctor) {
      setError(speechErrorMessage('unsupported'))
      wanted.current = false
      return
    }
    hangUp()
    const r = new Ctor()
    r.lang = lang ?? (typeof navigator !== 'undefined' ? navigator.language : 'en-GB')
    r.continuous = true
    r.interimResults = true
    r.maxAlternatives = 1
    r.onstart = () => setListening(true)
    r.onresult = (event) => {
      let interim = ''
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i]
        if (!result) continue
        const text = result[0]?.transcript ?? ''
        if (result.isFinal) finalRef.current(text.trim())
        else interim += text
      }
      interimRef.current(interim.trim())
    }
    r.onerror = (event) => {
      if (QUIET.has(event.error)) return
      setError(speechErrorMessage(event.error))
      if (FATAL.has(event.error)) wanted.current = false
    }
    r.onend = () => {
      // Any guess still on screen is not coming back as a final now.
      interimRef.current('')
      if (rec.current !== r) return
      if (!wanted.current) {
        rec.current = null
        setListening(false)
        return
      }
      // The browser hung up on its own; the person did not. Back in a beat —
      // immediately re-entering `start()` from inside `onend` is what Chrome
      // answers with `InvalidStateError`.
      window.clearTimeout(restartTimer.current)
      restartTimer.current = window.setTimeout(() => {
        if (wanted.current) open()
      }, 250)
    }
    rec.current = r
    try {
      r.start()
    } catch {
      // Two starts in flight, or a recogniser that died between construction
      // and start. Let the person try again rather than spinning.
      wanted.current = false
      rec.current = null
      setListening(false)
      setError(speechErrorMessage('unknown'))
    }
  }, [hangUp, lang])

  const start = useCallback(() => {
    if (wanted.current) return
    setError(null)
    wanted.current = true
    open()
  }, [open])

  const stop = useCallback(() => {
    wanted.current = false
    interimRef.current('')
    hangUp()
    setListening(false)
    // Stop is also how a failure is dismissed; the next start clears it too.
    setError(null)
  }, [hangUp])

  const toggle = useCallback(() => {
    if (wanted.current) stop()
    else start()
  }, [start, stop])

  useEffect(
    () => () => {
      wanted.current = false
      hangUp()
    },
    [hangUp]
  )

  return useMemo(
    () => ({ supported: SPEECH_SUPPORTED, listening, error, start, stop, toggle }),
    [listening, error, start, stop, toggle]
  )
}

/**
 * Words joined the way a sentence is: one space between, none at the edges,
 * and nothing added when either side is empty.
 */
export function joinSpoken(before: string, spoken: string): string {
  if (!spoken) return before
  if (!before) return spoken
  return /\s$/.test(before) ? before + spoken : `${before} ${spoken}`
}
