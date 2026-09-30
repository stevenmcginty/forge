import { useEffect, useLayoutEffect, useRef, useState, type FormEvent, type ReactNode } from 'react'
import { CHATBOTS } from '@shared/chatbots'
import { CHAT_MIRROR_FEATURE, mapToPage, scaleToPage, type ChatStatus, type Size } from '@shared/chat-mirror'
import type { ChatLeaf } from '@shared/types'
import { Icon } from '@/components/Icon'
import { focusChatComposer, sendChatInput, watchChat } from '../lib/client'
import { useDeskFeature } from '../lib/features'
import { useForge } from '../state'
import { ChatBotMark, ChatTabChip, chatTabStyle } from './ChatBadge'
import './ChatMirror.css'

/**
 * A chat tab (shared/chatbots.ts) in a browser: a live picture of the chat page
 * the desktop keeps for this browser, sized to this box, so the site draws the
 * layout it would draw on a phone. Taps land where they are made, a vertical
 * drag scrolls, and the box at the foot types into the site's own message box
 * and presses Enter. See shared/chat-mirror.ts for the wire and
 * electron/chat-panes/phone-mirror.ts for the desktop half.
 *
 * Watched only while on screen: a hidden tab costs the desktop nothing.
 */

/** A finger that moves further than this is scrolling, not tapping. */
const TAP_SLOP_PX = 8
/** A box has to hold its size this long before the desktop is asked to redraw at it. */
const RESIZE_SETTLE_MS = 250
/** How long "Opening…" may stand with no picture before the screen says so and offers a retry. */
const OPEN_TIMEOUT_MS = 15_000

type Shown = 'update' | 'reconnecting' | ChatStatus

const STATE_WORD: Record<Shown, string> = {
  update: 'Needs update',
  reconnecting: 'Reconnecting',
  loading: 'Loading',
  live: 'Live',
  error: "Can't reach it"
}

/** Each state as a shape as well as a word: a filled dot, a dashed ring, a ring, a cross. */
function StateGlyph({ state }: { state: Shown }): ReactNode {
  return (
    <svg className="chat-mirror__glyph" width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
      {state === 'live' ? <circle cx="5" cy="5" r="3.6" fill="currentColor" /> : null}
      {state === 'loading' || state === 'reconnecting' ? (
        <circle cx="5" cy="5" r="3.4" fill="none" stroke="currentColor" strokeWidth="1.4" strokeDasharray="2 1.6" />
      ) : null}
      {state === 'update' ? <circle cx="5" cy="5" r="3.4" fill="none" stroke="currentColor" strokeWidth="1.4" /> : null}
      {state === 'error' ? (
        <path d="M2 2 L8 8 M8 2 L2 8" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
      ) : null}
    </svg>
  )
}

