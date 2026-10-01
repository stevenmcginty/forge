import { useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type ReactNode, type Ref } from 'react'
import { Icon, type IconName } from '@/components/Icon'
import { BOARD_MIRROR_FEATURE } from '@shared/board-mirror'
import { BROWSER_MIRROR_FEATURE } from '@shared/browser-mirror'
import { AgentChooser } from '../components/AgentChooser'
import { CommandsButton, SkillsButton } from '../components/Flyouts'
import { useDeskFeature } from '../lib/features'
import { useActiveProject, useForge, useWorkspace } from '../state'
import { AgentsMenu } from './AgentsMenu'
import { ShortcutKeys } from './DictationKey'
import { DeckSheet, deckSheet, useDeckSheet } from './sheet'
import { DECK_THEMES, swatchOf } from './theme'
import { setDeckSurface, useDeckSurface, type BarPlace, type DeckSurface, type DeckView } from './view'
import { VoiceBar } from './VoiceBar'
import './DeckTopBar.css'

/*
 * The deck face's top bar: one slim row, and the only chrome above the panes.
 *
 * Left, the mark; then the
 * two things that decide which agents the stage shows — the Agents menu (which agent is on screen, every other one a click away, New
 * agent, close) and the Wall switch — and New, the Agents menu's New agent a
 * click nearer. Centre, the Agents | Browser | Board switch (./DeckBrowser.tsx,
 * ./DeckBoard.tsx), where the desktop's title bar keeps its mode pill. Right,
 * the voice bar (project, D, Type) while it lives up here rather than in the
 * dock, the pane tools (skills, slash commands), the link, and one "…" menu
 * that holds everything else. TopBar
 * supplies the menu's rows — Foreman, hand off, the screen, notifications,
 * sign out — because it already owns what they do; this file only draws them.
 *
 * There is no tab strip and no pane header: a tab is just where an agent lives
 * on the desk, so the Agents menu lists agents across every tab and names the
 * tab beside each one.
 *
 * It is the desktop's top bar (src/components/TitleBar.tsx) part for part: the
 * same chips, wells, lamps and discs, the same solid New, the same menus and
 * the same motion — DeckTopBar.css restates shell/DeckBar.css rule for rule.
 */

export interface DeckMenuRow {
  id: string
  label: string
  /** A word or two after the label: the state the row is in, never colour alone. */
  detail?: string
  icon: IconName
  onSelect?: () => void
  /** A real link (Open RustDesk) rather than a script. */
  href?: string
  disabled?: boolean
  /** Lit: the thing the row names is on right now. */
  on?: boolean
}

export interface DeckLink {
  state: string
  warm: boolean
  name: string
  title: string
}

/** The link as a word and a shape. The dot's colour only agrees with them. */
function linkWord(link: DeckLink): { word: string; glyph: 'live' | 'quiet' | 'asleep' | 'dialling' } {
  if (link.state === 'offline') return { word: 'asleep', glyph: 'asleep' }
  if (link.state === 'live') return link.warm ? { word: 'live', glyph: 'live' } : { word: 'quiet', glyph: 'quiet' }
  return { word: 'connecting', glyph: 'dialling' }
}

function LinkGlyph({ glyph }: { glyph: ReturnType<typeof linkWord>['glyph'] }): ReactNode {
  return (
    <svg className="dk-link__glyph" width="9" height="9" viewBox="0 0 10 10" aria-hidden="true">
      {glyph === 'live' ? <circle cx="5" cy="5" r="3.6" fill="currentColor" /> : null}
      {glyph === 'quiet' ? (
        <>
          <circle cx="5" cy="5" r="3.3" fill="none" stroke="currentColor" strokeWidth="1.4" />
          <path d="M5 1.7 A3.3 3.3 0 0 1 5 8.3 Z" fill="currentColor" />
        </>
      ) : null}
      {glyph === 'asleep' ? <circle cx="5" cy="5" r="3.2" fill="none" stroke="currentColor" strokeWidth="1.4" /> : null}
      {glyph === 'dialling' ? (
        <circle cx="5" cy="5" r="3.2" fill="none" stroke="currentColor" strokeWidth="1.4" strokeDasharray="1.6 1.6" />
      ) : null}
    </svg>
  )
}

