import { useRef, useState, type CSSProperties, type ReactNode } from 'react'
import type { TerminalTab } from '@shared/types'
import { isShellProfile, resolveProfile } from '@/lib/agents'
import { collectLeaves } from '@/lib/splitTree'
import { AgentBadge } from '@/components/AgentBadge'
import { Icon } from '@/components/Icon'
import { useForge, useProfiles, useWorkspace } from '../state'
import { AgentChooser } from './AgentChooser'
import { CommandsButton, SkillsButton } from './Flyouts'

/**
 * The tab strip, in the desktop's own `.tabstrip` / `.tab` classes.
 *
 * Every gesture here is a request. Selecting a tab sends `select-tab`, closing
 * one sends `close-tab`, and neither touches local state: what moves the strip
 * is the `workspace` push that comes back, because the desktop renderer owns the
 * split tree and is the one thing that persists it (decision 5). That is why
 * there is no `setActiveTab` anywhere in this file, and why clicking a tab on a
 * frozen desktop does nothing rather than lying about it.
 *
 * ## What a request may say about itself
 *
 * That rule made clicking a tab feel dead, because nothing at all moved until
 * the desktop's persist — debounced 250ms in src/state/AppState.tsx — pushed the
 * workspace back, while clicking a *project* moved instantly. Two identical
 * gestures behaving differently for a reason nobody outside this file can see.
 *
 * The fix is the smallest one that is not a lie: the clicked tab says it has
 * been asked for. It does not say it has been granted — no local `setActiveTab`
 * appears below, and the strip still moves only when the push arrives — because
 * a switch this page performed and the desk then contradicted is worse than a
 * beat of latency. `pending` is cleared by the answer, whichever answer it is:
 * the push that agrees, or the sentence that refuses.
 *
 * Absent, deliberately: renaming, tab colours, drag reordering and the mosaic
 * toggle. `WEB_LAYOUT_OPS` has seven verbs and none of them is any of those —
 * the browser can create, close, select, split, focus and switch project, and a
 * strip that offered more would be offering something the wire cannot carry.
 */
export function TabStrip(): ReactNode {
  const { state, actions } = useForge()
  const workspace = useWorkspace()
  const newTabRef = useRef<HTMLButtonElement | null>(null)
  const [chooserOpen, setChooserOpen] = useState(false)
  const live = state.stage.kind === 'connected' && state.connection.state === 'live'
  const project = (state.picture?.projects ?? state.cached?.projects ?? []).find((p) => p.id === state.projectId)

  /**
   * The tab this browser has asked for, and where the strip stood when it asked.
   *
   * Derived on the way out rather than cleared in an effect, so the mark comes
   * off in the same commit as the `workspace` push that answers it rather than a
   * paint later. Any move at all is the answer — to the tab that was asked for,
   * or to a different one, because the desk is entitled to do either and a mark
   * that outlived its own answer would be this page inventing a state the
   * desktop knows nothing about.
   */
  const [ask, setAsk] = useState<{ tabId: string; from: string | null } | null>(null)
  const pending = ask && ask.from === workspace.activeTabId ? ask.tabId : null

  const select = async (tabId: string): Promise<void> => {
    setAsk({ tabId, from: workspace.activeTabId })
    // `layout` resolves with the desktop's refusal sentence rather than throwing
    // one, and a tab that was refused must not go on looking like one that is
    // about to open.
    if (await actions.layout({ op: 'select-tab', tabId })) setAsk(null)
  }

  return (
    <div className="tabstrip" role="tablist" aria-label="Terminal tabs">
      <div className="tabstrip__tabs">
        {workspace.tabs.map((tab) => (
          <Tab
            key={tab.id}
            tab={tab}
            active={tab.id === workspace.activeTabId}
            pending={tab.id === pending}
            live={live}
            onSelect={() => void select(tab.id)}
          />
        ))}

        <button
          ref={newTabRef}
          type="button"
          className="ghost-btn tabstrip__new"
          title={live ? 'New terminal tab' : 'The desktop is not answering, so it cannot open a tab'}
          disabled={!live}
          onClick={() => setChooserOpen(true)}
        >
          <Icon name="plus" size={14} />
        </button>
      </div>

      <div className="tabstrip__spacer" />

      <SkillsButton />
      <CommandsButton />

      <AgentChooser
        anchor={newTabRef.current}
        open={chooserOpen}
        onClose={() => setChooserOpen(false)}
        onPick={(profileId, permissionMode) => void actions.layout({ op: 'create-tab', profileId, permissionMode })}
        selectedId={project?.defaultProfileId}
      />
    </div>
  )
}

function Tab({
  tab,
  active,
  pending,
  live,
  onSelect
}: {
  tab: TerminalTab
  active: boolean
  /** Asked for, not yet granted. See the header. */
  pending: boolean
  live: boolean
  onSelect: () => void
}): ReactNode {
  const { state, actions } = useForge()
  const profiles = useProfiles()
  const leaves = collectLeaves(tab.root)
  const badges = leaves.slice(0, 3).map((leaf) => resolveProfile(profiles, leaf.profileId))
  const primary = badges[0] ?? null
  // Agent tabs inherit the profile accent; an explicit tab colour still wins —
  // the same rule, in the same order, as the desktop's strip.
  const agentTint = primary && !isShellProfile(primary) ? primary.accent : undefined
  const tint = tab.color ?? agentTint
  const asking = leaves.some((leaf) => state.asking.has(leaf.id))

  return (
    <div
      className="tab"
      role="tab"
      aria-selected={active}
      aria-busy={pending || undefined}
      data-active={active}
      data-pending={pending ? 'true' : undefined}
      data-tint={tint ? 'true' : undefined}
      data-working={asking ? 'true' : undefined}
      title={
        !live
          ? `${tab.title} — the desktop is not answering, so it cannot switch tab`
          : pending
            ? `${tab.title} — asked for; waiting for the desktop to say it has switched`
            : asking
              ? `${tab.title} — a pane in here is waiting on an answer`
              : tab.title
      }
      style={
        {
          ...(tint ? { '--tab-tint': tint } : {}),
          ...(tab.textColor ? { '--tab-text-tint': tab.textColor } : {})
        } as CSSProperties
      }
      onPointerDown={() => {
        // Nothing at all on a link that cannot carry the request, exactly as the
        // header says: a strip that moved on a dropped socket would be claiming
        // the desk had agreed to something it has not been told about.
        if (!active && !pending && live) onSelect()
      }}
    >
      <div className="tab__badges">
        {badges.map((profile, index) => (
          <AgentBadge key={`${profile.id}-${index}`} profile={profile} size="sm" />
        ))}
        {leaves.length > 3 ? <span className="tab__more mono">+{leaves.length - 3}</span> : null}
      </div>

      <span className="tab__title truncate">{tab.title}</span>

      <button
        type="button"
        className="ghost-btn tab__close"
        data-danger="true"
        title="Close tab"
        onClick={(e) => {
          e.stopPropagation()
          void actions.layout({ op: 'close-tab', tabId: tab.id })
        }}
      >
        <Icon name="close" size={11} />
      </button>
    </div>
  )
}
