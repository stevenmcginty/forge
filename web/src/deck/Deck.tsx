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
 *
 * Laid out as a stage and one slim top bar: focus (one agent, edge to edge)
 * or the Wall, the Agents menu and the Wall switch in the bar, and a voice bar
 * that lives in the top bar or in the dock (./view.ts `BarPlace`).
 */
import { useCallback, useEffect, useRef, useState, type CSSProperties, type ReactNode, type RefObject } from 'react'
import '@/components/shell/deck-tokens.css'
import '@/components/shell/deck.css'
import { AgentBadge } from '@/components/AgentBadge'
import { Icon } from '@/components/Icon'
import { Popover } from '@/components/Popover'
import { isShellProfile, resolveProfile } from '@/lib/agents'
import { columnsFor } from '@/lib/mosaicLayout'
import { collectLeaves } from '@/lib/splitTree'
import { alpha, findTheme, mix } from '@/theme/themes'
import { PaneView } from '../components/PaneView'
import { SessionComposer } from '../components/SessionComposer'
import { FACES } from '../components/StatusLine'
import { requestPaneView, usePaneView } from '../lib/pane-status'
import { getClaudeView } from '../lib/view-pref'
import { useActiveProject, useForge, useProfiles, useWorkspace } from '../state'
import { AgentStateChip, bringForward, deckAgent, type DeckAgent } from './agents'
import { composerField, composerOpen } from './composer'
import { useDeckDictation } from './dictation'
import type { BarPlace, DeckView } from './view'
import { ProjectsSheet, VoiceBar, VoiceLine } from './VoiceBar'
import './deck.css'
// After deck.css (and so after DeckTopBar.css and VoicePill.css): the bar's own look has the last word.
import './voicebar.css'
import './paneface.css'

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
 * The stage: one agent on the whole of it (focus), or the Wall — every agent in
 * the project at once.
 *
 * One keyed container for both, on purpose. A browser pane *is* its xterm
 * (see Panes.tsx), so a view switch that rebuilt the panes would dispose every
 * terminal, re-attach and re-replay each one — and a replay taken while the
 * link is live has the terminal answer the queries in it again, into the
 * shell. Here every pane of every tab that has been on screen is a direct child
 * keyed on its id; focus shows the front tab's active pane edge to edge and
 * hides the rest (`display: none`, which `fit()` in lib/term.ts refuses to
 * measure, so a hidden pane never resizes its PTY), the Wall lays them all on
 * the deck's auto grid (`columnsFor`, MosaicView's rule). Switching moves boxes.
 *
 * No pane header in either: the top bar names the agent on screen and its
 * state, and on the Wall each tile carries one slim label with the same words.
 * Pressing a tile brings its tab forward first, so the bar always talks to the
 * pane with the ring on it; the label's expand (or a double click on the label)
 * puts it on the whole stage.
 */
