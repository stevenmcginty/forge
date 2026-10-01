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
 * It reads like WhatsApp (`data-bubbles`), on the phone and on the deck alike:
 * - The agent's replies are bubbles on the left, the person's on the right,
 *   each with a small time; a tail marks the first bubble after a change of
 *   speaker, and the agent is named inside it.
 * - The person's bubbles carry ticks by shape: one tick is sent (shown at once
 *   from `announcePaneSent`, before the transcript has it), two ticks is in
 *   the transcript.
 * - The agent's bubbles carry a speaker beside the time: one tap reads that
 *   bubble's answer aloud, and while it reads the speaker is a stop square.
 * - Long-press a bubble (~450 ms) for Copy, Read aloud and, on your own,
 *   Send again. Right-click does the same with a mouse. On a reply that used
 *   tools, Copy and Read aloud take the answer — the words after the last tool
 *   call — and Copy all / Read all take the whole turn.
 * - On a touch screen a bubble's text does not select (the hold is the menu's),
 *   so a part of a reply is taken three ways: tap inline code to copy it, tap
 *   a link, or "Select text" in the menu, which lets that one bubble's text be
 *   selected until the next tap outside it.
 * - Each run of tool calls folds into one quiet row inside the bubble.
 * - Working is a "typing" bubble; on the phone its clock is the status row's, below.
 *
 * On the deck (`data-desk`) the same bubbles, sized for a window: the column
 * holds a reading width however wide the pane, and a mouse gets the menu two
 * ways — right-click a bubble, or the ⋯ that shows beside it on hover and on
 * Tab. Right-click over a link or a selection keeps the browser's own menu.
 * The working bubble there keeps the count of the turn's seconds that the
 * desk's working line always had.
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
  /** What Copy and Read aloud take: your words, or a reply's answer. */
  text: string
  /** The whole turn, when it is more than `text` — a reply whose answer came after tool calls. */
  all?: string
  /** A touch screen, where the bubble's text does not select: the menu offers "Select text". */
  selectable: boolean
  mine: boolean
  /** Where the menu goes, in the chat's own box. */
  x: number
  y: number
  side: 'left' | 'right'
  /** Opened from the ⋯ button: the button's top, so the menu can drop below it or rise above. */
  above?: number
}

