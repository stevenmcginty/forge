import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type MouseEvent,
  type PointerEvent,
  type ReactNode,
  type WheelEvent
} from 'react'
import type { ChatBlock, ChatTurn } from '@shared/chat'
import { Icon } from '@/components/Icon'
import { renderMarkdown } from '../lib/markdown'
import { useMobile } from '../lib/mobile'
import { settlePendingSend, usePendingSends, type PendingSend } from '../lib/pane-sent'
import { speakReply, speechSupported, stopSpeaking, useSpeakingPane } from '../lib/speak'
import './ChatView.css'

/**
 * The chat transcript — a Claude / agent session read as a conversation.
 *
 * On the phone it reads like WhatsApp (`data-bubbles`):
 * - The agent's replies are bubbles on the left, the person's on the right,
 *   each with a small time; a tail marks the first bubble after a change of
 *   speaker, and the agent is named inside it.
 * - The person's bubbles carry ticks by shape: one tick is sent (shown at once
 *   from `announcePaneSent`, before the transcript has it), two ticks is in
 *   the transcript.
 * - The agent's bubbles carry a speaker beside the time: one tap reads that
 *   bubble aloud, and while it reads the speaker is a stop square.
 * - Long-press a bubble (~450 ms) for Copy, Read aloud and, on your own,
 *   Send again. Right-click does the same with a mouse.
 * - Each run of tool calls folds into one quiet row inside the bubble.
 * - Working is a "typing" bubble; its clock is the status row's, below.
 *
 * On the desk it keeps its page look: prompts in bubbles, replies as text on
 * the page, a Copy button under each.
 */

/** How close to the end counts as "reading the latest". */
const STICK_PX = 96
/** How close to the end a reader who wheeled away must come back to be following again. */
const AT_END_PX = 2
/** A gist longer than this is worth an expand even without a result note. */
const GIST_FOLD = 64
/** A finger held this long on a bubble opens its menu. */
const HOLD_MS = 450
/** A finger that drifts further than this is scrolling, not holding. */
const HOLD_SLOP_PX = 10
/** How long "Copied" stays up. */
const TOAST_MS = 1600
/** A pending send matches a transcript turn stamped no earlier than this before it (the desk's clock may lag). */
const MATCH_SKEW_MS = 10 * 60_000

/** What the long-press menu is open on. */
interface Held {
  key: string
  text: string
  mine: boolean
  /** Where the menu goes, in the chat's own box. */
  x: number
  y: number
  side: 'left' | 'right'
}

