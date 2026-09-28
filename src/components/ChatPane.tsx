import { useEffect, useRef, useState, type CSSProperties, type ReactNode, type RefObject } from 'react'
import type { ChatViewBounds } from '@shared/api'
import type { ChatLeaf } from '@shared/types'
import { CHATBOTS, type ChatBotId } from '@shared/chatbots'
import { chatBridge, signInWord, useChatSignIn, useChatViewState } from '@/lib/chat'
import { useActions, useActiveWorkspace } from '@/state/AppState'
import { COVERS, TRIMS } from './browser/overlays'
import { ChatMark } from './ChatMark'
import { Icon } from './Icon'
import './ChatPane.css'

/**
 * A chat tab on screen: a bar in the bot's own colours and, under it, the
 * placeholder the real chatbot website is laid over.
 *
 * The page is not in this DOM. It is an Electron WebContentsView
 * (electron/chat-panes/views.ts) in the browser's signed-in session, which
 * main positions over `.chat-stage__view` — the built-in browser's trick
 * (browser/BrowserSurface.tsx), copied rather than shared so the browser is
 * left exactly as it is. So the job here is to report where the placeholder
 * is, and when not to show the page:
 *
 *   moving    while the box is still changing (a glide, a tile being dragged,
 *             the window resizing) the page hides, and comes back at the
 *             settled box ~90 ms later.
 *   covered   a pop-up, menu or sheet over the box hides it (./browser/
 *             overlays.ts); the dock's risers trim its bottom edge, and Full
 *             screen's Previous / Next paddles its sides. On the
 *             Wall a tile dragged across it hides it too, and the wall's own
 *             scroll box trims it.
 *   hidden    the owner says so.
 *   failed    the last load did not happen: the card says "Failed" and why.
 *
 * The bar says what this is in words — "Claude · Chat" and "Signed in" or
 * "Not signed in" — so a chat is never mistaken for a CLI, and no state is
 * colour alone.
 */

/** How long the box must hold still before the page is shown on it. */
const SETTLE_MS = 90

/**
 * Full screen's Previous / Next paddles (shell/PaneCarousel), at the stage's
 * left and right edges. The page would be drawn over them, so it stops short
 * of them instead. Only Full screen mounts them, only with two stops or more.
 */
const SIDE_TRIMS = '.pcar__btn'

function same(a: ChatViewBounds | null, b: ChatViewBounds | null): boolean {
  if (!a || !b) return a === b
  return a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height
}

function overlaps(a: { left: number; right: number; top: number; bottom: number }, b: DOMRect): boolean {
  return a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom
}

/** The bot's paint as CSS custom properties, for a bar or a tile. */
export function chatPaint(bot: ChatBotId): CSSProperties {
  const tab = CHATBOTS[bot].tab
  return { '--chat-bg': tab.background, '--chat-ink': tab.ink, '--chat-border': tab.border ?? 'transparent' } as CSSProperties
}

/**
 * Keep the leaf's page made, and laid over `viewRef` whenever it may be seen.
 * `clip` names an ancestor whose box the page is trimmed to (the Wall's scroll
 * box). Returns whether the page is on screen now.
 */