export function DeckTopBar({
  link,
  view,
  onView,
  place,
  rows,
  menuRef,
  themeId,
  onTheme,
  everySurface = false
}: {
  link: DeckLink
  view: DeckView
  onView: (view: DeckView) => void
  place: BarPlace
  rows: DeckMenuRow[]
  menuRef?: Ref<HTMLButtonElement>
  themeId: string
  onTheme: (id: string) => void
  /** The preview harness: show Browser and Board whatever the desktop announces. */
  everySurface?: boolean
}): ReactNode {
  const sheet = useDeckSheet()
  const said = linkWord(link)
  // Picking an agent, the Wall or New is asking for the agents: the stage
  // leaves the Browser for them.
  const toAgents = (next: DeckView): void => {
    setDeckSurface('agents')
    onView(next)
  }

  return (
    <header className="dk-bar">
      <div className="dk-bar__left">
        <span className="dk-bar__mark" aria-hidden="true">
          <Icon name="forge" size={15} />
        </span>
        <span className="dk-bar__wordmark">Forge</span>
        <AgentsMenu onView={toAgents} />
        <WallSwitch view={view} onView={toAgents} />
        <NewAgentButton onView={toAgents} />
      </div>

      <div className="dk-bar__centre">
        <SurfaceSwitch every={everySurface} />
      </div>

      <div className="dk-bar__right">
        {place === 'top' ? <VoiceBar place="top" /> : null}
        <span className="dk-tools" role="group" aria-label="Pane tools">
          <SkillsButton />
          <CommandsButton />
        </span>

        {/*
          `.linkbadge` kept alongside the deck's own class: it is what the web
          checks look for, and its data-state is the same WebConnectionState.
        */}
        <span className="linkbadge dk-link" data-state={link.state} data-warm={link.warm ? 'true' : undefined} title={link.title}>
          <LinkGlyph glyph={said.glyph} />
          <span className="dk-link__word">{said.word}</span>
          {link.name ? <span className="dk-link__name truncate">{link.name}</span> : null}
        </span>

        <span className="dk-menu">
          <button
            ref={menuRef}
            type="button"
            className="dk-menu__btn"
            data-on={sheet === 'menu' ? 'true' : undefined}
            data-sheet-toggle="menu"
            aria-label="Menu"
            aria-haspopup="menu"
            aria-expanded={sheet === 'menu'}
            title="Menu — this pane, the desktop, the theme, sign out"
            onClick={() => deckSheet.toggle('menu')}
          >
            <Icon name="cog" size={16} />
          </button>
          <DeckSheet id="menu" className="dk-menu__panel" label="Menu">
            <DeckMenuBody rows={rows} themeId={themeId} onTheme={onTheme} />
          </DeckSheet>
        </span>
      </div>
    </header>
  )
}

const SURFACES: { id: DeckSurface; label: string; icon: IconName; title: string }[] = [
  { id: 'agents', label: 'Agents', icon: 'terminal', title: "The desktop's agents" },
  { id: 'browser', label: 'Browser', icon: 'globe', title: "The desktop's Browser tabs — sign in to sites from here" },
  { id: 'board', label: 'Board', icon: 'image', title: "What the agents put on this project's Board" }
]

/**
 * Agents, Browser or Board: what the stage shows (./view.ts `DeckSurface`) —
 * the desktop's mode switch (src/components/TitleBar.tsx `ModePill`), centred
 * in the bar the same way. A well, and in it one raised key — the lamp — on
 * the one showing: a shape and a word, never colour alone. The segments are
 * all one width, so the lamp is placed by two numbers (which segment, of how
 * many) and moved by a transform alone; nothing is measured, and it still
 * lands right when the words drop in a narrow window. Browser and Board each
 * hide from a desktop too old to serve them, unless this browser is already on
 * that one — then it stays, so there is a way back. With neither left, the
 * switch hides.
 */
