import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Icon } from '@/components/Icon'
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

/**
 * How long a tap waits for the question to go before "Send again" is offered.
 * The buttons never come back on their own: an agent slow to repaint would
 * otherwise take the same digit twice, the second into its next prompt.
 */
const SENT_RETRY_MS = 4000
/** How many rows of the thing being approved show before it is opened. */
const CONTEXT_FOLD_ROWS = 6
/** "  13 -  padding: 12px;" — a diff row, by the sign after its line number. */
const DIFF_ROW = /^\s*\d+\s+([+-])(?=\s|$)/
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

/**
 * How much of the screen's bottom is worth reading for a menu — and for the
 * plan or diff drawn above it, which is why it is more than a menu needs.
 */
export const SCREEN_TAIL_LINES = 120

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
  // A pick from the agent's own prose is a message: the number, then Enter.
  if (ask.typed) return [String(ask.options[index]!.n), '\r']
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

  /**
   * The answer tapped, kept until the question goes — which takes this card
   * with it, since a new question is a new card. `stale` is the question
   * outliving SENT_RETRY_MS, when "Send again" is offered instead.
   */
  const [sent, setSent] = useState<{ id: string; keys: string[] } | null>(null)
  const [stale, setStale] = useState(false)
  const retry = useRef(0)
  useEffect(() => () => window.clearTimeout(retry.current), [])

  const send = async (keys: string[]): Promise<void> => {
    try {
      navigator.vibrate?.(10)
    } catch {
      // A browser that refuses to buzz still sends the answer.
    }
    setStale(false)
    window.clearTimeout(retry.current)
    // Still asking after this long may mean the keys did not land — or only
    // that the agent is slow to repaint, so nothing is re-armed by itself.
    retry.current = window.setTimeout(() => setStale(true), SENT_RETRY_MS)
    await sendAnswerKeys(keys, onWrite)
  }

  const choose = async (id: string, keys: string[]): Promise<void> => {
    if (sent || !live) return
    setSent({ id, keys })
    await send(keys)
  }

  /** The same keys once more, on an explicit tap. */
  const again = async (): Promise<void> => {
    if (!sent || !stale || !live) return
    await send(sent.keys)
  }

  /** The keys that land on option `index` (0-based) of the parsed menu. */
  const keysFor = (index: number): string[] => answerKeys(ask, index, digits)

  const question = ask.question || prompt.trim() || `${agentName} needs an answer.`
  const disabled = sent !== null || !live
  /** Prose wants a reply in words, so the hint offers typing one as well. */
  const prose = ask.typed || (!ask.options.length && !isYesNo(question))
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
      {ask.context ? <AskContext rows={ask.context} /> : null}
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
                  data-picked={sent?.id === `n${option.n}` ? 'true' : undefined}
                  onClick={() => void choose(`n${option.n}`, keysFor(index))}
                >
                  <span className="answer__digit" aria-hidden="true">
                    {option.n}
                  </span>
                  <span className="answer__text">
                    <span className="answer__label">{option.label}</span>
                    {option.detail ? <span className="answer__detail">{option.detail}</span> : null}
                  </span>
                  {sent?.id === `n${option.n}` ? <Picked /> : null}
                </button>
              ))
            : replies.map((reply) => (
                <button
                  key={reply.label}
                  type="button"
                  className="answer__option"
                  disabled={disabled}
                  data-picked={sent?.id === reply.label ? 'true' : undefined}
                  onClick={() => void choose(reply.label, reply.keys)}
                >
                  <span className="answer__text">
                    <span className="answer__label">{reply.label}</span>
                  </span>
                  {sent?.id === reply.label ? <Picked /> : null}
                </button>
              ))}
        </div>
      ) : null}
      {sent ? (
        <div className="answer__sent">
          <p className="answer__sent-text" role="status">
            {stale ? `Still waiting for ${agentName}` : `Sent — waiting for ${agentName}`}
          </p>
          {stale ? (
            <button
              type="button"
              className="answer__again"
              aria-label="Send again"
              title="Send again"
              disabled={!live}
              onClick={() => void again()}
            >
              <Icon name="refresh" size={20} />
            </button>
          ) : null}
        </div>
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

/** The tapped row's mark: a shape, so "this one went" never rests on the dimming alone. */
function Picked(): ReactNode {
  return (
    <span className="answer__picked" role="img" aria-label="Sent">
      <Icon name="check" size={18} />
    </span>
  )
}

/**
 * What is being approved — the diff, the plan, the command — in the terminal's
 * own mono, folded to CONTEXT_FOLD_ROWS rows until the chevron opens it. A diff
 * row's +/- is repeated in a gutter at the row's start, so an added line and a
 * removed one differ by a character, and the tint is only a second cue.
 */
function AskContext({ rows }: { rows: string[] }): ReactNode {
  const [open, setOpen] = useState(false)
  const folds = rows.length > CONTEXT_FOLD_ROWS
  const shown = open || !folds ? rows : rows.slice(0, CONTEXT_FOLD_ROWS)
  const diff = rows.some((row) => DIFF_ROW.test(row))
  return (
    <div className="answer__context" data-open={open ? 'true' : undefined}>
      <pre className="answer__code" data-gutter={diff ? 'true' : undefined}>
        {shown.map((row, index) => {
          const sign = DIFF_ROW.exec(row)?.[1]
          return (
            <span
              key={index}
              className="answer__row"
              data-diff={sign === '+' ? 'add' : sign === '-' ? 'del' : undefined}
            >
              {diff ? (
                <span className="answer__sign" aria-hidden="true">
                  {sign ?? ' '}
                </span>
              ) : null}
              {row || ' '}
            </span>
          )
        })}
      </pre>
      {folds ? (
        <button
          type="button"
          className="answer__more"
          aria-expanded={open}
          aria-label={open ? 'Show less' : `Show all ${rows.length} lines`}
          title={open ? 'Show less' : `Show all ${rows.length} lines`}
          onClick={() => setOpen((value) => !value)}
        >
          <Icon name="chevronDown" size={18} />
        </button>
      ) : null}
    </div>
  )
}
