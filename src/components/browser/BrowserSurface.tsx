import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { AgentProfile } from '@shared/types'
import type { BrowserSurfaceInfo, BrowserViewBounds } from '@shared/browser'
import { commandExe } from '@shared/agents'
import { AgentBadge } from '../AgentBadge'
import { browserBridge } from './bridge'
import './browser.css'

/**
 * One browser surface: a slim toolbar and a placeholder the real page is laid
 * over.
 *
 * The page is not in this DOM. It is an Electron WebContentsView that main
 * positions over `.browser-surface__view`, so this component's whole job for
 * the page is to report where that placeholder is, every frame it moves (canvas
 * pan, zoom, resize), and to say "hide" when it is scrolled out of the window,
 * `hidden` (an overlay is open on top), or unmounted. Anything drawn over the
 * placeholder by the renderer would be *under* the page — so while a menu or
 * dialog covers a surface, the owner of that overlay passes `hidden`.
 *
 * The toolbar says who is driving in words, not colour alone: "Rex is driving"
 * with the agent's badge, or "Yours" for a tab Steve opened.
 */

interface Props {
  surface: BrowserSurfaceInfo
  /** Agent profiles, to draw the driving agent's badge. Optional. */
  profiles?: AgentProfile[]
  /** Canvas zoom — the page is zoomed to match. */
  scale?: number
  /** Hide the page (an overlay covers the surface). */
  hidden?: boolean
  onClose?: (id: string) => void
}

function sameBounds(a: BrowserViewBounds | null, b: BrowserViewBounds | null): boolean {
  if (!a || !b) return a === b
  return a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height && a.scale === b.scale
}

function OwnerChip({ surface, profiles }: { surface: BrowserSurfaceInfo; profiles?: AgentProfile[] }): ReactNode {
  const { owner } = surface
  if (owner.id === 'user') {
    return <span className="browser-surface__owner" data-owner="user">Yours</span>
  }
  const profile = owner.agent ? profiles?.find((p) => commandExe(p.command) === owner.agent) : undefined
  return (
    <span className="browser-surface__owner" title={owner.agent ? `${owner.label} — ${owner.agent}` : owner.label}>
      {profile ? (
        <AgentBadge profile={profile} size="sm" />
      ) : (
        <span className="browser-surface__owner-mark" aria-hidden="true">
          {(owner.agent || owner.label).slice(0, 2).toUpperCase()}
        </span>
      )}
      <span className="browser-surface__owner-name">{owner.label || 'Agent'}</span>
      <span className="browser-surface__owner-verb">is driving</span>
    </span>
  )
}

export function BrowserSurface({ surface, profiles, scale = 1, hidden = false, onClose }: Props): ReactNode {
  const viewRef = useRef<HTMLDivElement | null>(null)
  const [draft, setDraft] = useState<string | null>(null)
  const id = surface.id

  // Report the placeholder's box every frame it changes. getBoundingClientRect
  // already includes the canvas transform, so pan and zoom need nothing extra.
  useEffect(() => {
    const api = browserBridge()
    if (!api) return
    let last: BrowserViewBounds | null = null
    let frame = 0
    const tick = (): void => {
      frame = requestAnimationFrame(tick)
      const el = viewRef.current
      let next: BrowserViewBounds | null = null
      if (el && !hidden && document.visibilityState === 'visible') {
        const r = el.getBoundingClientRect()
        const onScreen = r.width >= 2 && r.height >= 2 && r.right > 0 && r.bottom > 0 && r.left < window.innerWidth && r.top < window.innerHeight
        if (onScreen) {
          next = { x: Math.round(r.left), y: Math.round(r.top), width: Math.round(r.width), height: Math.round(r.height), scale }
        }
      }
      if (!sameBounds(last, next)) {
        last = next
        api.setBounds(id, next)
      }
    }
    frame = requestAnimationFrame(tick)
    return () => {
      cancelAnimationFrame(frame)
      api.setBounds(id, null)
    }
  }, [id, hidden, scale])

  const api = browserBridge()
  const go = (): void => {
    const target = (draft ?? '').trim()
    setDraft(null)
    if (target && api) void api.navigate(id, target)
  }

  return (
    <section className="browser-surface" data-loading={surface.loading ? 'true' : undefined} aria-label={`Browser tab ${surface.title || surface.url}`}>
      <header className="browser-surface__bar">
        <button
          type="button"
          className="browser-surface__btn"
          title="Back"
          aria-label="Back"
          disabled={!surface.canGoBack}
          onClick={() => void api?.history(id, 'back')}
        >
          ←
        </button>
        <button
          type="button"
          className="browser-surface__btn"
          title="Forward"
          aria-label="Forward"
          disabled={!surface.canGoForward}
          onClick={() => void api?.history(id, 'forward')}
        >
          →
        </button>
        <button
          type="button"
          className="browser-surface__btn"
          title={surface.loading ? 'Stop loading' : 'Reload'}
          aria-label={surface.loading ? 'Stop loading' : 'Reload'}
          onClick={() => void api?.history(id, surface.loading ? 'stop' : 'reload')}
        >
          {surface.loading ? '✕' : '↻'}
        </button>
        <input
          className="browser-surface__url"
          spellCheck={false}
          aria-label="Address"
          value={draft ?? surface.url}
          onFocus={(e) => {
            setDraft(surface.url)
            e.currentTarget.select()
          }}
          onChange={(e) => setDraft(e.currentTarget.value)}
          onBlur={() => setDraft(null)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              go()
              e.currentTarget.blur()
            } else if (e.key === 'Escape') {
              setDraft(null)
              e.currentTarget.blur()
            }
          }}
        />
        {surface.loading ? <span className="browser-surface__state">Loading…</span> : null}
        <OwnerChip surface={surface} profiles={profiles} />
        {onClose ? (
          <button
            type="button"
            className="browser-surface__btn browser-surface__close"
            title="Close tab"
            aria-label="Close tab"
            onClick={() => onClose(id)}
          >
            ×
          </button>
        ) : null}
      </header>
      <div ref={viewRef} className="browser-surface__view" data-browser-id={id}>
        {!api ? <p className="browser-surface__missing">Restart Forge to use the built-in browser.</p> : null}
      </div>
    </section>
  )
}