export function ChatView({
  turns,
  truncated,
  busy,
  activity,
  quota,
  agentName,
  asking,
  paneId,
  onSendAgain
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
  /** The pane this is the chat of: its pending sends show at once, and Read aloud is keyed to it. */
  paneId?: string
  /** Send these words to the pane again ("Send again" on your own bubble). Absent: not offered. */
  onSendAgain?: (text: string) => void
}): ReactNode {
  const bubbles = useMobile()
  const root = useRef<HTMLDivElement | null>(null)
  const scroller = useRef<HTMLDivElement | null>(null)
  const stick = useRef(true)
  // A finger on the transcript owns the scroll; nothing snaps under it.
  const touching = useRef(false)
  /**
   * The wheel (a mouse notch, two fingers on a trackpad) took the reader up
   * off the end. Without this a wheel was "near the bottom" for its first
   * 96px, so every turn, busy line or height settle that landed meanwhile threw
   * the reader back down — and cut short the browser's smooth scroll — while a
   * finger (`touching`) was never snapped. Now a wheel frees the scroll the
   * way a finger does, and the end follows again only once they reach it.
   */
  const wheeled = useRef(false)
  /** The scroller's height at the last scroll event, to tell a resize from a reader. */
  const viewHeight = useRef(0)
  const [unseen, setUnseen] = useState(false)

  const lastId = turns.length ? turns[turns.length - 1]!.id : ''
  const rows = useMemo(() => toRows(turns), [turns])
  const replying = rows.length > 0 && rows[rows.length - 1]!.kind === 'reply'

  // Sent from this phone and not in the transcript yet: shown at once, one tick.
  const sends = usePendingSends(paneId)
  const { waiting, landed } = useMemo(() => matchSends(sends, turns), [sends, turns])
  useEffect(() => {
    if (paneId) for (const id of landed) settlePendingSend(paneId, id)
  }, [paneId, landed])

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
  }, [turns, lastId, busy, asking, waiting.length])

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

  /* -------------------------------------------------- hold for the menu */

  const [held, setHeld] = useState<Held | null>(null)
  const [toast, setToast] = useState('')
  const press = useRef<{ timer: number; x: number; y: number; id: number } | null>(null)
  /** A hold just opened the menu: the click its lift makes is not a tap on what it was over. */
  const swallowClick = useRef(false)
  const heldEl = useRef<HTMLElement | null>(null)

  const cancelPress = useCallback(() => {
    if (press.current) window.clearTimeout(press.current.timer)
    press.current = null
  }, [])

  const openMenu = useCallback((bubble: HTMLElement, y: number) => {
    const box = root.current?.getBoundingClientRect()
    const key = bubble.dataset['bubbleKey']
    const text = bubble.dataset['bubbleText'] ?? ''
    if (!box || !key) return
    const r = bubble.getBoundingClientRect()
    const mine = bubble.dataset['bubbleMine'] === 'true'
    heldEl.current?.closest('li')?.removeAttribute('data-held')
    heldEl.current = bubble
    bubble.closest('li')?.setAttribute('data-held', 'true')
    setHeld({
      key,
      text,
      mine,
      x: mine ? box.right - r.right : r.left - box.left,
      y: y - box.top,
      side: mine ? 'right' : 'left'
    })
    // A tick under the thumb, as a phone's own long-press gives.
    try {
      navigator.vibrate?.(12)
    } catch {
      /* no vibration motor, or not allowed: the menu is the feedback */
    }
  }, [])

  const closeMenu = useCallback((refocus: boolean) => {
    const bubble = heldEl.current
    bubble?.closest('li')?.removeAttribute('data-held')
    heldEl.current = null
    setHeld(null)
    if (refocus) bubble?.focus({ preventScroll: true })
  }, [])

  const onPointerDown = useCallback(
    (event: PointerEvent<HTMLDivElement>) => {
      swallowClick.current = false
      // A mouse has its right button for this; a held left button selects text.
      if (!bubbles || event.pointerType === 'mouse' || !event.isPrimary) return
      const bubble = (event.target as Element).closest<HTMLElement>('[data-bubble-key]')
      if (!bubble) return
      cancelPress()
      const { clientX: x, clientY: y, pointerId: id } = event
      press.current = {
        x,
        y,
        id,
        timer: window.setTimeout(() => {
          press.current = null
          swallowClick.current = true
          openMenu(bubble, y)
        }, HOLD_MS)
      }
    },
    [bubbles, cancelPress, openMenu]
  )

  const onPointerMove = useCallback(
    (event: PointerEvent<HTMLDivElement>) => {
      const p = press.current
      if (!p || event.pointerId !== p.id) return
      if (Math.hypot(event.clientX - p.x, event.clientY - p.y) > HOLD_SLOP_PX) cancelPress()
    },
    [cancelPress]
  )

  const onContextMenu = useCallback(
    (event: MouseEvent<HTMLDivElement>) => {
      if (!bubbles) return
      const bubble = (event.target as Element).closest<HTMLElement>('[data-bubble-key]')
      if (!bubble) return
      // The phone's own long-press menu (select, share) would sit on top of ours.
      event.preventDefault()
      if (held || swallowClick.current) return
      cancelPress()
      openMenu(bubble, event.clientY)
    },
    [bubbles, held, cancelPress, openMenu]
  )

  const onClickCapture = useCallback((event: MouseEvent<HTMLDivElement>) => {
    if (!swallowClick.current) return
    swallowClick.current = false
    event.preventDefault()
    event.stopPropagation()
  }, [])

  useEffect(() => () => cancelPress(), [cancelPress])

  // The toast goes by itself.
  useEffect(() => {
    if (!toast) return undefined
    const id = window.setTimeout(() => setToast(''), TOAST_MS)
    return () => window.clearTimeout(id)
  }, [toast])

  const speaking = useSpeakingPane()
  // Read aloud is keyed per bubble, under this pane, so the one being read can say so.
  const speakPrefix = `${paneId ?? 'chat'}#`
  const readingKey = speaking?.startsWith(speakPrefix) ? speaking.slice(speakPrefix.length) : null
  // Synchronous from the tap on purpose: a phone only lets speech start inside the gesture.
  const toggleRead = useCallback(
    (key: string, text: string) => {
      if (readingKey === key) stopSpeaking()
      else speakReply(speakPrefix + key, text)
    },
    [readingKey, speakPrefix]
  )
  const canSpeak = speechSupported()

  /* ---------------------------------------------------------- scrolling */

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
    if (wheeled.current) {
      if (el.scrollHeight - el.scrollTop - el.clientHeight > AT_END_PX) {
        stick.current = false
        return
      }
      wheeled.current = false
    }
    const near = el.scrollHeight - el.scrollTop - el.clientHeight < STICK_PX
    stick.current = near
    if (near) setUnseen(false)
  }, [])

  const onWheel = useCallback((event: WheelEvent<HTMLDivElement>) => {
    const el = scroller.current
    // Up, and with somewhere to go; Ctrl+wheel is the page's zoom, not a scroll.
    if (!el || event.ctrlKey || event.deltaY >= 0 || el.scrollTop <= 0) return
    wheeled.current = true
    stick.current = false
  }, [])

  const onTouchStart = useCallback(() => {
    touching.current = true
    wheeled.current = false
  }, [])

  const onTouchEnd = useCallback(() => {
    touching.current = false
    cancelPress()
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
  }, [turns.length, cancelPress])

  const jump = useCallback(() => {
    const el = scroller.current
    if (!el) return
    stick.current = true
    wheeled.current = false
    setUnseen(false)
    el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' })
  }, [])

  const lastRole = rows.length ? (rows[rows.length - 1]!.kind === 'user' ? 'user' : 'reply') : null

  return (
    <div className="chatview" ref={root} data-bubbles={bubbles ? 'true' : undefined}>
      <div
        className="chatview__scroll"
        ref={scroller}
        onScroll={onScroll}
        onWheel={onWheel}
        onTouchStart={onTouchStart}
        onTouchEnd={onTouchEnd}
        onTouchCancel={onTouchEnd}
      >
        <div
          className="chatview__column"
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={cancelPress}
          onPointerCancel={cancelPress}
          onContextMenu={onContextMenu}
          onClickCapture={onClickCapture}
        >
          {truncated && turns.length ? (
            <div
              className="chatview__cut"
              role="note"
              title="The transcript was read mid-file — turns before this point exist on disk but are not shown."
            >
              <span className="chatview__cut-text">{bubbles ? 'Earlier messages not shown' : 'earlier history not shown'}</span>
            </div>
          ) : null}
          {turns.length === 0 && waiting.length === 0 ? (
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
              {rows.map((row, i) =>
                row.kind === 'user' ? (
                  <UserRow
                    key={row.key}
                    turn={row.turn}
                    bubbles={bubbles}
                    tail={i === 0 || rows[i - 1]!.kind !== 'user'}
                    reading={readingKey === row.key}
                  />
                ) : (
                  <ReplyRow
                    key={row.key}
                    row={row}
                    agentName={agentName}
                    bubbles={bubbles}
                    reading={readingKey === row.key}
                    onRead={canSpeak ? toggleRead : undefined}
                  />
                )
              )}
              {waiting.map((send, i) => (
                <PendingRow
                  key={`pending-${send.id}`}
                  send={send}
                  bubbles={bubbles}
                  tail={i === 0 && lastRole !== 'user'}
                />
              ))}
            </ol>
          )}
          {asking ? (
            <Waiting agentName={agentName} named={!replying} />
          ) : busy ? (
            <Working activity={activity} agentName={agentName} named={!replying} bubbles={bubbles} />
          ) : null}
          {quota ? <Quota text={quota} /> : null}
        </div>
      </div>
      <button
        type="button"
        className="chatview__jump"
        data-show={unseen && !held ? 'true' : 'false'}
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
      {held ? (
        <BubbleMenu
          held={held}
          reading={readingKey === held.key}
          onClose={closeMenu}
          onCopy={() => {
            const text = held.text
            closeMenu(false)
            const done = navigator.clipboard?.writeText(text)
            if (!done) setToast('Could not copy')
            else void done.then(() => setToast('Copied')).catch(() => setToast('Could not copy'))
          }}
          onRead={
            canSpeak
              ? () => {
                  toggleRead(held.key, held.text)
                  closeMenu(false)
                }
              : undefined
          }
          onSendAgain={
            held.mine && onSendAgain
              ? () => {
                  const text = held.text
                  closeMenu(false)
                  onSendAgain(text)
                }
              : undefined
          }
        />
      ) : null}
      <div className="chatview__toast" role="status" aria-live="polite" data-show={toast ? 'true' : 'false'}>
        {toast ? (
          <>
            <Icon name={toast === 'Copied' ? 'check' : 'close'} size={16} />
            <span>{toast}</span>
          </>
        ) : null}
      </div>
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
  | {
      kind: 'reply'
      key: string
      /** The first record's CLI clock, for the desk's speaker line. */
      clock?: string
      /** The last record's time, for the bubble: when the reply got to where it is. */
      at: number
      lastClock?: string
      segments: Segment[]
    }

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
      reply = { kind: 'reply', key: turn.id, clock: turn.clock, at: turn.at, lastClock: turn.clock, segments: [] }
      rows.push(reply)
    }
    if (turn.at) reply.at = turn.at
    if (turn.clock) reply.lastClock = turn.clock
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