export function useChatPlacement(
  chat: ChatLeaf,
  viewRef: RefObject<HTMLElement | null>,
  { hidden = false, failed = false, clip }: { hidden?: boolean; failed?: boolean; clip?: string }
): boolean {
  const [shown, setShown] = useState(false)
  const { id, bot } = chat

  useEffect(() => {
    chatBridge()?.ensure?.(id, bot)
  }, [id, bot])

  useEffect(() => {
    const api = chatBridge()
    if (!api?.bounds) return
    let sent: ChatViewBounds | null = null
    let seen: ChatViewBounds | null = null
    let stillSince = 0
    let frame = 0
    const send = (next: ChatViewBounds | null): void => {
      if (same(sent, next)) return
      sent = next
      api.bounds(id, next)
      setShown(next !== null)
    }
    const measure = (): ChatViewBounds | null => {
      const el = viewRef.current
      if (!el || hidden || failed || document.visibilityState !== 'visible') return null
      const r = el.getBoundingClientRect()
      const box = { left: r.left, top: r.top, right: r.right, bottom: r.bottom }
      if (clip) {
        const c = el.closest(clip)?.getBoundingClientRect()
        if (c) {
          box.left = Math.max(box.left, c.left)
          box.top = Math.max(box.top, c.top)
          box.right = Math.min(box.right, c.right)
          box.bottom = Math.min(box.bottom, c.bottom)
        }
      }
      box.right = Math.min(box.right, window.innerWidth)
      box.bottom = Math.min(box.bottom, window.innerHeight)
      box.left = Math.max(box.left, 0)
      box.top = Math.max(box.top, 0)
      if (box.right - box.left < 60 || box.bottom - box.top < 60) return null
      for (const o of document.querySelectorAll<HTMLElement>(COVERS)) {
        if (overlaps(box, o.getBoundingClientRect())) return null
      }
      // A Wall tile on the move — this one, or another dragged over it — is
      // drawn by the renderer, so under the page: get out of its way.
      for (const o of document.querySelectorAll<HTMLElement>('.mtile[data-dragging]')) {
        if (o.contains(el) || overlaps(box, o.getBoundingClientRect())) return null
      }
      for (const o of document.querySelectorAll<HTMLElement>(TRIMS)) {
        const b = o.getBoundingClientRect()
        if (overlaps(box, b)) box.bottom = Math.min(box.bottom, b.top - 8)
      }
      for (const o of document.querySelectorAll<HTMLElement>(SIDE_TRIMS)) {
        const b = o.getBoundingClientRect()
        if (!overlaps(box, b)) continue
        // The paddle's laid-out edges, not its pressed-in scale, so a click
        // does not read as the box moving and blink the page off.
        const left = (o.offsetParent?.getBoundingClientRect().left ?? b.left) + o.offsetLeft
        const right = left + o.offsetWidth
        if (left + right < box.left + box.right) box.left = Math.max(box.left, right + 8)
        else box.right = Math.min(box.right, left - 8)
      }
      if (box.right - box.left < 60) return null
      if (box.bottom - box.top < 60) return null
      return {
        x: Math.round(box.left),
        y: Math.round(box.top),
        width: Math.round(box.right - box.left),
        height: Math.round(box.bottom - box.top)
      }
    }
    const tick = (now: number): void => {
      frame = requestAnimationFrame(tick)
      const next = measure()
      if (!next) {
        seen = null
        send(null)
        return
      }
      if (!same(seen, next)) {
        // Moving: take the page off the screen until the box holds still.
        seen = next
        stillSince = now
        if (sent && (sent.width !== next.width || sent.height !== next.height || Math.abs(sent.x - next.x) + Math.abs(sent.y - next.y) > 1)) send(null)
        return
      }
      if (now - stillSince >= SETTLE_MS) send(next)
    }
    frame = requestAnimationFrame(tick)
    return () => {
      cancelAnimationFrame(frame)
      api.bounds(id, null)
    }
  }, [id, hidden, failed, clip, viewRef])

  return shown
}

/** "Signed in" / "Not signed in" / "Checking…", as a word with a shape. */
export function ChatSignInWord({ bot, className = 'chat-signin' }: { bot: ChatBotId; className?: string }): ReactNode {
  const s = useChatSignIn(bot)
  return (
    <span className={className} data-state={s} title={`${CHATBOTS[bot].name} in Forge: ${signInWord(s)}. Settings → Chatbots to sign in or out.`}>
      <span className="chat-signin__shape" aria-hidden="true">
        {s === 'signed-in' ? '✓' : s === 'signed-out' ? '○' : '…'}
      </span>
      {signInWord(s)}
    </span>
  )
}

