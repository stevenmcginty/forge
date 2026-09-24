import { useRef, useState, type ReactNode, type Ref } from 'react'
import { Icon, type IconName } from '@/components/Icon'
import { AgentChooser } from '../components/AgentChooser'
import { CommandsButton, SkillsButton } from '../components/Flyouts'
import { useActiveProject, useForge } from '../state'
import { AgentsMenu } from './AgentsMenu'
import { ShortcutKeys } from './DictationKey'
import { DeckSheet, deckSheet, useDeckSheet } from './sheet'
import { DECK_THEMES, swatchOf } from './theme'
import type { BarPlace, DeckView } from './view'
import { VoiceBar } from './VoiceBar'
import './DeckTopBar.css'

/*
 * The deck face's top bar: one slim row, and the only chrome above the panes.
 *
 * Left, the mark; then the two things that decide what the stage shows — the
 * Agents menu (which agent is on screen, every other one a click away, New
 * agent, close) and the Wall switch — and New, the Agents menu's New agent a
 * click nearer. Centre, the voice bar (project, D,
 * Type) while it lives up here rather than in the dock. Right, the pane
 * tools (skills, slash commands), the link, and one "…" menu that holds
 * everything else. TopBar
 * supplies the menu's rows — Foreman, hand off, the screen, notifications,
 * sign out — because it already owns what they do; this file only draws them.
 *
 * There is no tab strip and no pane header: a tab is just where an agent lives
 * on the desk, so the Agents menu lists agents across every tab and names the
 * tab beside each one.
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
  onTheme
}: {
  link: DeckLink
  view: DeckView
  onView: (view: DeckView) => void
  place: BarPlace
  rows: DeckMenuRow[]
  menuRef?: Ref<HTMLButtonElement>
  themeId: string
  onTheme: (id: string) => void
}): ReactNode {
  const sheet = useDeckSheet()
  const said = linkWord(link)

  return (
    <header className="dk-bar">
      <div className="dk-bar__left">
        <span className="dk-bar__mark" aria-hidden="true">
          <Icon name="forge" size={15} />
        </span>
        <span className="dk-bar__wordmark">Forge</span>
        <span className="dk-bar__rule" aria-hidden="true" />
        <AgentsMenu onView={onView} />
        <WallSwitch view={view} onView={onView} />
        <NewAgentButton onView={onView} />
      </div>

      <div className="dk-bar__centre">{place === 'top' ? <VoiceBar place="top" /> : null}</div>

      <div className="dk-bar__right">
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
            <Icon name="dots" size={16} />
          </button>
          <DeckSheet id="menu" className="dk-menu__panel" label="Menu">
            <DeckMenuBody rows={rows} themeId={themeId} onTheme={onTheme} />
          </DeckSheet>
        </span>
      </div>
    </header>
  )
}

/**
 * The Wall, on or off. One button rather than a two-way switch: focus is where
 * you work, the Wall is where you look around. Its state is in its shape — the
 * four windows fill in and a close mark appears while it is on — as well as in
 * `aria-pressed`, never in colour alone.
 */
function WallSwitch({ view, onView }: { view: DeckView; onView: (view: DeckView) => void }): ReactNode {
  const on = view === 'wall'
  return (
    <button
      type="button"
      className="dk-wall"
      data-on={on ? 'true' : undefined}
      aria-pressed={on}
      title={on ? 'Leave the Wall — back to one agent on the whole screen (Ctrl+G)' : 'Wall — every agent in this project at once (Ctrl+G)'}
      onClick={() => onView(on ? 'focus' : 'wall')}
    >
      <Icon name="wall" size={13} className="dk-wall__glyph" />
      <span className="dk-wall__word">Wall</span>
      {on ? <Icon name="close" size={10} className="dk-wall__x" /> : null}
    </button>
  )
}

/**
 * New, beside the Wall: exactly the Agents menu's New agent — the chooser, and
 * the pick opens as a new tab on the whole stage — without opening the list.
 * A plus and the word; under 860px the word goes and the label stays.
 */
function NewAgentButton({ onView }: { onView: (view: DeckView) => void }): ReactNode {
  const { state, actions } = useForge()
  const project = useActiveProject()
  const live = state.stage.kind === 'connected' && state.connection.state === 'live'
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
  return (
    <>
      <ShortcutKeys />
      <div className="dk-menu__rows" role="menu">
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
      <div className="dk-menu__section">
        <span className="dk-menu__eyebrow">Theme · this browser</span>
        <div className="dk-themes" role="radiogroup" aria-label="Theme">
          {DECK_THEMES.map((core) => {
            const sw = swatchOf(core)
            const here = core.id === themeId
            return (
              <button
                key={core.id}
                type="button"
                role="radio"
                aria-checked={here}
                className="dk-theme"
                data-theme-id={core.id}
                data-here={here ? 'true' : undefined}
                title={`${core.name}${core.appearance === 'light' ? ' — light' : ''}${here ? ' (in use)' : ''}`}
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