function SurfaceSwitch({ every }: { every: boolean }): ReactNode {
  const surface = useDeckSurface()
  const browser = useDeskFeature(BROWSER_MIRROR_FEATURE)
  const board = useDeskFeature(BOARD_MIRROR_FEATURE)
  const shown = SURFACES.filter(
    ({ id }) => every || id === 'agents' || id === surface || (id === 'browser' ? browser : board)
  )
  const count = shown.length
  const index = Math.max(
    0,
    shown.findIndex(({ id }) => id === surface)
  )

  if (count < 2) return null
  return (
    <nav className="dk-modes" aria-label="Show on the stage" style={{ '--i': index, '--n': count } as CSSProperties}>
      <span className="dk-modes__lamp" aria-hidden="true" />
      {shown.map(({ id, label, icon, title }) => {
        const on = surface === id
        return (
          <button
            key={id}
            type="button"
            className="dk-modes__btn"
            data-surface={id}
            data-on={on ? 'true' : 'false'}
            aria-pressed={on}
            aria-label={label}
            title={on ? `${label} — showing now` : title}
            onClick={() => setDeckSurface(id)}
          >
            <Icon name={icon} size={13} />
            <span className="dk-modes__word">{label}</span>
          </button>
        )
      })}
    </nav>
  )
}

/**
 * Wall on or off, shown as the two views it flips between — the desktop's
 * switch (src/components/TitleBar.tsx `WallSwitch`). On: the Wall, every agent
 * at once. Off: Full screen, one agent on the whole stage. Both words are
 * always there and the one you are in sits on the lamp — a word and a shape,
 * never colour alone — which glides across. Still one button: a click (or
 * Ctrl+G) flips it, and `aria-pressed` says whether the Wall is on. Over the
 * Browser or the Board neither is where you are, so the lamp goes and a click
 * brings the agents back, as the Wall. In a narrow window the words give way
 * to their glyphs.
 */
function WallSwitch({ view, onView }: { view: DeckView; onView: (view: DeckView) => void }): ReactNode {
  const surface = useDeckSurface()
  const aside = surface !== 'agents'
  const on = view === 'wall' && !aside
  const title = on
    ? 'Wall — every agent at once. Click for Full screen, one agent (Ctrl+G)'
    : aside
      ? 'Wall — every agent in this project at once (Ctrl+G)'
      : 'Full screen — one agent. Click for the Wall, every agent at once (Ctrl+G)'
  return (
    <button
      type="button"
      className="dk-wall"
      data-on={on ? 'true' : undefined}
      aria-pressed={on}
      aria-label="Wall"
      title={title}
      style={{ '--i': on ? 0 : 1, '--n': 2 } as CSSProperties}
      onClick={() => onView(aside ? 'wall' : on ? 'focus' : 'wall')}
    >
      <span className="dk-wall__thumb" aria-hidden="true" data-hidden={aside ? 'true' : undefined} />
      <span className="dk-wall__view" data-view="wall" data-lit={on ? 'true' : undefined}>
        <Icon name="wall" size={13} />
        <span className="dk-wall__word">Wall</span>
      </span>
      <span className="dk-wall__view" data-view="full" data-lit={!on && !aside ? 'true' : undefined}>
        <Icon name="expand" size={13} />
        <span className="dk-wall__word">Full screen</span>
      </span>
    </button>
  )
}

/**
 * New, beside the Wall: exactly the Agents menu's New agent — the chooser, and
 * the pick opens as a new tab on the whole stage — without opening the list.
 * The one solid-accent control on the bar, as on the desktop: a plus that
 * rests as a close mark while its chooser is up, and a slow ring inviting the
 * first agent into an empty project. Under 860px the word goes and the label
 * stays.
 */
function NewAgentButton({ onView }: { onView: (view: DeckView) => void }): ReactNode {
  const { state, actions } = useForge()
  const project = useActiveProject()
  const live = state.stage.kind === 'connected' && state.connection.state === 'live'
  const none = useWorkspace().tabs.length === 0
  const ref = useRef<HTMLButtonElement | null>(null)
  const [open, setOpen] = useState(false)
  if (!project) return null
  return (
    <>
      <button
        ref={ref}
        type="button"
        className="dk-new"
        data-open={open ? 'true' : undefined}
        data-invite={none && live ? 'true' : undefined}
        aria-label="New agent"
        aria-haspopup="dialog"
        aria-expanded={open}
        disabled={!live}
        title={live ? 'New agent' : 'New agent — the desktop is not answering, so it cannot open one'}
        onClick={() => {
          deckSheet.set(null)
          setOpen((v) => !v)
        }}
      >
        <span className="dk-new__sheen" aria-hidden="true" />
        <Icon name="plus" size={13} />
        <span className="dk-new__word">New</span>
      </button>
      <AgentChooser
        anchor={ref.current}
        open={open}
        onClose={() => setOpen(false)}
        onPick={(profileId, permissionMode) => {
          setOpen(false)
          onView('focus')
          void actions.layout({ op: 'create-tab', profileId, permissionMode })
        }}
        onChat={(bot) => {
          setOpen(false)
          onView('focus')
          void actions.layout({ op: 'newChatTab', bot }).then((refused) => {
            if (refused) actions.setNotice(refused)
          })
        }}
        selectedId={project.defaultProfileId}
      />
    </>
  )
}