/** Back, Reload, Home — the page's own controls, drawn in the bar's ink. */
export function ChatNavButtons({ chat, canGoBack, className }: { chat: ChatLeaf; canGoBack: boolean; className: string }): ReactNode {
  const nav = (action: 'back' | 'reload' | 'home'): void => chatBridge()?.nav?.(chat.id, action)
  return (
    <>
      <button type="button" className={className} title="Back" aria-label="Back" disabled={!canGoBack} onClick={() => nav('back')}>
        <Icon name="chevronLeft" size={13} />
      </button>
      <button type="button" className={className} title="Reload" aria-label="Reload" onClick={() => nav('reload')}>
        <Icon name="refresh" size={12} />
      </button>
      <button
        type="button"
        className={className}
        title={`Home — a new ${CHATBOTS[chat.bot].name} chat`}
        aria-label="Home"
        onClick={() => nav('home')}
      >
        <svg width={13} height={13} viewBox="0 0 16 16" aria-hidden="true" focusable="false" className="chat-home">
          <path d="M2.5 7.5 8 3l5.5 4.5M4 6.5V13h3V9.5h2V13h3V6.5" />
        </svg>
      </button>
    </>
  )
}

/**
 * The placeholder the page is laid over, and the card seen while the page is
 * off it — calm, in the bot's name, saying why when a load failed.
 */
export function ChatStage({
  chat,
  hidden = false,
  clip,
  error
}: {
  chat: ChatLeaf
  hidden?: boolean
  clip?: string
  error: string
}): ReactNode {
  const viewRef = useRef<HTMLDivElement | null>(null)
  const failed = Boolean(error)
  const shown = useChatPlacement(chat, viewRef, { hidden, failed, ...(clip ? { clip } : {}) })
  const entry = CHATBOTS[chat.bot]
  const missing = !chatBridge()
  return (
    <div ref={viewRef} className="chat-stage__view" data-chat-id={chat.id} data-shown={shown ? 'true' : undefined}>
      <div className="chat-stage__card" data-failed={failed ? 'true' : undefined}>
        <ChatMark bot={chat.bot} />
        <span className="chat-stage__name">{entry.name} · Chat</span>
        {missing ? (
          <span className="chat-stage__note">Restart Forge to use chat tabs.</span>
        ) : failed ? (
          <span className="chat-stage__note" role="status">
            <strong>Failed</strong> — {error}. Reload to try again.
          </span>
        ) : (
          <span className="chat-stage__note">{new URL(entry.homeUrl).host}</span>
        )}
      </div>
    </div>
  )
}

/**
 * The Full screen pane for a chat tab (SplitView mounts it for a chat root).
 * A tab holds exactly one chat, so its close button closes the tab.
 */
export function ChatPane({ chat, focused }: { chat: ChatLeaf; focused: boolean }): ReactNode {
  const actions = useActions()
  const workspace = useActiveWorkspace()
  const tab = workspace.tabs.find((t) => t.root.type === 'chat' && t.root.id === chat.id) ?? null
  const view = useChatViewState(chat.id)
  const entry = CHATBOTS[chat.bot]

  return (
    <section
      className="pane chat-pane"
      data-pane-id={chat.id}
      data-flip={chat.id}
      data-focused={focused}
      data-chat-bot={chat.bot}
      aria-label={`${entry.name} chat`}
      style={chatPaint(chat.bot)}
    >
      <header className="chat-bar">
        <ChatMark bot={chat.bot} size="sm" bare bubble={false} />
        <span className="chat-bar__name">{entry.name}</span>
        <span className="chat-bar__kind">
          <span aria-hidden="true">·</span> Chat
        </span>
        <ChatSignInWord bot={chat.bot} />
        {view.loading ? <span className="chat-bar__state">Loading…</span> : null}
        {view.error ? (
          <span className="chat-bar__state" data-state="failed" title={view.error}>
            Failed
          </span>
        ) : null}
        <span className="chat-bar__spacer" />
        <ChatNavButtons chat={chat} canGoBack={view.canGoBack} className="chat-bar__btn" />
        {tab ? (
          <button
            type="button"
            className="chat-bar__btn"
            title="Close this chat tab"
            aria-label={`Close ${entry.name} chat`}
            onClick={() => actions.closeTab(tab.id)}
          >
            <Icon name="close" size={12} />
          </button>
        ) : null}
      </header>
      <ChatStage chat={chat} error={view.error} />
    </section>
  )
}
