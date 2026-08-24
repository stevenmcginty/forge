/**
 * Short, collision-safe, human-greppable ids — the renderer's door onto
 * shared/ids.ts.
 *
 * The implementation moved into `shared/` when the main process started minting
 * ids of its own (electron/layout-engine.ts performs a phone's layout ops in
 * main now, and a new pane needs a pane id there). `shared/` is the only folder
 * both sides may import, and tsconfig.node.json's include list is exactly
 * `electron/**` plus `shared/**` — so a file main imports cannot live in `src/`.
 *
 * This re-export stays so the ~forty `@/lib/ids` imports in the renderer do not
 * all have to move for it.
 */
export { makeId } from '@shared/ids'
