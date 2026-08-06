import {
  clampSectionHeight,
  RAIL_ALWAYS_ON,
  RAIL_SECTION_DEFAULT_H,
  RAIL_SECTION_ORDER
} from '@shared/rail'
import type { RailSectionId, Settings } from '@shared/types'

/**
 * The rail stack's arithmetic, with no React in it.
 *
 * Four sections, three of which can be switched off and all four of which can be
 * open or closed, is enough combinations that the rules deserve to be somewhere
 * a check script can reach them. Everything here is a pure function of settings;
 * RailStack does the drawing and nothing else.
 */

/** Which sections exist right now, in rail order. */
export function visibleSections(settings: Settings): RailSectionId[] {
  return RAIL_SECTION_ORDER.filter((id) => isEnabled(settings, id))
}

/**
 * Is this section switched on?
 *
 * Projects has no setting and never gets one. Every other section is scoped to
 * whichever project is active, so a rail you cannot change project from is a
 * rail where none of the others can be pointed at anything.
 */
export function isEnabled(settings: Settings, id: RailSectionId): boolean {
  switch (id) {
    case 'projects':
      return true
    case 'tasks':
      return settings.railTasks
    case 'git':
      return settings.railGit
    case 'activity':
      return settings.railActivity
    default:
      return false
  }
}

export function isOpen(settings: Settings, id: RailSectionId): boolean {
  return settings.railOpen.includes(id)
}

/**
 * Flip one section open or closed, returning the whole set.
 *
 * Kept in rail order rather than click order so that two settings.json files
 * with the same sections open are byte-identical — the persist effect in
 * AppState diffs a JSON string, and a set that reshuffles itself on every click
 * would write to disk every time.
 */
export function toggleOpen(open: RailSectionId[], id: RailSectionId): RailSectionId[] {
  const next = new Set(open.filter((x) => RAIL_SECTION_ORDER.includes(x)))
  if (next.has(id)) next.delete(id)
  else next.add(id)
  return RAIL_SECTION_ORDER.filter((x) => next.has(x))
}

/**
 * The body height for one section, clamped for the window it is about to be
 * drawn in.
 *
 * Projects is excluded on purpose and returns null: it is the section that
 * absorbs the slack, so it is `flex: 1` with no cap and nothing to remember. A
 * height for it in settings.json is ignored rather than honoured.
 */
export function sectionHeight(settings: Settings, id: RailSectionId, viewportH: number): number | null {
  if (id === RAIL_ALWAYS_ON) return null
  const saved = settings.railHeights[id]
  return clampSectionHeight(saved ?? RAIL_SECTION_DEFAULT_H, viewportH)
}

/**
 * True while the rail should offer the "＋ Git · Activity" line at its foot.
 *
 * Both new sections default off, which would otherwise make the whole feature
 * invisible to anyone who never opens Appearance. One row, and it goes away for
 * good the moment either section is on — a hint that keeps hinting after it has
 * been taken is just nagging.
 */
export function showsDiscoveryHint(settings: Settings): boolean {
  return !settings.railGit && !settings.railActivity
}