function textOf(turn: ChatTurn): string {
  return turn.blocks
    .filter((b): b is TextBlock => b.kind === 'text')
    .map((b) => b.text)
    .join('\n\n')
}

/* ------------------------------------------------------- pending sends
 *
 * A send from this phone is shown the moment it goes (lib/pane-sent.ts) and
 * settles when the transcript has a prompt with the same words. Matched from
 * the newest back, so the prompts that landed and the sends that are still
 * on their way pair up in order; a screen-read pane may have cut a long
 * prompt, so a long enough start of the words matches too.
 */

function squash(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

function sameWords(a: string, b: string): boolean {
  if (a === b) return true
  const shorter = Math.min(a.length, b.length)
  return shorter >= 24 && (a.startsWith(b) || b.startsWith(a))
}

const NO_SENDS: { waiting: PendingSend[]; landed: number[] } = { waiting: [], landed: [] }

function matchSends(sends: readonly PendingSend[], turns: ChatTurn[]): { waiting: PendingSend[]; landed: number[] } {
  if (!sends.length) return NO_SENDS
  const prompts = turns.filter((t) => t.role === 'user')
  const waiting: PendingSend[] = []
  const landed: number[] = []
  let from = prompts.length - 1
  for (let i = sends.length - 1; i >= 0; i--) {
    const send = sends[i]!
    const want = squash(send.text)
    let found = -1
    for (let j = from; j >= Math.max(0, from - 3); j--) {
      const prompt = prompts[j]!
      if (prompt.at && prompt.at < send.at - MATCH_SKEW_MS) break
      if (sameWords(squash(textOf(prompt)), want)) {
        found = j
        break
      }
    }
    if (found >= 0) {
      landed.push(send.id)
      from = found - 1
    } else waiting.unshift(send)
  }
  return { waiting, landed }
}

/* ---------------------------------------------------------------- times */

function timeOf(at: number, clock?: string): string {
  if (clock) return clock
  if (!at) return ''
  try {
    return new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  } catch {
    return ''
  }
}

/**
 * Sent or in the transcript, by shape: one tick, or two. The colour (the
 * theme's tick blue on two) only agrees with the count.
 */
function Ticks({ landed }: { landed: boolean }): ReactNode {
  return (
    <span
      className="chatview__ticks"
      data-landed={landed ? 'true' : 'false'}
      role="img"
      aria-label={landed ? 'In the transcript' : 'Sent'}
    >
      <svg width="18" height="12" viewBox="0 0 18 12" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        {landed ? (
          <>
            <path d="M1.2 6.6 4.4 9.8 11 2.4" />
            <path d="M8.6 9.4 9 9.8 15.8 2.4" />
          </>
        ) : (
          <path d="M3.6 6.6 6.8 9.8 13.4 2.4" />
        )}
      </svg>
    </span>
  )
}

/** A speaker, drawn: shown on the bubble being read aloud. */
function Speaker16(): ReactNode {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M2.5 6h2.6L8.6 3v10L5.1 10H2.5z" />
      <path d="M11 5.6a3.4 3.4 0 0 1 0 4.8M12.9 3.8a6 6 0 0 1 0 8.4" />
    </svg>
  )
}

