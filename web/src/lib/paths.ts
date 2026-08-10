/**
 * The two path helpers the browser needs, restated.
 *
 * `src/lib/paths.ts` has these two functions and they are pure — but the rest of
 * that file reaches for `window.forge` (drag-and-drop file resolution, which is
 * an Electron capability), so importing it would drag a preload API into a
 * bundle that has no preload. Six lines restated is cheaper than a shim, and the
 * behaviour is deliberately identical: the desktop draws `…\forge\src` in its
 * titlebar and the browser must draw the same string for the same folder.
 */

export function shortPath(fullPath: string, segments = 2): string {
  const parts = fullPath.split(/[\\/]/).filter(Boolean)
  if (parts.length <= segments) return fullPath
  return `…\\${parts.slice(-segments).join('\\')}`
}

/** Last path segment — what a pane is named after when it has no title. */
export function basename(fullPath: string): string {
  const parts = fullPath.split(/[\\/]/).filter(Boolean)
  return parts[parts.length - 1] ?? fullPath
}
