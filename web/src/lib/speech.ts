import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

/**
 * Web Speech API dictation helper for Forge Web.
 *
 * Transcribes voice directly on the device using the browser's built-in
 * speech recognition engine (Chrome on Android/desktop, Safari on iOS/macOS,
 * Edge). No audio is sent to custom cloud sidecars or external third parties.
 */

export interface SpeechDictationOptions {
  onTranscript: (text: string) => void
  onError?: (message: string) => void
  onStateChange?: (listening: boolean) => void
}

interface SpeechRecognitionAlternative {
  readonly transcript: string
  readonly confidence: number
}

interface SpeechRecognitionResult {
  readonly isFinal: boolean
  readonly length: number
  [index: number]: SpeechRecognitionAlternative
}

interface SpeechRecognitionResultList {
  readonly length: number
  [index: number]: SpeechRecognitionResult
}

interface SpeechRecognitionEventLike {
  readonly resultIndex: number
  readonly results: SpeechRecognitionResultList
}

interface SpeechRecognitionErrorEventLike {
  readonly error: string
  readonly message?: string
}

interface SpeechRecognitionLike extends EventTarget {
  continuous: boolean
  interimResults: boolean
  lang: string
  start(): void
  stop(): void
  abort(): void
  onresult: ((event: SpeechRecognitionEventLike) => void) | null
  onerror: ((event: SpeechRecognitionErrorEventLike) => void) | null
  onend: (() => void) | null
}

type SpeechRecognitionConstructor = new () => SpeechRecognitionLike

export function getSpeechRecognitionConstructor(): SpeechRecognitionConstructor | null {
  if (typeof window === 'undefined') return null
  const w = window as unknown as {
    SpeechRecognition?: SpeechRecognitionConstructor
    webkitSpeechRecognition?: SpeechRecognitionConstructor
  }
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null
}

export function isSpeechRecognitionSupported(): boolean {
  return getSpeechRecognitionConstructor() !== null
}

export function useSpeechDictation({
  onTranscript,
  onError,
  onStateChange
}: SpeechDictationOptions) {
  const [listening, setListening] = useState(false)
  const recognitionRef = useRef<SpeechRecognitionLike | null>(null)
  const baseTextRef = useRef('')
  const supported = useMemo(() => isSpeechRecognitionSupported(), [])

  useEffect(() => {
    onStateChange?.(listening)
  }, [listening, onStateChange])

  useEffect(() => {
    return () => {
      if (recognitionRef.current) {
        try {
          recognitionRef.current.abort()
        } catch {
          // ignore
        }
        recognitionRef.current = null
      }
    }
  }, [])

  const stop = useCallback(() => {
    if (recognitionRef.current) {
      try {
        recognitionRef.current.stop()
      } catch {
        // ignore
      }
    }
    setListening(false)
  }, [])

  const start = useCallback(
    (currentDraft: string = '') => {
      const Ctor = getSpeechRecognitionConstructor()
      if (!Ctor) {
        onError?.('Voice dictation is not supported in this browser.')
        return
      }

      if (recognitionRef.current) {
        try {
          recognitionRef.current.abort()
        } catch {
          // ignore
        }
        recognitionRef.current = null
      }

      baseTextRef.current = currentDraft

      let rec: SpeechRecognitionLike
      try {
        rec = new Ctor()
      } catch (err) {
        onError?.(err instanceof Error ? err.message : 'Could not initialize microphone.')
        return
      }

      rec.continuous = true
      rec.interimResults = true
      rec.lang = typeof navigator !== 'undefined' && navigator.language ? navigator.language : 'en-US'

      rec.onresult = (e: SpeechRecognitionEventLike) => {
        let speech = ''
        for (let i = 0; i < e.results.length; i++) {
          const item = e.results[i]
          if (item && item[0]) {
            speech += item[0].transcript
          }
        }

        const base = baseTextRef.current.trimEnd()
        const spoken = speech.trimStart()
        const full = base ? (spoken ? `${base} ${spoken}` : base) : spoken
        onTranscript(full)
      }

      rec.onerror = (e: SpeechRecognitionErrorEventLike) => {
        if (e.error === 'not-allowed') {
          onError?.('Microphone access was blocked. Please allow microphone permissions in your browser.')
        } else if (e.error === 'network') {
          onError?.('Speech recognition network error.')
        } else if (e.error !== 'no-speech' && e.error !== 'aborted') {
          onError?.(`Voice recognition error: ${e.error}`)
        }
      }

      rec.onend = () => {
        recognitionRef.current = null
        setListening(false)
      }

      try {
        rec.start()
        recognitionRef.current = rec
        setListening(true)
      } catch (err) {
        onError?.(err instanceof Error ? err.message : 'Could not start voice recognition.')
        setListening(false)
      }
    },
    [onError, onTranscript]
  )

  const toggle = useCallback(
    (currentDraft: string = '') => {
      if (listening) {
        stop()
      } else {
        start(currentDraft)
      }
    },
    [listening, start, stop]
  )

  return {
    supported,
    listening,
    start,
    stop,
    toggle
  }
}