/** The time, the ticks on your own, and the speaker while this bubble is read aloud. */
function Meta({ time, ticks, reading }: { time: string; ticks?: 'sent' | 'landed'; reading?: boolean }): ReactNode {
  return (
    <span className="chatview__meta">
      {reading ? (
        <span className="chatview__reading" role="img" aria-label="Reading aloud">
          <Speaker16 />
        </span>
      ) : null}
      {time ? <span className="chatview__time">{time}</span> : null}
      {ticks ? <Ticks landed={ticks === 'landed'} /> : null}
    </span>
  )
}

/**
 * Room at the end of a prompt's last line for the time and ticks, which sit
 * over it at the bubble's corner — so a short message keeps its time on its
 * own line, the way WhatsApp does, and a long one wraps it below.
 */
function MetaRoom({ time, ticks }: { time: string; ticks: boolean }): ReactNode {
  const style = { '--meta-ch': time.length, '--meta-ticks': ticks ? 1 : 0 } as CSSProperties
  return <span className="chatview__meta-room" style={style} aria-hidden="true" />
}

/* ---------------------------------------------------------- the person */

function Prompts({ blocks, room }: { blocks: ChatBlock[]; room?: ReactNode }): ReactNode {
  let lastText = -1
  blocks.forEach((b, i) => {
    if (b.kind === 'text') lastText = i
  })
  return (
    <>
      {blocks.map((block, i) =>
        block.kind === 'text' ? (
          <p key={i} className="chatview__prompt">
            {block.text}
            {i === lastText ? room : null}
          </p>
        ) : (
          <UserPiece key={i} block={block} />
        )
      )}
    </>
  )
}

