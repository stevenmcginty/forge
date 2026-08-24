import type { ClaudePermissionMode, MosaicState, MosaicTile, TerminalTab, Workspace } from './types'
import { TAB_NAME_POOL, TAB_TEXT_PALETTE } from './agents'
import { collectLeaves, makeLeaf } from './splitTree'
import { makeId } from './ids'

/**
 * How a tab is born, and what a workspace looks like with nothing in it.
 *
 * These lived in src/state/AppState.tsx, beside the reducer that is still their
 * loudest caller. They moved here when the main process started performing a
 * phone's and a browser's layout operations itself
 * (electron/layout-engine.ts): a tab opened from away has to come out with the
 * same name, the same colour and the same shape as one opened at the desk, and
 * the only way to guarantee that is for both to run this code rather than two
 * copies of it.
 *
 * No React, no Electron, no DOM — like shared/splitTree.ts, which this builds
 * on, so both sides and scripts/layout-engine-check.mjs can import it.
 */

/** A project nobody has opened a terminal in yet. */
export const EMPTY_WORKSPACE: Workspace = { tabs: [], activeTabId: null, viewMode: 'tabs' }

/** A mosaic wall with nothing on it, back on the automatic grid. */
export function emptyMosaic(): MosaicState {
  return { mode: 'auto', tiles: {}, wallTabs: [] }
}

/**
 * Drop wall boxes belonging to panes and tabs that have just been closed.
 *
 * Stale entries are invisible rather than harmful — nothing looks a box up by a
 * dead pane id — but a project worked in for a month would otherwise carry a
 * few hundred of them to disk forever. A wall left with nothing on it goes back
 * to the auto grid, which is the only honest thing an empty custom wall can be.
 */
export function withPrunedMosaic(ws: Workspace): Workspace {
  const m = ws.mosaic
  if (!m) return ws
  const livePanes = new Set<string>()
  for (const t of ws.tabs) for (const l of collectLeaves(t.root)) livePanes.add(l.id)
  const liveTabs = new Set(ws.tabs.map((t) => t.id))

  const tiles: Record<string, MosaicTile> = {}
  for (const [id, rect] of Object.entries(m.tiles)) if (livePanes.has(id)) tiles[id] = rect
  const wallTabs = m.wallTabs.filter((id) => liveTabs.has(id))

  const same =
    Object.keys(tiles).length === Object.keys(m.tiles).length && wallTabs.length === m.wallTabs.length
  if (same) return ws
  if (Object.keys(tiles).length === 0) return { ...ws, mosaic: emptyMosaic() }
  return { ...ws, mosaic: { ...m, tiles, wallTabs } }
}

/**
 * The terminal-text colour a new tab is born with: the first one nobody in this
 * project is already using, cycling once they are all spoken for.
 *
 * Taken rather than random, because random hands you two near-identical blues
 * often enough to be annoying, and the point of the colour is that no two
 * terminals on the mosaic wall look alike. A tab whose colour the user cleared
 * counts as using none, so the colour it gave up is free again.
 */
export function nextTextColor(tabs: TerminalTab[]): string {
  const taken = new Set(tabs.map((t) => t.textColor?.toLowerCase()).filter(Boolean))
  return (
    TAB_TEXT_PALETTE.find((c) => !taken.has(c.toLowerCase())) ??
    TAB_TEXT_PALETTE[tabs.length % TAB_TEXT_PALETTE.length]!
  )
}

/**
 * The name a new tab is born with, and where the project's cursor lands after
 * handing it out: the next name in the pool nobody in this project is already
 * wearing, wrapping when the hundred run out.
 *
 * The cursor only ever moves forward, so closing a tab does not put its name
 * back at the front of the queue — kill Otis and the next tab is whoever comes
 * after Otis, not Otis again. Names in use are skipped rather than duplicated,
 * which also covers the case where the user has renamed a tab by hand onto a
 * name the pool was about to reach.
 */
export function nextTabName(tabs: TerminalTab[], cursor: number): { title: string; cursor: number } {
  const taken = new Set(tabs.map((t) => t.title.trim().toLowerCase()))
  const start = ((cursor % TAB_NAME_POOL.length) + TAB_NAME_POOL.length) % TAB_NAME_POOL.length
  for (let i = 0; i < TAB_NAME_POOL.length; i++) {
    const at = (start + i) % TAB_NAME_POOL.length
    const name = TAB_NAME_POOL[at]!
    if (!taken.has(name.toLowerCase())) return { title: name, cursor: at + 1 }
  }
  // A hundred open tabs is well past the session limit, but a name is not worth
  // crashing over: fall back to the next free numbered variant of the one due.
  const base = TAB_NAME_POOL[start]!
  let n = 2
  while (taken.has(`${base} ${n}`.toLowerCase())) n++
  return { title: `${base} ${n}`, cursor: start + 1 }
}

export function makeTab(
  profileId: string,
  tabs: TerminalTab[],
  cursor: number,
  permissionMode?: ClaudePermissionMode
): { tab: TerminalTab; cursor: number } {
  const leaf = makeLeaf(profileId, '', permissionMode)
  const name = nextTabName(tabs, cursor)
  return {
    tab: {
      id: makeId('tab'),
      title: name.title,
      root: leaf,
      activePaneId: leaf.id,
      textColor: nextTextColor(tabs)
    },
    cursor: name.cursor
  }
}
