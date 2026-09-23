import { useEffect, useRef, useState, type ReactNode } from 'react'
import { HUB_CHEAT_SHEET_EVENT } from '@/lib/hubnav'
import { shellSheet, tabsHost, toolsHost, useHost, useShellSheet, useShellMode, useSurfaces, viewHost } from '@/lib/shellSlots'
import { collectLeaves } from '@/lib/splitTree'
import { uiCommands, useUiCommand } from '@/lib/uiCommands'
import { useActiveWorkspace, useApp } from '@/state/AppState'
import { AccountChip } from './AccountChip'
import { CommandKeys } from './hub/KeyRecorder'
import { Icon } from './Icon'
import { Popover } from './Popover'
import { ScreenshotTray } from './ScreenshotTray'
import { toggleSheet } from './shell/Sheet'
import './shell/DeckBar.css'

/**
 * The deck's one top layer: the mark and the agents' tabs on the left, the
 * mode switcher in the middle, and on the right the Tabs | Wall switch and one
 * "…" menu that holds everything else — Settings, the keyboard sheet, the
 * panes switcher, the tools (Skills, Commands, tab colours, Wall text), the
 * screenshot shelf and the account. Three grid columns, so the three can never
 * collide: however many tabs there are, they scroll inside their own column
 * (fading at the cut edge) and a "3 more" chip lists the ones out of sight.
 * Transparent over the backdrop — the window is draggable anywhere along it —
 * with the native minimise/maximise/close buttons drawn by Windows into the
 * reserved gap on the far right (titleBarOverlay), never re-implemented here.
 *
 * (Forge Web keeps its own top bar and still reads TitleBar.css; this bar's
 * styles are its own, in shell/DeckBar.css.)
 */
export function TitleBar(): ReactNode {
  const { state } = useApp()
  const [focused, setFocused] = useState(true)
  const isDevChannel = state.info?.channel === 'dev'

  useEffect(() => window.forge.window.onState((s) => setFocused(s.focused)), [])

  return (
    <header className="deckbar" data-focused={focused}>
      <div className="deckbar__left">
        <span className="deckbar__mark" data-channel={isDevChannel ? 'dev' : undefined}>
          <Icon name="forge" size={15} />
        </span>
        <span className="deckbar__wordmark">Forge</span>
        {isDevChannel ? <span className="deckbar__channel">DEV</span> : null}
        {/* The agents' tabs, portalled in by TerminalGrid (see tabsHost). */}
        <div className="deckbar__tabs" ref={tabsHost.set} />
        <TabOverflow />
      </div>

      <ModePill />

      <div className="deckbar__right">
        {/* Tabs | Wall, portalled in by TerminalGrid (see viewHost). */}
        <div className="deckbar__view" ref={viewHost.set} />
        <DeckMenu />
        {/* Reserved for the native window controls (3 × 46px on Windows 11). */}
        <div className="deckbar__controls-gap" />
      </div>
    </header>
  )
}

/* ------------------------------------------------------------- mode pill */

export interface DeckMode {
  id: string
  title: string
}

/** The modes, in switcher order: Agents, then every registered surface. */
export function useDeckModes(): DeckMode[] {
  const surfaces = useSurfaces()
  return [
    { id: 'agents', title: 'Agents' },
    ...[...surfaces]
      .sort((a, b) => (a.order ?? 50) - (b.order ?? 50))
      .map((s) => ({ id: s.id, title: s.title }))
  ]
}

/** Which mode is on screen. Settings is a pop-up over a mode, not a mode. */
export function useDeckMode(): string {
  const surface = useShellMode()
  return surface ?? 'agents'
}

/**
 * Agents, the browser, the board — one keystroke or one
 * click apart, with a lit capsule that glides between them. The capsule is a
 * single element moved by transform, measured off the button it lands on.
 */
