import { useEffect, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react'
import { useKeymap } from '@/hooks/useHub'
import { NEW_TAB_EVENT } from '@/hooks/useShortcuts'
import { HUB_CHEAT_SHEET_EVENT } from '@/lib/hubnav'
import { usePresence } from '@/lib/motion'
import { shellSheet, toolsHost, useShellSheet, useShellMode, useSurfaces } from '@/lib/shellSlots'
import { uiCommands, useUiCommand } from '@/lib/uiCommands'
import { useActions, useActiveProject, useActiveWorkspace, useAppSelector, usePaneCount, useViewMode } from '@/state/AppState'
import { AccountChip } from './AccountChip'
import { CommandKeys } from './hub/KeyRecorder'
import { Icon, type IconName } from './Icon'
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
  // One slice, not the whole state: the bar does not re-render on unrelated changes.
  const isDevChannel = useAppSelector((state) => state.info?.channel === 'dev')
  const [focused, setFocused] = useState(true)

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
  /** The switcher's glyph: the built-in one for a mode Forge knows, else the surface's own. */
  icon?: IconName
  glyph?: ReactNode
}

/** The glyphs Forge Web's deck uses for the same three (web/src/deck/DeckTopBar.tsx). */
const MODE_ICONS: Record<string, IconName> = { agents: 'terminal', browser: 'globe', board: 'image', read: 'book' }

/** The modes, in switcher order: Agents, then every registered surface. */
export function useDeckModes(): DeckMode[] {
  const surfaces = useSurfaces()
  return [
    { id: 'agents', title: 'Agents', icon: MODE_ICONS.agents },
    ...[...surfaces]
      .sort((a, b) => (a.order ?? 50) - (b.order ?? 50))
      .map((s) => ({ id: s.id, title: s.title, icon: MODE_ICONS[s.id], glyph: s.glyph }))
  ]
}

/** Which mode is on screen. Settings is a pop-up over a mode, not a mode. */
export function useDeckMode(): string {
  const surface = useShellMode()
  return surface ?? 'agents'
}

/**
 * Agents, the browser, the board — one keystroke or one click apart, in a well
 * with one raised key, the lamp, that glides to the mode you are in. The
 * segments are all one width (DeckBar.css), so the lamp is placed by two
 * numbers — which segment, of how many — and moved by a transform alone:
 * nothing is measured, and it cannot slide in from the edge on first paint.
 */
