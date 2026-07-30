import { useSyncExternalStore } from 'react'
import type { MachineSkillInfo, SkillBase, SkillInfo, SkillSource, SkillsList } from '@shared/skills'
import {
  dedupeSkills,
  skillBlurb,
  skillBody,
  skillCommandFor,
  skillPreambleFor,
  usesSlashSkills
} from '@shared/skills'
import type { AgentProfile } from '@shared/types'
import { terminalHost } from './terminals'

export type { MachineSkillInfo, SkillBase, SkillInfo, SkillSource, SkillsList }
export { dedupeSkills, skillBlurb, skillBody, skillCommandFor, skillPreambleFor, usesSlashSkills }

/** A skill plus which folder it came out of — everything below travels as one. */
export interface ResolvedSkill {
  skill: SkillBase
  source: SkillSource
}

/**
 * The renderer's copy of the skills library.
 *
 * A module-level store rather than React state, for the same reason terminalHost
 * is: two very different things need the same list at the same time — the rail,
 * which draws it, and the drag handler, which is a document-level listener with
 * no component to hang off. Both read from here, and every mutation goes through
 * the main process and comes back with the fresh list attached, so there is
 * exactly one round trip per action and no polling.
 */

/**
 * The drag payload. A private MIME type, so a skill dragged onto a pane is
 * unmistakably a skill: the pane's own file-drop handling keys off `Files` and
 * ignores this completely, which is what lets the two coexist without either
 * one knowing about the other.
 */
export const SKILL_DRAG_MIME = 'application/x-forge-skill'

const EMPTY: SkillsList = { skills: [], machineSkills: [] }

class SkillLibrary {
  private list: SkillsList = EMPTY
  private listeners = new Set<() => void>()
  private started = false

  subscribe = (cb: () => void): (() => void) => {
    this.listeners.add(cb)
    // The first subscriber pays for the initial read; everyone after rides it.
    if (!this.started) {
      this.started = true
      void this.refresh()
    }
    return () => {
      this.listeners.delete(cb)
    }
  }

  /** Stable between changes — useSyncExternalStore compares by identity. */
  snapshot = (): SkillsList => this.list

  /**
   * A skill by name, from either folder.
   *
   * Library first, always: a name in both is a library skill Forge either
   * synced into ~/.claude/skills or is refusing to overwrite, and either way
   * the library row is the one with the toggle. `dedupeSkills` applies the same
   * rule to the roster the voice model is given, so a dropped skill and a spoken
   * one can never resolve to different folders.
   */
  find(name: string): ResolvedSkill | null {
    const own = this.list.skills.find((s) => s.name === name)
    if (own) return { skill: own, source: 'library' }
    const machine = this.list.machineSkills.find((s) => s.name === name)
    return machine ? { skill: machine, source: 'machine' } : null
  }

  /** Every skill the model may name, machine ones shadowed by the library. */
  catalogue(): Array<{ name: string; description: string; enabled: boolean }> {
    return [
      ...this.list.skills.map((s) => ({ name: s.name, description: s.description, enabled: s.enabled })),
      // A machine skill is loaded by every session already — there is nothing to
      // enable, so as far as the model is concerned it is simply on.
      ...dedupeSkills(this.list.skills, this.list.machineSkills).map((s) => ({
        name: s.name,
        description: s.description,
        enabled: true
      }))
    ]
  }

  apply(next: SkillsList | undefined): void {
    if (!next || !Array.isArray(next.skills)) return
    this.list = { skills: next.skills, machineSkills: next.machineSkills ?? [] }
    for (const cb of this.listeners) cb()
  }

  async refresh(): Promise<void> {
    this.apply(await window.forge.skills.list())
  }
}

export const skillLibrary = new SkillLibrary()

export function useSkills(): SkillsList {
  return useSyncExternalStore(skillLibrary.subscribe, skillLibrary.snapshot, skillLibrary.snapshot)
}

/* ------------------------------------------------------------ typing in */

/**
 * Put a skill into a pane, and never press Enter.
 *
 * Claude Code and Kimi both read `~/.claude/skills`, so for those the skill is
 * already a slash command and the honest thing to type is `/name` — short,
 * recognisable, and it lights up their own autocomplete. Anything else has
 * never heard of the folder, so it gets the skill's prose instead, flattened
 * onto one line because in a terminal a newline *is* Enter.
 *
 * Unsubmitted either way. Steve reads what landed and presses Enter himself —
 * the same rule dictation follows, for the same reason.
 */
