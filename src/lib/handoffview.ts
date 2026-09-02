import type { AgentProfile, HandoffRecord, TerminalTab, Workspace } from '@shared/types'
import { isShellProfile, paneDisplayTitle, resolveProfile } from '@/lib/agents'
import { collectLeaves } from '@/lib/splitTree'

/**
 * What the Handoff control says, with no React in it.
 *
 * The same arrangement src/lib/shareview.ts has with ShareSection, and here it
 * earns its keep twice over. The *order* of the menu is the feature — "hand it
 * back where it came from" has to be the first thing you see, and a pane you
 * cannot hand to must not be offered at all — and the *chip* is the only thing
 * telling a person that a handoff they started is still waiting on an agent.
 * Both are pure functions of the records and the workspace, so
 * scripts/handoff-check.mjs can pin them without a window.
 *
 * Nothing in here reads the pack body or touches the file: the packs are the
 * truth (shared/handoff.ts) and this module only decides what to say about the
 * records main has already read off disk.
 */

/* ----------------------------------------------------------------- targets */

/** Which of the four kinds of row this is. The order below is the menu's order. */
export type HandoffTargetKind =
  /** Back to the pane that handed this one its work. */
  | 'back'
  /** The tab's own `handoffTargetId` — a profile, opened fresh. */
  | 'default'
  /** A live agent pane that is already open. */
  | 'pane'
  /** A new pane on this profile. */
  | 'new'

/**
 * One row of the menu, in the shape the component draws and the flow acts on.
 *
 * Deliberately one flat type rather than a union: every row answers the same
 * four questions — who takes over, on what profile, what does the row say, and
 * is this a reply to an earlier pack — and a union would make the check script
 * (and the click handler) branch on a kind to read fields that are always
 * meaningful. `paneId` is empty when the pane does not exist yet; `origin` is
 * empty for everything but a hand-back.
 */
export interface HandoffTarget {
  key: string
  kind: HandoffTargetKind
  /** The pane that takes over, when it is already open. '' for 'default' and 'new'. */
  paneId: string
  /** The profile a new pane opens on. For 'pane' and 'back', the pane's own. */
  profileId: string
  /** What the row says. */
  label: string
  /** The agent's name — the row's second line, and `toAgent` on the record. */
  agent: string
  /** The right-hand note: 'hand back', 'tab default', or ''. */
  note: string
  /** The pack this one replies to, or ''. */
  origin: string
}

interface TargetInput {
  /** The pane doing the handing off. Never offered as its own target. */
  paneId: string
  /** The tab that pane lives in, for its `handoffTargetId`. */
  tab: TerminalTab | null | undefined
  workspace: Workspace
  profiles: AgentProfile[]
  /** Every pack in the project, in any order. */
  records: HandoffRecord[]
  isLive: (paneId: string) => boolean
}

/** Newest first, by the time the header carries. Ties break on the id, which is a stamp. */
function newestFirst(records: HandoffRecord[]): HandoffRecord[] {
  return [...records].sort((a, b) => b.updatedAt - a.updatedAt || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0))
}

/** Every pane in the project, flattened, with the tab it belongs to forgotten. */
function leaves(workspace: Workspace): { id: string; title: string; profileId: string }[] {
  return workspace.tabs.flatMap((tab) => collectLeaves(tab.root))
}

/**
 * The pack this pane would hand back, or null.
 *
 * "The newest taken pack addressed to me, whose author is still open and still
 * running." All three conditions are load-bearing: a pack that was never taken
 * was never this pane's work, and a source pane that has been closed or has
 * exited is a pane there is nothing to hand back *to* — offering the row anyway
 * would write a pack addressed to a pane id that no longer names anything.
 */
export function handbackRecord(input: TargetInput): HandoffRecord | null {
  const open = leaves(input.workspace)
  const usable = newestFirst(input.records).filter((r) => {
    if (r.status !== 'taken' || r.to !== input.paneId) return false
    const source = open.find((l) => l.id === r.from)
    if (!source) return false
    return input.isLive(source.id) && !isShellProfile(resolveProfile(input.profiles, source.profileId))
  })
  return usable[0] ?? null
}

/**
 * The menu, in order.
 *
 * Hand back, the tab's default, the panes that are already open, then a new
 * pane of every kind. The first two are shortcuts for the two things a person
 * does over and over — bounce the work home, or send it to the agent this tab
 * always sends to — and they are first because a menu whose top row is the
 * answer nine times out of ten is a menu you stop reading.
 *
 * Shells are excluded everywhere. A handoff pack is a page of prose an agent is
 * asked to write and another is asked to read; at a PowerShell prompt it is a
 * very long command that does not exist. The pane itself is excluded for the
 * same reason a person would not pick it: handing work to yourself is not a
 * handover, it is a note.
 */
