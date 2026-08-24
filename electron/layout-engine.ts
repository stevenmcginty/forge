import type { SplitDirection, TerminalTab, Workspace } from '@shared/types'
import { MAX_PANES_PER_TAB, MAX_SESSIONS, MAX_TABS_PER_PROJECT } from '@shared/ipc'
import { isPermissionMode } from '@shared/agents'
import {
  collectLeaves,
  countLeaves,
  isValidLayout,
  makeLeaf,
  neighbourAfterClose,
  removeLeaf,
  splitLeaf
} from '@shared/splitTree'
import { EMPTY_WORKSPACE, makeTab, withPrunedMosaic } from '@shared/workspace'

/**
 * The split tree, owned by the main process.
 *
 * ## Why this exists
 *
 * Every layout operation a phone or a browser sent used to be forwarded into
 * the desktop renderer over IPC, where the React reducer performed it, and the
 * remote client waited up to eight seconds for the answer. That made the
 * renderer a single point of failure for a feature whose entire purpose is
 * being away from the desk: a window that had crashed, hung, or gone blank
 * turned every tap on the phone into "The desktop did not answer in time", and
 * the person holding the phone was three hundred miles from the only thing that
 * could fix it. It happened. electron/renderer-watchdog.ts now notices a dead
 * renderer and reloads it, which shortens the outage; this file removes the
 * dependency instead.
 *
 * So main holds the authoritative workspace and performs the operation itself,
 * against the same pure functions the reducer uses (shared/splitTree.ts,
 * shared/workspace.ts). The renderer becomes a *follower*: it is told what the
 * layout now is over `IPC.workspaceReplaced` and swaps it in. Nothing here
 * spawns a pane — a new leaf grows a PTY when the renderer mounts it, exactly
 * as it always has (src/lib/terminals.ts) — and nothing here draws anything.
 * What moved into main is only the arithmetic of the tree and the file it is
 * saved in, which were always the two things a browser was really waiting on.
 *
 * Decision 5 of docs/forge-web.md is untouched by this: there is still one
 * workspace and one truth, and a tab opened from the browser still appears on
 * the desk. What changed is *which process* holds that truth.
 *
 * ## Electron-free, on purpose
 *
 * Reading a layout, writing it and listing projects all arrive as injected
 * functions, so the engine has no `electron` import and no `app.getPath` in it.
 * That is what lets scripts/layout-engine-check.mjs drive the shipped code
 * head-less over a seeded workspace rather than a stand-in written to agree
 * with it — the same reason electron/web/fs-browse.ts and
 * electron/pty/grid-owner.ts have no Electron in them.
 *
 * ## Staying in step with the renderer
 *
 * The renderer still owns every *local* change — a drag on a divider, a
 * rename, a click on the split button — and persists them through
 * `IPC.storeSetWorkspace`. That handler feeds `replace()` here, so the copy in
 * this map is the one the desk last saved and the next remote op applies to the
 * latest layout rather than to whatever was on disk when this process started.
 */

/** The signal that an op is not this engine's to perform — see `apply`. */
export const UNSUPPORTED = 'unsupported'

/**
 * One layout operation off a wire.
 *
 * Deliberately structural rather than `WebLayoutOp | OpFrame`: the browser's
 * vocabulary is a superset of the phone's, both arrive here already coerced by
 * their own server, and a union would mean a cast per branch for the two fields
 * only one of them carries. `op` is a plain string because an unknown verb is a
 * refusal this engine has to be able to state, not a compile error somewhere
 * upstream.
 */
export interface LayoutOp {
  op: string
  projectId: string
  profileId?: string
  /** Wire data — run through `isPermissionMode` here, never cast. */
  permissionMode?: string
  tabId?: string
  paneId?: string
  direction?: SplitDirection
}

export type LayoutResult =
  | { ok: true; workspace: Workspace; killed: string[] }
  | { ok: false; error: string }

export interface LayoutEngineDeps {
  /** The workspace as last saved, or null for a project nobody has opened yet. */
  load: (projectId: string) => Workspace | null
  /** Persist a workspace the engine has just changed. Called once per applied op. */
  save: (projectId: string, workspace: Workspace) => void
  /**
   * The project rail. Two jobs: refusing an op that names a project this
   * desktop no longer has, and supplying the profile a pane opens with when the
   * client named none — the same `project.defaultProfileId` the renderer's own
   * handler falls back to.
   */
  projects: () => Array<{ id: string; defaultProfileId?: string }>
}

export class LayoutEngine {
  private readonly deps: LayoutEngineDeps
  /** Per project, the layout as this process believes it to be. */
  private readonly workspaces = new Map<string, Workspace>()

  constructor(deps: LayoutEngineDeps) {
    this.deps = deps
  }

