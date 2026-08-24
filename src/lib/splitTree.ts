/**
 * Pure operations on a pane layout — the renderer's door onto
 * shared/splitTree.ts.
 *
 * The implementation moved into `shared/` when the main process became the
 * thing that performs a phone's or a browser's layout operations
 * (electron/layout-engine.ts): main splits and prunes the same tree the reducer
 * does, with the same functions, because two implementations of "remove a leaf
 * and collapse the split it lived in" is exactly the sort of pair that agrees
 * until the day it does not.
 *
 * This re-export stays so the renderer's `@/lib/splitTree` imports — and the
 * web client's, which reuses these components — do not all have to move for it.
 */
export {
  collectLeaves,
  countLeaves,
  findLeaf,
  isValidLayout,
  makeLeaf,
  neighbourAfterClose,
  removeLeaf,
  setSplitRatio,
  splitLeaf,
  updateLeaf
} from '@shared/splitTree'