export function handoffTargets(input: TargetInput): HandoffTarget[] {
  const out: HandoffTarget[] = []
  const open = leaves(input.workspace)

  const back = handbackRecord(input)
  if (back) {
    const source = open.find((l) => l.id === back.from)
    const profile = resolveProfile(input.profiles, source?.profileId)
    const agent = back.fromAgent || profile.name
    const where = back.fromTitle || (source ? paneDisplayTitle(profile, source.title) : '')
    out.push({
      key: `back:${back.id}`,
      kind: 'back',
      paneId: back.from,
      profileId: source?.profileId ?? profile.id,
      label: where ? `Hand back to ${agent} — ${where}` : `Hand back to ${agent}`,
      agent,
      note: 'hand back',
      origin: back.id
    })
  }

  // The tab's standing answer. A profile that has since been deleted, or one
  // that turns out to be a shell, is silently no answer at all rather than a
  // row that cannot work — see tabDefaultProfileId, which takes the same line.
  const wanted = input.tab?.settings?.handoffTargetId
  const preferred = wanted ? input.profiles.find((p) => p.id === wanted) : undefined
  if (preferred && !isShellProfile(preferred)) {
    out.push({
      key: `default:${preferred.id}`,
      kind: 'default',
      paneId: '',
      profileId: preferred.id,
      label: preferred.name,
      agent: preferred.name,
      note: 'tab default',
      origin: ''
    })
  }

  for (const leaf of open) {
    if (leaf.id === input.paneId) continue
    if (out.some((t) => t.paneId === leaf.id)) continue
    if (!input.isLive(leaf.id)) continue
    const profile = resolveProfile(input.profiles, leaf.profileId)
    if (isShellProfile(profile)) continue
    out.push({
      key: `pane:${leaf.id}`,
      kind: 'pane',
      paneId: leaf.id,
      profileId: leaf.profileId,
      label: paneDisplayTitle(profile, leaf.title),
      agent: profile.name,
      note: '',
      origin: ''
    })
  }

  for (const profile of input.profiles) {
    if (isShellProfile(profile)) continue
    out.push({
      key: `new:${profile.id}`,
      kind: 'new',
      paneId: '',
      profileId: profile.id,
      label: `New ${profile.name}`,
      agent: profile.name,
      note: '',
      origin: ''
    })
  }

  return out
}

/** The tab title a handoff's own pane opens under. */
export function handoffPaneTitle(fromTitle: string): string {
  const who = String(fromTitle ?? '').trim()
  return who ? `Handoff — ${who}` : 'Handoff'
}

/* -------------------------------------------------------------------- chip */

export interface HandoffChip {
  /** The pack the chip is about — what a click reveals. */
  id: string
  label: string
  title: string
  /**
   * `waiting`  this pane was asked to write a pack and has not finished.
   * `sent`     it wrote one and another pane has it.
   * `took`     this pane is the one that took the work over.
   */
  state: 'waiting' | 'sent' | 'took'
}

/**
 * The one line a pane says about its own handoffs, or null.
 *
 * Newest pack this pane is either end of, and nothing else. It is the whole of
 * the reminder: Forge never nags a source agent that has not written its pack —
 * no timer, no second prompt — so "Handing off…" sitting in a header is how a
 * person notices that the agent went and did something else instead.
 *
 * `ready` reads as `waiting` on purpose. A filled pack that has not been handed
 * on yet is still a handoff in flight, and it is only ever `ready` for the beat
 * between the watcher promoting it and the flow marking it taken.
 */
export function paneHandoffChip(paneId: string, records: HandoffRecord[]): HandoffChip | null {
  if (!paneId) return null
  const mine = newestFirst(records).filter((r) => r.from === paneId || (r.to === paneId && r.status === 'taken'))
  const record = mine[0]
  if (!record) return null

  if (record.from === paneId) {
    if (record.status === 'taken') {
      const who = record.toAgent || 'another agent'
      return {
        id: record.id,
        label: `Handed off → ${who}`,
        title: `“${record.title}” went to ${who}${record.toTitle ? ` (${record.toTitle})` : ''}. Click to show the pack.`,
        state: 'sent'
      }
    }
    return {
      id: record.id,
      label: 'Handing off…',
      title: `Waiting for this agent to write the handoff pack for “${record.title}”. Click to show it.`,
      state: 'waiting'
    }
  }

  const who = record.fromAgent || 'another agent'
  return {
    id: record.id,
    label: `Took over ← ${who}`,
    title: `This pane took “${record.title}” over from ${who}${record.fromTitle ? ` (${record.fromTitle})` : ''}. Click to show the pack.`,
    state: 'took'
  }
}
