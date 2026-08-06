import { useState, type DragEvent, type ReactNode } from 'react'
import type { ActivityEntry } from '@shared/types'
import {
  activityAge,
  collectFiles,
  EXACT_GLYPH,
  INFERRED_GLYPH,
  type ActivityFileNode,
  type ActivityNode
} from '@/lib/activitytree'
import { badgeColor, resolveProfile } from '@/lib/agents'
import { PATH_DRAG_TYPE } from '@/lib/mosaicLayout'
import { useApp } from '@/state/AppState'

/**
 * The activity tree's rows.
 *
 * **This is not a report.** Every file row is `draggable`, and dragging one onto
 * a pane types its quoted path at that agent's prompt — the panel's real job is
 * to be the place you pick a file up and hand it to somebody else, and reading
 * it is only what you do on the way there. The drag carries a private type so
 * that dropping it anywhere in Forge that is not a pane is a no-op rather than a
 * surprise, plus the quoted path as plain text so a drop into anything *outside*
 * Forge still lands as something useful.
 *
 * Folders can be closed, and are the only local state here: which folders you
 * have shut is a glance-level preference that should not survive a restart, let
 * alone earn a field in Settings.
 */

export function ActivityTree({ nodes }: { nodes: ActivityNode[] }): ReactNode {
  const [closed, setClosed] = useState<ReadonlySet<string>>(() => new Set())

  const toggle = (path: string): void => {
    setClosed((prev) => {
      const next = new Set(prev)
      if (!next.delete(path)) next.add(path)
      return next
    })
  }

  return (
    <div className="atree">
      <Level nodes={nodes} depth={0} closed={closed} onToggle={toggle} />
    </div>
  )
}

function Level({
  nodes,
  depth,
  closed,
  onToggle
}: {
  nodes: ActivityNode[]
  depth: number
  closed: ReadonlySet<string>
  onToggle: (path: string) => void
}): ReactNode {
  return (
    <>
      {nodes.map((node) =>
        node.kind === 'dir' ? (
          <div key={`d:${node.path}`} className="atree__group">
            <button
              type="button"
              className="atree__row atree__dir"
              style={{ paddingLeft: `calc(var(--s-3) + ${depth} * var(--s-5))` }}
              aria-expanded={!closed.has(node.path)}
              title={node.path}
              onClick={() => onToggle(node.path)}
            >
              <span className="atree__twist" data-open={closed.has(node.path) ? undefined : 'true'}>
                ›
              </span>
              <span className="atree__name truncate">{node.name}</span>
              <span className="atree__count mono">{collectFiles(node.children).length}</span>
            </button>
            {closed.has(node.path) ? null : (
              <Level nodes={node.children} depth={depth + 1} closed={closed} onToggle={onToggle} />
            )}
          </div>
        ) : (
          <FileRow key={`f:${node.path}`} file={node} depth={depth} />
        )
      )}
    </>
  )
}

function FileRow({ file, depth }: { file: ActivityFileNode; depth: number }): ReactNode {
  const age = activityAge(file.at)

  const onDragStart = (e: DragEvent<HTMLDivElement>): void => {
    e.dataTransfer.setData(PATH_DRAG_TYPE, file.absPath)
    // Also as text, so the same drag works into anything outside Forge. Quoted
    // here rather than at the drop, because a path with a space in it pasted
    // bare into a shell is two arguments.
    e.dataTransfer.setData('text/plain', `"${file.absPath}"`)
    e.dataTransfer.effectAllowed = 'copy'
  }

  return (
    <div
      className="atree__row atree__file"
      aria-label={file.path}
      data-fresh={age === 'now' ? 'true' : undefined}
      style={{ paddingLeft: `calc(var(--s-3) + ${depth} * var(--s-5))` }}
      title={`${file.absPath}\n${file.exact ? 'Read from the agent’s own transcript' : 'Inferred from timing'} · drag onto a pane`}
      draggable
      onDragStart={onDragStart}
    >
      <span className="atree__glyph" data-exact={file.exact ? 'true' : undefined}>
        {file.exact ? EXACT_GLYPH : INFERRED_GLYPH}
      </span>
      <span className="atree__name truncate">{file.name}</span>
      <AgentDots entries={file.entries} />
      <span className="atree__age mono">{age}</span>
    </div>
  )
}

/** How many dots fit beside a filename in a 240px rail before it stops helping. */
const MAX_DOTS = 3

/**
 * One dot per pane that touched this file, in that agent's own accent.
 *
 * Two panes on one file is not a duplicate to be tidied away — it is the single
 * most interesting thing this panel can tell you, and the reason a row carries a
 * stack rather than a single mark.
 */
function AgentDots({ entries }: { entries: ActivityEntry[] }): ReactNode {
  const { state } = useApp()
  const shown = entries.slice(0, MAX_DOTS)
  const extra = entries.length - shown.length

  return (
    <span className="atree__dots">
      {shown.map((entry, i) => {
        const profile = resolveProfile(state.settings.agentProfiles, entry.profileId)
        return (
          <span
            key={`${entry.paneId}:${i}`}
            className="atree__dot"
            data-blank={entry.paneId ? undefined : 'true'}
            style={{ '--act-tint': badgeColor(profile) } as React.CSSProperties}
            title={entry.paneId ? `${profile.name} · ${entry.kind}` : `Unattributed · ${entry.kind}`}
          />
        )
      })}
      {extra > 0 ? <span className="atree__more mono">+{extra}</span> : null}
    </span>
  )
}