export function DeckStage({
  view,
  onView,
  drawn,
  empty
}: {
  view: DeckView
  onView: (view: DeckView) => void
  drawn: Set<string>
  /** What the stage says when there is no project, or no tab. Workspace's words. */
  empty: ReactNode | null
}): ReactNode {
  const { state, actions } = useForge()
  const workspace = useWorkspace()
  const profiles = useProfiles()
  const live = state.stage.kind === 'connected' && state.connection.state === 'live'
  const activeTab = workspace.tabs.find((t) => t.id === workspace.activeTabId) ?? workspace.tabs[0] ?? null

  const [closingTarget, setClosingTarget] = useState<{ agent: DeckAgent; anchor: HTMLElement } | null>(null)

  useEffect(() => {
    if (!closingTarget) return
    const exists = workspace.tabs.some((t) => collectLeaves(t.root).some((l) => l.id === closingTarget.agent.leaf.id))
    if (!exists) setClosingTarget(null)
  }, [workspace.tabs, closingTarget])

  const doClose = useCallback(
    (agent: DeckAgent) => {
      const tab = workspace.tabs.find((t) => t.id === agent.tab.id) ?? agent.tab
      const alone = collectLeaves(tab.root).length <= 1
      void actions
        .layout(alone ? { op: 'close-tab', tabId: tab.id } : { op: 'close-pane', paneId: agent.leaf.id })
        .then((refused) => {
          if (refused) actions.setNotice(refused)
        })
    },
    [actions, workspace.tabs]
  )

  if (empty || !activeTab) return <div className="dk-stage__empty">{empty}</div>

  const wall = view === 'wall'
  // Everything on the Wall has been seen; it stays mounted when focus comes back.
  if (wall) for (const tab of workspace.tabs) drawn.add(tab.id)
  const frontLeaves = collectLeaves(activeTab.root)
  const focusId = (frontLeaves.find((l) => l.id === activeTab.activePaneId) ?? frontLeaves[0])?.id ?? null
  const slots = workspace.tabs
    .filter((tab) => drawn.has(tab.id))
    .flatMap((tab) => collectLeaves(tab.root).map((leaf) => ({ leaf, tab })))
  const total = slots.length

  return (
    <>
      <div
        className="dk-panes"
        data-view={view}
        style={wall ? ({ '--dk-wall-cols': columnsFor(total) } as CSSProperties) : undefined}
      >
        {slots.map(({ leaf, tab }) => {
          const here = tab.id === activeTab.id
          const focused = here && leaf.id === focusId
          const shown = wall || focused
          const profile = resolveProfile(profiles, leaf.profileId)
          const agent = deckAgent(leaf, tab, profile)
          // Chat, Cards and Terminal are an agent's; a shell has only its terminal.
          const faces = !isShellProfile(profile)
          const open = (): void => {
            onView('focus')
            if (!live) return
            void bringForward(actions, activeTab.id, agent).then((refused) => {
              if (refused) actions.setNotice(refused)
            })
          }
          return (
            <div
              key={leaf.id}
              className="dk-slot"
              data-shown={shown ? 'true' : 'false'}
              data-focused={wall && focused ? 'true' : undefined}
              style={{ '--pane-accent': profile.accent } as CSSProperties}
              onPointerDownCapture={
                wall && !here && live ? () => void actions.layout({ op: 'select-tab', tabId: tab.id }) : undefined
              }
            >
              {wall ? (
                <TileLabel
                  agent={agent}
                  tabTitle={agent.name}
                  focused={focused}
                  faces={faces}
                  live={live}
                  onSelect={() => {
                    if (live && !focused) void actions.layout({ op: 'focus-pane', paneId: leaf.id })
                  }}
                  onOpen={open}
                  onClose={(anchor) => setClosingTarget({ agent, anchor })}
                />
              ) : null}
              <PaneView
                leaf={leaf}
                focused={focused}
                onlyPane={!wall || total === 1}
                onScreen={shown}
                fullScreen={!wall && shown}
                tabTitle={agent.name}
                faceSwitch={!wall && faces ? <FaceSwitch paneId={leaf.id} name={agent.name} /> : null}
                onClose={!wall && shown ? (anchor) => setClosingTarget({ agent, anchor }) : null}
              />
            </div>
          )
        })}
      </div>

      {closingTarget ? (
        <Popover
          anchor={closingTarget.anchor}
          open
          onClose={() => setClosingTarget(null)}
          align="end"
          side="bottom"
          width={260}
          label={`Close ${closingTarget.agent.name}?`}
        >
          <div className="tab-confirm" onPointerDown={(e) => e.stopPropagation()}>
            <div className="tab-confirm__head">
              <span className="eyebrow tab-confirm__eyebrow">
                Close {isShellProfile(closingTarget.agent.profile) ? 'Terminal' : 'Agent'}
              </span>
            </div>
            <p className="tab-confirm__body">
              Are you sure you want to close <strong className="tab-confirm__name truncate">“{closingTarget.agent.name}”</strong>?
            </p>
            <p className="tab-confirm__hint">
              Running processes in this window will be stopped.
            </p>
            <div className="tab-confirm__actions">
              <button
                type="button"
                className="ghost-btn tab-confirm__cancel"
                onClick={(e) => {
                  e.stopPropagation()
                  setClosingTarget(null)
                }}
              >
                Cancel
              </button>
              <button
                type="button"
                className="ghost-btn tab-confirm__close"
                data-danger="true"
                autoFocus
                onClick={(e) => {
                  e.stopPropagation()
                  const target = closingTarget.agent
                  setClosingTarget(null)
                  doClose(target)
                }}
              >
                Close
              </button>
            </div>
          </div>
        </Popover>
      ) : null}
    </>
  )
}

/**
 * A Wall tile's one line: who, which tab, the state in a shape and a word, and
 * the way to full screen. The tile with the ring on it also says "Active", so
 * which one the bar talks to never rests on the ring's colour.
 */