function ModePill(): ReactNode {
  const modes = useDeckModes()
  const active = useDeckMode()
  const ref = useRef<HTMLDivElement | null>(null)
  const lampRef = useRef<HTMLSpanElement | null>(null)
  const placed = useRef(false)

  useEffect(() => {
    const root = ref.current
    const lamp = lampRef.current
    if (!root || !lamp) return
    const btn = root.querySelector<HTMLElement>(`[data-mode='${active}']`)
    if (!btn) return
    lamp.style.width = `${btn.offsetWidth}px`
    lamp.style.transform = `translate3d(${btn.offsetLeft}px, 0, 0)`
    if (!placed.current) {
      placed.current = true
      requestAnimationFrame(() => lamp.setAttribute('data-ready', 'true'))
    }
  }, [active, modes.length])

  return (
    <nav className="deckbar__modes" ref={ref} aria-label="Modes">
      <span className="deckbar__lamp" ref={lampRef} aria-hidden="true" />
      {modes.map((m) => (
        <button
          key={m.id}
          type="button"
          className="deckbar__mode"
          data-mode={m.id}
          data-active={m.id === active ? 'true' : undefined}
          aria-pressed={m.id === active}
          onClick={() => uiCommands.run('set-mode', m.id)}
        >
          {m.title}
        </button>
      ))}
    </nav>
  )
}

/* ------------------------------------------------------------ tab overflow */

/**
 * More tabs than the left column holds: they scroll sideways (the wheel works
 * too), each cut edge fades, the active tab is always scrolled into view, and
 * a chip counts the ones out of sight — "3 more" — and lists every tab.
 */
