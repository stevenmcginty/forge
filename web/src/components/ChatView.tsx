import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
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
 * Read like a conversation, not a stack of boxes:
 * - The person's prompts are bubbles on the right; the agent's replies are
 *   plain text on the page, on the same gutters.
 * - The agent is named only when the speaker changes (see `toRows`).
 * - Each run of tool calls folds into one quiet row that opens in place.
 * - Copy is a real button under every prompt and every reply.
 * - Working / waiting sits under the last reply as one line.
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
  agentName,
  asking
}: {
  turns: ChatTurn[]
  truncated: boolean
  busy?: boolean
  /**
   * The pane has settled on a question. The last turn is then usually a tool
   * call with no text, which reads as "Thinking" — it is not thinking, it is
   * waiting on the person, so the indicator says that instead.
   */
  asking?: boolean
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
  /** The scroller's height at the last scroll event, to tell a resize from a reader. */
  const viewHeight = useRef(0)
  const [unseen, setUnseen] = useState(false)

  const lastId = turns.length ? turns[turns.length - 1]!.id : ''
  const rows = useMemo(() => toRows(turns), [turns])
  const replying = rows.length > 0 && rows[rows.length - 1]!.kind === 'reply'

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
  }, [turns, lastId, busy, asking])

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
    // A scroll caused by the box itself changing height — the phone keyboard
    // opening, a rotation — is not the reader scrolling away. Without this the
    // shrink showed up here as a 300px gap, unstuck the reader, and the
    // ResizeObserver's re-stick arrived too late to find them stuck.
    const height = el.clientHeight
    const resized = height !== viewHeight.current
    viewHeight.current = height
    if (resized && stick.current) {
      el.scrollTop = el.scrollHeight
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
              {rows.map((row) =>
                row.kind === 'user' ? (
                  <UserRow key={row.key} turn={row.turn} />
                ) : (
                  <ReplyRow key={row.key} row={row} agentName={agentName} />
                )
              )}
            </ol>
          )}
          {asking ? (
            <Waiting agentName={agentName} named={!replying} />
          ) : busy ? (
            <Working activity={activity} agentName={agentName} named={!replying} />
          ) : null}
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

/* -------------------------------------------------------------------- rows
 *
 * The transcript arrives as one turn per JSONL record, and a single reply is
 * usually many records: a line of text, a tool call, another tool call, more
 * text. Read one-to-one that is a stack of boxes each wearing the agent's
 * name. So the view folds the turns into rows before it draws anything: a
 * person's prompt is one row, and everything the agent says until the person
 * speaks again is one reply row — named once, copied as one — whose pieces are
 * its paragraphs, its thinking and, between them, each run of tool calls
 * folded into a single quiet line.
 */

type TextBlock = Extract<ChatBlock, { kind: 'text' }>
type ToolBlock = Extract<ChatBlock, { kind: 'tool' }>

type Segment =
  | { kind: 'text'; key: string; block: TextBlock }
  | { kind: 'thinking'; key: string; text: string }
  | { kind: 'tools'; key: string; tools: ToolBlock[] }

type Row =
  | { kind: 'user'; key: string; turn: ChatTurn }
  | { kind: 'reply'; key: string; clock?: string; segments: Segment[] }

function toRows(turns: ChatTurn[]): Row[] {
  const rows: Row[] = []
  for (const turn of turns) {
    if (turn.role === 'user') {
      rows.push({ kind: 'user', key: turn.id, turn })
      continue
    }
    // A record with only thinking in it is the working indicator's business.
    if (!turn.blocks.some((b) => b.kind === 'text' || b.kind === 'tool')) continue
    let reply = rows[rows.length - 1]
    if (!reply || reply.kind !== 'reply') {
      reply = { kind: 'reply', key: turn.id, clock: turn.clock, segments: [] }
      rows.push(reply)
    }
    const segments = reply.segments
    turn.blocks.forEach((block, i) => {
      const key = `${turn.id}:${i}`
      if (block.kind === 'text') segments.push({ kind: 'text', key, block })
      else if (block.kind === 'thinking') {
        if (block.text) segments.push({ kind: 'thinking', key, text: block.text })
      } else {
        const last = segments[segments.length - 1]
        if (last && last.kind === 'tools') last.tools.push(block)
        else segments.push({ kind: 'tools', key, tools: [block] })
      }
    })
  }
  return rows
}

