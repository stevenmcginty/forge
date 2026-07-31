import { useMemo, useRef, useState, type ReactNode } from 'react'
import type { ReleaseNote, SlashCommand } from '@/lib/commands'
import {
  BUNDLED_SNAPSHOT_DATE,
  commandSignature,
  needsNewerCli,
  paneTakesCommands,
  rankCommands,
  releasesAhead,
  typeCommandIntoPane,
  useCommands,
  commandsStore
} from '@/lib/commands'
import { resolveProfile } from '@/lib/agents'
import { collectLeaves } from '@/lib/splitTree'
import { terminalHost } from '@/lib/terminals'
import { useActiveTab, useApp } from '@/state/AppState'
import { Icon } from './Icon'
import { Popover } from './Popover'
import './CommandsFlyout.css'

/**
 * COMMANDS — the slash-command reference and the CLI changelog, in the strip.
 *
 * The problem it solves is the one Steve named: `claude` ships several times a
 * week, its command set moves with it, and the only way to see either was to
 * stop what you were doing and go and read a web page. So the web page comes
 * here — parsed, searchable, and one click from being typed into the pane you
 * are looking at.
 *
 * It sits in the tab strip beside the mosaic and tint toggles rather than in
 * Settings for the same reason the wall's text switch does: it is the answer to
 * a question you ask *while working*, and a reference you have to navigate away
 * from your work to open is a reference you stop opening.
 *
 * Two panels, because they are two different questions asked by the same
 * curiosity — "what can I type" and "what changed" — and neither is worth a
 * control of its own in a strip this crowded.
 */
export function CommandsButton(): ReactNode {
  const [open, setOpen] = useState(false)
  const buttonRef = useRef<HTMLButtonElement | null>(null)
  const { feed } = useCommands()

  const ahead = releasesAhead(feed.releases, feed.installed)
  const news = ahead.length

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        className="ghost-btn tabstrip__cmds"
        aria-expanded={open}
        data-on={open ? 'true' : undefined}
        title={
          news > 0
            ? `Slash commands, and ${news} new Claude Code release${news === 1 ? '' : 's'} since ${feed.installed}`
            : 'Every slash command, and what changed in the last few Claude Code releases'
        }
        // Opening is what asks for the feed — see the note on
        // `CommandsStore.subscribe`. Until then the panel costs nothing, which
        // matters because this button is mounted by the tab strip at the exact
        // moment the first terminal is trying to spawn.
        onClick={() => {
          setOpen((v) => {
            if (!v) commandsStore.ensureLoaded()
            return !v
          })
        }}
      >
        <span className="tabstrip__slash mono">/</span>
        Commands
        {/* A count, only when there is something to count. A badge that is
            always up is a badge nobody reads. */}
        {news > 0 ? <span className="tabstrip__news mono">{news}</span> : null}
      </button>

      <CommandsPanel anchor={buttonRef.current} open={open} onClose={() => setOpen(false)} />
    </>
  )
}

/* ------------------------------------------------------------------ panel */

type Tab = 'commands' | 'news'

function CommandsPanel({
  anchor,
  open,
  onClose
}: {
  anchor: HTMLElement | null
  open: boolean
  onClose: () => void
}): ReactNode {
  const { feed, loading } = useCommands()
  const [tab, setTab] = useState<Tab>('commands')
  const [query, setQuery] = useState('')

  const ahead = releasesAhead(feed.releases, feed.installed)

  return (
    <Popover
      anchor={anchor}
      open={open}
      onClose={onClose}
      align="end"
      // Wide, for the same reason the skills flyout is: the descriptions are
      // the content. A command list narrow enough to fit the strip would be a
      // list of names you still have to go and look up.
      width={460}
      label="Slash commands"
    >
      <div className="cfly">
        <header className="cfly__head">
          <div className="cfly__tabs" role="tablist" aria-label="Reference">
            <button
              type="button"
              role="tab"
              className="cfly__tab"
              aria-selected={tab === 'commands'}
              onClick={() => setTab('commands')}
            >
              Commands
            </button>
            <button
              type="button"
              role="tab"
              className="cfly__tab"
              aria-selected={tab === 'news'}
              onClick={() => setTab('news')}
            >
              What’s new
              {ahead.length > 0 ? <span className="cfly__badge mono">{ahead.length}</span> : null}
            </button>
          </div>

          <button
            type="button"
            className="ghost-btn cfly__refresh"
            title="Fetch the reference and the changelog again"
            disabled={loading}
            data-busy={loading ? 'true' : undefined}
            onClick={() => void commandsStore.refresh(true)}
          >
            <Icon name="restart" size={12} />
          </button>
        </header>

        {tab === 'commands' ? (
          <CommandsList query={query} setQuery={setQuery} onClose={onClose} />
        ) : (
          <NewsList ahead={ahead} />
        )}

        <Provenance />
      </div>
    </Popover>
  )
}

