import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { MAX_TABS_PER_PROJECT } from '@shared/ipc'
import { NEW_TAB_EVENT } from '@/hooks/useShortcuts'
import { collectLeaves, countLeaves } from '@/lib/splitTree'
import { fadeIn, useFlipChildren } from '@/lib/motion'
import { toolsHost as toolsHostStore, useHost } from '@/lib/shellSlots'
import { terminalHost } from '@/lib/terminals'
import { uiCommands } from '@/lib/uiCommands'
import { useActiveProject, useActiveTab, useActiveWorkspace, useApp, useMosaic, usePaneCount, useViewMode } from '@/state/AppState'
import { AgentChooser } from './AgentChooser'
import { CommandsButton } from './CommandsFlyout'
import { EmptyState } from './EmptyState'
import { Icon } from './Icon'
import { MosaicView } from './MosaicView'
import { SkillsButton } from './SkillsFlyout'
import { FocusReticle } from './shell/FocusReticle'
import { PaneCarousel } from './shell/PaneCarousel'
import { SplitView } from './SplitView'
import './TerminalGrid.css'

/** What a NEW_TAB_EVENT may carry: the button it came from, to anchor the chooser. */
export interface NewTabDetail {
  anchor?: HTMLElement | null
}

/**
 * The terminal area, in one of two sizes, plus the empty states that lead in:
 *
 *   Wall         (viewMode 'mosaic') every terminal at once, filling the stage.
 *   Full screen  (viewMode 'tabs') the active tab — its splits and all — with
 *                the whole stage to itself. Nothing sits over it.
 *
 * `beside` is the browser or the board on the stage: then this draws no
 * terminals (only the chooser and the tools), and the surface has the stage.
 *
 * There is no tab strip. Tabs are still the unit a split tree lives in, but you
 * pick a terminal from the top bar's Agents menu or the Wall; Ctrl+G (or the
 * Wall switch) flips the two sizes and the tab shortcuts still step through
 * the tabs Full screen shows.
 */