export async function typeSkillIntoPane(
  paneId: string,
  { skill, source }: ResolvedSkill,
  profile: AgentProfile
): Promise<boolean> {
  if (usesSlashSkills(profile.command)) {
    return terminalHost.type(paneId, skillCommandFor(skill.name))
  }
  const text = await window.forge.skills.read(skill.name, source)
  const body = skillBody(text)
  if (!body) return terminalHost.type(paneId, skillCommandFor(skill.name))
  return terminalHost.type(paneId, skillPreambleFor(skill, body))
}

/* --------------------------------------------------------- drag onto pane */

/**
 * A pane element and its id, from anywhere inside it.
 *
 * The nearest `[data-pane-id]` is often the xterm wrapper terminalHost parked in
 * the pane, which carries the right id but is the wrong thing to draw a ring
 * around — so the id and the surface are resolved separately. `.pane` is a
 * terminal pane; `.mtile` is a mosaic tile; both accept a skill.
 */
function paneUnder(target: EventTarget | null): { el: HTMLElement; paneId: string } | null {
  if (!(target instanceof Element)) return null
  const holder = target.closest<HTMLElement>('[data-pane-id]')
  const paneId = holder?.dataset['paneId']
  if (!holder || !paneId) return null
  return { el: target.closest<HTMLElement>('.pane, .mtile') ?? holder, paneId }
}

function carriesSkill(dt: DataTransfer | null): boolean {
  return dt ? Array.from(dt.types).includes(SKILL_DRAG_MIME) : false
}

/**
 * Let skills be dropped on terminal panes — without a single line inside
 * TerminalPane.
 *
 * The pane's own `onDragOver` only calls `preventDefault()` for `Files`, so a
 * skill drag would be rejected by the browser before any React handler saw it.
 * These listeners sit on the document in the *capture* phase, which runs before
 * React's delegated handlers at the root, so the drop is accepted here and the
 * pane's file handling never fires (it re-checks for `Files` and bails).
 *
 * The highlight is a data attribute set straight on the pane element rather than
 * React state, for the same reason: this is a foreign feature borrowing a
 * component it does not own, and it should leave no trace when it lets go.
 *
 * Returns an unsubscribe function.
 */
export function installSkillDropTarget(onDrop: (paneId: string, skillName: string) => void): () => void {
  let lit: HTMLElement | null = null

  const light = (el: HTMLElement | null): void => {
    if (lit === el) return
    if (lit) delete lit.dataset['skillDrop']
    lit = el
    if (lit) lit.dataset['skillDrop'] = 'true'
  }

  const onDragOver = (e: DragEvent): void => {
    if (!carriesSkill(e.dataTransfer)) return
    const hit = paneUnder(e.target)
    light(hit?.el ?? null)
    if (!hit) return
    // Accepting the drag is exactly this call — without it the browser shows a
    // "no entry" cursor and never fires a drop event at all.
    e.preventDefault()
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy'
  }

  const onDropEvent = (e: DragEvent): void => {
    if (!carriesSkill(e.dataTransfer)) return
    const hit = paneUnder(e.target)
    light(null)
    if (!hit) return
    e.preventDefault()
    e.stopPropagation()
    const name = e.dataTransfer?.getData(SKILL_DRAG_MIME) ?? ''
    if (name) onDrop(hit.paneId, name)
  }

  const onEnd = (): void => light(null)

  // No dragleave listener: `dragover` fires continuously wherever the pointer
  // is, so moving off a pane already reports a target that is not one, and
  // light(null) puts the highlight out. A leave handler as well would only
  // fight it across child-element boundaries.
  document.addEventListener('dragover', onDragOver, true)
  document.addEventListener('drop', onDropEvent, true)
  document.addEventListener('dragend', onEnd, true)

  return () => {
    light(null)
    document.removeEventListener('dragover', onDragOver, true)
    document.removeEventListener('drop', onDropEvent, true)
    document.removeEventListener('dragend', onEnd, true)
  }
}
