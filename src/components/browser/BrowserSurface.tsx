import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { AgentProfile } from '@shared/types'
import { isArtifactUrl, type BrowserSurfaceInfo, type BrowserViewBounds } from '@shared/browser'
import { commandExe } from '@shared/agents'
import { AgentBadge } from '../AgentBadge'
import { Icon } from '../Icon'
import { browserBridge } from './bridge'
import './browser.css'

/**
 * One browser tab on screen: a glass toolbar and the placeholder the real page
 * is laid over.
 *
 * The page is not in this DOM. It is an Electron WebContentsView that main
 * positions over `.browser-surface__view`, so this component's whole job for
 * the page is to report where that placeholder is — and when not to show it:
 *
 *   moving     while the placeholder's box is still changing (a mode glide, a
 *              pane closing beside it, the window being resized) the view is
 *              hidden, and shown again at the settled box ~90 ms later. The
 *              native page never chases a transform frame by frame, so it is
 *              never seen stretched or lagging behind its frame.
 *   covered    the deck's pop-ups (settings, sheets, the cheat sheet, a
 *              popover) are drawn by the renderer, i.e. *under* the page, so
 *              while one overlaps the placeholder the view hides; the
 *              composer's palette and captions only trim the page's bottom
 *              edge up to where they start.
 *   hidden     the owner says so (another mode is on screen).
 *   failed     the last load did not happen. The page would be blank, so the
 *              card underneath says "Failed" and why, and the toolbar says it
 *              too, until a page loads.
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
  /** Hide the page (an overlay covers the surface, or another mode is up). */
  hidden?: boolean
  onClose?: (id: string) => void
}

/** How long the box must hold still before the page is shown on it. */
const SETTLE_MS = 90
/** Deck pop-ups that hide the page while they overlap it. */
const COVERS = '.spop, .cheat, .sheet, .popover, .blight'
/** Things that rise from the dock: the page's bottom edge stops above them. */
const TRIMS = '.cpal, .csave, .crail, .barrive, .dtoast'

function sameBounds(a: BrowserViewBounds | null, b: BrowserViewBounds | null): boolean {
  if (!a || !b) return a === b
  return a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height && a.scale === b.scale
}

function overlaps(a: DOMRect, b: DOMRect): boolean {
  return a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom
}

/** Who holds a tab, as a profile (for the logo) and the word to show. */
export function ownerOf(
  surface: BrowserSurfaceInfo,
  profiles?: AgentProfile[]
): { profile: AgentProfile | null; mark: string; name: string; mine: boolean } {
  const { owner } = surface
  if (owner.id === 'user') return { profile: null, mark: '', name: 'You', mine: true }
  const profile = owner.agent ? (profiles?.find((p) => commandExe(p.command) === owner.agent) ?? null) : null
  return {
    profile,
    mark: (owner.agent || owner.label || 'AG').slice(0, 2).toUpperCase(),
    name: owner.label || 'Agent',
    mine: false
  }
}

function OwnerChip({ surface, profiles }: { surface: BrowserSurfaceInfo; profiles?: AgentProfile[] }): ReactNode {
  const who = ownerOf(surface, profiles)
  if (who.mine) {
    return (
      <span className="browser-surface__owner" data-owner="user" title="You opened this tab">
        <span className="browser-surface__owner-mark" aria-hidden="true">
          ●
        </span>
        Yours
      </span>
    )
  }
  const { owner } = surface
  return (
    <span className="browser-surface__owner" title={owner.agent ? `${owner.label} — ${owner.agent}` : owner.label}>
      {who.profile ? (
        <AgentBadge profile={who.profile} size="sm" />
      ) : (
        <span className="browser-surface__owner-mark" aria-hidden="true">
          {who.mark}
        </span>
      )}
      <span className="browser-surface__owner-name">{who.name}</span>
      <span className="browser-surface__owner-verb">is driving</span>
    </span>
  )
}

/** "example.com" from an address, for the quiet card under the page. */
export function hostOf(url: string): string {
  try {
    return new URL(url).host || url
  } catch {
    return url
  }
}

