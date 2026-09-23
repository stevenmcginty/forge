import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { isYesNo, offersYesNo, readAsk, type ParsedAsk } from '../lib/answer-options'
import './AnswerCard.css'

/**
 * The question an asking pane is waiting on, with one big button per answer.
 *
 * Docked above the composer in every face — Chat, Cards and Terminal — so a
 * permission prompt is one tap from the phone rather than a trip into the
 * terminal and a hunt for ↑/↓. The words come off the `attention` push, which
 * the desktop flattens and caps at 200 characters; the pane's own screen is
 * read as well (see `registerAnswerScreen`) because it still has the menu
 * whole. A question with no menu to find gets Yes and No: a bare `y` or `n` for
 * a shell's `[y/N]`, and otherwise the word itself, typed and sent the way the
 * composer sends a message — the question is the agent's own prose, and its
 * input box is where the answer goes.
 *
 * A choice is the digit key where the CLI takes one — Claude Code's and Gemini
 * CLI's select lists pick the numbered row on its digit — and arrows from the
 * cursor row then Enter everywhere else, which every list takes.
 *
 * Standalone on purpose: it knows nothing about the composer it sits over, so
 * the dock can move without it.
 */

/** How long a tap waits for the question to go before the buttons come back. */
const SENT_RETRY_MS = 4000
/** The gap between arrow presses while walking to a row. */
const SETTLE_BETWEEN_KEYS_MS = 80
/** The gap between the last arrow and the Enter that picks the row. */
const SETTLE_BEFORE_ENTER_MS = 120
/** A reply to a question with no menu. See `plainReplies`. */
export interface PlainReply {
  label: string
  keys: string[]
}

/**
 * Yes and No for a question with no menu.
 *
 * A `[y/N]` is a shell's line prompt, which takes the letter. Anything else is
 * an agent asking in prose — "Do you want me to commit the DeepSeek work?" —
 * whose answer is a message: the word, then Enter as its own keystroke a beat
 * later, which is how `sendAnswerKeys` spaces a final `\r` and how the
 * composer sends one. Enter or Esc on their own answered nothing there.
 */
export function plainReplies(question: string): PlainReply[] {
  const [yes, no] = isYesNo(question) ? ['y', 'n'] : ['yes', 'no']
  return [
    { label: 'Yes', keys: [yes, '\r'] },
    { label: 'No', keys: [no, '\r'] }
  ]
}

/** How much of the screen's bottom is worth reading for a menu. */
export const SCREEN_TAIL_LINES = 60

const UP = '\x1b[A'
const DOWN = '\x1b[B'

const pause = (ms: number): Promise<void> => new Promise((resolve) => window.setTimeout(resolve, ms))

/* ------------------------------------------------------ the screen, by pane */

/**
 * Each pane's screen, as plain rows, for the card to read.
 *
 * The terminal lives in PaneView and the card sits over the composer, which is
 * not in that pane's tree — the same distance lib/pane-status.ts bridges for
 * the status strip. A reader rather than a copy, so the rows are read the
 * moment the card wants them and cost nothing the rest of the time.
 */
const screens = new Map<string, () => string[]>()

export function registerAnswerScreen(paneId: string, read: () => string[]): () => void {
  screens.set(paneId, read)
  return () => {
    if (screens.get(paneId) === read) screens.delete(paneId)
  }
}

function readScreen(paneId: string): string[] {
  try {
    return screens.get(paneId)?.() ?? []
  } catch {
    return []
  }
}

/**
 * The question `paneId` is asking, read the way the card reads it: the pushed
 * prompt and the pane's own screen, the fuller of the two. For a spoken
 * answer ("option two"), which has to find the same rows the buttons show.
 */
export function readPaneAsk(paneId: string, prompt: string): ParsedAsk {
  return readAsk(prompt, readScreen(paneId))
}

/** The keys that land on option `index` (0-based) of `ask`'s menu. */
export function answerKeys(ask: ParsedAsk, index: number, digits: boolean): string[] {
  if (digits) return [String(ask.options[index]!.n)]
  const moves = index - ask.cursor
  const arrow = moves < 0 ? UP : DOWN
  return [...Array.from({ length: Math.abs(moves) }, () => arrow), '\r']
}

