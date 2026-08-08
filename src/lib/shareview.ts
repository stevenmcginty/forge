import { SHARE_HANDOFF_INLINE_MAX, slotFileName } from '@shared/share'
import type { AgentProfile, ShareSlot, ShareVia, SharePane, Workspace } from '@shared/types'
import { paneDisplayTitle, resolveProfile } from '@/lib/agents'
import { sinceLabel } from '@/lib/gitview'
import { collectLeaves } from '@/lib/splitTree'

/**
 * What the SHARE section says, with no React in it.
 *
 * Same arrangement src/lib/gitview.ts has with GitSection: the wording an agent
 * is handed, and the arithmetic behind a row, are the two parts of this feature
 * most able to be quietly wrong, so they live where a check script can reach them
 * and the component only draws.
 */

/** `.forge/share/slot-2.md` — the path as an agent should be told it. */
export function slotRelPath(index: number): string {
  return `.forge/share/${slotFileName(index)}`
}

/** `812 B`, `1.8K`, `64K`. Bytes, not characters — the cap is in bytes. */
export function bytesLabel(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return ''
  if (bytes < 1024) return `${Math.round(bytes)} B`
  const k = bytes / 1024
  return k < 10 ? `${k.toFixed(1)}K` : `${Math.round(k)}K`
}

export function viaLabel(via: ShareVia): string {
  switch (via) {
    case 'rail':
      return 'typed here'
    case 'mcp':
      return 'an agent’s share_write'
    case 'capture':
      return 'a pane capture'
    default:
      return 'an agent writing the file'
  }
}

/** The right-hand end of a row: size and age, or nothing for an empty slot. */
export function slotMeta(slot: ShareSlot, now = Date.now()): string {
  if (!slot.filled) return ''
  const age = slot.updatedAt > 0 ? sinceLabel(slot.updatedAt, now) : ''
  return [bytesLabel(slot.bytes), age].filter(Boolean).join(' · ')
}

/**
 * A row's `title` attribute.
 *
 * Author and provenance go here rather than on screen: in a 240px rail they would
 * cost the title its width, and "who wrote this" is a question you ask about one
 * row at a time rather than about all five at once.
 */
export function slotTooltip(slot: ShareSlot, now = Date.now()): string {
  if (slot.problem) return slot.problem
  if (!slot.filled) return `Slot ${slot.index} is empty — click to write in it`
  const who = slot.author.trim() || 'Somebody'
  const parts = [`Written by ${who}`, slot.updatedAt > 0 ? sinceLabel(slot.updatedAt, now) : '', `via ${viaLabel(slot.via)}`]
  const line = parts.filter(Boolean).join(', ')
  return slot.truncated ? `${line}. Too long for one slot — the end was dropped.` : `${line}.`
}

/**
 * The brief handed to another agent about a slot.
 *
 * Four things, in this order, because that is the order an agent needs them: what
 * to read, where it is, whose it is, and what it may do to it. The last of those
 * is the important one — a slot is a shared surface, and an agent that helpfully
 * rewrites somebody else's plan has done the one thing this feature must not make
 * easy.
 *
 * The body is inlined under SHARE_HANDOFF_INLINE_MAX characters so an agent that
 * can read it now saves a tool round trip and cannot end up holding a stale copy;
 * over that, the path alone, because a 60 KiB paste is a prompt nobody wants.
 */
export function sharePrompt(slot: ShareSlot, body: string | null, now = Date.now()): string {
  const who = slot.author.trim()
  const age = slot.updatedAt > 0 ? sinceLabel(slot.updatedAt, now) : ''
  const provenance = [who || 'Someone', age ? `wrote it ${age}` : 'wrote it'].join(' ')
  const size = bytesLabel(slot.bytes)

  const head = [
    `Read shared scratchpad slot ${slot.index} — “${slot.title}” — at ${slotRelPath(slot.index)}.`,
    `${provenance}${size ? `, ${size}` : ''}.`,
    'Do not change it unless I ask you to. If you do change it, use the share_write tool for',
    `slot ${slot.index} so the other panes in this project see it.`
  ].join(' ')

  if (!body || body.length > SHARE_HANDOFF_INLINE_MAX) return `${head}\n`
  return `${head}\n\n${body.replace(/\s+$/, '')}\n`
}

/** What a capture writes as its title when the slot has no name yet. */
export function captureTitle(paneLabel: string): string {
  return paneLabel ? `Capture — ${paneLabel}` : 'Pane capture'
}

/* ----------------------------------------------------------------- the panes */

export interface PaneOption {
  paneId: string
  /** The name a person would say: the pane's nickname, or its profile's name. */
  label: string
  /** The profile's name, for the second line of a menu row. */
  agent: string
  profileId: string
  /** Does this window have a terminal with a buffer to read? */
  live: boolean
}

/**
 * Every pane in the project, for the "capture pane" menu.
 *
 * Unlike the hand-off, this deliberately *includes* shells: a PowerShell screen
 * full of a failing build is one of the most useful things there is to put in
 * front of another agent, and refusing to capture it because it is not an agent
 * would be a rule inherited from a different problem.
 */
export function capturePaneOptions(
  workspace: Workspace,
  profiles: AgentProfile[],
  isLive: (paneId: string) => boolean
): PaneOption[] {
  return workspace.tabs
    .flatMap((tab) => collectLeaves(tab.root))
    .map((leaf) => {
      const profile = resolveProfile(profiles, leaf.profileId)
      return {
        paneId: leaf.id,
        label: paneDisplayTitle(profile, leaf.title),
        agent: profile.name,
        profileId: leaf.profileId,
        live: isLive(leaf.id)
      }
    })
}

/**
 * The roster written to `.forge/share/panes.json`.
 *
 * Composed here because the renderer is the only side that knows any of it: main
 * sees pane ids and nothing else, and "Codex — worker" is a nickname living in the
 * workspace tree next to a profile id. `openedAt` is left at 0 on purpose — the
 * store fills it with the first time it saw the pane, which is the only honest
 * answer available without inventing a second place to remember one.
 */
export function sharePanes(workspace: Workspace, profiles: AgentProfile[]): SharePane[] {
  return workspace.tabs
    .flatMap((tab) => collectLeaves(tab.root))
    .map((leaf) => {
      const profile = resolveProfile(profiles, leaf.profileId)
      return {
        paneId: leaf.id,
        title: paneDisplayTitle(profile, leaf.title),
        agent: profile.name,
        profileId: leaf.profileId,
        openedAt: 0
      }
    })
}