  /** The layout for a project, read from disk the first time it is asked for. */
  workspace(projectId: string): Workspace {
    const held = this.workspaces.get(projectId)
    if (held) return held
    const loaded = this.deps.load(projectId)
    const workspace = loaded && Array.isArray(loaded.tabs) ? loaded : EMPTY_WORKSPACE
    this.workspaces.set(projectId, workspace)
    return workspace
  }

  /**
   * Adopt a workspace somebody else wrote — the renderer, through
   * `IPC.storeSetWorkspace`.
   *
   * Without this the engine would be applying a phone's op to the layout as it
   * stood the last time a phone touched it, and a split made at the desk five
   * minutes ago would vanish the moment somebody closed a pane from away.
   */
  replace(projectId: string, workspace: Workspace): void {
    if (!workspace || !Array.isArray(workspace.tabs)) return
    this.workspaces.set(projectId, workspace)
  }

  /** Every pane in every project this desktop has, which is what MAX_SESSIONS counts. */
  private totalPanes(): number {
    let n = 0
    for (const project of this.deps.projects()) {
      for (const tab of this.workspace(project.id).tabs) n += countLeaves(tab.root)
    }
    return n
  }

  /**
   * Perform one operation, save the result, and say which panes it orphaned.
   *
   * `killed` is returned rather than acted on: killing a PTY is the host's job
   * (electron/pty-host.ts), and an engine that reached for it could not be
   * driven by a check with no PTYs in it. The caller kills them and pushes the
   * new workspace to the renderer.
   *
   * `{ ok: false, error: UNSUPPORTED }` is the one refusal that is not about
   * this op being wrong: it means the verb is not the layout's to answer, and
   * the caller should fall back to asking the renderer. `select-project` is the
   * only one — which project the desk is *looking at* is a fact about a window,
   * not about a saved layout.
   */
  apply(projectId: string, op: LayoutOp): LayoutResult {
    const project = this.deps.projects().find((p) => p.id === projectId)
    if (!project) return { ok: false, error: 'That project is no longer open on the desktop.' }
    if (op.op === 'select-project') return { ok: false, error: UNSUPPORTED }

    const ws = this.workspace(projectId)
    // Wire data, so it is checked and never cast: anything that is not one of
    // the four modes becomes undefined, which means "whatever the profile
    // says" — exactly what a client that never sent the field gets.
    const mode = isPermissionMode(op.permissionMode) ? op.permissionMode : undefined
    const profileId = op.profileId || project.defaultProfileId || ''

    let next: Workspace
    let killed: string[] = []

    switch (op.op) {
      case 'create-tab': {
        if (this.totalPanes() >= MAX_SESSIONS) {
          return { ok: false, error: `Forge is at its ${MAX_SESSIONS}-session limit.` }
        }
        if (ws.tabs.length >= MAX_TABS_PER_PROJECT) {
          return { ok: false, error: `That project already holds its ${MAX_TABS_PER_PROJECT} tabs.` }
        }
        const made = makeTab(profileId, ws.tabs, ws.nameCursor ?? 0, mode)
        next = { ...ws, tabs: [...ws.tabs, made.tab], activeTabId: made.tab.id, nameCursor: made.cursor }
        break
      }

      case 'close-tab': {
        if (!op.tabId) return { ok: false, error: 'No tab named.' }
        const closed = this.closeTab(ws, op.tabId)
        if (!closed) return { ok: false, error: 'That tab is gone.' }
        next = closed.workspace
        killed = closed.killed
        break
      }

      case 'select-tab': {
        if (!op.tabId) return { ok: false, error: 'No tab named.' }
        if (!ws.tabs.some((t) => t.id === op.tabId)) return { ok: false, error: 'That tab is gone.' }
        next = { ...ws, activeTabId: op.tabId }
        break
      }

      case 'create-pane': {
        if (this.totalPanes() >= MAX_SESSIONS) {
          return { ok: false, error: `Forge is at its ${MAX_SESSIONS}-session limit.` }
        }
        const active = ws.tabs.find((t) => t.id === ws.activeTabId)
        const paneId = op.paneId ?? active?.activePaneId
        if (!paneId) return { ok: false, error: 'There is no pane open to split.' }
        const tab = tabHolding(ws, paneId)
        if (!tab) return { ok: false, error: 'That pane is gone.' }
        if (countLeaves(tab.root) >= MAX_PANES_PER_TAB) {
          return { ok: false, error: `That tab already holds its ${MAX_PANES_PER_TAB} panes.` }
        }
        // The client's own default when it sends nothing, matching the desktop's
        // split button rather than inventing a third answer. The phone has no
        // `direction` on its wire at all, so every split from one lands here.
        const direction: SplitDirection = op.direction === 'column' ? 'column' : 'row'
        const leaf = makeLeaf(profileId, '', mode)
        next = replaceTab(ws, { ...tab, root: splitLeaf(tab.root, paneId, direction, leaf), activePaneId: leaf.id })
        break
      }

      case 'close-pane': {
        if (!op.paneId) return { ok: false, error: 'No pane named.' }
        const tab = tabHolding(ws, op.paneId)
        if (!tab) return { ok: false, error: 'That pane is gone.' }
        // Closing the last pane of a tab closes the tab — the reducer's rule,
        // and the reason a phone's × on a lone pane does not leave an empty one.
        if (countLeaves(tab.root) === 1) {
          const closed = this.closeTab(ws, tab.id)
          if (!closed) return { ok: false, error: 'That pane is gone.' }
          next = closed.workspace
          killed = closed.killed
          break
        }
        const nextFocus = neighbourAfterClose(tab.root, op.paneId)
        const root = removeLeaf(tab.root, op.paneId)
        if (!root) return { ok: false, error: 'That pane is gone.' }
        next = withPrunedMosaic(
          replaceTab(ws, { ...tab, root, activePaneId: nextFocus ?? tab.activePaneId })
        )
        killed = [op.paneId]
        break
      }

      case 'focus-pane': {
        if (!op.paneId) return { ok: false, error: 'No pane named.' }
        const tab = tabHolding(ws, op.paneId)
        if (!tab) return { ok: false, error: 'That pane is gone.' }
        // `revealPane`, not `focusPane`: a client can name a pane in a tab that
        // is not the one on screen at the desk, and moving the ring to a pane
        // nobody can see is a focus that is invisible there.
        next = { ...replaceTab(ws, { ...tab, activePaneId: op.paneId }), activeTabId: tab.id }
        break
      }

      default:
        return { ok: false, error: 'Forge does not know that command.' }
    }

    // Never save a tree that could not be loaded again. The pure functions
    // above cannot produce one, which is exactly why this is worth asserting:
    // if it ever fires, something upstream handed us a workspace that was
    // already broken, and writing it back would make that permanent.
    for (const tab of next.tabs) {
      if (!isValidLayout(tab.root)) return { ok: false, error: 'That layout could not be saved.' }
    }

    this.workspaces.set(projectId, next)
    this.deps.save(projectId, next)
    return { ok: true, workspace: next, killed }
  }

