import type { ReactNode, Ref } from 'react'
import { Icon, type IconName } from '@/components/Icon'
import { DeckSheet, deckSheet, useDeckSheet } from './sheet'
import { DECK_THEMES, swatchOf } from './theme'
import type { DeckView } from './view'
import './DeckTopBar.css'

/*
 * Mirrors the deck top bar; redesign in progress on desktop-redesign — re-sync
 * when it lands. (src/components/TitleBar.tsx + shell/DeckBar.css, read only.)
 *
 * Deliberately small and self-contained so it can be thrown away and redrawn
 * when the desktop's bar settles: the mark and wordmark on the left, one chip in
 * the middle that says where you are and opens the panes sheet (the tabs live
 * there, not up here), and on the right the link, Tabs | Wall and one "…" menu
 * that holds everything else. TopBar supplies the menu's rows — Foreman, hand
 * off, the screen, notifications, sign out — because it already owns what they
 * do; this file only draws them.
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

export interface DeckWhere {
  tab: string
  panes: number
  tabs: number
  /** Panes in this project settled on a question. */
  waiting: number
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
  where,
  link,
  view,
  onView,
  rows,
  menuRef,
  themeId,
  onTheme
}: {
  where: DeckWhere | null
  link: DeckLink
  view: DeckView
  onView: (view: DeckView) => void
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
      </div>

      {where ? (
        <button
          type="button"
          className="dk-where"
          data-open={sheet === 'panes' ? 'true' : undefined}
          data-sheet-toggle="panes"
          aria-expanded={sheet === 'panes'}
          aria-haspopup="dialog"
          title="Tabs and panes — switch, open, close"
          onClick={() => deckSheet.toggle('panes')}
        >
          <Icon name="viewTabs" size={13} />
          <span className="dk-where__tab truncate">{where.tab}</span>
          <span className="dk-where__meta">
            {where.tabs} {where.tabs === 1 ? 'tab' : 'tabs'} · {where.panes} {where.panes === 1 ? 'pane' : 'panes'}
          </span>
          {where.waiting > 0 ? (
            <span className="dk-where__ask">
              <span aria-hidden="true">◆</span> {where.waiting} {where.waiting === 1 ? 'needs you' : 'need you'}
            </span>
          ) : null}
          <Icon name="chevronDown" size={11} className="dk-where__chev" />
        </button>
      ) : (
        <span />
      )}

      <div className="dk-bar__right">
        {/*
          `.linkbadge` kept alongside the deck's own class: it is what the web
          checks look for, and its data-state is the same WebConnectionState.
        */}
        <span className="linkbadge dk-link" data-state={link.state} data-warm={link.warm ? 'true' : undefined} title={link.title}>
          <LinkGlyph glyph={said.glyph} />
          <span className="dk-link__word">{said.word}</span>
          {link.name ? <span className="dk-link__name truncate">{link.name}</span> : null}
        </span>

        <div className="dk-view" role="group" aria-label="View">
          <button
            type="button"
            data-view="tabs"
            data-active={view === 'tabs' ? 'true' : undefined}
            aria-pressed={view === 'tabs'}
            title="Tabs — one tab's panes at a time"
            onClick={() => onView('tabs')}
          >
            <Icon name="viewTabs" size={12} />
            <span>Tabs</span>
          </button>
          <button
            type="button"
            data-view="wall"
            data-active={view === 'wall' ? 'true' : undefined}
            aria-pressed={view === 'wall'}
            title="Wall — every pane in this project at once"
            onClick={() => onView('wall')}
          >
            <Icon name="viewMosaic" size={12} />
            <span>Wall</span>
          </button>
        </div>

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
