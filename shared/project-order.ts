/**
 * Order for every project picker (desktop sheet, Forge Web, the phone list).
 *
 * The saved array order is unchanged. This only decides what is drawn first,
 * so a folder you are in, or one that still has work open, is not buried under
 * folders you are not using.
 *
 *   0  pinned — always the top block, in the order they were saved
 *   1  the project you are in
 *   2  a project that is working, or waiting on you
 *   3  a project that has panes open
 *   4  the rest, in the order they were saved
 */

export interface PickerFacts {
  active: boolean
  /** Terminals are producing output, or one of them is waiting on you. */
  working: boolean
  /** At least one pane exists, even if it is quiet. */
  open: boolean
  pinned: boolean
}

export function projectPickerTier(facts: PickerFacts): number {
  if (facts.pinned) return 0
  if (facts.active) return 1
  if (facts.working) return 2
  if (facts.open) return 3
  return 4
}

/** `pinned` is the top block. `live` is the in-use rows under it. `rest` scrolls. */
export function projectPickerBucket(tier: number): 'live' | 'pinned' | 'rest' {
  if (tier === 0) return 'pinned'
  if (tier <= 3) return 'live'
  return 'rest'
}

/**
 * Lower tier first. The same tier keeps the saved order, so a drag inside one
 * group still sticks and two quiet folders do not swap on their own.
 */
export function sortProjectsForPicker<T>(projects: readonly T[], facts: (project: T) => PickerFacts): T[] {
  return projects
    .map((project, index) => ({ project, index, tier: projectPickerTier(facts(project)) }))
    .sort((a, b) => a.tier - b.tier || a.index - b.index)
    .map((row) => row.project)
}
