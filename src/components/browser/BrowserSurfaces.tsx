import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { AgentProfile } from '@shared/types'
import type { BrowserSurfaceInfo } from '@shared/browser'
import { popIn } from '@/lib/motion'
import { AgentBadge } from '../AgentBadge'
import { Icon } from '../Icon'
import { browserBridge } from './bridge'
import { BrowserSurface, hostOf, ownerOf } from './BrowserSurface'
import { useBrowserSurfaces } from './useBrowserSurfaces'
import '../shell/deck-tokens.css'
import './browser.css'

/**
 * The browser as a place on the deck: every tab any agent (or Steve) holds, as
 * a chip that says whose it is in words, and one tab at a time on the stage.
 *
 * Many agents browse at once, so the strip is the overview — a chip per tab
 * with the owner's logo and name and a word for its state ("Zeb is
 * driving", "Yours", "Loading…") — and a click brings that tab forward. A tab
 * that arrives is shown straight away unless Steve is on one of his own, in
 * which case its chip pops in and waits. With no tabs, a calm empty state and
 * an address field that feels like the composer: type a site or a search,
 * Enter.
 */

/** Non-addresses become a search, the way every browser's bar works. */
export function toAddress(input: string): string {
  const t = input.trim()
  if (!t) return 'https://www.google.com'
  if (/^[a-z]+:\/\//i.test(t)) return t
  if (/^localhost(:\d+)?(\/.*)?$/i.test(t) || /^[\d.]+(:\d+)?(\/.*)?$/.test(t)) return `http://${t}`
  if (!/\s/.test(t) && /\.[a-z]{2,}(:\d+)?(\/.*)?$/i.test(t)) return t
  return `https://www.google.com/search?q=${encodeURIComponent(t)}`
}

export function BrowserSurfaces({
  projectId,
  profiles,
  scale = 1,
  hidden = false
}: {
  projectId: string
  profiles?: AgentProfile[]
  scale?: number
  hidden?: boolean
}): ReactNode {
  const { visible } = useBrowserSurfaces(projectId)
  const tabs = useMemo(() => [...visible].sort((a, b) => a.createdAt - b.createdAt), [visible])
  const [activeId, setActiveId] = useState<string | null>(null)
  const [adding, setAdding] = useState(false)
  const known = useRef<Set<string> | null>(null)
  const [fresh, setFresh] = useState<string[]>([])

  const active = tabs.find((t) => t.id === activeId) ?? null

  // Keep a tab on stage; bring new arrivals forward unless Steve is on his own.
  useEffect(() => {
    const ids = tabs.map((t) => t.id)
    const before = known.current
    known.current = new Set(ids)
    if (!before) {
      if (!activeId && tabs.length) setActiveId(tabs[tabs.length - 1]!.id)
      return
    }
    const arrived = tabs.filter((t) => !before.has(t.id))
    if (arrived.length) setFresh((f) => [...f, ...arrived.map((t) => t.id)])
    const current = tabs.find((t) => t.id === activeId) ?? null
    const newest = arrived[arrived.length - 1]
    if (newest && (!current || current.owner.id !== 'user' || newest.owner.id === 'user')) {
      setActiveId(newest.id)
      return
    }
    if (!current) setActiveId(tabs.length ? tabs[tabs.length - 1]!.id : null)
  }, [tabs, activeId])

  useEffect(() => {
    if (!fresh.length) return undefined
    const t = window.setTimeout(() => setFresh([]), 2400)
    return () => window.clearTimeout(t)
  }, [fresh])

  const open = (text: string): void => {
    setAdding(false)
    void browserBridge()?.open({ url: toAddress(text), project: projectId })
  }

  const agents = new Set(tabs.filter((t) => t.owner.id !== 'user').map((t) => t.owner.id)).size

  return (
    <div className="bdeck" data-empty={tabs.length ? undefined : 'true'}>
      {tabs.length ? (
        <>
          <nav className="bdeck__strip" aria-label="Browser tabs">
            <div className="bdeck__tabs" role="tablist">
              {tabs.map((t) => (
                <TabChip
                  key={t.id}
                  surface={t}
                  profiles={profiles}
                  active={t.id === active?.id}
                  fresh={fresh.includes(t.id)}
                  onPick={() => setActiveId(t.id)}
                  onClose={() => void browserBridge()?.close(t.id)}
                />
              ))}
            </div>
            {adding ? (
              <AddressField compact autoFocus onSubmit={open} onCancel={() => setAdding(false)} />
            ) : (
              <button type="button" className="bdeck__new" title="Open a page in a new tab of your own" onClick={() => setAdding(true)}>
                <Icon name="plus" size={13} />
                New tab
              </button>
            )}
            <span className="bdeck__meta">
              {tabs.length} {tabs.length === 1 ? 'tab' : 'tabs'}
              {agents ? ` · ${agents} ${agents === 1 ? 'agent' : 'agents'}` : ''}
            </span>
          </nav>
          {active ? (
            <BrowserSurface
              key={active.id}
              surface={active}
              profiles={profiles}
              scale={scale}
              hidden={hidden}
              onClose={(id) => void browserBridge()?.close(id)}
            />
          ) : null}
        </>
      ) : (
        <Empty onOpen={open} />
      )}
    </div>
  )
}

/* ----------------------------------------------------------------- chips */

function TabChip({
  surface,
  profiles,
  active,
  fresh,
  onPick,
  onClose
}: {
  surface: BrowserSurfaceInfo
  profiles?: AgentProfile[]
  active: boolean
  fresh: boolean
  onPick: () => void
  onClose: () => void
}): ReactNode {
  const ref = useRef<HTMLDivElement | null>(null)
  const who = ownerOf(surface, profiles)
  const failed = Boolean(surface.error) && !surface.loading
  const word = surface.loading ? 'Loading…' : failed ? 'Failed' : who.mine ? 'Yours' : `${who.name} is driving`

  useLayoutEffect(() => {
    if (fresh && ref.current) popIn(ref.current, { from: 0.9, lift: 6 })
  }, [fresh])

  return (
    <div
      ref={ref}
      className="btab"
      role="tab"
      aria-selected={active}
      data-active={active ? 'true' : undefined}
      data-loading={surface.loading ? 'true' : undefined}
      data-failed={failed ? 'true' : undefined}
      data-mine={who.mine ? 'true' : undefined}
      data-fresh={fresh ? 'true' : undefined}
      title={`${surface.title || surface.url}\n${failed ? `Failed — ${surface.error}` : word}`}
    >
      <button type="button" className="btab__main" onClick={onPick}>
        <span className="btab__who" aria-hidden="true">
          {who.profile ? <AgentBadge profile={who.profile} size="sm" /> : <span className="btab__mark">{who.mine ? '●' : who.mark}</span>}
        </span>
        <span className="btab__text">
          <span className="btab__title">{surface.title || hostOf(surface.url) || 'New tab'}</span>
          <span className="btab__word">{word}</span>
        </span>
      </button>
      <button type="button" className="btab__x" aria-label={`Close ${surface.title || 'tab'}`} title="Close tab" onClick={onClose}>
        <Icon name="close" size={11} />
      </button>
    </div>
  )
}

/* --------------------------------------------------------------- address */

function AddressField({
  compact = false,
  autoFocus = false,
  onSubmit,
  onCancel
}: {
  compact?: boolean
  autoFocus?: boolean
  onSubmit: (text: string) => void
  onCancel?: () => void
}): ReactNode {
  const [text, setText] = useState('')
  return (
    <form
      className="baddr"
      data-compact={compact ? 'true' : undefined}
      onSubmit={(e) => {
        e.preventDefault()
        onSubmit(text)
        setText('')
      }}
    >
      <Icon name="globe" size={compact ? 13 : 16} className="baddr__icon" />
      <input
        className="baddr__field"
        placeholder="Go to a page, or search"
        aria-label="Open a page"
        spellCheck={false}
        autoFocus={autoFocus}
        value={text}
        onChange={(e) => setText(e.currentTarget.value)}
        onBlur={() => {
          if (!text && onCancel) onCancel()
        }}
        onKeyDown={(e) => {
          if (e.key === 'Escape' && onCancel) {
            e.preventDefault()
            onCancel()
          }
        }}
      />
      <button type="submit" className="baddr__go" aria-label="Open" title="Open (Enter)">
        {compact ? '⏎' : 'Open ⏎'}
      </button>
    </form>
  )
}

function Empty({ onOpen }: { onOpen: (text: string) => void }): ReactNode {
  const ref = useRef<HTMLDivElement | null>(null)
  useLayoutEffect(() => {
    if (ref.current) popIn(ref.current, { from: 0.97, lift: 8 })
  }, [])
  return (
    <div className="bempty" ref={ref}>
      <span className="bempty__mark" aria-hidden="true">
        <Icon name="globe" size={24} />
      </span>
      <p className="bempty__title">No tabs open</p>
      <p className="bempty__text">
        Open a page yourself, or ask any agent to — each one gets its own tabs, and you can watch every one of them
        here. Sign in once and every tab is signed in.
      </p>
      <AddressField autoFocus={false} onSubmit={onOpen} />
      <div className="bempty__quick">
        {['localhost:5173', 'github.com', 'example.com'].map((q) => (
          <button key={q} type="button" className="bempty__chip" onClick={() => onOpen(q)}>
            {q}
          </button>
        ))}
      </div>
    </div>
  )
}