// Turns are immutable by id — the transcript only ever appends or resets — so
// a memo on the turn is all a prompt needs to stay cheap.
const UserRow = memo(function UserRow({ turn }: { turn: ChatTurn }): ReactNode {
  const text = turn.blocks
    .filter((b): b is TextBlock => b.kind === 'text')
    .map((b) => b.text)
    .join('\n\n')
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
              <UserPiece key={i} block={block} />
            )
          )}
        </div>
        <div className="chatview__under">
          {turn.clock ? <span className="chatview__clock">{turn.clock}</span> : null}
          {text ? <CopyButton text={text} label="Copy your message" /> : null}
        </div>
      </div>
    </li>
  )
})

function UserPiece({ block }: { block: ChatBlock }): ReactNode {
  if (block.kind === 'thinking') return block.text ? <ThoughtFold text={block.text} /> : null
  if (block.kind === 'tool') return <ToolGroup tools={[block]} />
  return null
}

/**
 * Everything the agent said between two prompts. Consecutive replies are one
 * row by construction, so a reply row always follows a change of speaker and
 * always carries the name.
 */
function ReplyRow({ row, agentName }: { row: Extract<Row, { kind: 'reply' }>; agentName?: string }): ReactNode {
  const text = row.segments
    .filter((s): s is Extract<Segment, { kind: 'text' }> => s.kind === 'text')
    .map((s) => s.block.text)
    .join('\n\n')
  return (
    <li className="chatview__turn" data-role="assistant">
      <div className="chatview__reply">
        <Speaker agentName={agentName} clock={row.clock} />
        {row.segments.map((segment) =>
          segment.kind === 'text' ? (
            <Prose key={segment.key} block={segment.block} />
          ) : segment.kind === 'thinking' ? (
            <ThoughtFold key={segment.key} text={segment.text} />
          ) : (
            <ToolGroup key={segment.key} tools={segment.tools} />
          )
        )}
        {text ? <CopyButton text={text} label="Copy reply" /> : null}
      </div>
    </li>
  )
}

/** Who is talking: the agent's dot and name, once per change of speaker. */
function Speaker({ agentName, clock }: { agentName?: string; clock?: string }): ReactNode {
  return (
    <div className="chatview__speaker">
      <span className="chatview__speaker-dot" aria-hidden="true" />
      <span className="chatview__speaker-name">{agentName ?? 'Assistant'}</span>
      {clock ? <span className="chatview__speaker-clock">{clock}</span> : null}
    </div>
  )
}

// The block object is stable for the life of its turn, so the markdown parse
// runs once per paragraph however many times the reply around it grows.
const Prose = memo(function Prose({ block }: { block: TextBlock }): ReactNode {
  return <div className="chatview__prose">{renderMarkdown(block.text)}</div>
})

function CopyButton({ text, label }: { text: string; label: string }): ReactNode {
  const [copied, setCopied] = useState(false)
  const timer = useRef<number | null>(null)
  useEffect(
    () => () => {
      if (timer.current) window.clearTimeout(timer.current)
    },
    []
  )
  const onCopy = (): void => {
    void navigator.clipboard?.writeText(text).then(() => {
      setCopied(true)
      if (timer.current) window.clearTimeout(timer.current)
      timer.current = window.setTimeout(() => setCopied(false), 2000)
    })
  }
  return (
    <button
      type="button"
      className="chatview__copy"
      data-done={copied ? 'true' : undefined}
      aria-label={copied ? 'Copied' : label}
      onClick={onCopy}
    >
      <Icon name={copied ? 'check' : 'clipboard'} size={16} />
      <span>{copied ? 'Copied' : 'Copy'}</span>
    </button>
  )
}

function Chevron(): ReactNode {
  return (
    <span className="chatview__chev" aria-hidden="true">
      <Icon name="chevronRight" size={16} />
    </span>
  )
}

