import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { readAsk } from '../lib/answer-options'
import './AnswerCard.css'

/**
 * The question an asking pane is waiting on, with one big button per answer.
 *
 * Docked above the composer in every face — Chat, Cards and Terminal — so a
 * permission prompt is one tap from the phone rather than a trip into the
 * terminal and a hunt for ↑/↓. The words come off the `attention` push, which
 * the desktop flattens and caps at 200 characters; the pane's own screen is
 * read as well (see `registerAnswerScreen`) because it still has the menu
 * whole. A question with no menu to find gets Yes and No, which are Enter and
 * Esc on every TUI Forge runs.
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
    for (let i = 0; i < keys.length; i++) {
      if (i > 0) await pause(i === keys.length - 1 && keys[i] === '\r' ? SETTLE_BEFORE_ENTER_MS : SETTLE_BETWEEN_KEYS_MS)
      onWrite(keys[i]!)
    }
  }

  /** The keys that land on option `index` (0-based) of the parsed menu. */
  const keysFor = (index: number): string[] => {
    if (digits) return [String(ask.options[index]!.n)]
    const moves = index - ask.cursor
    const arrow = moves < 0 ? UP : DOWN
    return [...Array.from({ length: Math.abs(moves) }, () => arrow), '\r']
  }

  const question = ask.question || prompt.trim() || `${agentName} needs an answer.`
  const disabled = sent || !live

  return (
    <section className="answer" aria-label={`${agentName} is asking`} data-sent={sent ? 'true' : undefined}>
      <div className="answer__eyebrow">
        <span className="answer__bang" aria-hidden="true">
          !
        </span>
        <span>{agentName} is asking</span>
      </div>
      <p className="answer__question">{question}</p>
      <div className="answer__options" role="group" aria-label="Answers">
        {ask.options.length ? (
          ask.options.map((option, index) => (
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
        ) : (
          <>
            <button type="button" className="answer__option" disabled={disabled} onClick={() => void choose(['\r'])}>
              <span className="answer__label">Yes (Enter)</span>
            </button>
            <button type="button" className="answer__option" disabled={disabled} onClick={() => void choose(['\x1b'])}>
              <span className="answer__label">No (Esc)</span>
            </button>
          </>
        )}
      </div>
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
        <span className="answer__hint">or say your answer</span>
      </div>
    </section>
  )
}
