/**
 * The Handoff control's view helpers, which now live in shared/handoffview.ts.
 *
 * Moved there when Forge Web and Forge Mobile grew a Handoff menu of their own:
 * the *order* of that menu is the feature, so one file decides it for all three
 * surfaces rather than each drawing its own answer. This file stays as the
 * desktop's name for it, exactly as src/lib/agents.ts and src/lib/splitTree.ts
 * stay as the desktop's names for their shared halves.
 */
export {
  handbackRecord,
  handoffPaneTitle,
  handoffTargetWire,
  handoffTargets,
  paneHandoffChip,
  readHandoffTarget,
  type HandoffChip,
  type HandoffTarget,
  type HandoffTargetKind,
  type HandoffTargetWire
} from '@shared/handoffview'