// Memoised: the pane above re-renders on every parsed screen frame — about
// twelve a second while an agent streams — and none of that is the chat's
// business unless one of these props moved. PaneView keeps them stable.
export const ChatView = memo(function ChatView({
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
  const desk = !useMobile()
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
  /** The rows as last drawn, for the menu: a held reply's whole turn is read from here. */
  const rowsRef = useRef(rows)
  rowsRef.current = rows
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
  /** The ⋯ the menu was opened from, if it was: focus goes back to it. */
  const opener = useRef<HTMLElement | null>(null)

  const cancelPress = useCallback(() => {
    if (press.current) window.clearTimeout(press.current.timer)
    press.current = null
  }, [])

  /*
   * "Select text": on a touch screen a bubble's text does not select, because
   * the hold opens this menu. The menu can hand one bubble back to the phone's
   * own selection (`data-select`, which ChatView.css turns into
   * `user-select: text`) — until a tap anywhere outside it, or another menu.
   */
  const selecting = useRef<HTMLElement | null>(null)
  const endSelect = useCallback(() => {
    const bubble = selecting.current
    if (!bubble) return
    selecting.current = null
    bubble.removeAttribute('data-select')
    const picked = window.getSelection()
    if (picked && !picked.isCollapsed && bubble.contains(picked.anchorNode)) picked.removeAllRanges()
  }, [])
  useEffect(() => {
    const onDown = (event: Event): void => {
      const bubble = selecting.current
      if (bubble && !(event.target instanceof Node && bubble.contains(event.target))) endSelect()
    }
    document.addEventListener('pointerdown', onDown, true)
    return () => {
      document.removeEventListener('pointerdown', onDown, true)
      endSelect()
    }
  }, [endSelect])

  const openMenu = useCallback((bubble: HTMLElement, y: number, from?: HTMLElement) => {
    const box = root.current?.getBoundingClientRect()
    const key = bubble.dataset['bubbleKey']
    const text = bubble.dataset['bubbleText'] ?? ''
    if (!box || !key) return
    endSelect()
    // From the ⋯ the menu hangs off the button itself; otherwise off the bubble's edge.
    const r = (from ?? bubble).getBoundingClientRect()
    const mine = bubble.dataset['bubbleMine'] === 'true'
    // A reply's bubble carries its answer; the whole turn is read off the row.
    const row = mine ? undefined : rowsRef.current.find((candidate) => candidate.key === key)
    const whole = row?.kind === 'reply' ? pickAnswer(row.segments).all : text
    heldEl.current?.closest('li')?.removeAttribute('data-held')
    opener.current?.setAttribute('aria-expanded', 'false')
    heldEl.current = bubble
    opener.current = from ?? null
    bubble.closest('li')?.setAttribute('data-held', 'true')
    from?.setAttribute('aria-expanded', 'true')
    setHeld({
      key,
      text,
      all: whole !== text ? whole : undefined,
      // The same question ChatView.css asks before it turns selection off.
      selectable: typeof window.matchMedia === 'function' && window.matchMedia('(pointer: coarse)').matches,
      mine,
      x: mine ? box.right - r.right : r.left - box.left,
      y: (from ? r.bottom : y) - box.top,
      side: mine ? 'right' : 'left',
      above: from ? r.top - box.top : undefined
    })
    // A tick under the thumb, as a phone's own long-press gives.
    try {
      navigator.vibrate?.(12)
    } catch {
      /* no vibration motor, or not allowed: the menu is the feedback */
    }
  }, [endSelect])

  const closeMenu = useCallback((refocus: boolean) => {
    const bubble = heldEl.current
    const from = opener.current
    bubble?.closest('li')?.removeAttribute('data-held')
    from?.setAttribute('aria-expanded', 'false')
    heldEl.current = null
    opener.current = null
    setHeld(null)
    if (refocus) (from ?? bubble)?.focus({ preventScroll: true })
  }, [])

  const onPointerDown = useCallback(
    (event: PointerEvent<HTMLDivElement>) => {
      swallowClick.current = false
      // A mouse has its right button for this; a held left button selects text.
      if (event.pointerType === 'mouse' || !event.isPrimary) return
      const bubble = (event.target as Element).closest<HTMLElement>('[data-bubble-key]')
      if (!bubble) return
      // Its text is being selected: a hold there is the phone's, not the menu's.
      if (bubble.hasAttribute('data-select')) return
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
    [cancelPress, openMenu]
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
      const target = event.target as Element
      const bubble = target.closest<HTMLElement>('[data-bubble-key]')
      if (!bubble) return
      // "Select text" is on for this bubble: the phone's own selection and its menu are the point.
      if (bubble.hasAttribute('data-select')) return
      if (desk && !held) {
        // A link, or words picked out of the bubble, want the browser's own
        // menu (open in a new tab, copy just these words), not ours.
        if (target.closest('a[href]')) return
        const picked = window.getSelection()
        if (picked && !picked.isCollapsed && bubble.contains(picked.anchorNode)) return
      }
      // The phone's own long-press menu (select, share) would sit on top of ours.
      event.preventDefault()
      if (held || swallowClick.current) return
      cancelPress()
      // The keyboard's menu key on a focused ⋯ opens it as the ⋯ would.
      const more = target.closest<HTMLElement>('[data-bubble-more]')
      openMenu(bubble, event.clientY, more ?? undefined)
    },
    [desk, held, cancelPress, openMenu]
  )

  const copy = useCallback((text: string) => {
    const done = navigator.clipboard?.writeText(text)
    if (!done) setToast('Could not copy')
    else void done.then(() => setToast('Copied')).catch(() => setToast('Could not copy'))
  }, [])

  /**
   * On the deck, the ⋯ beside a bubble: the same menu, for a mouse or the
   * keyboard. On the phone, a tap on inline code: a command, a path or a name
   * out of a long reply is copied by itself, and the toast says so. Handled
   * here, on the column, so the rows stay memo-cheap. (A mouse selects code
   * the ordinary way, so the deck does not copy on a click.)
   */
  const onClick = useCallback(
    (event: MouseEvent<HTMLDivElement>) => {
      const target = event.target as Element
      if (!desk) {
        const code = target.closest<HTMLElement>('code.md__inline-code')
        // Code that is a link's words follows the link; code being selected is left to the selection.
        if (!code || code.closest('a[href]') || code.closest('[data-select]')) return
        const text = code.textContent ?? ''
        if (text) copy(text)
        return
      }
      const more = target.closest<HTMLElement>('[data-bubble-more]')
      const bubble = more?.closest<HTMLElement>('[data-bubble-key]')
      if (!more || !bubble) return
      event.preventDefault()
      openMenu(bubble, 0, more)
    },
    [desk, copy, openMenu]
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
  // Read through a ref so the callback keeps its identity when reading starts
  // or stops: every reply row takes it as a prop, and only the row being read
  // (its `reading` flag) has anything to redraw.
  const readingRef = useRef(readingKey)
  readingRef.current = readingKey
  // Synchronous from the tap on purpose: a phone only lets speech start inside the gesture.
  const toggleRead = useCallback(
    (key: string, text: string) => {
      if (readingRef.current === key) stopSpeaking()
      else speakReply(speakPrefix + key, text)
    },
    [speakPrefix]
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
    <div className="chatview" ref={root} data-bubbles="true" data-desk={desk ? 'true' : undefined}>
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
          onClick={onClick}
        >
          {truncated && turns.length ? (
            <div
              className="chatview__cut"
              role="note"
              title="The transcript was read mid-file — turns before this point exist on disk but are not shown."
            >
              <span className="chatview__cut-text">Earlier messages not shown</span>
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
                    desk={desk}
                    tail={i === 0 || rows[i - 1]!.kind !== 'user'}
                    reading={readingKey === row.key}
                  />
                ) : (
                  <ReplyRow
                    key={row.key}
                    row={row}
                    agentName={agentName}
                    desk={desk}
                    reading={readingKey === row.key}
                    onRead={canSpeak ? toggleRead : undefined}
                  />
                )
              )}
              {waiting.map((send, i) => (
                <PendingRow
                  key={`pending-${send.id}`}
                  send={send}
                  desk={desk}
                  tail={i === 0 && lastRole !== 'user'}
                />
              ))}
            </ol>
          )}
          {asking ? (
            <Waiting agentName={agentName} named={!replying} />
          ) : busy ? (
            <Working activity={activity} agentName={agentName} named={!replying} counted={desk} />
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
            copy(text)
          }}
          onCopyAll={
            held.all !== undefined
              ? () => {
                  const text = held.all ?? held.text
                  closeMenu(false)
                  copy(text)
                }
              : undefined
          }
          onRead={
            canSpeak
              ? () => {
                  toggleRead(held.key, held.text)
                  closeMenu(false)
                }
              : undefined
          }
          onReadAll={
            canSpeak && held.all !== undefined
              ? () => {
                  // Synchronous from the tap, as Read aloud is; it takes over from whatever was being read.
                  speakReply(speakPrefix + held.key, held.all ?? held.text)
                  closeMenu(false)
                }
              : undefined
          }
          onSelect={
            held.selectable
              ? () => {
                  const bubble = heldEl.current
                  closeMenu(false)
                  if (!bubble) return
                  selecting.current = bubble
                  bubble.setAttribute('data-select', 'true')
                  setToast('Hold a word to select it')
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
            {/* A tick or a cross for how a copy went; any other line is only its words. */}
            {toast === 'Copied' || toast === 'Could not copy' ? (
              <Icon name={toast === 'Copied' ? 'check' : 'close'} size={16} />
            ) : null}
            <span>{toast}</span>
          </>
        ) : null}
      </div>
    </div>
  )
})

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
      /** The last record's time, for the bubble: when the reply got to where it is. */
      at: number
      lastClock?: string
      segments: Segment[]
    }