  /**
   * Close a tab and every pane in it.
   *
   * Its own function because `close-pane` on the last pane of a tab is this
   * operation — the reducer expresses that by calling itself, and so does this.
   * The tab that takes over is the one to its *left*, which is where the eye
   * already is after a ×; falling to the first remaining tab when the closed
   * one was leftmost.
   */
  private closeTab(ws: Workspace, tabId: string): { workspace: Workspace; killed: string[] } | null {
    const index = ws.tabs.findIndex((t) => t.id === tabId)
    if (index < 0) return null
    const tab = ws.tabs[index]!
    const killed = collectLeaves(tab.root).map((l) => l.id)
    const tabs = ws.tabs.filter((t) => t.id !== tabId)
    const activeTabId =
      ws.activeTabId === tabId ? (tabs[Math.max(0, index - 1)]?.id ?? null) : ws.activeTabId
    return { workspace: withPrunedMosaic({ ...ws, tabs, activeTabId }), killed }
  }
}

/** The tab a pane lives in, wherever in the project that is. */
function tabHolding(ws: Workspace, paneId: string): TerminalTab | null {
  for (const tab of ws.tabs) {
    if (collectLeaves(tab.root).some((l) => l.id === paneId)) return tab
  }
  return null
}

/** The workspace with one tab swapped for a new version of itself, in place. */
function replaceTab(ws: Workspace, tab: TerminalTab): Workspace {
  return { ...ws, tabs: ws.tabs.map((t) => (t.id === tab.id ? tab : t)) }
}

/* ------------------------------------------------------------- the instance
 *
 * One engine per Forge, installed by electron/main.ts once the store is ready
 * and reached by both link hosts. A module-level holder rather than an import
 * of the store, because the injection above is the whole reason this file can
 * be driven by a check — and because web-host and mobile-host must not have to
 * import each other to share it.
 */

let installed: LayoutEngine | null = null

export function installLayoutEngine(deps: LayoutEngineDeps): LayoutEngine {
  installed = new LayoutEngine(deps)
  return installed
}

/**
 * The engine, or null before main has installed one.
 *
 * Null is a real answer rather than a thrown error: a host that finds none
 * falls back to asking the renderer, which is exactly what every host did
 * before this file existed.
 */
export function layoutEngine(): LayoutEngine | null {
  return installed
}