// Turns are immutable by id — the transcript only ever appends or resets — so
// a memo on the turn is all a prompt needs to stay cheap.
const UserRow = memo(function UserRow({
  turn,
  bubbles,
  tail,
  reading
}: {
  turn: ChatTurn
  bubbles: boolean
  tail: boolean
  reading: boolean
}): ReactNode {
  const text = textOf(turn)
  if (!bubbles) {
    return (
      <li className="chatview__turn" data-role="user">
        <div className="chatview__mine">
          <div className="chatview__bubble">
            <Prompts blocks={turn.blocks} />
          </div>
          <div className="chatview__under">
            {turn.clock ? <span className="chatview__clock">{turn.clock}</span> : null}
            {text ? <CopyButton text={text} label="Copy your message" /> : null}
          </div>
        </div>
      </li>
    )
  }
  const time = timeOf(turn.at, turn.clock)
  return (
    <li className="chatview__turn" data-role="user" data-tail={tail ? 'true' : undefined}>
      <div
        className="chatview__bubble chatview__msg"
        data-bubble-key={turn.id}
        data-bubble-text={text}
        data-bubble-mine="true"
        tabIndex={-1}
      >
        <Prompts blocks={turn.blocks} room={<MetaRoom time={time} ticks />} />
        <Meta time={time} ticks="landed" reading={reading} />
      </div>
    </li>
  )
})