function ModePill(): ReactNode {
  const modes = useDeckModes()
  const active = useDeckMode()
  const index = Math.max(
    0,
    modes.findIndex((m) => m.id === active)
  )

  return (
    <nav className="deckbar__modes" aria-label="Modes" style={{ '--i': index, '--n': modes.length } as CSSProperties}>
      <span className="deckbar__lamp" aria-hidden="true" />
      {modes.map((m) => (
        <button
          key={m.id}
          type="button"
          className="deckbar__mode"
          data-mode={m.id}
          data-active={m.id === active ? 'true' : undefined}
          aria-pressed={m.id === active}
          title={m.id === active ? `${m.title} — showing now` : m.title}
          onClick={() => uiCommands.run('set-mode', m.id)}
        >
          {m.icon ? <Icon name={m.icon} size={13} /> : (m.glyph ?? null)}
          <span className="deckbar__modeword">{m.title}</span>
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
      style={{ '--project': project.color } as CSSProperties}
      onMouseDown={(e) => e.preventDefault()}
      onClick={() => toggleSheet('projects')}
    >
      <Icon name="folder" size={13} className="deckbar__projectmark" />
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
 * The Agents menu, the Wall | Full screen switch and the new-agent button
 * (Ctrl+T's chooser anchors on it; it is on screen whichever size the
 * terminals are): a menu, a switch and an action, side by side.
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
 * New agent, right beside the Wall switch: the one solid-accent control on the
 * bar. Opens Ctrl+T's chooser, anchored on this button, same as the Agents
 * menu's own "New agent" row; while that chooser is up TerminalGrid marks the
 * button `data-open` and the plus rests as a close mark. In a project with no
 * agent yet a slow ring invites the first one.
 */
function NewAgentButton(): ReactNode {
  const { used, max } = usePaneCount()
  const { commands } = useKeymap()
  const none = useActiveWorkspace().tabs.length === 0
  const combo = commands.find((c) => c.id === 'tab.new')?.keys[0]
  const atLimit = used >= max
  const keys = combo ? ` (${combo})` : ''

  return (
    <button
      type="button"
      className="deckbar__new"
      data-new-agent=""
      data-invite={none ? 'true' : undefined}
      aria-label="New agent"
      aria-haspopup="dialog"
      title={atLimit ? `Session limit reached (${max})` : `New agent${keys}`}
      disabled={atLimit}
      onClick={(e) =>
        window.dispatchEvent(new CustomEvent<NewTabDetail>(NEW_TAB_EVENT, { detail: { anchor: e.currentTarget } }))
      }
    >
      <span className="deckbar__newsheen" aria-hidden="true" />
      <Icon name="plus" size={13} />
      <span className="deckbar__newword">New</span>
    </button>
  )
}

/**
 * Wall on or off, shown as the two views it flips between. On: the Wall, every
 * agent at once. Off: Full screen, one terminal. Both words are always there
 * and the one you are in sits on the lamp — a word and a shape, not a colour
 * alone — which glides across like the mode switch's. Still one button: a
 * click (or Ctrl+G) flips it, and aria-pressed tells a screen reader whether
 * the Wall is on. Over the browser or the board it brings the agents back, as
 * the Wall. In a narrow window the words give way to their glyphs.
 */
function WallSwitch(): ReactNode {
  const actions = useActions()
  const viewMode = useViewMode()
  const surface = useShellMode()
  const { commands } = useKeymap()
  const combo = commands.find((c) => c.id === 'view.toggle')?.keys[0]
  const on = viewMode === 'mosaic' && !surface
  const keys = combo ? ` (${combo})` : ''

  const title = on
    ? `Wall — every agent at once. Click for Full screen, one terminal${keys}`
    : surface
      ? `Wall — every agent at once${keys}`
      : `Full screen — one terminal. Click for the Wall, every agent at once${keys}`

  return (
    <button
      type="button"
      className="deckbar__wall"
      data-on={on ? 'true' : undefined}
      aria-pressed={on}
      aria-label="Wall"
      title={title}
      style={{ '--i': on ? 0 : 1, '--n': 2 } as CSSProperties}
      onClick={() => {
        if (surface) {
          actions.setViewMode('mosaic')
          uiCommands.run('set-mode', 'agents')
          return
        }
        actions.setViewMode(on ? 'tabs' : 'mosaic')
      }}
    >
      <span className="deckbar__thumb" aria-hidden="true" data-hidden={surface ? 'true' : undefined} />
      <span className="deckbar__view" data-view="wall" data-lit={on ? 'true' : undefined}>
        <Icon name="wall" size={13} />
        <span className="deckbar__viewword">Wall</span>
      </span>
      <span className="deckbar__view" data-view="full" data-lit={!on && !surface ? 'true' : undefined}>
        <Icon name="expand" size={13} />
        <span className="deckbar__viewword">Full screen</span>
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
 * Closing, it stays on screen for the length of its exit (DeckBar.css) and is
 * hidden after. ↑ ↓ Home End move through its rows. A fresh screenshot still
 * announces itself: a count on the "…" button.
 */
function DeckMenu(): ReactNode {
  const actions = useActions()
  const inSettings = useAppSelector((state) => state.view === 'settings')
  const btnRef = useRef<HTMLButtonElement | null>(null)
  const menuRef = useRef<HTMLDivElement | null>(null)
  const open = useShellSheet() === 'shelf'
  const { mounted, closing } = usePresence(open, 160)
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

  // The rows are a menu: the arrows walk them, Home and End jump to the ends.
  const onRowKey = (e: ReactKeyboardEvent<HTMLDivElement>): void => {
    const step = e.key === 'ArrowDown' ? 1 : e.key === 'ArrowUp' ? -1 : 0
    if (!step && e.key !== 'Home' && e.key !== 'End') return
    const rows = [...e.currentTarget.querySelectorAll<HTMLElement>('[role="menuitem"]')]
    if (!rows.length) return
    e.preventDefault()
    const at = rows.indexOf(document.activeElement as HTMLElement)
    const next = e.key === 'Home' ? 0 : e.key === 'End' ? rows.length - 1 : (at + step + rows.length) % rows.length
    rows[next]?.focus()
  }

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
      <div ref={menuRef} className="deckmenu__panel" data-shell-overlay="" data-state={closing ? 'closing' : 'open'} hidden={!mounted} role="menu" aria-label="Menu">
        <div className="deckmenu__rows" onKeyDown={onRowKey}>
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