function TabOverflow(): ReactNode {
  const { actions } = useApp()
  const workspace = useActiveWorkspace()
  const host = useHost(tabsHost)
  const chipRef = useRef<HTMLButtonElement | null>(null)
  const [hidden, setHidden] = useState<number[]>([])
  const [open, setOpen] = useState(false)
  const tabs = workspace.tabs
  const activeId = workspace.activeTabId
  const activeRef = useRef(activeId)
  activeRef.current = activeId
  const remeasure = useRef<() => void>(() => undefined)

  useEffect(() => {
    if (!host) return undefined
    let raf = 0
    let scroller: HTMLElement | null = null
    /** The tab id last scrolled into view. */
    let shownFor: string | null = null
    /** Layout moved (a resize, a tab added, a font landing): check the active tab again. */
    let ensure = true
    const FADE = 34
    const measure = (): void => {
      raf = 0
      scroller = host.querySelector<HTMLElement>('.tabstrip__tabs')
      if (!scroller) {
        setHidden((prev) => (prev.length ? [] : prev))
        return
      }
      // The tab you are on is never the one out of sight, nor under a fade.
      const active = scroller.querySelector<HTMLElement>('.tab[data-active="true"]')
      if (active && (ensure || shownFor !== activeRef.current)) {
        const first = shownFor === null || shownFor === activeRef.current
        shownFor = activeRef.current
        const b = scroller.getBoundingClientRect()
        const r = active.getBoundingClientRect()
        let left = scroller.scrollLeft
        if (r.left - b.left < FADE) left += r.left - b.left - FADE
        else if (b.right - r.right < FADE) left += r.right - b.right + FADE
        if (Math.round(left) !== Math.round(scroller.scrollLeft)) {
          scroller.scrollTo({ left: Math.max(0, left), behavior: first ? 'auto' : 'smooth' })
        }
      }
      ensure = false
      const box = scroller.getBoundingClientRect()
      const out: number[] = []
      scroller.querySelectorAll<HTMLElement>('.tab').forEach((el, i) => {
        resize.observe(el)
        const r = el.getBoundingClientRect()
        // Out of sight: less than half of it shows.
        const seen = Math.min(r.right, box.right) - Math.max(r.left, box.left)
        if (seen < r.width / 2) out.push(i)
      })
      setHidden((prev) => (prev.join() === out.join() ? prev : out))
      host.toggleAttribute('data-fade-start', scroller.scrollLeft > 1)
      host.toggleAttribute('data-fade-end', scroller.scrollLeft + scroller.clientWidth < scroller.scrollWidth - 1)
    }
    const later = (relayout = true): void => {
      if (relayout) ensure = true
      if (!raf) raf = requestAnimationFrame(measure)
    }
    // Scrolling by hand is his: it re-measures without pulling the active tab back.
    const onScroll = (): void => later(false)
    // A mouse wheel over the tabs scrolls them sideways.
    const onWheel = (e: WheelEvent): void => {
      const el = (e.target as HTMLElement | null)?.closest<HTMLElement>('.tabstrip__tabs')
      if (!el || Math.abs(e.deltaX) > Math.abs(e.deltaY) || el.scrollWidth <= el.clientWidth) return
      el.scrollLeft += e.deltaY
      e.preventDefault()
    }
    const resize = new ResizeObserver(() => later())
    const mutate = new MutationObserver(() => {
      const next = host.querySelector<HTMLElement>('.tabstrip__tabs')
      if (next && next !== scroller) resize.observe(next)
      later()
    })
    resize.observe(host)
    mutate.observe(host, { childList: true, subtree: true })
    host.addEventListener('scroll', onScroll, true)
    host.addEventListener('wheel', onWheel, { passive: false })
    const first = host.querySelector<HTMLElement>('.tabstrip__tabs')
    if (first) resize.observe(first)
    remeasure.current = later
    later()
    return () => {
      remeasure.current = () => undefined
      if (raf) cancelAnimationFrame(raf)
      resize.disconnect()
      mutate.disconnect()
      host.removeEventListener('scroll', onScroll, true)
      host.removeEventListener('wheel', onWheel)
    }
  }, [host])

  useEffect(() => remeasure.current(), [activeId, tabs.length])

  if (hidden.length === 0 && !open) return null

  return (
    <>
      <button
        ref={chipRef}
        type="button"
        className="deckbar__more"
        data-open={open ? 'true' : undefined}
        aria-expanded={open}
        title={`${hidden.length} tab${hidden.length === 1 ? '' : 's'} out of sight — click for every tab`}
        onClick={() => setOpen((v) => !v)}
      >
        {hidden.length} more
        <span aria-hidden="true" className="deckbar__more-chev">
          ▾
        </span>
      </button>
      <Popover anchor={chipRef.current} open={open} onClose={() => setOpen(false)} align="start" width={300} label="Every tab">
        <div className="deckbar__tablist" data-shell-overlay="" role="listbox" aria-label="Tabs">
          <div className="deckbar__tablist-head">
            <span>Tabs</span>
            <span className="mono">{tabs.length}</span>
          </div>
          {tabs.map((t, i) => {
            const panes = collectLeaves(t.root).length
            const here = t.id === activeId
            return (
              <button
                key={t.id}
                type="button"
                role="option"
                aria-selected={here}
                className="deckbar__tabrow"
                data-here={here ? 'true' : undefined}
                data-hidden={hidden.includes(i) ? 'true' : undefined}
                onClick={() => {
                  setOpen(false)
                  actions.selectTab(t.id)
                }}
              >
                <span className="deckbar__tabrow-num mono">{i + 1}</span>
                <span className="deckbar__tabrow-name truncate">{t.title}</span>
                <span className="deckbar__tabrow-meta">
                  {panes} {panes === 1 ? 'pane' : 'panes'}
                </span>
                {here ? <span className="deckbar__tabrow-here">here</span> : null}
              </button>
            )
          })}
        </div>
      </Popover>
    </>
  )
}

/* ------------------------------------------------------------- the … menu */

/**
 * Everything the top bar used to spread across four buttons, in one menu:
 * Settings, the keyboard sheet, the panes switcher, the tools TerminalGrid
 * portals in (see toolsHost), the screenshot shelf (drag a shot onto a pane,
 * as ever) and the account.
 *
 * It stays mounted while closed, only hidden, so the tools keep their own
 * state and flyouts; a click inside one of their pop-ups does not close it.
 * A fresh screenshot still announces itself: a count on the "…" button.
 */