/** Sent from this phone a moment ago; the transcript has not shown it yet. */
function PendingRow({ send, bubbles, tail }: { send: PendingSend; bubbles: boolean; tail: boolean }): ReactNode {
  const time = timeOf(send.at)
  const blocks: ChatBlock[] = [{ kind: 'text', text: send.text }]
  if (!bubbles) {
    return (
      <li className="chatview__turn" data-role="user" data-pending="true">
        <div className="chatview__mine">
          <div className="chatview__bubble">
            <Prompts blocks={blocks} />
          </div>
          <div className="chatview__under">
            <Ticks landed={false} />
          </div>
        </div>
      </li>
    )
  }
  return (
    <li className="chatview__turn" data-role="user" data-pending="true" data-tail={tail ? 'true' : undefined}>
      <div
        className="chatview__bubble chatview__msg"
        data-bubble-key={`pending-${send.id}`}
        data-bubble-text={send.text}
        data-bubble-mine="true"
        tabIndex={-1}
      >
        <Prompts blocks={blocks} room={<MetaRoom time={time} ticks />} />
        <Meta time={time} ticks="sent" />
      </div>
    </li>
  )
}

function UserPiece({ block }: { block: ChatBlock }): ReactNode {
  if (block.kind === 'thinking') return block.text ? <ThoughtFold text={block.text} /> : null
  if (block.kind === 'tool') return <ToolGroup tools={[block]} />
  return null
}

/* ----------------------------------------------------------- the agent */

/**
 * Everything the agent said between two prompts. Consecutive replies are one
 * row by construction, so a reply row always follows a change of speaker and
 * always carries the name.
 */
function ReplyRow({
  row,
  agentName,
  bubbles,
  reading,
  onRead
}: {
  row: Extract<Row, { kind: 'reply' }>
  agentName?: string
  bubbles: boolean
  reading: boolean
  /** Read this bubble aloud, or stop it (keyed by the row). Absent: this browser has no voice. */
  onRead?: (key: string, text: string) => void
}): ReactNode {
  const text = row.segments
    .filter((s): s is Extract<Segment, { kind: 'text' }> => s.kind === 'text')
    .map((s) => s.block.text)
    .join('\n\n')
  const pieces = row.segments.map((segment) =>
    segment.kind === 'text' ? (
      <Prose key={segment.key} block={segment.block} />
    ) : segment.kind === 'thinking' ? (
      <ThoughtFold key={segment.key} text={segment.text} />
    ) : (
      <ToolGroup key={segment.key} tools={segment.tools} />
    )
  )
  if (!bubbles) {
    return (
      <li className="chatview__turn" data-role="assistant">
        <div className="chatview__reply">
          <Speaker agentName={agentName} clock={row.clock} />
          {pieces}
          {text ? <CopyButton text={text} label="Copy reply" /> : null}
        </div>
      </li>
    )
  }
  return (
    <li className="chatview__turn" data-role="assistant" data-tail="true">
      <div
        className="chatview__reply chatview__msg"
        data-bubble-key={row.key}
        data-bubble-text={text}
        tabIndex={-1}
      >
        <Speaker agentName={agentName} />
        {pieces}
        <div className="chatview__meta-line">
          {onRead && text ? (
            <ReadAloud reading={reading} onToggle={() => onRead(row.key, text)} />
          ) : null}
          <Meta time={timeOf(row.at, row.lastClock)} reading={reading && !(onRead && text)} />
        </div>
      </div>
    </li>
  )
}