export function TerminalGrid({ beside = false }: { beside?: boolean }): ReactNode {
  const { state, actions } = useApp()
  const project = useActiveProject()
  const workspace = useActiveWorkspace()
  const tab = useActiveTab()
  const viewMode = useViewMode()
  const mosaic = useMosaic()
  const { used, max } = usePaneCount()

  const bodyRef = useRef<HTMLDivElement | null>(null)
  const toolsHost = useHost(toolsHostStore)
  const [chooserOpen, setChooserOpen] = useState(false)
  const [chooserAnchor, setChooserAnchor] = useState<HTMLElement | null>(null)

  const atTabLimit = workspace.tabs.length >= MAX_TABS_PER_PROJECT

  /**
   * Pop the agent chooser — and meet the tab ceiling. Anchored on whatever
   * asked for it, or else on the title bar's + (the one new-agent button that
   * is always on screen, whichever size the terminals are).
   */
  const openChooser = useCallback(
    (anchor?: HTMLElement | null): void => {
      if (atTabLimit) {
        actions.setNotice(`A project holds at most ${MAX_TABS_PER_PROJECT} tabs`)
        return
      }
      setChooserAnchor(anchor ?? document.querySelector<HTMLElement>('[data-new-agent]'))
      setChooserOpen(true)
    },
    [actions, atTabLimit]
  )

  // Ctrl+T, the title bar's +, the panes sheet's "New agent": one chooser.
  useEffect(() => {
    const open = (e: Event): void => {
      if (!project) return
      openChooser((e as CustomEvent<NewTabDetail | null>).detail?.anchor)
    }
    window.addEventListener(NEW_TAB_EVENT, open)
    return () => window.removeEventListener(NEW_TAB_EVENT, open)
  }, [project, openChooser])

  /*
   * Tab text colours reach the terminals from here rather than from
   * TerminalPane, because on the Wall and in the strip there are no panes —
   * there are tiles, and TerminalPane is not mounted at all. This is the one
   * component that is up in every view and knows every tab, so it is the one
   * that paints.
   */
  const tabs = workspace.tabs
  const tinted = state.settings.tabTextColours
  useEffect(() => {
    for (const t of tabs) {
      for (const leaf of collectLeaves(t.root)) {
        // Off means null, not "no call": flipping the switch has to repaint the
        // terminals that are already coloured, not merely stop colouring new ones.
        terminalHost.setForeground(leaf.id, tinted ? (t.textColor ?? null) : null)
      }
    }
  }, [tabs, tinted])

  /*
   * From a Wall tile to Full screen. It also brings the agents back on stage
   * when the browser or the board is up.
   */
  const openFull = useCallback(
    (paneId: string): void => {
      actions.revealPane(paneId)
      actions.setViewMode('tabs')
      if (beside) uiCommands.run('set-mode', 'agents')
      // The pane may only now be mounting; give it a frame before focusing xterm.
      requestAnimationFrame(() => requestAnimationFrame(() => terminalHost.focus(paneId)))
    },
    [actions, beside]
  )

  /*
   * Esc goes from Full screen back to the Wall — but only when nobody else owns
   * the key. A focused terminal always does: Esc is Claude Code's interrupt,
   * the shell's clear-line and vim's normal mode, and a full-screen TUI owns it
   * even unfocused (MosaicView's guard). So does anything with an Esc of its
   * own — a field, a sheet, a pop-up; those listen in the capture phase and
   * stop it, so this one, on the bubble, never hears them. The Wall button and
   * Ctrl+G are always there instead.
   */
  const fullScreen = !beside && viewMode === 'tabs' && Boolean(tab)
  const focusPaneId = tab?.activePaneId ?? null
  useEffect(() => {
    if (!fullScreen || state.view !== 'terminals') return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape' || e.ctrlKey || e.altKey || e.metaKey || e.shiftKey || e.defaultPrevented) return
      const el = document.activeElement
      if (el?.closest('.xterm, [data-shell-overlay], .popover')) return
      if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement) return
      if (focusPaneId && terminalHost.isAltBuffer(focusPaneId)) return
      e.preventDefault()
      actions.setViewMode('mosaic')
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [actions, focusPaneId, fullScreen, state.view])

  /*
   * The glides. A pane that survives a re-layout — a sibling closed, a split
   * opened — slides and stretches into its new box (keyed on which panes the
   * tab holds, so dragging a divider is never animated against). A tab switch
   * or a flip between the two sizes crossfades the whole body instead.
   */
  const leafKey = `${viewMode}:${tab ? collectLeaves(tab.root).map((l) => l.id).join(',') : ''}`
  useFlipChildren(bodyRef, leafKey)
  const switchKey = `${project?.id ?? ''}:${viewMode}:${viewMode === 'tabs' ? (workspace.activeTabId ?? '') : ''}`
  const lastSwitch = useRef(switchKey)
  useLayoutEffect(() => {
    if (lastSwitch.current === switchKey) return
    lastSwitch.current = switchKey
    if (bodyRef.current) fadeIn(bodyRef.current)
  }, [switchKey])

  if (!state.ready) return <div className="grid grid--booting" data-view={beside ? 'beside' : undefined} />

  if (!project) {
    // Beside a surface there is nothing to strip yet; the surface has the stage.
    if (beside) return <div className="grid" data-view="beside" />
    return (
      <div className="grid">
        <EmptyState
          icon="folder"
          eyebrow="Forge"
          title="Bring a project aboard"
          body="Add a folder and Forge gives it its own deck — Claude Code, Codex, Gemini and shells, side by side, all listening."
          action={
            <button type="button" className="cta-btn" onClick={() => void actions.addProject()}>
              <Icon name="plus" size={14} />
              Add a project folder
            </button>
          }
        />
      </div>
    )
  }

  const atLimit = used >= max
  const view = beside ? 'beside' : viewMode === 'mosaic' ? 'wall' : 'full'

  const toolParts = (
    <>
      {/* The wall's legibility switch — it sets the strip's tiles too. */}
      {viewMode === 'mosaic' ? <MosaicTextToggle /> : null}

      {/*
        The freeform wall's one control, parked here rather than over the
        tiles: the mosaic must not gain a toolbar the moment you drag
        something, or every tile shifts down by the height of it.
      */}
      {viewMode === 'mosaic' && mosaic.mode === 'custom' ? (
        <button
          type="button"
          className="ghost-btn tabstrip__reset"
          title="Freeform wall — drag a header to move it, an edge to resize it, double-click a header to refit its terminal. Click here to put every tile back in the grid."
          onClick={() => actions.resetMosaicLayout()}
        >
          <Icon name="restart" size={11} />
          Reset to grid
        </button>
      ) : null}

      {/* The two references, next to the switches rather than in Settings:
          what `claude` understands changes weekly, what it *knows* is a
          folder you curate, and the moment you want either is the moment you
          are looking at a pane. Skills first — it is the one you feed. */}
      <SkillsButton />

      <CommandsButton />

      <TabTintToggle />
    </>
  )

  const chooser = (
    <AgentChooser
      anchor={chooserAnchor}
      open={chooserOpen}
      onClose={() => setChooserOpen(false)}
      onPick={(profileId, permissionMode) => actions.newTab(profileId, permissionMode)}
      selectedId={project.defaultProfileId}
    />
  )

  return (
    <div className="grid" data-view={view}>
      {/* The references live in the title bar's "…" menu (see toolsHost in lib/shellSlots). */}
      {toolsHost ? createPortal(<div className="deck-tools">{toolParts}</div>, toolsHost) : null}

      {beside ? null : (
        <div className="grid__body" ref={bodyRef}>
          {viewMode === 'mosaic' ? (
            <MosaicView project={project} workspace={workspace} onNewTerminal={() => openChooser()} onOpenFull={openFull} />
          ) : tab ? (
            <>
              <SplitView
                node={tab.root}
                project={project}
                activePaneId={tab.activePaneId}
                onlyPane={countLeaves(tab.root) === 1}
              />
              <FocusReticle
                rootRef={bodyRef}
                selector=".pane[data-focused='true']"
                targetKey={tab.activePaneId}
                enabled={countLeaves(tab.root) > 1}
              />
              <PaneCarousel rootRef={bodyRef} count={workspace.tabs.reduce((n, t) => n + countLeaves(t.root), 0)} />
            </>
          ) : (
            <EmptyState
              icon="terminal"
              eyebrow={project.name}
              title="The deck is clear"
              body={
                <>
                  Open an agent in <span className="mono">{project.path}</span>. Panes split, glide and keep running
                  whatever you look at.
                </>
              }
              action={
                <button type="button" className="cta-btn" disabled={atLimit} onClick={() => openChooser()}>
                  <Icon name="plus" size={14} />
                  Open an agent
                </button>
              }
              hint="Ctrl + T"
            />
          )}
        </div>
      )}

      {chooser}
    </div>
  )
}