function DeckMenu(): ReactNode {
  const { state, actions } = useApp()
  const btnRef = useRef<HTMLButtonElement | null>(null)
  const menuRef = useRef<HTMLDivElement | null>(null)
  const open = useShellSheet() === 'shelf'
  const toggle = (): void => shellSheet.set(shellSheet.get() === 'shelf' ? null : 'shelf')
  useUiCommand('open-shelf', () => shellSheet.set('shelf'))
  useUiCommand('close-shelf', () => {
    if (shellSheet.get() === 'shelf') shellSheet.set(null)
  })
  useUiCommand('toggle-shelf', toggle)
  useUiCommand('toggle-tools', toggle)

  // Esc, or a click anywhere that is not the menu, its button, or one of the
  // tools' own pop-ups, puts it away.
  useEffect(() => {
    if (!open) return undefined
    const onDown = (e: PointerEvent): void => {
      const t = e.target as HTMLElement | null
      if (!t) return
      if (menuRef.current?.contains(t) || btnRef.current?.contains(t)) return
      if (t.closest('.popover, .rexp, .comet')) return
      shellSheet.set(null)
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      e.stopPropagation()
      shellSheet.set(null)
    }
    window.addEventListener('pointerdown', onDown, true)
    window.addEventListener('keydown', onKey, true)
    return () => {
      window.removeEventListener('pointerdown', onDown, true)
      window.removeEventListener('keydown', onKey, true)
    }
  }, [open])

  // The shelf is folded away, so a fresh screenshot has to announce itself on
  // the button: a count of shots that arrived since the menu was last opened.
  const [fresh, setFresh] = useState(0)
  const known = useRef<Set<string> | null>(null)
  useEffect(() => {
    const receive = (shots: Array<{ id: string }>): void => {
      const ids = new Set(shots.map((s) => s.id))
      if (known.current === null) {
        known.current = ids
        return
      }
      const added = shots.filter((s) => !known.current!.has(s.id)).length
      known.current = ids
      if (added > 0 && shellSheet.get() !== 'shelf') setFresh((n) => n + added)
    }
    const off = window.forge.shots.onUpdated(receive)
    void window.forge.shots.list().then(receive)
    return off
  }, [])
  useEffect(() => {
    if (open) setFresh(0)
  }, [open])

  const run = (fn: () => void): void => {
    shellSheet.set(null)
    fn()
  }
  const inSettings = state.view === 'settings'

  return (
    <span className="deckmenu">
      <button
        ref={btnRef}
        type="button"
        className="deckbar__btn"
        title={fresh > 0 ? `${fresh} new screenshot${fresh === 1 ? '' : 's'} — the menu has the shelf` : 'Menu — Settings, tools, screenshots, account'}
        aria-label="Menu"
        aria-haspopup="menu"
        aria-expanded={open}
        data-on={open ? 'true' : undefined}
        onClick={toggle}
      >
        <Icon name="dots" size={16} />
        {fresh > 0 ? <span className="deckbar__badge">{fresh > 9 ? '9+' : fresh}</span> : null}
      </button>
      <div ref={menuRef} className="deckmenu__panel" data-shell-overlay="" hidden={!open} role="menu" aria-label="Menu">
        <div className="deckmenu__rows">
          <button
            type="button"
            role="menuitem"
            className="deckmenu__row"
            onClick={() => run(() => (inSettings ? actions.closeSettings() : actions.openSettings()))}
          >
            <Icon name="gear" size={14} />
            <span className="deckmenu__label">{inSettings ? 'Close settings' : 'Settings'}</span>
            <CommandKeys id="app.settings" />
          </button>
          <button
            type="button"
            role="menuitem"
            className="deckmenu__row"
            onClick={() => run(() => window.dispatchEvent(new CustomEvent(HUB_CHEAT_SHEET_EVENT)))}
          >
            <Icon name="key" size={14} />
            <span className="deckmenu__label">Keyboard shortcuts</span>
            <CommandKeys id="app.cheatSheet" />
          </button>
          <button type="button" role="menuitem" className="deckmenu__row" onClick={() => run(() => toggleSheet('panes'))}>
            <Icon name="viewMosaic" size={14} />
            <span className="deckmenu__label">Every pane</span>
            <CommandKeys id="ui.toggle-panes-switcher" />
          </button>
        </div>
        <div className="deckmenu__section">
          <span className="deckmenu__eyebrow">Tools</span>
          <div className="deckmenu__tools" ref={toolsHost.set}>
            <span className="deckmenu__empty">Open Agents to use these.</span>
          </div>
        </div>
        <div className="deckbar__shelf">
          <ScreenshotTray />
          <AccountChip />
        </div>
      </div>
    </span>
  )
}