export function ChatMirror({ leaf, onScreen }: { leaf: ChatLeaf; onScreen: boolean }): ReactNode {
  const { state } = useForge()
  const live = state.stage.kind === 'connected' && state.connection.state === 'live'
  const supported = useDeskFeature(CHAT_MIRROR_FEATURE)
  const bot = CHATBOTS[leaf.bot]

  const stageRef = useRef<HTMLDivElement | null>(null)
  const imgRef = useRef<HTMLImageElement | null>(null)
  /** The page's CSS size the picture on screen shows — what a tap maps onto. */
  const pageRef = useRef<Size>({ width: 0, height: 0 })
  const [box, setBox] = useState<Size | null>(null)
  const [status, setStatus] = useState<ChatStatus>('loading')
  const [error, setError] = useState('')
  const [pictured, setPictured] = useState(false)
  const [draft, setDraft] = useState('')
  /** Bumped by Retry: a fresh watch — the desktop is told to stop and start again. */
  const [again, setAgain] = useState(0)
  /** Opening has run past OPEN_TIMEOUT_MS with no picture. */
  const [stalled, setStalled] = useState(false)

  // The box, measured; a change is passed on once it has held still.
  useLayoutEffect(() => {
    const el = stageRef.current
    if (!el) return undefined
    let timer = 0
    const read = (): Size => {
      const r = el.getBoundingClientRect()
      return { width: Math.round(r.width), height: Math.round(r.height) }
    }
    setBox(read())
    const observer = new ResizeObserver(() => {
      window.clearTimeout(timer)
      timer = window.setTimeout(() => {
        const next = read()
        setBox((prev) => (prev && prev.width === next.width && prev.height === next.height ? prev : next))
      }, RESIZE_SETTLE_MS)
    })
    observer.observe(el)
    return () => {
      window.clearTimeout(timer)
      observer.disconnect()
    }
  }, [])

  const width = box?.width ?? 0
  const height = box?.height ?? 0
  const watching = onScreen && live && supported && width >= 50 && height >= 50

  useEffect(() => {
    if (!watching) return undefined
    const dpr = Math.min(2, Math.max(1, window.devicePixelRatio || 1))
    return watchChat(
      leaf.id,
      { width, height, dpr },
      {
        onFrame: (frame) => {
          pageRef.current = { width: frame.width, height: frame.height }
          const img = imgRef.current
          if (img) img.src = `data:image/jpeg;base64,${frame.jpeg}`
          setPictured(true)
        },
        onState: (frame) => {
          setStatus(frame.status)
          setError(frame.error ?? '')
        }
      }
    )
  }, [watching, leaf.id, width, height, again])

  // "Opening…" is not allowed to stand for ever: past the timeout it says it
  // is slow and offers Retry. Counted afresh on every watch.
  useEffect(() => {
    setStalled(false)
    if (!watching || pictured || status === 'error') return undefined
    const timer = window.setTimeout(() => setStalled(true), OPEN_TIMEOUT_MS)
    return () => window.clearTimeout(timer)
  }, [watching, pictured, status, again])

  const retry = (): void => {
    setStatus('loading')
    setError('')
    setAgain((n) => n + 1)
  }

  const shown: Shown = !supported ? 'update' : !live ? 'reconnecting' : status

  /* ------------------------------------------------------------ gestures */

  const press = useRef<{ id: number; x: number; y: number; lastY: number; moved: boolean; owed: number } | null>(null)
  const flush = useRef(0)

  const pagePoint = (clientX: number, clientY: number): { x: number; y: number } | null => {
    const el = stageRef.current
    if (!el) return null
    const r = el.getBoundingClientRect()
    return mapToPage({ x: clientX - r.left, y: clientY - r.top }, { width: r.width, height: r.height }, pageRef.current)
  }

  const scrollBy = (clientX: number, clientY: number, dy: number): void => {
    const el = stageRef.current
    const at = pagePoint(clientX, clientY)
    if (!el || !at) return
    const r = el.getBoundingClientRect()
    const pageDy = scaleToPage(dy, { width: r.width, height: r.height }, pageRef.current)
    if (pageDy !== 0) sendChatInput({ leafId: leaf.id, kind: 'scroll', x: at.x, y: at.y, dy: pageDy })
  }

  const canTouch = watching && pictured

  /* -------------------------------------------------------------- typing */

  const send = (e?: FormEvent): void => {
    e?.preventDefault()
    const text = draft.trim()
    if (!text || !canTouch) return
    setError('')
    focusChatComposer(leaf.id)
    sendChatInput({ leafId: leaf.id, kind: 'text', text })
    sendChatInput({ leafId: leaf.id, kind: 'key', key: 'Enter' })
    setDraft('')
  }

  // Remote-safe on purpose: never "restart Forge" — from a phone that strands
  // the page for minutes while the tunnel is found again.
  const notice = !supported
    ? 'Forge on your PC is too old to show chats here. Update Forge on your PC when you are back.'
    : !live
      ? 'The link to your PC dropped. The chat comes back when it reconnects.'
      : status === 'error'
        ? error || `Can't reach ${bot.name} from your PC.`
        : !pictured
          ? stalled
            ? `${bot.name} is taking a long time to open on your PC.`
            : `Opening ${bot.name} on your PC…`
          : ''
  /** Retry is offered where a fresh watch can help: an error, or an open that stalled. */
  const canRetry = supported && live && (status === 'error' || (stalled && !pictured))

  return (
    <div className="chat-mirror" data-state={shown}>
      <div className="chat-mirror__bar" style={chatTabStyle(leaf.bot)}>
        <ChatBotMark bot={leaf.bot} size={18} />
        <span className="chat-mirror__name truncate">{bot.name}</span>
        <span className="chat-mirror__kind">Chat</span>
        <span className="chat-mirror__state" role="status" data-state={shown}>
          <StateGlyph state={shown} />
          {STATE_WORD[shown]}
        </span>
      </div>

      <div
        ref={stageRef}
        className="chat-mirror__stage"
        data-pictured={pictured ? 'true' : undefined}
        onPointerDown={(e) => {
          if (!canTouch || (e.pointerType === 'mouse' && e.button !== 0)) return
          e.currentTarget.setPointerCapture(e.pointerId)
          press.current = { id: e.pointerId, x: e.clientX, y: e.clientY, lastY: e.clientY, moved: false, owed: 0 }
        }}
        onPointerMove={(e) => {
          const p = press.current
          if (!p || p.id !== e.pointerId) return
          if (!p.moved && Math.hypot(e.clientX - p.x, e.clientY - p.y) > TAP_SLOP_PX) p.moved = true
          if (!p.moved) return
          p.owed += e.clientY - p.lastY
          p.lastY = e.clientY
          // One scroll a frame, carrying everything the finger did since the last.
          if (flush.current) return
          flush.current = window.requestAnimationFrame(() => {
            flush.current = 0
            const q = press.current
            if (!q || q.owed === 0) return
            scrollBy(q.x, q.y, q.owed)
            q.owed = 0
          })
        }}
        onPointerUp={(e) => {
          const p = press.current
          press.current = null
          if (!p || p.id !== e.pointerId) return
          if (p.moved) {
            if (p.owed !== 0) scrollBy(p.x, p.y, p.owed)
            return
          }
          const at = pagePoint(e.clientX, e.clientY)
          if (at) sendChatInput({ leafId: leaf.id, kind: 'tap', x: at.x, y: at.y })
        }}
        onPointerCancel={() => {
          press.current = null
        }}
        onWheel={(e) => {
          // A wheel's deltaY is positive towards the page's end; the wire's `dy`
          // is a finger's travel, positive towards its start.
          if (canTouch && e.deltaY !== 0) scrollBy(e.clientX, e.clientY, -e.deltaY)
        }}
      >
        <img ref={imgRef} className="chat-mirror__picture" alt={`${bot.name}, as the desktop shows it`} draggable={false} />
        {notice ? (
          // Its own pointer island: a press here is a press on Retry, never a
          // tap or a scroll relayed to the chat page underneath.
          <div className="chat-mirror__notice" onPointerDown={(e) => e.stopPropagation()}>
            <p>{notice}</p>
            {canRetry ? (
              <button type="button" className="chat-mirror__retry" onClick={retry} data-testid="chat-mirror-retry">
                <Icon name="refresh" size={16} />
                Retry
              </button>
            ) : null}
          </div>
        ) : null}
      </div>

      {error && status !== 'error' ? <p className="chat-mirror__hint">{error}</p> : null}

      <form className="chat-mirror__compose" onSubmit={send}>
        <textarea
          className="chat-mirror__input"
          rows={1}
          value={draft}
          placeholder={`Message ${bot.name}`}
          aria-label={`Message ${bot.name}`}
          enterKeyHint="send"
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) send(e)
          }}
        />
        <button
          type="submit"
          className="chat-mirror__send"
          disabled={!canTouch || !draft.trim()}
          title={canTouch ? `Send to ${bot.name}` : `${bot.name} is not showing yet`}
        >
          Send
        </button>
      </form>
    </div>
  )
}

/**
 * A chat tab on the deck's Wall: its label and a way in, not a live picture —
 * the desktop keeps only so many chat copies for browsers, and the Wall would
 * spend them all at once. Full screen shows the chat itself.
 */
export function ChatTile({ leaf, onOpen }: { leaf: ChatLeaf; onOpen: () => void }): ReactNode {
  return (
    <div className="chat-tile">
      <ChatTabChip bot={leaf.bot} />
      <button type="button" className="chat-tile__open" onClick={onOpen}>
        Open {CHATBOTS[leaf.bot].name}
      </button>
    </div>
  )
}