/**
 * Read aloud, on the bubble: a speaker beside the time, a stop square in a
 * ring while this bubble is being read. Drawn at the time's size; its touch
 * target is 44px, reaching past the drawing without growing the bubble.
 */
function ReadAloud({ reading, onToggle }: { reading: boolean; onToggle: () => void }): ReactNode {
  return (
    <button
      type="button"
      className="chatview__read"
      data-reading={reading ? 'true' : undefined}
      aria-pressed={reading}
      aria-label={reading ? 'Stop reading aloud' : 'Read aloud'}
      title={reading ? 'Stop reading' : 'Read aloud'}
      onClick={onToggle}
    >
      {reading ? (
        <svg width="20" height="20" viewBox="0 0 20 20" aria-hidden="true">
          <circle cx="10" cy="10" r="8.6" fill="none" stroke="currentColor" strokeWidth="1.6" />
          <rect x="6.5" y="6.5" width="7" height="7" rx="1.4" fill="currentColor" />
        </svg>
      ) : (
        <svg width="20" height="20" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M2.5 6h2.6L8.6 3v10L5.1 10H2.5z" />
          <path d="M11 5.6a3.4 3.4 0 0 1 0 4.8M12.9 3.8a6 6 0 0 1 0 8.4" />
        </svg>
      )}
    </button>
  )
}

/** Who is talking: the agent's name (and, on the desk, its dot), once per change of speaker. */
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

/** The desk's Copy under a message. The phone copies from the long-press menu instead. */
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

/* -------------------------------------------------------- the hold menu */

/**
 * What a held bubble offers: Copy, Read aloud (Stop reading while it is), and
 * on your own bubble Send again. Icons with words, 48px rows, over a clear
 * layer that takes the next tap anywhere else as "never mind".
 */
function BubbleMenu({
  held,
  reading,
  onClose,
  onCopy,
  onRead,
  onSendAgain
}: {
  held: Held
  reading: boolean
  onClose: (refocus: boolean) => void
  onCopy: () => void
  onRead?: () => void
  onSendAgain?: () => void
}): ReactNode {
  const menu = useRef<HTMLDivElement | null>(null)
  const [place, setPlace] = useState<CSSProperties>({ visibility: 'hidden' })

  // Above the finger when there is room, below when not; kept inside the chat.
  useLayoutEffect(() => {
    const el = menu.current
    const box = el?.parentElement?.getBoundingClientRect()
    if (!el || !box) return
    const h = el.offsetHeight
    const w = el.offsetWidth
    const gap = 12
    const top = held.y - h - gap >= gap ? held.y - h - gap : Math.min(held.y + gap, box.height - h - gap)
    const edge = Math.max(gap, Math.min(held.x, box.width - w - gap))
    setPlace(held.side === 'left' ? { top: Math.max(gap, top), left: edge } : { top: Math.max(gap, top), right: edge })
    el.querySelector<HTMLButtonElement>('button')?.focus({ preventScroll: true })
  }, [held])

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key === 'Escape') {
      event.preventDefault()
      onClose(true)
      return
    }
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
    event.preventDefault()
    const items = [...(menu.current?.querySelectorAll<HTMLButtonElement>('button') ?? [])]
    const at = items.indexOf(document.activeElement as HTMLButtonElement)
    const next = items[(at + (event.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length]
    next?.focus()
  }

  // Only a tap that starts on the layer closes it: the lift that ends the hold
  // lands a click here too, and must leave the menu up.
  const armed = useRef(false)

  return (
    <div
      className="chatview__menu-layer"
      onPointerDown={(event) => {
        armed.current = event.target === event.currentTarget
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget && armed.current) onClose(false)
        armed.current = false
      }}
      onContextMenu={(event) => event.preventDefault()}
    >
      <div
        ref={menu}
        className="chatview__menu"
        role="menu"
        aria-label={held.mine ? 'Your message' : 'Reply'}
        data-side={held.side}
        style={place}
        onKeyDown={onKeyDown}
      >
        <button type="button" role="menuitem" className="chatview__menu-item" onClick={onCopy}>
          <Icon name="clipboard" size={20} />
          <span>Copy</span>
        </button>
        {onRead ? (
          <button type="button" role="menuitem" className="chatview__menu-item" onClick={onRead}>
            {reading ? <StopGlyph /> : <Speaker16Large />}
            <span>{reading ? 'Stop reading' : 'Read aloud'}</span>
          </button>
        ) : null}
        {onSendAgain ? (
          <button type="button" role="menuitem" className="chatview__menu-item" onClick={onSendAgain}>
            <Icon name="refresh" size={20} />
            <span>Send again</span>
          </button>
        ) : null}
      </div>
    </div>
  )
}

