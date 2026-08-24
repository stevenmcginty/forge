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
import { renderMarkdown } from '../lib/markdown'
import './ChatView.css'

/**
 * The chat transcript — a Claude session read as a conversation.
 *
 * The Feed is a lens over the terminal's screen; this is the real thing: turns
 * parsed from the session's own JSONL by the desktop (shared/chat.ts is the
 * contract) and rendered the way the official Claude Code app reads. The
 * assistant's words are the page — full-width prose in the UI font, markdown
 * rendered — and everything else recedes: the person's prompts sit in compact
 * accent-washed bubbles on the right, a tool call is a one-line chip a thumb
 * can expand or ignore, thinking is folded shut until asked for.
 *
 * This component knows nothing about sockets or panes. It takes `turns`,
 * `truncated` and `busy`, and the wiring job feeds it. Scroll behaviour is the
 * Feed's, because the Feed's is right: follow the bottom while the reader is
 * there, never yank the page while they are reading history, offer the pill.
 */

/** How close to the end counts as "reading the latest". */
const STICK_PX = 96
/** A gist longer than this is worth an expand even without a result note. */
const GIST_FOLD = 64

export function ChatView({
  turns,
  truncated,
  busy
}: {
  turns: ChatTurn[]
  truncated: boolean
  busy?: boolean
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
              <span className="chatview__empty-dot" />
              <p>The conversation will appear here.</p>
            </div>
          ) : (
            <ol className="chatview__turns">
              {turns.map((turn) => (
                <Turn key={turn.id} turn={turn} />
              ))}
            </ol>
          )}
          {busy ? (
            <div className="chatview__busy" role="status" aria-live="polite">
              <span className="chatview__busy-dot" aria-hidden />
              <span>Working…</span>
            </div>
          ) : null}
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
const Turn = memo(function Turn({ turn }: { turn: ChatTurn }): ReactNode {
  return (
    <li className="chatview__turn" data-role={turn.role}>
      {turn.role === 'user' ? (
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
      ) : (
        <div className="chatview__reply">
          {turn.blocks.map((block, i) => (
            <Piece key={i} block={block} />
          ))}
        </div>
      )}
    </li>
  )
})

function Piece({ block }: { block: ChatBlock }): ReactNode {
  switch (block.kind) {
    case 'text':
      return <div className="chatview__prose">{renderMarkdown(block.text)}</div>
    case 'thinking':
      return <ThinkingFold text={block.text} />
    case 'tool':
      return <ToolChip name={block.name} gist={block.gist} note={block.note} failed={block.failed} />
  }
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

/* --------------------------------------------------------------- thinking */

function ThinkingFold({ text }: { text: string }): ReactNode {
  const [open, setOpen] = useState(false)
  return (
    <div className="chatview__think" data-open={open ? 'true' : 'false'}>
      <button type="button" className="chatview__think-head" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
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
        Thought for a moment
      </button>
      {open ? <div className="chatview__think-body">{text}</div> : null}
    </div>
  )
}