type ReplyOf = Extract<Row, { kind: 'reply' }>

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
      reply = { kind: 'reply', key: turn.id, at: turn.at, lastClock: turn.clock, segments: [] }
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

/**
 * A reply's words, two ways. `all` is every paragraph of the turn — the
 * running commentary between tool calls included. `answer` is what the agent
 * said once it was done: the text after the last run of tool calls. A long
 * turn is one bubble, and reading it aloud from "I'll start by looking at…"
 * is a long wait for the result, so Copy and Read aloud take `answer`.
 *
 * When nothing follows the last tool call — the agent is still working, or
 * it ended on a tool — `answer` is `all`, so there is always something to
 * take. Thinking is neither: it is not said to the person.
 *
 * Exported for scripts/web-phone-six-check.mjs.
 */
export function pickAnswer(segments: readonly Segment[]): { answer: string; all: string } {
  const texts: string[] = []
  let sinceTools: string[] = []
  for (const segment of segments) {
    if (segment.kind === 'tools') sinceTools = []
    else if (segment.kind === 'text') {
      texts.push(segment.block.text)
      sinceTools.push(segment.block.text)
    }
  }
  const all = texts.join('\n\n')
  const answer = sinceTools.join('\n\n')
  return { answer: answer.trim() ? answer : all, all }
}