export function BrowserSurface({ surface, profiles, scale = 1, hidden = false, onClose }: Props): ReactNode {
  const viewRef = useRef<HTMLDivElement | null>(null)
  const [draft, setDraft] = useState<string | null>(null)
  const [shown, setShown] = useState(false)
  const id = surface.id
  const failed = Boolean(surface.error) && !surface.loading

  // Report the placeholder's box once it has settled, hide the page while it
  // moves or while a pop-up covers it. getBoundingClientRect includes the
  // stage's transforms, so a glide reads as movement and waits it out.
  useEffect(() => {
    const api = browserBridge()
    if (!api) return
    let sent: BrowserViewBounds | null = null
    let seen: BrowserViewBounds | null = null
    let stillSince = 0
    let frame = 0
    const send = (next: BrowserViewBounds | null): void => {
      if (sameBounds(sent, next)) return
      sent = next
      api.setBounds(id, next)
      setShown(next !== null)
    }
    const measure = (): BrowserViewBounds | null => {
      const el = viewRef.current
      if (!el || hidden || failed || document.visibilityState !== 'visible') return null
      const r = el.getBoundingClientRect()
      const onScreen = r.width >= 2 && r.height >= 2 && r.right > 0 && r.bottom > 0 && r.left < window.innerWidth && r.top < window.innerHeight
      if (!onScreen) return null
      let bottom = r.bottom
      for (const o of document.querySelectorAll<HTMLElement>(COVERS)) {
        if (overlaps(r, o.getBoundingClientRect())) return null
      }
      for (const o of document.querySelectorAll<HTMLElement>(TRIMS)) {
        const b = o.getBoundingClientRect()
        if (overlaps(r, b)) bottom = Math.min(bottom, b.top - 8)
      }
      if (bottom - r.top < 60) return null
      return { x: Math.round(r.left), y: Math.round(r.top), width: Math.round(r.width), height: Math.round(bottom - r.top), scale }
    }
    const tick = (now: number): void => {
      frame = requestAnimationFrame(tick)
      const next = measure()
      if (!next) {
        seen = null
        send(null)
        return
      }
      if (!sameBounds(seen, next)) {
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
      api.setBounds(id, null)
    }
  }, [id, hidden, failed, scale])

  const api = browserBridge()
  const go = (): void => {
    const target = (draft ?? '').trim()
    setDraft(null)
    if (target && api) void api.navigate(id, target)
  }

  return (
    <section
      className="browser-surface"
      data-loading={surface.loading ? 'true' : undefined}
      data-failed={failed ? 'true' : undefined}
      aria-label={`Browser tab ${surface.title || surface.url}`}
    >
      <header className="browser-surface__bar">
        <span className="browser-surface__nav">
          <button
            type="button"
            className="browser-surface__btn"
            title="Back"
            aria-label="Back"
            disabled={!surface.canGoBack}
            onClick={() => void api?.history(id, 'back')}
          >
            <Icon name="chevronLeft" size={14} />
          </button>
          <button
            type="button"
            className="browser-surface__btn"
            title="Forward"
            aria-label="Forward"
            disabled={!surface.canGoForward}
            onClick={() => void api?.history(id, 'forward')}
          >
            <Icon name="chevronRight" size={14} />
          </button>
          <button
            type="button"
            className="browser-surface__btn"
            title={surface.loading ? 'Stop loading' : 'Reload'}
            aria-label={surface.loading ? 'Stop loading' : 'Reload'}
            onClick={() => void api?.history(id, surface.loading ? 'stop' : 'reload')}
          >
            <Icon name={surface.loading ? 'close' : 'refresh'} size={13} />
          </button>
        </span>
        <label className="browser-surface__address">
          <span className="browser-surface__scheme" aria-hidden="true">
            {surface.url.startsWith('https:') ? 'https' : surface.url.startsWith('http:') ? 'http' : isArtifactUrl(surface.url) ? 'board' : ''}
          </span>
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
          {failed ? (
            <span className="browser-surface__state" data-state="failed" role="status" title={surface.error}>
              Failed
            </span>
          ) : null}
        </label>
        <OwnerChip surface={surface} profiles={profiles} />
        {onClose ? (
          <button
            type="button"
            className="browser-surface__btn browser-surface__close"
            title="Close tab"
            aria-label="Close tab"
            onClick={() => onClose(id)}
          >
            <Icon name="close" size={13} />
          </button>
        ) : null}
        {surface.loading ? <span className="browser-surface__progress" aria-hidden="true" /> : null}
      </header>
      <div ref={viewRef} className="browser-surface__view" data-browser-id={id} data-shown={shown ? 'true' : undefined}>
        {!api ? (
          <p className="browser-surface__missing">Restart Forge to use the built-in browser.</p>
        ) : (
          // Seen for the moment the page is off its frame — a calm card in the
          // deck's colours instead of a white flash — and while a failed load
          // keeps the (blank) page hidden, when it says "Failed" and why.
          <div className="browser-surface__card" aria-hidden={failed ? undefined : 'true'} data-failed={failed ? 'true' : undefined}>
            {failed ? <span className="browser-surface__card-failed">Failed</span> : null}
            <span className="browser-surface__card-host">{hostOf(surface.url)}</span>
            <span className="browser-surface__card-title">{failed ? surface.error : surface.title || (surface.loading ? 'Loading…' : '')}</span>
          </div>
        )}
      </div>
    </section>
  )
}
