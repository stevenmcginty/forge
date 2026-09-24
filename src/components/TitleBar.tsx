import { useEffect, useRef, useState, type ReactNode } from 'react'
import { useKeymap } from '@/hooks/useHub'
import { HUB_CHEAT_SHEET_EVENT } from '@/lib/hubnav'
import { shellSheet, toolsHost, useShellSheet, useShellMode, useSurfaces } from '@/lib/shellSlots'
import { uiCommands, useUiCommand } from '@/lib/uiCommands'
import { setVoiceBarPlace, useVoiceBarPlace } from '@/lib/voiceBarPlace'
import { useActiveProject, useApp, useViewMode } from '@/state/AppState'
import { AccountChip } from './AccountChip'
import { CommandKeys } from './hub/KeyRecorder'
import { Icon } from './Icon'
import { ScreenshotTray } from './ScreenshotTray'
import { AgentsMenu } from './shell/AgentsMenu'
import { Dock } from './shell/Dock'
import { toggleSheet } from './shell/Sheet'
import './shell/DeckBar.css'

/**
 * The deck's one top layer. On the left: the mark, the Agents menu (every agent
 * in the project; pick one to open it Full screen), the new-agent button and
 * the Wall switch. In the middle: the voice bar (project, Listen, D, the text)
 * — unless it has been clipped to the bottom edge, when the mode switcher takes
 * the middle back. On the right: the modes (while the voice bar is up here) and
 * one "…" menu that holds everything else — Settings, the keyboard sheet, the
 * agents list, the voice bar's place, the tools (Skills, Commands, tab
 * colours, Wall text), the screenshot shelf and the account. Three grid
 * columns, so nothing can collide. There is nothing over the terminals: Full
 * screen is one terminal, the Wall is all of them, and Ctrl+G flips the two.
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
  const place = useVoiceBarPlace()

  useEffect(() => window.forge.window.onState((s) => setFocused(s.focused)), [])

  return (
    <header className="deckbar" data-focused={focused} data-voicebar={place}>
      <div className="deckbar__left">
        <span className="deckbar__mark" data-channel={isDevChannel ? 'dev' : undefined}>
          <Icon name="forge" size={15} />
        </span>
        <span className="deckbar__wordmark">Forge</span>
        {isDevChannel ? <span className="deckbar__channel">DEV</span> : null}
        <AgentControls />
      </div>

      {place === 'top' ? (
        <div className="deckbar__voice">
          <Dock place="top" />
        </div>
      ) : (
        <ModePill />
      )}

      <div className="deckbar__right">
        {place === 'top' ? <ModePill /> : null}
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

/* --------------------------------------------------------- agent controls */

/**
 * The Agents menu, the new-agent button (Ctrl+T's chooser anchors on it; it is
 * on screen whichever size the terminals are) and the Wall switch.
 */
function AgentControls(): ReactNode {
  const project = useActiveProject()
  if (!project) return null

  return (
    <span className="deckbar__agents">
      <AgentsMenu />
      <WallSwitch />
    </span>
  )
}

/**
 * Wall on or off. On: every agent at once. Off: Full screen, one terminal.
 * The state is a shape as well as a light — a filled square beside the word
 * when on, a hollow one when off — and aria-pressed for a screen reader.
 * Over the browser or the board it brings the agents back, as the Wall.
 */
function WallSwitch(): ReactNode {
  const { actions } = useApp()
  const viewMode = useViewMode()
  const surface = useShellMode()
  const { commands } = useKeymap()
  const combo = commands.find((c) => c.id === 'view.toggle')?.keys[0]
  const on = viewMode === 'mosaic' && !surface
  const keys = combo ? ` (${combo})` : ''

  return (
    <button
      type="button"
      className="deckbar__wall"
      data-on={on ? 'true' : undefined}
      aria-pressed={on}
      title={on ? `Wall is on — every agent at once. Click for Full screen${keys}` : `Wall — every agent at once${keys}`}
      onClick={() => {
        if (surface) {
          actions.setViewMode('mosaic')
          uiCommands.run('set-mode', 'agents')
          return
        }
        actions.setViewMode(on ? 'tabs' : 'mosaic')
      }}
    >
      <span className="deckbar__wallmark" aria-hidden="true">
        {on ? '■' : '□'}
      </span>
      Wall
    </button>
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
            <span className="deckmenu__label">Every agent</span>
            <CommandKeys id="ui.toggle-panes-switcher" />
          </button>
        </div>
        <VoiceBarPlaceRow />
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

/* ------------------------------------------------------- voice bar place */

/**
 * Voice bar: Top or Bottom — the same choice as dragging the bar by its grip,
 * kept per machine (lib/voiceBarPlace). The chosen side is lit and ticked.
 */
function VoiceBarPlaceRow(): ReactNode {
  const place = useVoiceBarPlace()
  return (
    <div className="deckmenu__section">
      <span className="deckmenu__eyebrow">Voice bar</span>
      <div className="deckmenu__seg" role="group" aria-label="Voice bar place">
        {(['top', 'bottom'] as const).map((p) => (
          <button
            key={p}
            type="button"
            data-on={place === p ? 'true' : undefined}
            aria-pressed={place === p}
            onClick={() => setVoiceBarPlace(p)}
          >
            {place === p ? <span aria-hidden="true">✓</span> : null}
            {p === 'top' ? 'Top' : 'Bottom'}
          </button>
        ))}
      </div>
    </div>
  )
}