/*
 * Sameness, for the rows' memos. A transcript read from the session file
 * keeps its turn and block objects from one update to the next, so these are
 * identity checks that end at once. A chat read off the screen is rebuilt
 * whole on every parsed frame — new objects, the same words — and there the
 * comparison by value is what keeps every finished row from being drawn again
 * about twelve times a second while the last one streams.
 */

function sameBlock(a: ChatBlock, b: ChatBlock): boolean {
  if (a === b) return true
  if (a.kind === 'tool') {
    return b.kind === 'tool' && a.name === b.name && a.gist === b.gist && a.note === b.note && a.failed === b.failed
  }
  return b.kind !== 'tool' && a.kind === b.kind && a.text === b.text
}

function sameBlocks(a: readonly ChatBlock[], b: readonly ChatBlock[]): boolean {
  if (a === b) return true
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (!sameBlock(a[i]!, b[i]!)) return false
  return true
}

function sameSegment(a: Segment, b: Segment): boolean {
  if (a === b) return true
  if (a.key !== b.key) return false
  if (a.kind === 'text') return b.kind === 'text' && sameBlock(a.block, b.block)
  if (a.kind === 'thinking') return b.kind === 'thinking' && a.text === b.text
  return b.kind === 'tools' && sameBlocks(a.tools, b.tools)
}

function sameReply(a: ReplyOf, b: ReplyOf): boolean {
  if (a === b) return true
  if (a.key !== b.key || a.at !== b.at || a.lastClock !== b.lastClock) return false
  if (a.segments.length !== b.segments.length) return false
  for (let i = 0; i < a.segments.length; i++) if (!sameSegment(a.segments[i]!, b.segments[i]!)) return false
  return true
}

function sameTurn(a: ChatTurn, b: ChatTurn): boolean {
  if (a === b) return true
  return a.id === b.id && a.role === b.role && a.at === b.at && a.clock === b.clock && sameBlocks(a.blocks, b.blocks)
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
// a memo on the turn is all a prompt needs to stay cheap. The turn is compared
// by what it says (`sameTurn`): a chat read off the screen hands over a new
// object for the same prompt on every frame.
const UserRow = memo(
  function UserRow({
    turn,
    desk,
    tail,
    reading
  }: {
    turn: ChatTurn
    desk: boolean
    tail: boolean
    reading: boolean
  }): ReactNode {
    const text = textOf(turn)
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
          {desk ? <MoreButton mine /> : null}
        </div>
      </li>
    )
  },
  (a, b) => a.desk === b.desk && a.tail === b.tail && a.reading === b.reading && sameTurn(a.turn, b.turn)
)

/** Sent from this phone a moment ago; the transcript has not shown it yet. */
function PendingRow({ send, desk, tail }: { send: PendingSend; desk: boolean; tail: boolean }): ReactNode {
  const time = timeOf(send.at)
  const blocks: ChatBlock[] = [{ kind: 'text', text: send.text }]
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
        {desk ? <MoreButton mine /> : null}
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
 *
 * The bubble's text — what its speaker reads and the menu's Copy takes — is
 * the turn's answer (`pickAnswer`), not the whole turn; the menu reads the
 * whole turn off the row for Copy all and Read all.
 *
 * Memoised on what the row says (`sameReply`): the rows are rebuilt each time
 * the transcript moves, and only the one that grew has anything to redraw.
 */
const ReplyRow = memo(
  function ReplyRow({
    row,
    agentName,
    desk,
    reading,
    onRead
  }: {
    row: ReplyOf
    agentName?: string
    desk: boolean
    reading: boolean
    /** Read this bubble aloud, or stop it (keyed by the row). Absent: this browser has no voice. */
    onRead?: (key: string, text: string) => void
  }): ReactNode {
    const text = pickAnswer(row.segments).answer
    const pieces = row.segments.map((segment) =>
      segment.kind === 'text' ? (
        <Prose key={segment.key} block={segment.block} />
      ) : segment.kind === 'thinking' ? (
        <ThoughtFold key={segment.key} text={segment.text} />
      ) : (
        <ToolGroup key={segment.key} tools={segment.tools} />
      )
    )
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
          {desk ? <MoreButton mine={false} /> : null}
        </div>
      </li>
    )
  },
  (a, b) =>
    a.agentName === b.agentName &&
    a.desk === b.desk &&
    a.reading === b.reading &&
    a.onRead === b.onRead &&
    sameReply(a.row, b.row)
)