function TileLabel({
  agent,
  tabTitle,
  focused,
  faces,
  live,
  onSelect,
  onOpen,
  onClose
}: {
  agent: DeckAgent
  /** The terminal's one name, on its chip — always shown. */
  tabTitle: string
  focused: boolean
  /** An agent's tile carries its Chat / Cards / Terminal switch; a shell's does not. */
  faces: boolean
  live: boolean
  onSelect: () => void
  onOpen: () => void
  onClose: (anchor: HTMLElement) => void
}): ReactNode {
  return (
    <div
      className="dk-tile__label"
      title={`${tabTitle} (${agent.title}). Double-click for full screen`}
      onClick={onSelect}
      onDoubleClick={onOpen}
    >
      <AgentBadge profile={agent.profile} size="sm" />
      <span className="dk-tile__name truncate">{agent.title}</span>
      <span className="dk-tile__tab truncate">{tabTitle}</span>
      <span className="dk-tile__spacer" />
      {focused ? <span className="dk-tile__active">Active</span> : null}
      <AgentStateChip paneId={agent.leaf.id} compact />
      {faces ? <FaceSwitch paneId={agent.leaf.id} name={agent.name} compact /> : null}
      <button
        type="button"
        className="dk-tile__open"
        aria-label={`Full screen: ${agent.name}`}
        title="Full screen — this agent alone"
        onClick={(e) => {
          e.stopPropagation()
          onOpen()
        }}
        onDoubleClick={(e) => e.stopPropagation()}
      >
        <Icon name="expand" size={12} />
      </button>
      <button
        type="button"
        className="dk-tile__close"
        disabled={!live}
        aria-label={`Close ${agent.name}`}
        title={live ? `Close ${agent.name}` : 'The desktop is not answering, so it cannot close one'}
        onClick={(e) => {
          e.stopPropagation()
          onClose(e.currentTarget)
        }}
        onDoubleClick={(e) => e.stopPropagation()}
      >
        <Icon name="close" size={11} />
      </button>
    </div>
  )
}

/**
 * Chat, Cards or Terminal for one agent pane: in Full screen's slim header,
 * and on each Wall tile's label. The pane itself, not the composer, carries it:
 * the composer's strip (AgentStatus's face button) gives its place to the
 * drawer while the box has the keys, and in Chat or Cards the box is the only
 * place the keys can go — so a switch that lived only there went with the first
 * word typed, and Terminal was out of reach.
 *
 * Every face is a shape (bubble, stacked cards, prompt). The one on screen is a
 * raised chip that also says its name in a bold word; on a Wall tile the others
 * are their shapes alone, named on hover. Colour only agrees.
 */
function FaceSwitch({ paneId, name, compact = false }: { paneId: string; name: string; compact?: boolean }): ReactNode {
  const view = usePaneView(paneId) ?? getClaudeView()
  return (
    <div
      className="dk-face"
      data-compact={compact ? 'true' : undefined}
      role="group"
      aria-label={`Show ${name} as`}
      onClick={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
    >
      {FACES.map(({ face, label, icon }) => {
        const on = view === face
        return (
          <button
            key={face}
            type="button"
            className="dk-face__btn"
            data-on={on ? 'true' : 'false'}
            aria-pressed={on}
            aria-label={label}
            title={on ? `${label} — showing now` : `Show as ${label}`}
            onClick={() => {
              if (!on) requestPaneView(paneId, face)
            }}
          >
            <svg
              width="14"
              height="14"
              viewBox="0 0 20 20"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.6"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
              focusable="false"
            >
              {icon}
            </svg>
            <span className="dk-face__word">{label}</span>
          </button>
        )
      })}
    </div>
  )
}

/* -------------------------------------------------------------------- dock */

/**
 * Where the words are written, by where the voice bar is.
 *
 *   bottom  the dock: one bar along the bottom edge (Dock.tsx's) — the voice
 *           bar group leads it, then the words and where they go. It floats
 *           below the stage, so it never covers a terminal: the stage stops
 *           where the dock's resting height says (useDockClearance).
 *   top     the voice bar group is in the top bar, and the words float as a
 *           card over the foot of the stage — only while they are wanted: asked
 *           for (Ctrl+Shift+G, Type, D with no text field focused), while a
 *           dictation is filling them, or while they hold unsent words. Send,
 *           or Esc on an empty box, puts it away; so does a click elsewhere
 *           while it is empty. Hidden, it stays mounted — SessionComposer owns
 *           the drafts, and they must outlive a hide.
 */
export function DeckDock({ place }: { place: BarPlace }): ReactNode {
  const { state } = useForge()
  const project = useActiveProject()
  const workspace = useWorkspace()
  const offline = state.stage.kind === 'offline'
  const hasTab = workspace.tabs.length > 0
  const githubMode = offline && state.offlineMode === 'github'
  const composing = !!project && hasTab && !githubMode
  const dockRef = useRef<HTMLDivElement | null>(null)
  useDockClearance(dockRef, place === 'bottom')

  if (place === 'top') return composing ? <FloatingComposer /> : null

  return (
    <div ref={dockRef} className="dk-dock dk-composer" role="toolbar" aria-label="Dock">
      <VoiceLine place="bottom" />
      {composing ? (
        <SessionComposer face="deck" lead={<VoiceBar place="bottom" />} />
      ) : (
        <div className="dk-bar-idle">
          <VoiceBar place="bottom" />
          <span className="dk-bar-idle__words">
            {!project ? 'Pick a project to start' : githubMode ? 'The desktop is asleep' : 'No terminals open here yet'}
          </span>
        </div>
      )}
      <ProjectsSheet />
    </div>
  )
}

/** The dock's words or picks have the keys: it is growing for now, not for good. */
const DOCK_TYPING = '.composer__input:focus, .composer__picks:focus-within, .composer__picks [aria-expanded="true"]'

/**
 * The stage makes room for the dock as it really is, not as a guess: the
 * dock's height at rest, measured, goes on the deck root as `--dk-dock-h`, and
 * deck.css turns it into the stage's clearance. The terminal keys, a voice
 * line, a draft of several lines left in the box — each is the dock's height
 * for as long as it stays, and the panes above refit to it once.
 *
 * At rest means the words or the picks do not have the keys. The picks row
 * that opens while you are in the box, and each line a draft grows by while
 * you type it, float over the foot of the stage instead: refitting every
 * terminal (and resizing every PTY) on each focus and each new line would
 * jolt the panes while you write. Leaving the box measures again.
 */
function useDockClearance(ref: RefObject<HTMLDivElement | null>, on: boolean): void {
  useEffect(() => {
    const dock = ref.current
    const root = dock?.closest<HTMLElement>('.app[data-face="deck"]')
    if (!on || !dock || !root) return undefined
    let frame = 0
    const measure = (): void => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => {
        if (dock.querySelector(DOCK_TYPING)) return
        root.style.setProperty('--dk-dock-h', `${Math.ceil(dock.getBoundingClientRect().height)}px`)
      })
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(dock)
    dock.addEventListener('focusout', measure)
    return () => {
      cancelAnimationFrame(frame)
      observer.disconnect()
      dock.removeEventListener('focusout', measure)
      root.style.removeProperty('--dk-dock-h')
    }
  }, [ref, on])
}