/* ------------------------------------------------------------- commands */

function CommandsList({
  query,
  setQuery,
  onClose
}: {
  query: string
  setQuery: (q: string) => void
  onClose: () => void
}): ReactNode {
  const { feed } = useCommands()
  const send = useSendCommand()
  const [expanded, setExpanded] = useState<string | null>(null)

  const rows = useMemo(() => rankCommands(feed.commands, query), [feed.commands, query])

  return (
    <>
      <div className="cfly__search">
        <span className="cfly__search-slash mono">/</span>
        <input
          className="cfly__input mono"
          value={query}
          autoFocus
          spellCheck={false}
          placeholder="search commands"
          aria-label="Search slash commands"
          onChange={(e) => setQuery(e.target.value)}
          // The app is full of single-key shortcuts and this is a text box in
          // the middle of it. Without this, typing "t" opens a terminal.
          onKeyDown={(e) => e.stopPropagation()}
        />
        {query ? (
          <button type="button" className="ghost-btn cfly__clear" title="Clear" onClick={() => setQuery('')}>
            <Icon name="close" size={11} />
          </button>
        ) : null}
      </div>

      <div className="cfly__scroll">
        {rows.length === 0 ? (
          <div className="cfly__empty">
            Nothing matches “{query}”. The list is every built-in command — your own live in Skills.
          </div>
        ) : (
          rows.map((cmd) => (
            <CommandRow
              key={cmd.name}
              command={cmd}
              tooNew={needsNewerCli(cmd, feed.installed)}
              open={expanded === cmd.name}
              onToggle={() => setExpanded((n) => (n === cmd.name ? null : cmd.name))}
              onSend={() => {
                send(cmd)
                onClose()
              }}
            />
          ))
        )}
      </div>
    </>
  )
}

/**
 * One command.
 *
 * The row itself types; the chevron expands. Typing is the frequent thing and
 * so it gets the whole row, and it is safe to give it the whole row because
 * nothing is ever submitted — a misclick leaves `/context` sitting at a prompt
 * for you to delete. Expanding is for the handful of commands whose one-line
 * summary genuinely is not enough (`/fork`, `/effort`, `/cd`).
 */
function CommandRow({
  command,
  tooNew,
  open,
  onToggle,
  onSend
}: {
  command: SlashCommand
  tooNew: boolean
  open: boolean
  onToggle: () => void
  onSend: () => void
}): ReactNode {
  const hasMore = command.detail.length > command.summary.length

  return (
    <div className="crow" data-open={open ? 'true' : undefined} data-too-new={tooNew ? 'true' : undefined}>
      <button
        type="button"
        className="crow__main"
        title={
          tooNew
            ? `Needs Claude Code ${command.minVersion} — yours is older. Type it anyway, or update from What’s new.`
            : 'Type this into the terminal'
        }
        onClick={onSend}
      >
        <span className="crow__sig mono">{commandSignature(command)}</span>
        <span className="crow__summary truncate">{command.summary}</span>
      </button>

      {/* Only when it is news. A version chip on every row is a version chip
          nobody reads; on the four commands your CLI is too old for, it is the
          answer to "why does this say unknown command". */}
      {tooNew ? (
        <span className="crow__since mono" title={`Added in Claude Code ${command.minVersion}`}>
          {command.minVersion}+
        </span>
      ) : null}

      {command.aliases.length > 0 ? (
        <span className="crow__alias mono" title={`Also: ${command.aliases.map((a) => `/${a}`).join(', ')}`}>
          /{command.aliases[0]}
        </span>
      ) : null}

      {hasMore ? (
        <button
          type="button"
          className="ghost-btn crow__more"
          aria-expanded={open}
          title={open ? 'Less' : 'More'}
          onClick={onToggle}
        >
          <Icon name="chevronDown" size={12} />
        </button>
      ) : null}

      {open ? <p className="crow__detail">{command.detail}</p> : null}
    </div>
  )
}

