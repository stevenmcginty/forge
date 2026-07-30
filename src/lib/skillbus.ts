import type { ActionOutcome } from './appactions'

/**
 * The one seam between `use_skill` and the thing that can actually type into a
 * terminal.
 *
 * `appactions.ts` is pure on purpose — hand it a context and a runner and it
 * tells you what it did, with no import of xterm, no DOM and no `window`. That
 * is what lets it be tested without a renderer, and it is worth keeping.
 *
 * But `use_skill` has to reach a live pane, and the runner that would carry it
 * is built inside VoicePanel. So the renderer registers its implementation here
 * once, at mount, and the executor asks for it only if the caller did not supply
 * a `useSkill` of its own. A test registers a spy; a head-less script registers
 * nothing and the action fails honestly ("skills are not available here")
 * instead of quietly doing nothing.
 *
 * This module imports nothing but a type, which is what keeps the purity claim
 * above true.
 */

export interface SkillRequest {
  /** Folder name of the skill — what `/<name>` types. */
  name: string
  /**
   * Where to put it. A pane title or an agent name; matched loosely. Absent
   * means the focused pane, which is what "use the writing skill" means when
   * nobody said where.
   */
  target?: string
}

export type SkillHandler = (request: SkillRequest) => ActionOutcome

let handler: SkillHandler | null = null

/** Called once by the renderer. Returns an unregister function. */
export function setSkillHandler(fn: SkillHandler | null): () => void {
  handler = fn
  return () => {
    if (handler === fn) handler = null
  }
}

export function skillHandler(): SkillHandler | null {
  return handler
}

/* ------------------------------------------------------------- catalogue */

/** The shape `buildManifest` lists under SKILLS. */
export interface SkillCatalogueEntry {
  name: string
  description: string
  enabled: boolean
}

let catalogue: (() => SkillCatalogueEntry[]) | null = null

/**
 * Tell the manifest what is in the library.
 *
 * `buildManifest` takes its skill list on the snapshot, which is the right way
 * round — but the snapshot is built inside VoicePanel, and a caller written
 * before skills existed does not fill it in. Rather than make every caller
 * change, an unset `snapshot.skills` falls back to whatever is registered here,
 * so the model is told the truth either way.
 */
export function setSkillCatalogue(fn: (() => SkillCatalogueEntry[]) | null): () => void {
  catalogue = fn
  return () => {
    if (catalogue === fn) catalogue = null
  }
}

export function skillCatalogue(): SkillCatalogueEntry[] | null {
  return catalogue ? catalogue() : null
}