function Speaker16Large(): ReactNode {
  return (
    <svg width="20" height="20" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M2.5 6h2.6L8.6 3v10L5.1 10H2.5z" />
      <path d="M11 5.6a3.4 3.4 0 0 1 0 4.8M12.9 3.8a6 6 0 0 1 0 8.4" />
    </svg>
  )
}

function StopGlyph(): ReactNode {
  return (
    <svg width="20" height="20" viewBox="0 0 16 16" aria-hidden="true">
      <rect x="4" y="4" width="8" height="8" rx="1.5" fill="currentColor" />
    </svg>
  )
}

/* ------------------------------------------------------------------ folds */

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
 * The agent mid-turn. On the phone a "typing" bubble — what it says it is
 * doing and three dots breathing in turn; how long it has been at it is the
 * status row's clock just below, so there is one clock, not two that
 * disagree. On the desk the line keeps its own count. Either way only the
 * words are in the live region: a screen reader hears "Thinking", not a
 * number every second.
 */

function Working({
  activity,
  agentName,
  named,
  bubbles
}: {
  activity?: string
  agentName?: string
  /** Nothing of this reply is on the page yet, so say who is working. */
  named: boolean
  bubbles: boolean
}): ReactNode {
  const label = (activity ?? 'Thinking').replace(/[…:.]+$/, '')
  return (
    <div className="chatview__busy-turn" data-tail={bubbles && named ? 'true' : undefined}>
      {named && !bubbles ? <Speaker agentName={agentName} /> : null}
      <div className="chatview__busy-bubble">
        {named && bubbles ? <Speaker agentName={agentName} /> : null}
        <span className="chatview__busy-line">
          <span className="chatview__busy-label" role="status" aria-live="polite">
            {label}
          </span>
          <span className="chatview__busy-dots" aria-hidden="true">
            <span />
            <span />
            <span />
          </span>
          {bubbles ? null : <Elapsed />}
        </span>
      </div>
    </div>
  )
}

/** The desk's count of how long this turn has run, out of the live region. */
function Elapsed(): ReactNode {
  const started = useRef(Date.now())
  const [seconds, setSeconds] = useState(0)
  useEffect(() => {
    started.current = Date.now()
    setSeconds(0)
    const id = window.setInterval(() => setSeconds(Math.floor((Date.now() - started.current) / 1000)), 1000)
    return () => window.clearInterval(id)
  }, [])
  return seconds >= 1 ? (
    <span className="chatview__busy-time" aria-hidden="true">
      {formatElapsed(seconds)}
    </span>
  ) : null
}

/**
 * The pane asked and is waiting on the person. Said in words with a "!" beside
 * them, never by colour alone; the answer card over the composer holds the
 * question and its choices.
 */
function Waiting({ agentName, named }: { agentName?: string; named: boolean }): ReactNode {
  return (
    <div className="chatview__busy-turn" data-waiting="true" role="status" aria-live="polite">
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