function DeckMenuBody({
  rows,
  themeId,
  onTheme
}: {
  rows: DeckMenuRow[]
  themeId: string
  onTheme: (id: string) => void
}): ReactNode {
  const run = (fn: (() => void) | undefined): void => {
    deckSheet.set(null)
    fn?.()
  }
  // The rows are a menu: the arrows walk them, Home and End jump to the ends.
  const onRowKey = (e: ReactKeyboardEvent<HTMLDivElement>): void => {
    const step = e.key === 'ArrowDown' ? 1 : e.key === 'ArrowUp' ? -1 : 0
    if (!step && e.key !== 'Home' && e.key !== 'End') return
    const items = [...e.currentTarget.querySelectorAll<HTMLElement>('[role="menuitem"]:not(:disabled)')]
    if (!items.length) return
    e.preventDefault()
    const at = items.indexOf(document.activeElement as HTMLElement)
    const next = e.key === 'Home' ? 0 : e.key === 'End' ? items.length - 1 : (at + step + items.length) % items.length
    items[next]?.focus()
  }
  return (
    <>
      <div className="dk-menu__rows" role="menu" onKeyDown={onRowKey}>
        {rows.map((row) =>
          row.href ? (
            <a
              key={row.id}
              role="menuitem"
              className="dk-menu__row"
              href={row.href}
              rel="noopener"
              onClick={() => deckSheet.set(null)}
            >
              <Icon name={row.icon} size={14} />
              <span className="dk-menu__label">{row.label}</span>
              {row.detail ? <span className="dk-menu__detail">{row.detail}</span> : <span />}
            </a>
          ) : (
            <button
              key={row.id}
              type="button"
              role="menuitem"
              className="dk-menu__row"
              data-on={row.on ? 'true' : undefined}
              disabled={row.disabled}
              onClick={() => run(row.onSelect)}
            >
              <Icon name={row.icon} size={14} />
              <span className="dk-menu__label">{row.label}</span>
              {row.detail ? <span className="dk-menu__detail">{row.detail}</span> : <span />}
            </button>
          )
        )}
      </div>
      <ShortcutKeys />
      <div className="dk-menu__section">
        <span className="dk-menu__eyebrow">Theme · this browser</span>
        <div className="dk-themes" role="radiogroup" aria-label="Theme">
          {DECK_THEMES.map((core) => {
            const here = core.id === themeId
            const sw = swatchOf(core)
            const look = core.appearance === 'light' ? ' — light' : ''
            return (
              <button
                key={core.id}
                type="button"
                role="radio"
                aria-checked={here}
                className="dk-theme"
                data-theme-id={core.id}
                data-here={here ? 'true' : undefined}
                title={`${core.name}${look}${here ? ' (in use)' : ''}`}
                onClick={() => onTheme(core.id)}
              >
                <span className="dk-theme__swatch" style={{ background: sw.bg }} aria-hidden="true">
                  <span className="dk-theme__panel" style={{ background: sw.panel }} />
                  <span className="dk-theme__accent" style={{ background: sw.accent }} />
                  {here ? (
                    <span className="dk-theme__check">
                      <Icon name="check" size={10} />
                    </span>
                  ) : null}
                </span>
                <span className="dk-theme__name">
                  {core.name}
                  {here ? <span className="dk-theme__here">in use</span> : null}
                </span>
              </button>
            )
          })}
        </div>
      </div>
    </>
  )
}