/** How long after Send the box may take to empty (the claim wait) and still count as sent. */
const SENT_GRACE_MS = 8000

function FloatingComposer(): ReactNode {
  const open = composerOpen.use()
  const dictation = useDeckDictation()
  const [hasDraft, setHasDraft] = useState(false)
  const sentAt = useRef(0)
  const ref = useRef<HTMLDivElement | null>(null)

  // The draft lives in SessionComposer; its box is the one place to read it.
  useEffect(() => {
    const tick = (): void => {
      const words = (composerField()?.value ?? '').trim()
      setHasDraft(words.length > 0)
      if (!words && sentAt.current) {
        if (Date.now() - sentAt.current < SENT_GRACE_MS) composerOpen.set(false)
        sentAt.current = 0
      } else if (sentAt.current && Date.now() - sentAt.current >= SENT_GRACE_MS) {
        sentAt.current = 0
      }
    }
    tick()
    const timer = window.setInterval(tick, 250)
    return () => window.clearInterval(timer)
  }, [])

  // A dictation that sent itself is a Send: the box goes once it empties, as after Enter.
  const wasReview = useRef(false)
  useEffect(() => {
    if (wasReview.current && dictation === 'idle') sentAt.current = Date.now()
    wasReview.current = dictation === 'review'
  }, [dictation])

  const busy = dictation !== 'idle'
  const shown = open || hasDraft

  // A click elsewhere puts an empty, idle box away — not one holding words.
  useEffect(() => {
    if (!open) return undefined
    const onDown = (e: PointerEvent): void => {
      const t = e.target as Element | null
      if (!t || ref.current?.contains(t)) return
      if (t.closest('.popover, .bsheet-layer, [data-voicebar]')) return
      if (busy || (composerField()?.value ?? '').trim()) return
      composerOpen.set(false)
    }
    window.addEventListener('pointerdown', onDown, true)
    return () => window.removeEventListener('pointerdown', onDown, true)
  }, [open, busy])

  return (
    <div
      ref={ref}
      className="dk-float dk-composer"
      data-shown={shown ? 'true' : 'false'}
      aria-hidden={shown ? undefined : true}
      onKeyDownCapture={(e) => {
        const field = composerField()
        if (!field || e.target !== field) return
        if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing && field.value.trim()) {
          sentAt.current = Date.now()
        } else if (e.key === 'Escape' && !field.value.trim()) {
          e.preventDefault()
          composerOpen.set(false)
          field.blur()
          // The keys go back to the agent on screen.
          document
            .querySelector<HTMLTextAreaElement>(
              '.app[data-face="deck"] .dk-slot[data-shown="true"] .pane[data-focused="true"] .xterm-helper-textarea'
            )
            ?.focus()
        }
      }}
      onClickCapture={(e) => {
        if ((e.target as Element).closest('.composer__send') && (composerField()?.value ?? '').trim()) {
          sentAt.current = Date.now()
        }
      }}
    >
      <SessionComposer face="deck" />
    </div>
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
