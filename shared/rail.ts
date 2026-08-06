import type { RailSectionId } from './types'

/**
 * The left rail's sections, and the numbers both sides of the preload boundary
 * have to agree about.
 *
 * The rail used to be two fixed things stacked in App.tsx — the project list and
 * the tasks dock — each owning its own header, its own collapsed variant and, in
 * the dock's case, its own height in localStorage. Adding git and activity as
 * two more of those would have meant four components each inventing the same
 * chrome slightly differently. So the chrome moved out into RailSection and the
 * facts about it moved here.
 *
 * This file is imported by electron/store.ts (for the settings normaliser) and
 * by src/lib/railstack.ts (for the renderer). One file rather than two literals
 * is the whole point: main cannot import renderer modules, and a duplicated
 * constant across that line is what `npm run hub:check` exists to catch. There
 * is nothing to catch here.
 */

/**
 * Fixed order, top to bottom. Not user-reorderable, and deliberately so: the
 * rail is furniture you learn the shape of once, and a draggable stack of four
 * panels is a thing you have to re-learn every time you move one.
 *
 * Projects is first because it is the only section that answers "which project
 * am I even looking at" — everything below it is scoped to that answer.
 */
export const RAIL_SECTION_ORDER: readonly RailSectionId[] = ['projects', 'tasks', 'git', 'activity']

/**
 * Open on a fresh install, and the fallback for a settings.json whose railOpen
 * is missing or corrupt.
 *
 * Git and activity are absent rather than merely closed, because on the update
 * that introduces them they are switched off entirely — a rail that grows two
 * new panels on a version bump has changed without being asked to.
 */
export const DEFAULT_RAIL_OPEN: readonly RailSectionId[] = ['projects', 'tasks']

/**
 * A section header's height. A closed section is exactly this and nothing else,
 * which is the invariant that makes four sections usable at once: however the
 * heights below are dragged, every header stays reachable without scrolling.
 *
 * Must match `.rsec__head` in src/components/rail/RailSection.css.
 */
export const RAIL_HEADER_H = 28

/** How tall a section's body may be dragged, in px. */
export const RAIL_SECTION_MIN_H = 120
export const RAIL_SECTION_MAX_H = 520

/**
 * The largest fraction of the window a single section may claim, applied on top
 * of RAIL_SECTION_MAX_H. On a short laptop screen 520px is most of the rail, and
 * a section that eats the project list is a section that has broken the app.
 */
export const RAIL_SECTION_MAX_VH = 0.55

/** Body height for a section that has never been dragged. */
export const RAIL_SECTION_DEFAULT_H = 240

/**
 * The one section that can never be hidden.
 *
 * Every other section is scoped to the active project, so a rail with no way to
 * change project is a rail with no way to change what any of the others are
 * talking about.
 */
export const RAIL_ALWAYS_ON: RailSectionId = 'projects'

/** Is this a section id we know about? Used by the settings normaliser. */
export function isRailSectionId(value: unknown): value is RailSectionId {
  return typeof value === 'string' && RAIL_SECTION_ORDER.includes(value as RailSectionId)
}

/**
 * A dragged height, made safe.
 *
 * `viewportH` is passed in rather than read off `window` so this stays pure and
 * the check script can exercise it without a DOM. Anything non-finite — a
 * hand-edited settings.json, a NaN out of a pointer maths slip — comes back as
 * the default rather than becoming a `NaN` CSS custom property, which fails
 * silently and looks exactly like a broken drag handle.
 */
export function clampSectionHeight(h: number, viewportH: number): number {
  if (!Number.isFinite(h) || h <= 0) return RAIL_SECTION_DEFAULT_H
  const vh = Number.isFinite(viewportH) && viewportH > 0 ? viewportH : Infinity
  const ceiling = Math.max(RAIL_SECTION_MIN_H, Math.min(RAIL_SECTION_MAX_H, Math.round(vh * RAIL_SECTION_MAX_VH)))
  return Math.min(Math.max(Math.round(h), RAIL_SECTION_MIN_H), ceiling)
}
