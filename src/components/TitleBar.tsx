import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { useKeymap } from '@/hooks/useHub'
import { NEW_TAB_EVENT } from '@/hooks/useShortcuts'
import { HUB_CHEAT_SHEET_EVENT } from '@/lib/hubnav'
import { shellSheet, toolsHost, useShellSheet, useShellMode, useSurfaces } from '@/lib/shellSlots'
import { uiCommands, useUiCommand } from '@/lib/uiCommands'
import { useActiveProject, useApp, usePaneCount, useViewMode } from '@/state/AppState'
import { AccountChip } from './AccountChip'
import { CommandKeys } from './hub/KeyRecorder'
import { Icon } from './Icon'
import { ScreenshotTray } from './ScreenshotTray'
import type { NewTabDetail } from './TerminalGrid'
import { BrainButton } from './brain/BrainButton'
import { AgentsMenu } from './shell/AgentsMenu'
import { toggleSheet } from './shell/Sheet'
import { useBranch } from './shell/useBranch'
import './shell/DeckBar.css'

/**
 * The deck's one top layer. On the left: the mark, the Agents menu (every agent
 * in the project; pick one to open it Full screen), the new-agent button and
 * the Wall switch. In the middle: the mode switcher. On the right: Forge Brain
 * (its mark, and the chat that drops from it — ./brain), the project chip and
 * one "…" menu that holds everything else — Settings, the keyboard sheet, the
 * agents list, the tools (Skills, Commands, tab colours, Wall text), the
 * screenshot shelf and the account. The voice bar is not up here: it is fixed
 * to the bottom edge (shell/Dock). Three grid columns, so nothing can collide.
 * There is nothing over the terminals: Full screen is one terminal, the Wall is
 * all of them, and Ctrl+G flips the two.
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
        <AgentControls />
      </div>

      <ModePill />

      <div className="deckbar__right">
        <BrainButton />
        <ProjectChip />
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

/* ----------------------------------------------------------- project chip */

/**
 * The folder you are in, beside the mark, in every view: the folder, its name,
 * the git branch (when there is one) and a chevron. It opens the same project
 * sheet as the voice bar's project pill — one sheet, one state (shellSheet);
 * the pill keeps the Ctrl+Shift+B commands. The full path is its tooltip. In a
 * narrow window the branch goes first, then the name (DeckBar.css).
 */
function ProjectChip(): ReactNode {
  const project = useActiveProject()
  const branch = useBranch(project?.id ?? null)
  const open = useShellSheet() === 'projects'
  if (!project) return null

  return (
    <button
      type="button"
      className="deckbar__project"
      data-open={open ? 'true' : undefined}
      data-sheet-toggle="projects"
      aria-expanded={open}
      aria-label={`Project ${project.name}${branch ? `, branch ${branch}` : ''}. Switch project`}
      title={project.path}
      style={{ '--project': project.color } as React.CSSProperties}
      onMouseDown={(e) => e.preventDefault()}
      onClick={() => toggleSheet('projects')}
    >
      <Icon name="folder" size={14} className="deckbar__projectmark" />
      <span className="deckbar__projectname truncate">{project.name}</span>
      {branch ? (
        <span className="deckbar__projectbranch">
          <Icon name="branch" size={11} />
          <span className="truncate">{branch}</span>
        </span>
      ) : null}
      <Icon name="chevronDown" size={11} className="deckbar__projectchev" />
    </button>
  )
}

/* --------------------------------------------------------- agent controls */

/**
 * The Agents menu, the Wall | Full screen switch, the new-agent button (Ctrl+T's
 * chooser anchors on it; it is on screen whichever size the terminals are) and,
 * while the Wall is up, its layout controls — one tray, parted by hairlines.
 */
function AgentControls(): ReactNode {
  const project = useActiveProject()
  if (!project) return null

  return (
    <span className="deckbar__agents" role="group" aria-label="Agents and views">
      <AgentsMenu />
      <WallSwitch />
      <NewAgentButton />
    </span>
  )
}