function ThoughtFold({ text }: { text: string }): ReactNode {
  const [open, setOpen] = useState(false)
  return (
    <div className="chatview__fold" data-kind="thought" data-open={open ? 'true' : 'false'}>
      <button
        type="button"
        className="chatview__fold-head"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        <span className="chatview__fold-label">{open ? 'Thinking' : 'Thought for a moment'}</span>
        <span className="chatview__fold-gist" />
        <Chevron />
      </button>
      {open ? <div className="chatview__thought-body">{text}</div> : null}
    </div>
  )
}

/* ------------------------------------------------------------- tool calls */

/**
 * One run of tool calls as one line: "4 tool calls" and the tools by name, or,
 * for a lone call, its name and what it was asked. Opens in place to a list,
 * where each call opens once more to its full input and its result.
 */
function ToolGroup({ tools }: { tools: ToolBlock[] }): ReactNode {
  const [open, setOpen] = useState(false)
  const lone = tools.length === 1 ? tools[0]! : null
  const failed = tools.filter((t) => t.failed).length
  const names = [...new Set(tools.map((t) => t.name))].join(' · ')
  const expandable = lone ? Boolean(lone.note) || lone.gist.length > GIST_FOLD : true
  return (
    <div
      className="chatview__fold"
      data-kind="tools"
      data-open={open ? 'true' : 'false'}
      data-failed={failed ? 'true' : undefined}
    >
      <button
        type="button"
        className="chatview__fold-head"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={expandable ? open : undefined}
        disabled={!expandable}
      >
        <span className="chatview__fold-label" data-mono={lone ? 'true' : undefined}>
          {lone ? lone.name : `${tools.length} tool calls`}
        </span>
        <span className="chatview__fold-gist">{lone ? lone.gist : names}</span>
        {failed ? (
          <span className="chatview__tool-flag">{lone || failed === tools.length ? 'failed' : `${failed} failed`}</span>
        ) : null}
        <Chevron />
      </button>
      {open ? (
        lone ? (
          <ToolDetail tool={lone} />
        ) : (
          <ul className="chatview__tool-list">
            {tools.map((tool, i) => (
              <ToolRow key={i} tool={tool} />
            ))}
          </ul>
        )
      ) : null}
    </div>
  )
}

function ToolRow({ tool }: { tool: ToolBlock }): ReactNode {
  const [open, setOpen] = useState(false)
  const expandable = Boolean(tool.note) || tool.gist.length > GIST_FOLD
  return (
    <li className="chatview__tool" data-open={open ? 'true' : 'false'} data-failed={tool.failed ? 'true' : undefined}>
      <button
        type="button"
        className="chatview__tool-head"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={expandable ? open : undefined}
        disabled={!expandable}
      >
        <span className="chatview__tool-name">{tool.name}</span>
        <span className="chatview__tool-gist">{tool.gist}</span>
        {tool.failed ? <span className="chatview__tool-flag">failed</span> : null}
        <Chevron />
      </button>
      {open ? <ToolDetail tool={tool} /> : null}
    </li>
  )
}

function ToolDetail({ tool }: { tool: ToolBlock }): ReactNode {
  return (
    <div className="chatview__tool-body">
      <div className="chatview__tool-gist-full">{tool.gist}</div>
      {tool.note ? <div className="chatview__tool-note">{tool.note}</div> : null}
    </div>
  )
}

/* ---------------------------------------------------------------- working
 *
 * The agent mid-turn: one quiet line — what it says it is doing, three dots
 * breathing in turn, and how long it has been at it.
 */

function Working({
  activity,
  agentName,
  named
}: {
  activity?: string
  agentName?: string
  /** Nothing of this reply is on the page yet, so say who is working. */
  named: boolean
}): ReactNode {
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
      {named ? <Speaker agentName={agentName} /> : null}
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

/**
 * The pane asked and is waiting on the person. Said in words with a "!" beside
 * them, never by colour alone; the answer card over the composer holds the
 * question and its choices.
 */
function Waiting({ agentName, named }: { agentName?: string; named: boolean }): ReactNode {
  return (
    <div className="chatview__busy-turn" role="status" aria-live="polite">
      {named ? <Speaker agentName={agentName} /> : null}
      <div className="chatview__busy-bubble" data-asking="true">
        <span className="chatview__wait-bang" aria-hidden="true">
          !
        </span>
        <span className="chatview__busy-label">Waiting on you</span>
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
