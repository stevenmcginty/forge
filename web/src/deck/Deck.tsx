/*
 * Forge Web's desktop-browser face: "the deck", as the redesigned desktop app
 * (branch desktop-redesign) draws it. A phone never renders anything in here —
 * Workspace picks this face only when `useMobile()` is false, and every rule in
 * ./deck.css hangs off `.app[data-face='deck']`, which the phone face never
 * carries.
 *
 * What it mirrors, and how:
 *
 *   imported, so Dev changes flow through on the next build
 *     src/components/shell/deck-tokens.css   fonts, springs, geometry, glass
 *     src/components/shell/deck.css          pane / split / tab / empty chrome under `.deck`
 *     src/theme/themes.ts                    the six themes (./theme.ts)
 *     src/components/hub/VoicePill.css       the Listen switch (./ListenSwitch.tsx)
 *     src/lib/mosaicLayout.ts columnsFor     the Wall's grid (DeckStage below)
 *     src/lib/motion.ts usePresence          sheet enter/exit (./sheet.tsx)
 *
 *   redrawn here from the deck's own values (drift-checked by
 *   `node scripts/web-deck-check.mjs`)
 *     src/components/shell/Dock.tsx + Dock.css      the dock, the bar, the sheets
 *     src/components/shell/Backdrop.tsx (Calm)      the room behind the panes
 *     src/components/shell/Shell.css                stage padding, the toast
 *     src/components/TitleBar.tsx + DeckBar.css     the top bar (./DeckTopBar.tsx;
 *                                                   its redesign is in progress)
 *
 * Dock.css is not imported: its `.prow` would restyle the rail rows this face
 * puts in its projects sheet. DeckBar.css is not imported because that bar is
 * being redrawn on the desktop now.
 */
import { useEffect, useRef, type CSSProperties, type ReactNode } from 'react'
import '@/components/shell/deck-tokens.css'
import '@/components/shell/deck.css'
import { Icon } from '@/components/Icon'
import { columnsFor } from '@/lib/mosaicLayout'
import { collectLeaves } from '@/lib/splitTree'
import { alpha, findTheme, mix } from '@/theme/themes'
import { leafBoxes } from '../components/Panes'
import { PaneView } from '../components/PaneView'
import { Rail } from '../components/Rail'
import { SessionComposer } from '../components/SessionComposer'
import { useActiveProject, useForge, useWorkspace } from '../state'
import { PanesSheet } from './PanesSheet'
import { DeckSheet, deckSheet, useDeckSheet } from './sheet'
import type { DeckView } from './view'
import './deck.css'

/** The deck's pane gutter: `.deck .split > .split__divider` in deck.css, 20px. */
const DECK_GUTTER_PX = 20

/* ---------------------------------------------------------------- backdrop */

/**
 * The room behind the panes: the deck's "Calm" backdrop (Backdrop.tsx), its own
 * three gradients from the theme and the project's colour, so switching project
 * changes the light in the room as it does on the desk. The deck's default
 * scene (Ridgeline: stars and mountains, drawn to a canvas) is not redrawn here.
 */
export function DeckBackdrop({ themeId }: { themeId: string }): ReactNode {
  const project = useActiveProject()
  const core = findTheme(themeId, [])
  const light = core.appearance === 'light'
  const tint = project?.color && /^#[0-9a-f]{6}$/i.test(project.color) ? project.color : core.accent
  const background = [
    `radial-gradient(80% 60% at 50% -10%, ${alpha(tint, light ? 0.08 : 0.1)}, transparent 70%)`,
    `radial-gradient(120% 90% at 50% 120%, ${alpha('#000000', light ? 0.04 : 0.35)}, transparent 70%)`,
    `linear-gradient(180deg, ${core.bg}, ${mix(core.bg, core.info, 0.06)})`
  ].join(', ')
  return <div className="dk-backdrop" aria-hidden="true" style={{ background }} />
}

/* ------------------------------------------------------------------- stage */

/**
 * The stage: one tab's panes, or the Wall — every pane in the project at once.
 *
 * One keyed container for both, on purpose. A browser pane *is* its xterm
 * (see Panes.tsx), so a view switch that rebuilt the panes would dispose every
 * terminal, re-attach and re-replay each one — and a replay taken while the
 * link is live has the terminal answer the queries in it again, into the
 * shell. Here every pane of every tab that has been on screen is a direct child
 * keyed on its id; Tabs places the current tab's by its split tree (with the
 * deck's 20px gutter) and hides the rest, the Wall lays them all on the deck's
 * auto grid (`columnsFor`, MosaicView's rule). Switching moves boxes.
 *
 * On the Wall, pressing a tile in another tab brings that tab forward first, so
 * the bar below always talks to the pane with the ring on it. None of the
 * desk's freeform arranging, zoom or tile dragging: the wire has no verb for
 * any of it.
 */