/** Write an answer's keys a beat apart — arrows, then Enter a longer beat after. */
export async function sendAnswerKeys(keys: string[], write: (data: string) => void): Promise<void> {
  for (let i = 0; i < keys.length; i++) {
    if (i > 0) await pause(i === keys.length - 1 && keys[i] === '\r' ? SETTLE_BEFORE_ENTER_MS : SETTLE_BETWEEN_KEYS_MS)
    write(keys[i]!)
  }
}

/* ------------------------------------------------------------------ the card */

export function AnswerCard({
  paneId,
  agentName,
  prompt,
  digits,
  live,
  onWrite,
  onShowTerminal
}: {
  paneId: string
  /** Who is asking — "Claude Code". */
  agentName: string
  /** The desktop's flattened question; may be empty. */
  prompt: string
  /** Whether this CLI's menus pick a row on its digit key. */
  digits: boolean
  /** False while nothing can be sent: the buttons stay, and go quiet. */
  live: boolean
  /** One write down the pane's PTY, the same road the composer's keys take. */
  onWrite: (data: string) => void
  /** Absent when the terminal is already the face on screen. */
  onShowTerminal?: () => void
}): ReactNode {
  // The screen is read when the card appears and once more a beat later: the
  // push that raised the question can land before this browser's copy of the
  // terminal has painted the menu it is asking with.
  const [screen, setScreen] = useState<string[]>(() => readScreen(paneId))
  useEffect(() => {
    const id = window.setTimeout(() => setScreen(readScreen(paneId)), 400)
    return () => window.clearTimeout(id)
  }, [paneId])
  const ask = useMemo(() => readAsk(prompt, screen), [prompt, screen])

  const [sent, setSent] = useState(false)
  const retry = useRef(0)
  useEffect(() => () => window.clearTimeout(retry.current), [])

  const choose = async (keys: string[]): Promise<void> => {
    if (sent || !live) return
    try {
      navigator.vibrate?.(10)
    } catch {
      // A browser that refuses to buzz still sends the answer.
    }
    setSent(true)
    window.clearTimeout(retry.current)
    // Still asking after this long means the keys did not land where they were
    // meant to — give the buttons back rather than leave a dead card.
    retry.current = window.setTimeout(() => setSent(false), SENT_RETRY_MS)
    await sendAnswerKeys(keys, onWrite)
  }

  /** The keys that land on option `index` (0-based) of the parsed menu. */
  const keysFor = (index: number): string[] => answerKeys(ask, index, digits)

  const question = ask.question || prompt.trim() || `${agentName} needs an answer.`
  const disabled = sent || !live
  /** Prose wants a reply in words, so the hint offers typing one as well. */
  const prose = !ask.options.length && !isYesNo(question)
  /** "What should I do instead?" gets no buttons: only words answer it. */
  const replies = ask.options.length || !offersYesNo(question) ? [] : plainReplies(question)
  const buttons = ask.options.length > 0 || replies.length > 0

  return (
    <section className="answer" aria-label={`${agentName} is asking`} data-sent={sent ? 'true' : undefined}>
      <div className="answer__eyebrow">
        <span className="answer__bang" aria-hidden="true">
          !
        </span>
        <span>{agentName} is asking</span>
      </div>
      <p className="answer__question">{question}</p>
      {buttons ? (
        <div className="answer__options" role="group" aria-label="Answers">
          {ask.options.length
            ? ask.options.map((option, index) => (
                <button
                  key={option.n}
                  type="button"
                  className="answer__option"
                  disabled={disabled}
                  onClick={() => void choose(keysFor(index))}
                >
                  <span className="answer__digit" aria-hidden="true">
                    {option.n}
                  </span>
                  <span className="answer__label">{option.label}</span>
                </button>
              ))
            : replies.map((reply) => (
                <button
                  key={reply.label}
                  type="button"
                  className="answer__option"
                  disabled={disabled}
                  onClick={() => void choose(reply.keys)}
                >
                  <span className="answer__label">{reply.label}</span>
                </button>
              ))}
        </div>
      ) : null}
      {sent ? (
        <p className="answer__sent" role="status">
          Sent — waiting for {agentName}
        </p>
      ) : null}
      <div className="answer__foot">
        {onShowTerminal ? (
          <button type="button" className="answer__terminal" onClick={onShowTerminal}>
            Show terminal
          </button>
        ) : null}
        <span className="answer__hint">
          {!buttons ? 'Type or say your reply' : prose ? 'or type / say your reply' : 'or say your answer'}
        </span>
      </div>
    </section>
  )
}