/**
 * Read aloud, on the bubble: a speaker beside the time, a stop square in a
 * ring while this bubble is being read. Drawn larger than the time, on its line; its touch
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
        <svg width="30" height="30" viewBox="0 0 20 20" aria-hidden="true">
          <circle cx="10" cy="10" r="8.6" fill="none" stroke="currentColor" strokeWidth="1.6" />
          <rect x="6.5" y="6.5" width="7" height="7" rx="1.4" fill="currentColor" />
        </svg>
      ) : (
        <svg width="30" height="30" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M2.5 6h2.6L8.6 3v10L5.1 10H2.5z" />
          <path d="M11 5.6a3.4 3.4 0 0 1 0 4.8M12.9 3.8a6 6 0 0 1 0 8.4" />
        </svg>
      )}
    </button>
  )
}

/**
 * The deck's way into a bubble's menu without a right-click: three dots in a
 * circle just off the bubble's far side, at its top. Shown while the pointer is
 * on the row or the key is on it, and held on while its menu is open. The
 * chat's own click handler opens the menu, so the rows stay memo-cheap.
 */
function MoreButton({ mine }: { mine: boolean }): ReactNode {
  return (
    <button
      type="button"
      className="chatview__more"
      data-bubble-more="true"
      aria-haspopup="menu"
      aria-expanded={false}
      aria-label={mine ? 'Message options' : 'Reply options'}
      title={mine ? 'Copy, read aloud, send again' : 'Copy, read aloud'}
    >
      <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
        <circle cx="3.2" cy="8" r="1.45" fill="currentColor" />
        <circle cx="8" cy="8" r="1.45" fill="currentColor" />
        <circle cx="12.8" cy="8" r="1.45" fill="currentColor" />
      </svg>
    </button>
  )
}

/** Who is talking: the agent's name, once per change of speaker. */
function Speaker({ agentName }: { agentName?: string }): ReactNode {
  return (
    <div className="chatview__speaker">
      <span className="chatview__speaker-dot" aria-hidden="true" />
      <span className="chatview__speaker-name">{agentName ?? 'Assistant'}</span>
    </div>
  )
}

// The block object is stable for the life of its turn, so the markdown parse
// runs once per paragraph however many times the reply around it grows. A
// block read off the screen is a new object each frame; the same words there
// are the same paragraph, and are not parsed again either.
const Prose = memo(
  function Prose({ block }: { block: TextBlock }): ReactNode {
    return <div className="chatview__prose">{renderMarkdown(block.text)}</div>
  },
  (a, b) => a.block === b.block || a.block.text === b.block.text
)

/* -------------------------------------------------------- the hold menu */

/**
 * What a held bubble offers: Copy, Read aloud (Stop reading while it is), and
 * on your own bubble Send again. On a reply whose answer came after tool
 * calls those two take the answer, and Copy all / Read all take the whole
 * turn. On a touch screen, Select text. Icons with words, 48px rows, over a
 * clear layer that takes the next tap anywhere else as "never mind".
 */
