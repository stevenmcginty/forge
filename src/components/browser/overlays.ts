/**
 * What the native page must get out of the way of. A WebContentsView is drawn
 * above the whole renderer, so anything the renderer shows over a surface's
 * box would be drawn *under* the page — invisible, with its clicks landing in
 * the page instead.
 *
 * `[data-shell-overlay]` is the general mechanism: any pop-up, menu or prompt
 * that sets that attribute hides the page while it overlaps it (the title-bar
 * menu, settings and sheets already do). The class names are the ones that do
 * not carry it yet. Plain module, no DOM, no React: scripts/browser-check.mjs
 * reads these lists directly.
 */

/** Pop-ups and prompts that hide the page while they overlap it. */
export const COVERS = [
  '[data-shell-overlay]',
  '.spop',
  '.cheat',
  '.sheet',
  '.popover',
  '.blight',
  // The title bar's "…" menu (it also sets data-shell-overlay).
  '.deckmenu__panel',
  // Phone pairing, onboarding / account, What's new.
  '.approval',
  '.onboard',
  '.wnew'
].join(', ')

/** Things that rise from the dock: the page's bottom edge stops above them. */
export const TRIMS = '.cpal, .csave, .crail, .barrive, .dtoast'
