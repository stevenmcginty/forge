import { useEffect, useMemo, useReducer, useState, type ReactNode } from 'react'
import { buildActivityTree, groupByAgent } from '@/lib/activitytree'
import { badgeColor, resolveProfile } from '@/lib/agents'
import { isOpen } from '@/lib/railstack'
import { useActivity } from '@/hooks/useActivity'
import { useActiveProject, useApp } from '@/state/AppState'
import { EmptyState } from '../EmptyState'
import { Icon } from '../Icon'
import { ActivityTree } from './ActivityTree'
import { RailSection } from './RailSection'
import './ActivitySection.css'

/**
 * Which agent is touching which file.
 *
 * The panel makes one promise and keeps it visibly: it never pretends to know
 * more than it does. A `◆` came out of an agent's own transcript and is a fact;
 * a `◇` is Forge noticing a file change while exactly one pane happened to be
 * working, and is a good guess. The foot lines say which kind you are looking at
 * and, when there are no Claude panes open, what you would have to do to get the
 * better kind. A panel that quietly mixed the two would be more compact and
 * completely untrustworthy.
 *
 * **Nothing runs while the section is closed.** This is the only part of Forge
 * that watches a project folder on its own initiative, so the watch is keyed on
 * the section's open state, not merely on the setting that puts it in the rail.
 */
/**
 * How often the ages are re-read off the clock.
 *
 * Snapshots only arrive when something changes, so without this every "2m" and
 * every freshness halo freezes at whatever it said when the last one landed —
 * and a project that goes quiet is left claiming a file was touched just now,
 * indefinitely. Four re-renders a minute of a small tree, and only while the
 * section is open with something in it.
 */
const AGE_TICK_MS = 15_000

export function ActivitySection(): ReactNode {
  const { state } = useApp()
  const project = useActiveProject()
  const open = isOpen(state.settings, 'activity')

  /** Folder tree or per-agent list. A glance-level preference; not persisted. */
  const [byAgent, setByAgent] = useState(false)
  /**
   * Reads are off by default. An agent reads twenty files for every one it
   * edits, and a tree where "touched" means "glanced at" answers a different and
   * much less useful question than the one the panel is for.
   */
  const [showReads, setShowReads] = useState(false)

  const { snapshot, claudePanes, clear } = useActivity(open)

  const [, tick] = useReducer((n: number) => n + 1, 0)
  useEffect(() => {
    if (!open || snapshot.entries.length === 0) return
    const id = setInterval(tick, AGE_TICK_MS)
    return () => clearInterval(id)
  }, [open, snapshot.entries.length])

  const entries = useMemo(
    () => (showReads ? snapshot.entries : snapshot.entries.filter((e) => e.kind !== 'read')),
    [snapshot.entries, showReads]
  )

  const tree = useMemo(() => buildActivityTree(entries), [entries])
  const groups = useMemo(() => (byAgent ? groupByAgent(entries) : []), [entries, byAgent])
  const files = useMemo(() => new Set(entries.map((e) => e.path.toLowerCase())).size, [entries])
  const hidden = snapshot.entries.length - entries.length

  return (
    <RailSection
      id="activity"
      title="Activity"
      count={files}
      hint="Which agent is touching which file"
      actions={
        <>
          <button
            type="button"
            className="ghost-btn asec__act"
            title={byAgent ? 'Group by folder' : 'Group by agent'}
            aria-pressed={byAgent}
            onClick={() => setByAgent((v) => !v)}
          >
            <Icon name={byAgent ? 'user' : 'folder'} size={12} />
          </button>
          <button
            type="button"
            className="ghost-btn asec__act asec__reads"
            data-on={showReads ? 'true' : undefined}
            title={showReads ? 'Hide files that were only read' : 'Show files that were only read'}
            aria-pressed={showReads}
            onClick={() => setShowReads((v) => !v)}
          >
            <span className="asec__readsdot" />
          </button>
          {entries.length > 0 ? (
            <button type="button" className="ghost-btn asec__act" title="Forget everything here" onClick={clear}>
              <Icon name="trash" size={12} />
            </button>
          ) : null}
        </>
      }
    >
      <div className="asec">
        {!project ? (
          <EmptyState icon="history" size="sm" title="No project" body="Select a project to watch its files." />
        ) : entries.length === 0 ? (
          snapshot.stormy ? (
            <EmptyState
              icon="history"
              size="sm"
              title="Too many file changes to follow"
              body="Showing what got through. This settles once the checkout or install finishes."
            />
          ) : (
            <EmptyState
              icon="history"
              size="sm"
              title="Nothing touched yet"
              body="This fills in as your agents work."
              hint={hidden > 0 ? `${hidden} read${hidden === 1 ? '' : 's'} hidden` : undefined}
            />
          )
        ) : (
          <>
            {snapshot.stormy ? (
              <p className="asec__strip">Too many file changes to follow — showing what got through.</p>
            ) : null}

            {byAgent ? (
              groups.map((group) => {
                const profile = resolveProfile(state.settings.agentProfiles, group.profileId)
                return (
                  <section
                    key={group.paneId || 'unattributed'}
                    className="asec__agent"
                    style={{ '--act-tint': badgeColor(profile) } as React.CSSProperties}
                    data-blank={group.paneId ? undefined : 'true'}
                  >
                    <h3 className="asec__agenthead">
                      <span className="asec__agentdot" />
                      <span className="truncate">{group.paneId ? profile.name : 'Unattributed'}</span>
                      <span className="asec__agentcount mono">{group.entries.length}</span>
                    </h3>
                    <ActivityTree nodes={buildActivityTree(group.entries)} />
                  </section>
                )
              })
            ) : (
              <ActivityTree nodes={tree} />
            )}

            <div className="asec__foot">
              {claudePanes === 0 ? (
                <p className="asec__note">Inferred from timing — a Claude pane gives exact attribution.</p>
              ) : snapshot.hasInferred ? (
                <p className="asec__note">
                  <span className="asec__glyph">◇</span> inferred from timing ·{' '}
                  <span className="asec__glyph">◆</span> read from a transcript
                </p>
              ) : null}
              {snapshot.truncated ? <p className="asec__note">Older entries have been dropped.</p> : null}
              {hidden > 0 ? (
                <p className="asec__note">
                  {hidden} read{hidden === 1 ? '' : 's'} hidden
                </p>
              ) : null}
            </div>
          </>
        )}
      </div>
    </RailSection>
  )
}