/**
 * Type a command into the pane that has focus.
 *
 * The same resolution the skills rail does, and the same refusal to guess: no
 * pane, no typing, and a notice saying so rather than a click that silently
 * does nothing.
 *
 * The one addition is the warning. A slash command in a bare PowerShell is not
 * a command, it is a typo, and the pane will say so in red — better to say it
 * here, before the pane does.
 */
function useSendCommand(): (command: SlashCommand) => void {
  const { state, actions } = useApp()
  const tab = useActiveTab()

  return (command: SlashCommand): void => {
    const leaf = tab ? collectLeaves(tab.root).find((l) => l.id === tab.activePaneId) : undefined
    if (!leaf) {
      actions.setNotice('Open a terminal first — a command has to be typed into something')
      return
    }
    const profile = resolveProfile(state.settings.agentProfiles, leaf.profileId)
    actions.focusPane(leaf.id)
    const ok = typeCommandIntoPane(leaf.id, command)
    terminalHost.focus(leaf.id)
    if (!ok) {
      actions.setNotice(`/${command.name} could not be typed — that pane is not running`)
      return
    }
    if (!paneTakesCommands(profile.command)) {
      actions.setNotice(`${profile.name} is not Claude Code — /${command.name} will not mean anything to it`)
    }
  }
}

/* ----------------------------------------------------------------- news */

function NewsList({ ahead }: { ahead: ReleaseNote[] }): ReactNode {
  const { feed } = useCommands()
  const { actions } = useApp()

  // Up to date, or no installed version to compare against: show recent history
  // rather than an empty panel. Which of the two it is, the header says.
  const showing = ahead.length > 0 ? ahead : feed.releases.slice(0, 8)

  return (
    <>
      <div className="cfly__version">
        <div className="cfly__version-text">
          {feed.installed ? (
            <>
              <span className="mono">{feed.installed}</span> installed
              {feed.latest ? (
                <>
                  {' · '}
                  <span className="mono">{feed.latest}</span> latest
                </>
              ) : null}
            </>
          ) : (
            <>Claude Code was not found on PATH — showing recent releases</>
          )}
          <span className="cfly__version-note">
            {ahead.length > 0
              ? `${ahead.length} release${ahead.length === 1 ? '' : 's'} since yours`
              : feed.installed
                ? 'Up to date — recent history'
                : ''}
          </span>
        </div>

        {ahead.length > 0 ? (
          <button
            type="button"
            className="cta-btn cfly__update"
            title="Opens a shell tab with `claude update` typed into it. Nothing runs until you press Enter."
            onClick={() => actions.openToolPane('update: Claude Code', 'claude update')}
          >
            Update
          </button>
        ) : null}
      </div>

      <div className="cfly__scroll">
        {showing.length === 0 ? (
          <div className="cfly__empty">No changelog yet — press refresh once you are online.</div>
        ) : (
          showing.map((release) => (
            <div key={release.version} className="nrow">
              <div className="nrow__version mono">{release.version}</div>
              <ul className="nrow__bullets">
                {release.bullets.map((b, i) => (
                  <li key={i}>{b}</li>
                ))}
              </ul>
            </div>
          ))
        )}
      </div>
    </>
  )
}

/* ----------------------------------------------------------- provenance */

/**
 * Where what you are reading came from, and how old it is.
 *
 * A foot on both panels rather than a detail in a tooltip, because a stale
 * command list is indistinguishable from a current one until it is wrong, and
 * the moment it is wrong is the moment you needed to know this.
 */
function Provenance(): ReactNode {
  const { feed, loading } = useCommands()

  const origin =
    feed.commandsFrom === 'live'
      ? `${feed.commands.length} commands · from the docs ${ago(feed.fetchedAt)}`
      : feed.commandsFrom === 'cached'
        ? `${feed.commands.length} commands · last fetched ${ago(feed.fetchedAt)}`
        : `${feed.commands.length} commands · bundled snapshot, ${BUNDLED_SNAPSHOT_DATE}`

  return (
    <footer className="cfly__foot">
      <span className="cfly__origin">{loading ? 'Fetching…' : origin}</span>
      {feed.error ? <span className="cfly__error">{feed.error}</span> : null}
    </footer>
  )
}

/** "4 minutes ago", roughly. Precision here would be false precision. */
function ago(at: number | null): string {
  if (!at) return 'never'
  const mins = Math.round((Date.now() - at) / 60_000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins} min ago`
  const hours = Math.round(mins / 60)
  if (hours < 24) return `${hours} h ago`
  const days = Math.round(hours / 24)
  return `${days} day${days === 1 ? '' : 's'} ago`
}