function BubbleMenu({
  held,
  reading,
  onClose,
  onCopy,
  onCopyAll,
  onRead,
  onReadAll,
  onSelect,
  onSendAgain
}: {
  held: Held
  reading: boolean
  onClose: (refocus: boolean) => void
  onCopy: () => void
  /** Copy the whole turn. Absent: Copy already takes all of it. */
  onCopyAll?: () => void
  onRead?: () => void
  /** Read the whole turn. Absent: Read aloud already reads all of it, or there is no voice. */
  onReadAll?: () => void
  /** Let this bubble's text be selected. Absent: it already can be (a mouse). */
  onSelect?: () => void
  onSendAgain?: () => void
}): ReactNode {
  const menu = useRef<HTMLDivElement | null>(null)
  const [place, setPlace] = useState<CSSProperties>({ visibility: 'hidden' })

  // Above the finger when there is room, below when not; kept inside the chat.
  // Off the ⋯ it drops below the button, and rises above it only when it must.
  useLayoutEffect(() => {
    const el = menu.current
    const box = el?.parentElement?.getBoundingClientRect()
    if (!el || !box) return
    const h = el.offsetHeight
    const w = el.offsetWidth
    const gap = 12
    const top =
      held.above !== undefined
        ? held.y + 4 + h <= box.height - gap
          ? held.y + 4
          : held.above - h - 4
        : held.y - h - gap >= gap
          ? held.y - h - gap
          : Math.min(held.y + gap, box.height - h - gap)
    const edge = Math.max(gap, Math.min(held.x, box.width - w - gap))
    setPlace(held.side === 'left' ? { top: Math.max(gap, top), left: edge } : { top: Math.max(gap, top), right: edge })
  }, [held])

  // The first item takes the key once the menu is placed: while it is still
  // hidden for measuring, a focus() is refused and the key stays behind it.
  useEffect(() => {
    if (place.visibility === 'hidden') return
    menu.current?.querySelector<HTMLButtonElement>('button')?.focus({ preventScroll: true })
  }, [place])

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    // Tab leaves a menu the way Escape does: shut, and back where it came from.
    if (event.key === 'Escape' || event.key === 'Tab') {
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
        {onCopyAll ? (
          <button type="button" role="menuitem" className="chatview__menu-item" onClick={onCopyAll}>
            <Icon name="clipboard" size={20} />
            <span>Copy all</span>
          </button>
        ) : null}
        {onRead ? (
          <button type="button" role="menuitem" className="chatview__menu-item" onClick={onRead}>
            {reading ? <StopGlyph /> : <Speaker16Large />}
            <span>{reading ? 'Stop reading' : 'Read aloud'}</span>
          </button>
        ) : null}
        {onReadAll && !reading ? (
          <button type="button" role="menuitem" className="chatview__menu-item" onClick={onReadAll}>
            <Speaker16Large />
            <span>Read all</span>
          </button>
        ) : null}
        {onSelect ? (
          <button type="button" role="menuitem" className="chatview__menu-item" onClick={onSelect}>
            <SelectGlyph />
            <span>Select text</span>
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

/** A text caret between its two serifs: "Select text". */
function SelectGlyph(): ReactNode {
  return (
    <svg width="20" height="20" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M8 3.2v9.6M5.6 2.4c1.2 0 2.4.4 2.4.8 0-.4 1.2-.8 2.4-.8M5.6 13.6c1.2 0 2.4-.4 2.4-.8 0 .4 1.2.8 2.4.8" />
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
 * The agent mid-turn: a "typing" bubble — what it says it is doing and three
 * dots breathing in turn. On the phone how long it has been at it is the
 * status row's clock just below, so there is one clock, not two that
 * disagree; on the desk the bubble keeps its own count. Either way only the
 * words are in the live region: a screen reader hears "Thinking", not a
 * number every second.
 */

function Working({
  activity,
  agentName,
  named,
  counted
}: {
  activity?: string
  agentName?: string
  /** Nothing of this reply is on the page yet, so say who is working. */
  named: boolean
  /** Count the turn's seconds in the bubble (the desk; the phone's status row has the clock). */
  counted: boolean
}): ReactNode {
  const label = (activity ?? 'Thinking').replace(/[…:.]+$/, '')
  return (
    <div className="chatview__busy-turn" data-tail={named ? 'true' : undefined}>
      <div className="chatview__busy-bubble">
        {named ? <Speaker agentName={agentName} /> : null}
        <span className="chatview__busy-line">
          <span className="chatview__busy-label" role="status" aria-live="polite">
            {label}
          </span>
          <span className="chatview__busy-dots" aria-hidden="true">
            <span />
            <span />
            <span />
          </span>
          {counted ? <Elapsed /> : null}
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
