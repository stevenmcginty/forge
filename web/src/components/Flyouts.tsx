import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { CommandsFeed, SlashCommand } from '@shared/commands'
import type { SkillsList } from '@shared/skills'
import { collectLeaves } from '@/lib/splitTree'
import { Icon } from '@/components/Icon'
import { Popover } from '@/components/Popover'
import { useForge, useWorkspace } from '../state'

/**
 * The two references, in the tab strip where the desktop keeps them: what
 * `claude` understands (commands) and what it *knows* (skills).
 *
 * Deliberately thinner than src/components/SkillsFlyout.tsx, and the reason is
 * the protocol rather than effort. That component is 1,020 lines because it
 * enables, disables, drags, syncs and repairs skills on disk — every one of
 * which is a write to `~/.claude/skills` on the desktop's own filesystem, and
 * `WebRequest` carries exactly one skills verb: `{ kind: 'skills' }`, a read.
 * The same is true of commands: `{ kind: 'commands' }` and nothing else. So what
 * a browser can honestly offer is the list, and one click that *types* the name
 * into the focused pane — which is the thing you actually wanted the list for,
 * and which travels as an ordinary `write` because that is what a keystroke is.
 */

/** Where a typed name should land: the active pane of the active tab. */
function useFocusedPaneId(): string | null {
  const workspace = useWorkspace()
  const tab = workspace.tabs.find((t) => t.id === workspace.activeTabId) ?? workspace.tabs[0]
  if (!tab) return null
  const leaves = collectLeaves(tab.root)
  return leaves.find((leaf) => leaf.id === tab.activePaneId)?.id ?? leaves[0]?.id ?? null
}

/* ------------------------------------------------------------------ skills */

export function SkillsButton(): ReactNode {
  const { state, actions } = useForge()
  const anchorRef = useRef<HTMLButtonElement | null>(null)
  const [open, setOpen] = useState(false)
  const [list, setList] = useState<SkillsList | null>(null)
  const [error, setError] = useState('')
  const paneId = useFocusedPaneId()
  const live = state.connection.state === 'live'

  useEffect(() => {
    if (!open || !live) return
    let cancelled = false
    void actions.request({ kind: 'skills' }).then((result) => {
      if (cancelled) return
      if (result.kind === 'skills') setList(result.skills)
      else if (result.kind === 'failed') setError(result.message)
    })
    return () => {
      cancelled = true
    }
  }, [open, live, actions])

  const rows = [
    ...(list?.skills ?? []).filter((s) => s.enabled).map((s) => ({ key: s.name, name: s.name, description: s.description, types: `/${s.name} ` })),
    ...(list?.machineSkills ?? []).map((s) => ({ key: `m:${s.name}`, name: s.name, description: s.description, types: `/${s.name} ` })),
    ...(list?.externalSkills ?? []).map((s) => ({ key: s.id, name: s.title || s.name, description: s.description, types: s.command }))
  ]

  return (
    <>
      <button
        ref={anchorRef}
        type="button"
        className="ghost-btn tabstrip__skills"
        data-on={open ? 'true' : undefined}
        title="Skills on that desktop — click one to type it into the focused pane"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <Icon name="note" size={12} />
        {rows.length > 0 ? <span className="tabstrip__tally mono">{rows.length}</span> : null}
      </button>

      <Popover anchor={anchorRef.current} open={open} onClose={() => setOpen(false)} align="end" width={340} label="Skills">
        <div className="sfly">
          <div className="sfly__head">
            <span className="eyebrow">Skills</span>
            <span className="sfly__tally mono">{rows.length}</span>
          </div>
          <p className="sfly__hint">
            Enabling and repairing skills writes to that machine’s disk, so it stays at the desk. Clicking a row types it
            into the pane you are in.
          </p>
          <div className="sfly__scroll">
            {error ? <p className="sfly__hint">{error}</p> : null}
            {!list && !error ? <p className="sfly__hint">Reading skills…</p> : null}
            {rows.map((row) => (
              <button
                key={row.key}
                type="button"
                className="srow"
                data-enabled="true"
                title={row.description || row.name}
                disabled={!paneId}
                onClick={() => {
                  if (!paneId) return
                  actions.write(paneId, row.types)
                  setOpen(false)
                }}
              >
                <span className="srow__text">
                  <span className="srow__name truncate">{row.name}</span>
                  <span className="srow__desc truncate">{row.description}</span>
                </span>
              </button>
            ))}
          </div>
        </div>
      </Popover>
    </>
  )
}

/* ---------------------------------------------------------------- commands */

export function CommandsButton(): ReactNode {
  const { state, actions } = useForge()
  const anchorRef = useRef<HTMLButtonElement | null>(null)
  const [open, setOpen] = useState(false)
  const [feed, setFeed] = useState<CommandsFeed | null>(null)
  const [error, setError] = useState('')
  const [query, setQuery] = useState('')
  const paneId = useFocusedPaneId()
  const live = state.connection.state === 'live'

  useEffect(() => {
    if (!open || !live) return
    let cancelled = false
    void actions.request({ kind: 'commands' }).then((result) => {
      if (cancelled) return
      if (result.kind === 'commands') setFeed(result.feed)
      else if (result.kind === 'failed') setError(result.message)
    })
    return () => {
      cancelled = true
    }
  }, [open, live, actions])

  const needle = query.trim().toLowerCase()
  const commands: SlashCommand[] = (feed?.commands ?? []).filter(
    (command) => !needle || command.name.toLowerCase().includes(needle) || command.summary.toLowerCase().includes(needle)
  )

  return (
    <>
      <button
        ref={anchorRef}
        type="button"
        className="ghost-btn tabstrip__cmds"
        data-on={open ? 'true' : undefined}
        title="Slash commands this Claude Code understands"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="tabstrip__slash mono">/</span>
      </button>

      <Popover
        anchor={anchorRef.current}
        open={open}
        onClose={() => setOpen(false)}
        align="end"
        width={380}
        label="Slash commands"
      >
        <div className="cfly">
          <div className="cfly__head">
            <span className="eyebrow">Slash commands</span>
            {feed?.installed ? <span className="cfly__badge mono">{feed.installed}</span> : null}
          </div>
          <div className="cfly__search">
            <span className="cfly__search-slash mono">/</span>
            <input
              className="cfly__input"
              placeholder="Filter"
              spellCheck={false}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </div>
          <div className="cfly__scroll">
            {error ? <p className="cfly__empty">{error}</p> : null}
            {!feed && !error ? <p className="cfly__empty">Reading the command reference…</p> : null}
            {feed && commands.length === 0 ? <p className="cfly__empty">Nothing matches that.</p> : null}
            {commands.map((command) => (
              <button
                key={command.name}
                type="button"
                className="crow"
                title={command.detail || command.summary}
                disabled={!paneId}
                onClick={() => {
                  if (!paneId) return
                  // Typed, never submitted — the same contract the desktop's
                  // flyout honours, so a command lands at the prompt for a human
                  // to read and press Enter on.
                  actions.write(paneId, `/${command.name} `)
                  setOpen(false)
                }}
              >
                <span className="crow__main">
                  <span className="crow__sig mono truncate">
                    /{command.name} {command.args}
                  </span>
                  <span className="truncate">{command.summary}</span>
                </span>
              </button>
            ))}
          </div>
        </div>
      </Popover>
    </>
  )
}