/* ------------------------------------------------------ mosaic text size */

/**
 * Full-size text on the wall, or whole terminals shrunk to fit.
 *
 * Lives in the menu's Tools rather than in Settings alone because it is the
 * answer to "why can I not read this", and the place you ask that is while
 * looking at the wall. It sets the wall strip's tiles too. Settings →
 * Appearance has the same switch for anyone who goes looking there first.
 */
function MosaicTextToggle(): ReactNode {
  const { state, actions } = useApp()
  const lifesize = state.settings.mosaicText !== 'scaled'

  return (
    <button
      type="button"
      className="ghost-btn tabstrip__text"
      data-on={lifesize ? 'true' : undefined}
      aria-pressed={lifesize}
      title={
        lifesize
          ? 'Full-size text: every tile is a window onto its terminal at the same type size as Full screen, cropped to the tile with the latest output showing. Click to shrink whole terminals to fit instead.'
          : 'Shrunk to fit: every tile keeps its terminal’s full width and shrinks the picture, so nothing reflows and the text gets smaller with every tile you add. Click for full-size text.'
      }
      onClick={() => actions.setMosaicText(lifesize ? 'scaled' : 'lifesize')}
    >
      <span className="tabstrip__aa">Aa</span>
      {lifesize ? 'Full size' : 'Shrink to fit'}
    </button>
  )
}

/* ------------------------------------------------------- tab text colours */

/**
 * Every tab's terminal colour, on or off, in one click.
 *
 * The tints are excellent for telling four Claudes apart and a distraction when
 * you are reading one of them closely, and that flips several times an hour —
 * so it is a switch in the menu's Tools, not a setting you go and find. It hides the
 * colours rather than clearing them: each tab keeps whatever it was painted,
 * the right-click palettes still work while it is off, and turning it back on
 * restores the lot. Nothing to redo, so nothing to fear about pressing it.
 */
function TabTintToggle(): ReactNode {
  const { state, actions } = useApp()
  const on = state.settings.tabTextColours

  return (
    <button
      type="button"
      className="ghost-btn tabstrip__tint"
      data-on={on ? 'true' : undefined}
      aria-pressed={on}
      title={
        on
          ? 'Tab text colours are on: each tab’s terminals print in its own colour. Click to put every terminal back to the default text colour — the colours are kept, not cleared.'
          : 'Tab text colours are off: every terminal prints in the default text colour. Click to bring each tab’s colour back.'
      }
      onClick={() => actions.setTabTextColours(!on)}
    >
      <Icon name="palette" size={12} />
    </button>
  )
}
