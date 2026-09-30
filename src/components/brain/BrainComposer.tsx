import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { BRAIN_SEND_MAX } from '@shared/brain'
import { barDictationSink, setBarDictationSink, useBarDictationPhase, type BarDictationSink } from '@/lib/barDictation'
import { useDictation } from '@/state/Dictation'
import { Icon } from '../Icon'
import { sendToBrain } from './brainStore'

/**
 * The drop-down's text box: type and Enter (Shift+Enter for a new line), or
 * the mic — Forge's own desktop dictation, with whatever speech engine
 * Settings picks. The mic's words land in this box, wait a moment with Undo
 * (Esc undoes too), then send; the brain's answer to a spoken message is read
 * aloud (BrainButton). The Dictate key works here as everywhere: its words go
 * where the cursor is.
 *
 * The mic borrows the voice bar's dictation sink (lib/barDictation) for the
 * one dictation it starts, and hands it straight back when that ends.
 *
 * As WhatsApp: an empty box shows the mic, words in it show Send.
 */

/** How long dictated words wait, with Undo, before they send — the voice bar's. */
const REVIEW_MS = 1500
const MAX_ROWS_PX = 120

export function BrainComposer({ disabled, placeholder }: { disabled?: boolean; placeholder: string }): ReactNode {
  const [text, setText] = useState('')
  const fieldRef = useRef<HTMLTextAreaElement | null>(null)
  const textRef = useRef(text)
  textRef.current = text

  const dictation = useDictation()
  const barPhase = useBarDictationPhase()
  const [mic, setMic] = useState(false)
  const release = useRef<(() => void) | null>(null)
  const heard = useRef(false)
  const [review, setReview] = useState<number | null>(null)
  const reviewTimer = useRef(0)

  const recording = mic && barPhase !== 'off'
  const transcribing = mic && !recording && dictation.status.phase === 'finishing'
  const armed = mic && barPhase === 'armed'

  // Grow with the words, up to a few lines.
  useLayoutEffect(() => {
    const el = fieldRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(MAX_ROWS_PX, el.scrollHeight)}px`
  }, [text])

  useEffect(() => {
    if (!disabled) fieldRef.current?.focus()
  }, [disabled])

  const send = (spoken = false): void => {
    const words = textRef.current.trim()
    if (!words || words.length > BRAIN_SEND_MAX) return
    if (sendToBrain(words, spoken)) setText('')
    fieldRef.current?.focus()
  }

  /* ------------------------------------------------------------- the mic */

  const giveBack = (): void => {
    release.current?.()
    release.current = null
  }

  const startReview = (): void => {
    window.clearTimeout(reviewTimer.current)
    setReview(Date.now() + REVIEW_MS)
    reviewTimer.current = window.setTimeout(() => {
      setReview(null)
      send(true)
    }, REVIEW_MS)
  }
  const startReviewRef = useRef(startReview)
  startReviewRef.current = startReview

  const undo = (): void => {
    window.clearTimeout(reviewTimer.current)
    setReview(null)
    fieldRef.current?.focus()
  }

  const toggleMic = (): void => {
    if (mic) {
      // A press while it records stops it; its words then send.
      dictation.dictateIntoBar()
      return
    }
    undo()
    const before = barDictationSink()
    heard.current = false
    const mine: BarDictationSink = {
      phrase: (words) => {
        heard.current = true
        setText((prev) => (prev.trim() ? `${prev.replace(/\s+$/, '')} ${words}` : words))
      },
      done: (ok) => {
        giveBack()
        setMic(false)
        if (ok && heard.current) startReviewRef.current()
      },
      ownsField: (el) => el === fieldRef.current,
      sendKeyWords: (landing) => before?.sendKeyWords(landing)
    }
    const off = setBarDictationSink(mine)
    release.current = () => {
      off()
      if (before && barDictationSink() === null) setBarDictationSink(before)
    }
    setMic(true)
    dictation.dictateIntoBar()
  }

  // A dictation refused at the start (a setup problem) never reaches `done`.
  useEffect(() => {
    if (mic && dictation.status.phase === 'error') {
      giveBack()
      setMic(false)
    }
  }, [mic, dictation.status.phase])

  // Shut mid-dictation: the sink goes back, the timer stops.
  useEffect(
    () => () => {
      giveBack()
      window.clearTimeout(reviewTimer.current)
    },
    []
  )

  // Esc undoes the countdown, and only that — the drop-down stays open.
  useEffect(() => {
    if (review === null) return undefined
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      e.preventDefault()
      e.stopImmediatePropagation()
      undo()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [review])

  const long = text.length > BRAIN_SEND_MAX
  const hasWords = text.trim().length > 0 && !mic
  const word = armed ? 'Getting the mic ready…' : recording ? 'Listening… press the mic to stop' : transcribing ? 'Writing it down…' : null

  return (
    <div className="braincomp" data-mic={recording ? 'live' : undefined}>
      {review !== null ? (
        <div className="braincomp__review" role="status">
          <span className="braincomp__review-bar" style={{ animationDuration: `${REVIEW_MS}ms` }} aria-hidden="true" />
          <span>Sending…</span>
          <button type="button" onClick={undo}>
            Undo <kbd>Esc</kbd>
          </button>
        </div>
      ) : null}
      {long ? <p className="braincomp__long">Too long — the brain takes {BRAIN_SEND_MAX} characters, this is {text.length}.</p> : null}
      <div className="braincomp__row">
        <textarea
          ref={fieldRef}
          className="braincomp__field"
          rows={1}
          value={text}
          disabled={disabled}
          placeholder={word ?? placeholder}
          aria-label="Message Forge Brain"
          onChange={(e) => {
            setText(e.target.value)
            if (review !== null) undo()
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault()
              window.clearTimeout(reviewTimer.current)
              setReview(null)
              send()
            }
          }}
        />
        <button
          type="button"
          className="braincomp__btn"
          data-look={hasWords ? 'send' : recording ? 'rec' : transcribing || armed ? 'busy' : 'mic'}
          disabled={disabled || (hasWords && long)}
          aria-label={hasWords ? 'Send' : recording ? 'Stop dictating' : 'Dictate'}
          aria-pressed={hasWords ? undefined : recording}
          title={
            hasWords
              ? 'Send (Enter)'
              : recording
                ? 'Recording — press to stop; the words go in the box, then send'
                : 'Dictate — press, talk, press again. The reply is read aloud.'
          }
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => (hasWords ? send() : toggleMic())}
        >
          <span key={hasWords ? 'send' : recording ? 'rec' : 'mic'} className="braincomp__glyph" aria-hidden="true">
            {hasWords ? (
              <Icon name="send" size={16} />
            ) : recording ? (
              <span className="braincomp__stop" />
            ) : transcribing || armed ? (
              <svg className="braincomp__turn" width="16" height="16" viewBox="0 0 18 18">
                <path d="M9 2.5A6.5 6.5 0 1 1 2.5 9" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
              </svg>
            ) : (
              <Icon name="mic" size={17} />
            )}
          </span>
        </button>
      </div>
    </div>
  )
}