/**
 * New agent, right beside the Wall switch. Opens Ctrl+T's chooser, anchored
 * on this button, same as the Agents menu's own "New agent" row.
 */
function NewAgentButton(): ReactNode {
  const { used, max } = usePaneCount()
  const { commands } = useKeymap()
  const combo = commands.find((c) => c.id === 'tab.new')?.keys[0]
  const atLimit = used >= max
  const keys = combo ? ` (${combo})` : ''

  return (
    <button
      type="button"
      className="deckbar__new"
      data-new-agent=""
      aria-label="New agent"
      title={atLimit ? `Session limit reached (${max})` : `New agent${keys}`}
      disabled={atLimit}
      onClick={(e) =>
        window.dispatchEvent(new CustomEvent<NewTabDetail>(NEW_TAB_EVENT, { detail: { anchor: e.currentTarget } }))
      }
    >
      <Icon name="plus" size={13} />
      New
    </button>
  )
}

/**
 * Wall on or off, shown as the two views it flips between. On: the Wall, every
 * agent at once. Off: Full screen, one terminal. Both words are always there
 * and the one you are in sits in the lit capsule — a word and a shape, not a
 * colour alone — which glides across like the mode pill's lamp. Still one
 * button: a click (or Ctrl+G) flips it, and aria-pressed tells a screen reader
 * whether the Wall is on. Over the browser or the board it brings the agents
 * back, as the Wall.
 */
function WallSwitch(): ReactNode {
  const { actions } = useApp()
  const viewMode = useViewMode()
  const surface = useShellMode()
  const { commands } = useKeymap()
  const combo = commands.find((c) => c.id === 'view.toggle')?.keys[0]
  const on = viewMode === 'mosaic' && !surface
  const keys = combo ? ` (${combo})` : ''
  const ref = useRef<HTMLButtonElement | null>(null)
  const thumbRef = useRef<HTMLSpanElement | null>(null)
  const placed = useRef(false)

  // The capsule is measured off the word it lands on, before paint, and only
  // animates after its first placement so it never slides in from the edge.
  useLayoutEffect(() => {
    const thumb = thumbRef.current
    const word = ref.current?.querySelector<HTMLElement>(`[data-view='${on ? 'wall' : 'full'}']`)
    if (!thumb || !word) return
    thumb.style.width = `${word.offsetWidth}px`
    thumb.style.transform = `translate3d(${word.offsetLeft}px, 0, 0)`
    if (!placed.current) {
      placed.current = true
      requestAnimationFrame(() => thumb.setAttribute('data-ready', 'true'))
    }
  }, [on])

  const title = on
    ? `Wall — every agent at once. Click for Full screen, one terminal${keys}`
    : surface
      ? `Wall — every agent at once${keys}`
      : `Full screen — one terminal. Click for the Wall, every agent at once${keys}`

  return (
    <button
      ref={ref}
      type="button"
      className="deckbar__wall"
      data-on={on ? 'true' : undefined}
      aria-pressed={on}
      aria-label="Wall"
      title={title}
      onClick={() => {
        if (surface) {
          actions.setViewMode('mosaic')
          uiCommands.run('set-mode', 'agents')
          return
        }
        actions.setViewMode(on ? 'tabs' : 'mosaic')
      }}
    >
      <span className="deckbar__thumb" ref={thumbRef} aria-hidden="true" data-hidden={surface ? 'true' : undefined} />
      <span className="deckbar__view" data-view="wall" data-lit={on ? 'true' : undefined}>
        Wall
      </span>
      <span className="deckbar__view" data-view="full" data-lit={!on && !surface ? 'true' : undefined}>
        Full screen
      </span>
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
  // The shot itself pops up at the top right (ShotPop) and tucks in here.
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
        <Icon name="cog" size={16} />
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
