import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
  type TouchEvent
} from 'react'
import type { FeedBlock, PaneStatus, RichLine, Run } from '@/lib/rich'
import './Feed.css'

/**
 * The conversation drawn from a pane's captured screen.
 *
 * The PTY is still the source and xterm is still the emulator; this is a lens
 * over the styled cells it holds. Every run keeps the colour the terminal gave
 * it — that is the whole point of `RichLine` — and the roles only decide the
 * frame around the words: the person's turn sits in a bubble tinted with the
 * pane's accent, the agent's turn is just the words with a thin accent rule,
 * a tool call folds into a card, and the TUI's own announcements shrink to a
 * small-caps banner.
 */

/** Lines of a tool result shown before the card folds. */
const TOOL_FOLD_AT = 12
const TOOL_FOLD_SHOW = 8
/** How close to the end counts as "reading the latest". */
const STICK_PX = 96

export function Feed({
  blocks,
  status,
  asking,
  prompt,
  empty,
  cut,
  pageTui,
  onTuiScroll
}: {
  blocks: FeedBlock[]
  status?: PaneStatus
  asking: boolean
  prompt: string
  empty: string
  /**
   * The catch-up buffer met its ceiling, so the transcript starts mid-stream.
   * Marked as a seam at the top of the column — where the cut actually is —
   * rather than as a chip in the pane chrome.
   */
  cut?: boolean
  /**
   * This pane is an alt-screen TUI (Grok, OpenCode). The cards are a snapshot
   * of the current frame, so native overflow has nothing older to reveal —
   * overscroll has to page the TUI itself.
   */
  pageTui?: boolean
  /** Same sign as WheelEvent.deltaY. Return true if the TUI took the gesture. */
  onTuiScroll?: (deltaY: number, deltaMode?: number) => boolean
}): ReactNode {
  const scroller = useRef<HTMLDivElement | null>(null)
  const stick = useRef(true)
  /**
   * A finger is on the feed. Nothing snaps to the bottom while it is there:
   * with the keyboard up the feed is a few lines tall, so the reader is
   * "near the bottom" for most of a drag, and a capture landing mid-drag used
   * to yank the feed back under their thumb.
   */
  const touching = useRef(false)
  /**
   * After a TUI PageUp the new older lines land at the top of the capture, so
   * sticking to the bottom would hide the thing the reader just asked to see.
   */
  const preferTop = useRef(false)
  const [unseen, setUnseen] = useState(false)
  const [revealed, setRevealed] = useState<string | null>(null)

  const lastId = blocks.length ? blocks[blocks.length - 1]!.id : ''
  const busy = status?.busy === true

  // Follow the bottom while the reader is there; otherwise leave them be and
  // raise the pill. Layout effect so the scroll lands before paint — no jump.
  useLayoutEffect(() => {
    const el = scroller.current
    if (!el) return
    if (preferTop.current) {
      el.scrollTop = 0
      preferTop.current = false
      stick.current = false
      if (blocks.length) setUnseen(true)
      return
    }
    if (stick.current && !touching.current) {
      el.scrollTop = el.scrollHeight
      setUnseen(false)
    } else if (blocks.length) {
      setUnseen(true)
    }
  }, [blocks, lastId, asking, prompt, busy])

  // Heights change after the blocks do — fonts land, a folded card opens,
  // `content-visibility` settles, the composer grows an attachment row and
  // takes the space from this box. While the reader is at the bottom, the
  // bottom follows; the flag, not the effect above, decides.
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
    // A drag is the reader taking the wheel; the bottom is theirs again only
    // once the finger lifts somewhere near it.
    if (touching.current) {
      stick.current = false
      return
    }
    const near = el.scrollHeight - el.scrollTop - el.clientHeight < STICK_PX
    stick.current = near
    if (near) setUnseen(false)
  }, [])

  const touchY = useRef(0)

  const onTouchStart = useCallback((event: TouchEvent) => {
    touching.current = true
    touchY.current = event.touches[0]?.clientY ?? 0
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
    } else if (blocks.length) {
      setUnseen(true)
    }
  }, [blocks.length])

  const jump = useCallback(() => {
    const el = scroller.current
    if (!el) return
    stick.current = true
    preferTop.current = false
    setUnseen(false)
    el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' })
  }, [])

  const pageAtEdge = useCallback(
    (deltaY: number, deltaMode = 0): boolean => {
      const el = scroller.current
      if (!el || !pageTui || !onTuiScroll) return false
      const up = deltaY < 0
      const atTop = el.scrollTop <= 1
      const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight <= 1
      if (up ? !atTop : !atBottom) return false
      if (!onTuiScroll(deltaY, deltaMode)) return false
      if (up) {
        preferTop.current = true
        stick.current = false
      } else {
        preferTop.current = false
        stick.current = true
      }
      return true
    },
    [pageTui, onTuiScroll]
  )

  useEffect(() => {
    const el = scroller.current
    if (!el || !pageTui || !onTuiScroll) return
    const onWheel = (event: WheelEvent): void => {
      if (event.ctrlKey || event.shiftKey) return
      if (pageAtEdge(event.deltaY, event.deltaMode)) event.preventDefault()
    }
    const onMove = (event: globalThis.TouchEvent): void => {
      if (event.touches.length !== 1) return
      event.preventDefault()
      const y = event.touches[0]!.clientY
      const dy = touchY.current - y
      touchY.current = y
      const max = Math.max(0, el.scrollHeight - el.clientHeight)
      const next = el.scrollTop + dy
      if (next <= 0) {
        el.scrollTop = 0
        if (dy < 0) pageAtEdge(dy, 0)
      } else if (next >= max) {
        el.scrollTop = max
        if (dy > 0) pageAtEdge(dy, 0)
      } else {
        el.scrollTop = next
        stick.current = false
      }
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    el.addEventListener('touchmove', onMove, { passive: false })
    return () => {
      el.removeEventListener('wheel', onWheel)
      el.removeEventListener('touchmove', onMove)
    }
  }, [pageTui, onTuiScroll, pageAtEdge])

  return (
    <div className="feed" data-busy={busy ? 'true' : undefined}>
      <div
        className="feed__scroll"
        data-page-tui={pageTui ? 'true' : undefined}
        ref={scroller}
        onScroll={onScroll}
        onTouchStart={onTouchStart}
        onTouchEnd={onTouchEnd}
        onTouchCancel={onTouchEnd}
      >
        <div className="feed__column">
          {cut && blocks.length ? (
            <div
              className="feed__cut"
              role="note"
              title="The catch-up buffer met its ceiling — output before this point was trimmed, so the transcript starts mid-stream."
            >
              <span className="feed__cut-text">earlier output trimmed</span>
            </div>
          ) : null}
          {blocks.length === 0 ? (
            <div className="feed__empty">
              <span className="feed__empty-dot" />
              <p>{empty}</p>
            </div>
          ) : null}
          {blocks.map((block) => (
            <Block key={block.id} block={block} revealed={revealed === block.id} onReveal={setRevealed} />
          ))}
          {busy ? <Busy activity={status?.activity} /> : null}
          {asking ? (
            <div className="feed__ask" role="status">
              <span className="feed__ask-label">
                <span className="feed__ask-ring" />
                Waiting on you
              </span>
              <p className="feed__ask-prompt">
                {prompt || 'This pane has settled on a question. Answer in the box, or use Tab / Esc below.'}
              </p>
            </div>
          ) : null}
        </div>
      </div>
      <button
        type="button"
        className="feed__jump"
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

/* ------------------------------------------------------------------ blocks */

const Block = memo(function Block({
  block,
  revealed,
  onReveal
}: {
  block: FeedBlock
  revealed: boolean
  onReveal: (id: string | null) => void
}): ReactNode {
  const press = useRef<number | null>(null)

  const onTouchStart = (_event: TouchEvent): void => {
    if (press.current) window.clearTimeout(press.current)
    press.current = window.setTimeout(() => {
      onReveal(block.id)
      press.current = null
    }, 450)
  }
  const cancelPress = (): void => {
    if (press.current) window.clearTimeout(press.current)
    press.current = null
  }

  let body: ReactNode
  switch (block.role) {
    case 'user':
      body = (
        <div className="feed__bubble">
          <Lines lines={block.lines} fallback={block.text} />
        </div>
      )
      break
    case 'tool':
      body = <ToolCard block={block} />
      break
    case 'system':
      body = (
        <div className="feed__system">
          <span className="feed__system-text">{firstLine(block.text)}</span>
        </div>
      )
      break
    default:
      body = (
        <div className="feed__agent">
          <Lines lines={block.lines} fallback={block.text} />
        </div>
      )
  }

  return (
    <article
      className="feed__block"
      data-role={block.role}
      data-revealed={revealed ? 'true' : undefined}
      onTouchStart={onTouchStart}
      onTouchEnd={cancelPress}
      onTouchMove={cancelPress}
      onTouchCancel={cancelPress}
    >
      {body}
      {block.role !== 'system' ? <CopyButton text={block.text} /> : null}
    </article>
  )
})

function firstLine(text: string): string {
  const nl = text.indexOf('\n')
  return (nl === -1 ? text : text.slice(0, nl)).trim()
}

/* ------------------------------------------------------------- tool cards */

function ToolCard({ block }: { block: FeedBlock }): ReactNode {
  // null = the default for this card: a long result starts folded to a
  // preview, a short one starts open. A tap on the header overrides either.
  const [choice, setChoice] = useState<boolean | null>(null)
  const head = block.lines[0]
  const rest = block.lines.slice(1)
  const folds = rest.length > TOOL_FOLD_AT
  const open = choice ?? !folds
  const shown = open ? rest : folds ? rest.slice(0, TOOL_FOLD_SHOW) : []
  const hidden = rest.length - shown.length

  return (
    <div className="feed__tool" data-open={open ? 'true' : 'false'}>
      <button
        type="button"
        className="feed__tool-head"
        onClick={() => setChoice(!open)}
        aria-expanded={rest.length ? open : undefined}
        disabled={!rest.length}
      >
        <span className="feed__tool-caret" aria-hidden>
          <svg
            width="10"
            height="10"
            viewBox="0 0 16 16"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M6 3.5L10.5 8 6 12.5" />
          </svg>
        </span>
        <span className="feed__tool-title">{head ? <Line line={head} /> : firstLine(block.text)}</span>
        {rest.length ? <span className="feed__tool-count">{rest.length === 1 ? '1 line' : `${rest.length} lines`}</span> : null}
      </button>
      {rest.length ? (
        <div className="feed__tool-body">
          <div className="feed__tool-lines">
            {shown.map((line, i) => (
              <Line key={i} line={line} />
            ))}
          </div>
          {hidden > 0 ? (
            <button type="button" className="feed__tool-more" onClick={() => setChoice(true)}>
              Show {hidden} more {hidden === 1 ? 'line' : 'lines'}
            </button>
          ) : folds ? (
            <button type="button" className="feed__tool-more" onClick={() => setChoice(false)}>
              Show less
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}

/* --------------------------------------------------------------- styled text */

function Lines({ lines, fallback }: { lines: RichLine[]; fallback: string }): ReactNode {
  if (!lines.length) return <pre className="feed__text">{fallback}</pre>
  return (
    <pre className="feed__text">
      {lines.map((line, i) => (
        <Line key={i} line={line} />
      ))}
    </pre>
  )
}

function Line({ line }: { line: RichLine }): ReactNode {
  return (
    <span className="feed__line">
      {line.runs.length ? line.runs.map((run, i) => <RunSpan key={i} run={run} />) : line.text || ' '}
      {'\n'}
    </span>
  )
}

function RunSpan({ run }: { run: Run }): ReactNode {
  if (!run.fg && !run.bg && !run.bold && !run.dim && !run.italic && !run.underline && !run.strike) {
    return <>{run.text}</>
  }
  const style: CSSProperties = {}
  if (run.fg) style.color = run.fg
  if (run.bg) style.background = run.bg
  if (run.bold) style.fontWeight = 700
  if (run.dim) style.opacity = 0.55
  if (run.italic) style.fontStyle = 'italic'
  const deco = [run.underline ? 'underline' : '', run.strike ? 'line-through' : ''].filter(Boolean).join(' ')
  if (deco) style.textDecoration = deco
  return <span style={style}>{run.text}</span>
}

/* ------------------------------------------------------------------- copy */

function CopyButton({ text }: { text: string }): ReactNode {
  const [done, setDone] = useState(false)
  const timer = useRef<number | null>(null)
  useEffect(
    () => () => {
      if (timer.current) window.clearTimeout(timer.current)
    },
    []
  )
  return (
    <button
      type="button"
      className="feed__copy"
      data-done={done ? 'true' : undefined}
      aria-label="Copy this block"
      title="Copy"
      onClick={() => {
        void navigator.clipboard?.writeText(text).then(() => {
          setDone(true)
          if (timer.current) window.clearTimeout(timer.current)
          timer.current = window.setTimeout(() => setDone(false), 1400)
        })
      }}
    >
      {done ? (
        <svg
          width="13"
          height="13"
          viewBox="0 0 16 16"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden
        >
          <path d="M3.5 8.5l3 3 6-6.5" />
        </svg>
      ) : (
        <svg
          width="13"
          height="13"
          viewBox="0 0 16 16"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.4"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden
        >
          <rect x="5.5" y="5.5" width="8" height="8" rx="1.6" />
          <path d="M10.5 5.5V4a1.5 1.5 0 0 0-1.5-1.5H4A1.5 1.5 0 0 0 2.5 4v5A1.5 1.5 0 0 0 4 10.5h1.5" />
        </svg>
      )}
      <span className="feed__copy-text">{done ? 'Copied' : 'Copy'}</span>
    </button>
  )
}

/* ------------------------------------------------------------------- busy */

function Busy({ activity }: { activity?: string }): ReactNode {
  const started = useRef(Date.now())
  const [seconds, setSeconds] = useState(0)
  useEffect(() => {
    started.current = Date.now()
    setSeconds(0)
    const id = window.setInterval(() => setSeconds(Math.floor((Date.now() - started.current) / 1000)), 1000)
    return () => window.clearInterval(id)
  }, [])
  const label = (activity ?? 'Working').replace(/[…:.]+$/, '')
  return (
    <div className="feed__busy" role="status" aria-live="polite">
      <span className="feed__busy-orb" aria-hidden>
        <span />
        <span />
      </span>
      <span className="feed__busy-text">
        {label}
        {seconds >= 1 ? <span className="feed__busy-time"> · {formatElapsed(seconds)}</span> : null}
      </span>
    </div>
  )
}

function formatElapsed(s: number): string {
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  return `${m}m ${s % 60}s`
}
