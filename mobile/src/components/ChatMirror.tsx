import { useEffect, useLayoutEffect, useRef, useState, type FormEvent } from 'react'
import { CHATBOTS } from '@shared/chatbots'
import { mapToPage, scaleToPage, type ChatStatus, type Size } from '@shared/chat-mirror'
import type { ChatLeaf } from '@shared/types'
import type { Link } from '../lib/link'
import { ChatBotMark, chatTabStyle } from './ChatBadge'
import './ChatMirror.css'

/**
 * A chat tab (shared/chatbots.ts) on the phone: a live picture of the chat page
 * the desktop keeps for this phone, sized to this box, so the site draws the
 * layout it would draw on a phone. Taps land where they are made, a vertical
 * drag scrolls, and the box at the foot types into the site's own message box
 * and presses Enter. The phone's port of web/src/components/ChatMirror.tsx;
 * see shared/chat-mirror.ts for the wire and electron/chat-panes/phone-mirror.ts
 * for the desktop half.
 *
 * Watched only while on screen: leaving this screen, or the app going to the
 * background, lets the desktop stop drawing it.
 */

/** A finger that moves further than this is scrolling, not tapping. */
const TAP_SLOP_PX = 8
/** A box has to hold its size this long before the desktop is asked to redraw at it. */
const RESIZE_SETTLE_MS = 250

type Shown = 'update' | 'reconnecting' | ChatStatus

const STATE_WORD: Record<Shown, string> = {
  update: 'Needs update',
  reconnecting: 'Reconnecting',
  loading: 'Loading',
  live: 'Live',
  error: "Can't reach it"
}

/** Each state as a shape as well as a word: a filled dot, a dashed ring, a ring, a cross. */
function StateGlyph({ state }: { state: Shown }): React.JSX.Element {
  return (
    <svg className="chat-mirror-glyph" width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
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

/** Whether the app is on screen. A backgrounded phone watches nothing. */
function useVisible(): boolean {
  const [visible, setVisible] = useState(() => document.visibilityState !== 'hidden')
  useEffect(() => {
    const read = (): void => setVisible(document.visibilityState !== 'hidden')
    document.addEventListener('visibilitychange', read)
    return () => document.removeEventListener('visibilitychange', read)
  }, [])
  return visible
}

export interface ChatMirrorProps {
  link: Link
  leaf: ChatLeaf
  /** The link is up (`LinkState` 'live'). */
  live: boolean
  /** The desktop advertised CHAT_MIRROR_FEATURE. */
  supported: boolean
  onBack: () => void
}

export function ChatMirror({ link, leaf, live, supported, onBack }: ChatMirrorProps): React.JSX.Element {
  const visible = useVisible()
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
  const watching = visible && live && supported && width >= 50 && height >= 50

  useEffect(() => {
    if (!watching) return undefined
    const dpr = Math.min(2, Math.max(1, window.devicePixelRatio || 1))
    return link.watchChat(
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
  }, [watching, link, leaf.id, width, height])

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
    if (pageDy !== 0) link.sendChatInput({ leafId: leaf.id, kind: 'scroll', x: at.x, y: at.y, dy: pageDy })
  }

  const canTouch = watching && pictured

  /* -------------------------------------------------------------- typing */

  const send = (e?: FormEvent): void => {
    e?.preventDefault()
    const text = draft.trim()
    if (!text || !canTouch) return
    setError('')
    link.focusChatComposer(leaf.id)
    link.sendChatInput({ leafId: leaf.id, kind: 'text', text })
    link.sendChatInput({ leafId: leaf.id, kind: 'key', key: 'Enter' })
    setDraft('')
  }

  const notice = !supported
    ? 'The Forge on the desktop is older than this app, so it cannot show chats here yet. Restart Forge on the desktop.'
    : !live
      ? 'The link to the desktop dropped. The chat comes back when it reconnects.'
      : status === 'error'
        ? error || `Can't reach ${bot.name} from the desktop.`
        : !pictured
          ? `Opening ${bot.name} on the desktop…`
          : ''

  return (
    <div className="chat-mirror" data-state={shown}>
      <header className="chat-mirror-bar" style={chatTabStyle(leaf.bot)}>
        <button type="button" className="chat-mirror-back" onClick={onBack} aria-label="Back">
          ‹
        </button>
        <ChatBotMark bot={leaf.bot} size={20} />
        <span className="chat-mirror-name">{bot.name}</span>
        <span className="chat-mirror-kind">· Chat</span>
        <span className="chat-mirror-state" role="status" data-state={shown}>
          <StateGlyph state={shown} />
          {STATE_WORD[shown]}
        </span>
      </header>

      <div
        ref={stageRef}
        className="chat-mirror-stage"
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
          if (at) link.sendChatInput({ leafId: leaf.id, kind: 'tap', x: at.x, y: at.y })
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
        <img ref={imgRef} className="chat-mirror-picture" alt={`${bot.name}, as the desktop shows it`} draggable={false} />
        {notice ? <p className="chat-mirror-notice">{notice}</p> : null}
      </div>

      {error && status !== 'error' ? <p className="chat-mirror-hint">{error}</p> : null}

      <form className="chat-mirror-compose" onSubmit={send}>
        <textarea
          className="chat-mirror-input"
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
          className="chat-mirror-send"
          disabled={!canTouch || !draft.trim()}
          title={canTouch ? `Send to ${bot.name}` : `${bot.name} is not showing yet`}
        >
          Send
        </button>
      </form>
    </div>
  )
}
