import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode
} from 'react'
import type { ChatBlock, ChatTurn } from '@shared/chat'
import { Icon } from '@/components/Icon'
import { renderMarkdown } from '../lib/markdown'
import './ChatView.css'

/**
 * The chat transcript — a Claude / agent session read as a conversation.
 *
 * Styled with the modern Gemini-inspired messenger layout:
 * - Two-sided conversation: user prompts in compact accent bubbles on the right,
 *   agent replies in soft left-aligned cards with the Gemini sparkle badge.
 * - Thinking traces are omitted so the conversation reads cleanly as text.
 * - Tool calls appear as compact, collapsible extension chips.
 * - Working / busy indicator sits on the left with an animated sparkle.
 */

/** How close to the end counts as "reading the latest". */
const STICK_PX = 96
/** A gist longer than this is worth an expand even without a result note. */
const GIST_FOLD = 64

export function ChatView({
  turns,
  truncated,
  busy,
  activity,
  quota,
  agentName
}: {
  turns: ChatTurn[]
  truncated: boolean
  busy?: boolean
  /**
   * What the agent says it is doing, off its own status line — "Thinking",
   * "Waiting for response". Labels the working indicator; "Thinking" without.
   */
  activity?: string
  /**
   * What is left of the agent's plan, as its TUI printed it (`Weekly limit
   * left: 3%`). Set for a pane whose chat is read off the screen, where the
   * footer that said so has been lifted away; shown as a quiet line under
   * the conversation rather than as a card in it.
   */
  quota?: string
  /** The name of the agent or model for reply headers (e.g. "Claude", "Gemini"). */
  agentName?: string
}): ReactNode {
  const scroller = useRef<HTMLDivElement | null>(null)
  const stick = useRef(true)
  // A finger on the transcript owns the scroll; nothing snaps under it.
  const touching = useRef(false)
  const [unseen, setUnseen] = useState(false)

  const lastId = turns.length ? turns[turns.length - 1]!.id : ''

  // Follow the bottom while the reader is there; otherwise leave them be and
  // raise the pill. Layout effect so the scroll lands before paint.
  useLayoutEffect(() => {
    const el = scroller.current
    if (!el) return
    if (stick.current && !touching.current) {
      el.scrollTop = el.scrollHeight
      setUnseen(false)
    } else if (turns.length) {
      setUnseen(true)
    }
  }, [turns, lastId, busy])

  // Heights settle after the turns do — fonts land, a chip opens, the box
  // above grows. While the reader is at the bottom, the bottom follows.
  useEffect(() => {
    const el = scroller.current
    const column = el?.firstElementChild
    if (!el || !column || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(() => {
      if (stick.current && !touching.current) el.scrollTop = el.scrollHeight
    })
    ro.observe(column)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const onScroll = useCallback(() => {
    const el = scroller.current
    if (!el) return
    if (touching.current) {
      stick.current = false
      return
    }
    const near = el.scrollHeight - el.scrollTop - el.clientHeight < STICK_PX
    stick.current = near
    if (near) setUnseen(false)
  }, [])

  const onTouchStart = useCallback(() => {
    touching.current = true
  }, [])

  const onTouchEnd = useCallback(() => {
    touching.current = false
    const el = scroller.current
    if (!el) return
    const near = el.scrollHeight - el.scrollTop - el.clientHeight < STICK_PX
    stick.current = near
    if (near) {
      el.scrollTop = el.scrollHeight
      setUnseen(false)
    } else if (turns.length) {
      setUnseen(true)
    }
  }, [turns.length])

  const jump = useCallback(() => {
    const el = scroller.current
    if (!el) return
    stick.current = true
    setUnseen(false)
    el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' })
  }, [])

  return (
    <div className="chatview">
      <div
        className="chatview__scroll"
        ref={scroller}
        onScroll={onScroll}
        onTouchStart={onTouchStart}
        onTouchEnd={onTouchEnd}
        onTouchCancel={onTouchEnd}
      >
        <div className="chatview__column">
          {truncated && turns.length ? (
            <div
              className="chatview__cut"
              role="note"
              title="The transcript was read mid-file — turns before this point exist on disk but are not shown."
            >
              <span className="chatview__cut-text">earlier history not shown</span>
            </div>
          ) : null}
          {turns.length === 0 ? (
            <div className="chatview__empty">
              <div className="chatview__empty-sparkle" aria-hidden="true">
                <Icon name="sparkle" size={26} />
              </div>
              <h3 className="chatview__empty-title">Ready when you are</h3>
              <p className="chatview__empty-sub">
                Ask a question, run commands, or describe what you want {agentName ? agentName : 'your agent'} to build.
              </p>
            </div>
          ) : (
            <ol className="chatview__turns">
              {turns.map((turn) => (
                <Turn key={turn.id} turn={turn} agentName={agentName} />
              ))}
            </ol>
          )}
          {busy ? <Working activity={activity} agentName={agentName} /> : null}
          {quota ? <Quota text={quota} /> : null}
        </div>
      </div>
      <button
        type="button"
        className="chatview__jump"
        data-show={unseen ? 'true' : 'false'}
        tabIndex={unseen ? 0 : -1}
        aria-hidden={!unseen}
        onClick={jump}
      >
        <svg
          width="14"
          height="14"
          viewBox="0 0 16 16"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden
        >
          <path d="M8 3v10M3.8 8.8L8 13l4.2-4.2" />
        </svg>
        Jump to latest
      </button>
    </div>
  )
}

/* ------------------------------------------------------------------- turns */

// Turns are immutable by id — the transcript only ever appends or resets — so
// a memo on the object is all 500 turns need to stay cheap.
const Turn = memo(function Turn({ turn, agentName }: { turn: ChatTurn; agentName?: string }): ReactNode {
  const [copied, setCopied] = useState(false)

  if (turn.role === 'user') {
    return (
      <li className="chatview__turn" data-role="user">
        <div className="chatview__mine">
          <div className="chatview__bubble">
            {turn.blocks.map((block, i) =>
              block.kind === 'text' ? (
                <p key={i} className="chatview__prompt">
                  {block.text}
                </p>
              ) : (
                <Piece key={i} block={block} />
              )
            )}
          </div>
          {turn.clock ? <span className="chatview__clock">{turn.clock}</span> : null}
        </div>
      </li>
    )
  }

  // Assistant turn: only render if there are text or tool blocks (if it is only thinking, it is handled by the Working indicator)
  const hasContent = turn.blocks.some((b) => b.kind === 'text' || b.kind === 'tool')
  if (!hasContent) return null

  const onCopy = () => {
    const text = turn.blocks
      .filter((b): b is Extract<ChatBlock, { kind: 'text' }> => b.kind === 'text')
      .map((b) => b.text)
      .join('\n\n')
    if (!text) return
    void navigator.clipboard?.writeText(text).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    })
  }

  return (
    <li className="chatview__turn" data-role="assistant">
      <div className="chatview__reply">
        <div className="chatview__agent-header">
          <span className="chatview__sparkle-icon" aria-hidden="true">
            <Icon name="sparkle" size={13} />
          </span>
          <span className="chatview__agent-name">{agentName ?? 'Assistant'}</span>
          {turn.clock ? <span className="chatview__agent-clock">{turn.clock}</span> : null}
          <button
            type="button"
            className="chatview__copy-btn"
            title="Copy message"
            aria-label="Copy message"
            onClick={onCopy}
          >
            <Icon name={copied ? 'check' : 'clipboard'} size={11} />
            <span>{copied ? 'Copied' : 'Copy'}</span>
          </button>
        </div>
        <div className="chatview__agent-bubble">
          {turn.blocks.map((block, i) => (
            <Piece key={i} block={block} />
          ))}
        </div>
      </div>
    </li>
  )
})

function Piece({ block }: { block: ChatBlock }): ReactNode {
  switch (block.kind) {
    case 'text':
      return <div className="chatview__prose">{renderMarkdown(block.text)}</div>
    case 'thinking':
      return block.text ? <ThoughtChip text={block.text} /> : null
    case 'tool':
      return <ToolChip name={block.name} gist={block.gist} note={block.note} failed={block.failed} />
  }
}

function ThoughtChip({ text }: { text: string }): ReactNode {
  const [open, setOpen] = useState(false)
  return (
    <div className="chatview__thought" data-open={open ? 'true' : 'false'}>
      <button
        type="button"
        className="chatview__thought-head"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        <span className="chatview__thought-caret" aria-hidden>
          <svg
            width="9"
            height="9"
            viewBox="0 0 16 16"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M6 3.5L10.5 8 6 12.5" />
          </svg>
        </span>
        <span className="chatview__thought-icon" aria-hidden="true">
          <Icon name="sparkle" size={11} />
        </span>
        <span className="chatview__thought-label">{open ? 'Thinking process' : 'Thought for a moment'}</span>
      </button>
      {open ? <div className="chatview__thought-body">{text}</div> : null}
    </div>
  )
}

/* -------------------------------------------------------------- tool chips */

function ToolChip({
  name,
  gist,
  note,
  failed
}: {
  name: string
  gist: string
  note?: string
  failed?: boolean
}): ReactNode {
  const [open, setOpen] = useState(false)
  const expandable = Boolean(note) || gist.length > GIST_FOLD
  return (
    <div className="chatview__tool" data-open={open ? 'true' : 'false'} data-failed={failed ? 'true' : undefined}>
      <button
        type="button"
        className="chatview__tool-head"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={expandable ? open : undefined}
        disabled={!expandable}
      >
        <span className="chatview__tool-caret" aria-hidden>
          <svg
            width="9"
            height="9"
            viewBox="0 0 16 16"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M6 3.5L10.5 8 6 12.5" />
          </svg>
        </span>
        <span className="chatview__tool-name">{name}</span>
        <span className="chatview__tool-gist">{gist}</span>
        {failed ? <span className="chatview__tool-flag">failed</span> : null}
      </button>
      {open ? (
        <div className="chatview__tool-body">
          <div className="chatview__tool-gist-full">{gist}</div>
          {note ? <div className="chatview__tool-note">{note}</div> : null}
        </div>
      ) : null}
    </div>
  )
}

/* ---------------------------------------------------------------- working
 *
 * The agent mid-turn: Gemini-styled sparkle header with shimmering label and
 * elapsed counter.
 */

function Working({ activity, agentName }: { activity?: string; agentName?: string }): ReactNode {
  const started = useRef(Date.now())
  const [seconds, setSeconds] = useState(0)
  useEffect(() => {
    started.current = Date.now()
    setSeconds(0)
    const id = window.setInterval(() => setSeconds(Math.floor((Date.now() - started.current) / 1000)), 1000)
    return () => window.clearInterval(id)
  }, [])
  const label = (activity ?? 'Thinking').replace(/[…:.]+$/, '')
  return (
    <div className="chatview__busy-turn" role="status" aria-live="polite">
      <div className="chatview__agent-header">
        <span className="chatview__sparkle-icon chatview__sparkle-icon--pulse" aria-hidden="true">
          <Icon name="sparkle" size={13} />
        </span>
        <span className="chatview__agent-name">{agentName ?? 'Assistant'}</span>
      </div>
      <div className="chatview__busy-bubble">
        <span className="chatview__busy-label">{label}</span>
        <span className="chatview__busy-dots" aria-hidden="true">
          <span />
          <span />
          <span />
        </span>
        {seconds >= 1 ? <span className="chatview__busy-time">{formatElapsed(seconds)}</span> : null}
      </div>
    </div>
  )
}

function formatElapsed(s: number): string {
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  return `${m}m ${String(s % 60).padStart(2, '0')}s`
}

/** The plan's remaining quota, as one quiet line under the conversation. */
function Quota({ text }: { text: string }): ReactNode {
  return (
    <div className="chatview__quota" role="note">
      <span className="chatview__quota-text">{text}</span>
    </div>
  )
}