export function DeckStage({
  view,
  drawn,
  empty
}: {
  view: DeckView
  drawn: Set<string>
  /** What the stage says when there is no project, or no tab. Workspace's words. */
  empty: ReactNode | null
}): ReactNode {
  const { state, actions } = useForge()
  const workspace = useWorkspace()
  const live = state.stage.kind === 'connected' && state.connection.state === 'live'
  const activeTab = workspace.tabs.find((t) => t.id === workspace.activeTabId) ?? workspace.tabs[0] ?? null

  if (empty || !activeTab) return <div className="dk-stage__empty">{empty}</div>

  const wall = view === 'wall'
  // Everything on the Wall has been seen; it stays mounted when Tabs comes back.
  if (wall) for (const tab of workspace.tabs) drawn.add(tab.id)
  const slots = workspace.tabs
    .filter((tab) => drawn.has(tab.id))
    .flatMap((tab) => leafBoxes(tab.root, DECK_GUTTER_PX).map(({ leaf, style }) => ({ leaf, tab, style })))
  const total = slots.length

  return (
    <div
      className="dk-panes"
      data-view={view}
      style={wall ? ({ '--dk-wall-cols': columnsFor(total) } as CSSProperties) : undefined}
    >
      {slots.map(({ leaf, tab, style }) => {
        const here = tab.id === activeTab.id
        const shown = wall || here
        const alone = wall ? total === 1 : collectLeaves(tab.root).length === 1
        return (
          <div
            key={leaf.id}
            className="dk-slot"
            data-shown={shown ? 'true' : 'false'}
            data-here-tab={here ? 'true' : undefined}
            style={wall ? undefined : style}
            onPointerDownCapture={
              wall && !here && live ? () => void actions.layout({ op: 'select-tab', tabId: tab.id }) : undefined
            }
          >
            {wall && workspace.tabs.length > 1 ? (
              <span className="dk-slot__tab" title={`In the tab “${tab.title}”`}>
                {tab.title}
              </span>
            ) : null}
            <PaneView
              leaf={leaf}
              focused={wall ? here && leaf.id === tab.activePaneId : leaf.id === tab.activePaneId}
              onlyPane={alone}
              onScreen={shown}
            />
          </div>
        )
      })}
    </div>
  )
}

/* -------------------------------------------------------------------- dock */

/**
 * The dock: one bar along the bottom edge — Dock.tsx's. The project you are in
 * leads it (and opens the projects sheet), then Listen, then the words and
 * where they go. It floats over the backdrop below the stage, so it never
 * covers a terminal.
 */
export function DeckDock(): ReactNode {
  const { state } = useForge()
  const project = useActiveProject()
  const workspace = useWorkspace()
  const offline = state.stage.kind === 'offline'
  const hasTab = workspace.tabs.length > 0
  const githubMode = offline && state.offlineMode === 'github'

  return (
    <div className="dk-dock" role="toolbar" aria-label="Dock">
      {project && hasTab && !githubMode ? (
        <SessionComposer face="deck" lead={<ProjectPill />} />
      ) : (
        <div className="dk-bar-idle">
          <ProjectPill />
          <span className="dk-bar-idle__words">
            {!project ? 'Pick a project to start' : githubMode ? 'The desktop is asleep' : 'No terminals open here yet'}
          </span>
        </div>
      )}
      <ProjectsSheet />
    </div>
  )
}

/** The project you are in, as the bar's first word; opens the projects sheet. */
function ProjectPill(): ReactNode {
  const project = useActiveProject()
  const open = useDeckSheet() === 'projects'
  return (
    <button
      type="button"
      className="dk-project"
      data-open={open ? 'true' : undefined}
      data-sheet-toggle="projects"
      aria-expanded={open}
      aria-haspopup="dialog"
      title="Projects — switch, add, git"
      style={{ '--project': project?.color ?? 'var(--accent)' } as CSSProperties}
      onMouseDown={(e) => e.preventDefault()}
      onClick={() => deckSheet.toggle('projects')}
    >
      <span className="dk-project__dot" aria-hidden="true" />
      <span className="dk-project__name truncate">{project?.name ?? 'No project'}</span>
      <Icon name="chevronDown" size={11} className="dk-project__chev" />
    </button>
  )
}

/**
 * Every project, rising out of the dock — Dock.tsx's ProjectSheet, holding this
 * page's own rail (projects, Add project, git) at full width. Picking a project
 * is the end of the errand: the sheet goes.
 */
function ProjectsSheet(): ReactNode {
  const { state } = useForge()
  const projectId = state.projectId
  const last = useRef(projectId)
  useEffect(() => {
    if (last.current === projectId) return
    last.current = projectId
    if (deckSheet.get() === 'projects') deckSheet.set(null)
  }, [projectId])
  return (
    <DeckSheet id="projects" className="dk-sheet--projects" label="Projects">
      <div className="dk-sheet__rail">
        <Rail collapsed={false} />
      </div>
    </DeckSheet>
  )
}

/* -------------------------------------------------------------- sheet host */

/**
 * Where this page's bottom sheets (the live-files sheet, a tab's confirm on a
 * phone-sized pop-up) land while the deck face is up. `BottomSheet` portals into
 * the first `.app[data-shell="app"]`, and its desktop styling hangs off
 * `.app:not([data-mobile])`; the deck root is `data-shell="deck"` — so the old
 * wide layout's `:not([data-mobile])` rules cannot reach the deck — and this
 * empty, click-through layer is that host instead.
 */
export function DeckSheetHost(): ReactNode {
  return <div className="app dk-sheet-host" data-shell="app" data-ready="true" />
}

export { PanesSheet }
