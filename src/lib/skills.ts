import { useSyncExternalStore, type PointerEvent as ReactPointerEvent } from 'react'
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

/** Pixels the pointer must travel before a press on a row becomes a drag. */
const DRAG_SLOP = 4

/**
 * Drag a skill onto a pane — with pointer events, not HTML5 drag-and-drop.
 *
 * This used to be a `draggable` row and a document-level drop target, and on
 * this machine it did nothing at all: a native drag has to satisfy Chromium's
 * own drag-source rules before a single event is dispatched, and when it
 * declines there is no event, no error and nothing to debug. Between a
 * portalled popover, an `-webkit-user-drag` rule inherited from the reset, a
 * WebGL canvas for a drop target and Electron underneath, "nothing happened"
 * had too many candidate causes to keep guessing at.
 *
 * So the gesture is ours end to end. A press, four pixels of travel, and from
 * then on the app is drawing the chip, hit-testing the pane under the cursor
 * and deciding what a release means. Nothing about it can be vetoed by the
 * platform, and every part of it is visible while it happens.
 *
 * Called from a row's `onPointerDown`; it wires and unwires its own listeners.
 */
export function startSkillDrag(
  event: ReactPointerEvent<HTMLElement>,
  name: string,
  onDrop: (paneId: string, skillName: string) => void
): void {
  // Left button only, and never from a control inside the row: the switch and
  // the ⋯ button are things you press, not handles you pull.
  if (event.button !== 0) return
  if (event.target instanceof Element && event.target.closest('button, input')) return

  const row = event.currentTarget
  const pointerId = event.pointerId
  const fromX = event.clientX
  const fromY = event.clientY

  /** Non-null exactly while the press has become a drag. */
  let chip: HTMLElement | null = null
  let lit: HTMLElement | null = null

  const light = (el: HTMLElement | null): void => {
    if (lit === el) return
    if (lit) delete lit.dataset['skillDrop']
    lit = el
    if (lit) lit.dataset['skillDrop'] = 'true'
  }

  /**
   * The pane under a point. `elementFromPoint` rather than the event target
   * because the pointer is captured by the row for the length of the drag —
   * which is what keeps these events away from xterm, and what makes the target
   * a question of geometry instead of event routing.
   */
  const paneAt = (x: number, y: number): { el: HTMLElement; paneId: string } | null =>
    paneUnder(document.elementFromPoint(x, y))

  const begin = (): void => {
    // Popovers go pointer-transparent for the length of the drag, so a skill
    // pulled out of the flyout is hit-tested against the pane underneath it
    // rather than against the flyout it came from.
    document.body.dataset['skillDragging'] = 'true'
    chip = document.createElement('div')
    chip.className = 'skilldrag mono'
    chip.textContent = `/${name}`
    document.body.append(chip)
    try {
      row.setPointerCapture(pointerId)
    } catch {
      // A row that went away mid-press; the listeners below still clean up.
    }
  }

  const move = (e: PointerEvent): void => {
    if (e.pointerId !== pointerId) return
    if (!chip) {
      if (Math.abs(e.clientX - fromX) < DRAG_SLOP && Math.abs(e.clientY - fromY) < DRAG_SLOP) return
      begin()
    }
    const hit = paneAt(e.clientX, e.clientY)
    // Offset from the cursor, so the chip never covers the thing being aimed at.
    chip!.style.transform = `translate(${e.clientX + 14}px, ${e.clientY + 12}px)`
    if (hit) chip!.dataset['over'] = 'true'
    else delete chip!.dataset['over']
    light(hit?.el ?? null)
  }

  const stop = (): void => {
    document.removeEventListener('pointermove', move, true)
    document.removeEventListener('pointerup', up, true)
    document.removeEventListener('pointercancel', stop, true)
    window.removeEventListener('keydown', key, true)
    try {
      row.releasePointerCapture(pointerId)
    } catch {
      /* already released */
    }
    light(null)
    chip?.remove()
    chip = null
    delete document.body.dataset['skillDragging']
  }

  const up = (e: PointerEvent): void => {
    if (e.pointerId !== pointerId) return
    // A press that never travelled is a click, not a drop — the row's own
    // handlers get to mean what they mean.
    const hit = chip ? paneAt(e.clientX, e.clientY) : null
    stop()
    if (hit) onDrop(hit.paneId, name)
  }

  const key = (e: KeyboardEvent): void => {
    if (e.key === 'Escape') stop()
  }

  document.addEventListener('pointermove', move, true)
  document.addEventListener('pointerup', up, true)
  document.addEventListener('pointercancel', stop, true)
  window.addEventListener('keydown', key, true)
}
