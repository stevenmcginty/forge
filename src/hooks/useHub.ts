import { useCallback, useEffect, useState, useSyncExternalStore } from 'react'
import type { CallSignMap, CanvasItem, CanvasLayoutPatch, CanvasSnapshot, SavedPrompt } from '@shared/hub'
import { hubApi } from '@/lib/hubApi'
import {
  deletePrompt,
  getCallSigns,
  getPrompts,
  renameCallSign,
  savePrompt,
  subscribeCallSigns,
  subscribePrompts
} from '@/lib/hubStores'
import {
  getKeymapView,
  resetCommandKeys,
  runCommand,
  setCommandKeys,
  subscribeKeymap,
  suspendShortcuts,
  type KeymapView
} from '@/lib/keymapRegistry'
import { useApp } from '@/state/AppState'

/**
 * The hub's React hooks, for D2's surfaces. Data only — no markup. See
 * SCRATCH/b2-api.md for the contract.
 */

/* --------------------------------------------------------------- canvas */

export interface CanvasFeed {
  /** The active project's board, in board order. Empty while loading. */
  items: CanvasItem[]
  /** The folder agents save into (also FORGE_CANVAS_DIR in this project's panes). '' until loaded. */
  dir: string
  /** Ids added by the most recent change — for an entrance animation. */
  justAdded: string[]
  available: boolean
  post(path: string, title?: string): Promise<{ ok: true; item: CanvasItem } | { ok: false; error: string }>
  remove(id: string): Promise<boolean>
  layout(patch: CanvasLayoutPatch): Promise<void>
  /** A blob: URL for an item's bytes. Revoke it (URL.revokeObjectURL) when the tile unmounts. */
  objectUrl(id: string): Promise<string | null>
  /** An item's text (md/txt/html). */
  readText(id: string): Promise<string | null>
  reveal(): void
}

export function useCanvasFeed(projectId?: string | null): CanvasFeed {
  const { state } = useApp()
  const pid = projectId === undefined ? state.activeProjectId : projectId
  const [snap, setSnap] = useState<CanvasSnapshot | null>(null)
  const [justAdded, setJustAdded] = useState<string[]>([])
  const hub = hubApi()

  useEffect(() => {
    setSnap(null)
    setJustAdded([])
    if (!hub || !pid) return
    let live = true
    hub.canvas
      .list(pid)
      .then((s) => live && setSnap(s))
      .catch((err: unknown) => console.error('[canvas] list failed', err))
    const off = hub.canvas.onChanged((change) => {
      if (!live || change.projectId !== safeId(pid)) return
      setSnap(change.snapshot)
      if (change.added.length) setJustAdded(change.added)
    })
    return () => {
      live = false
      off()
    }
  }, [hub, pid])

  const post = useCallback(
    async (path: string, title?: string) => {
      if (!hub || !pid) return { ok: false as const, error: 'No project is open.' }
      return hub.canvas.post(pid, path, title)
    },
    [hub, pid]
  )
  const remove = useCallback(async (id: string) => (hub && pid ? hub.canvas.remove(pid, id) : false), [hub, pid])
  const layout = useCallback(
    async (patch: CanvasLayoutPatch) => {
      if (hub && pid) setSnap(await hub.canvas.layout(pid, patch))
    },
    [hub, pid]
  )
  const objectUrl = useCallback(
    async (id: string) => {
      if (!hub || !pid) return null
      const file = await hub.canvas.read(pid, id)
      if (!file) return null
      return URL.createObjectURL(new Blob([file.bytes as BlobPart], { type: file.mime }))
    },
    [hub, pid]
  )
  const readText = useCallback(
    async (id: string) => {
      if (!hub || !pid) return null
      const file = await hub.canvas.read(pid, id)
      return file ? new TextDecoder().decode(file.bytes) : null
    },
    [hub, pid]
  )
  const reveal = useCallback(() => {
    if (hub && pid) void hub.canvas.reveal(pid)
  }, [hub, pid])

  return {
    items: snap?.items ?? [],
    dir: snap?.dir ?? '',
    justAdded,
    available: Boolean(hub),
    post,
    remove,
    layout,
    objectUrl,
    readText,
    reveal
  }
}

/** Same rule as electron/hub-store.ts safeId — main keys pushes by the sanitised id. */
function safeId(id: string): string {
  return String(id ?? '').replace(/[^a-zA-Z0-9_-]/g, '_') || '_'
}

/* ----------------------------------------------------------- call-signs */

/** paneId → call-sign for a project (the active one by default), plus rename. */
export function useCallSigns(projectId?: string | null): {
  map: CallSignMap
  rename(paneId: string, name: string): Promise<{ ok: true } | { ok: false; error: string }>
} {
  const { state } = useApp()
  const pid = projectId === undefined ? state.activeProjectId : projectId
  const map = useSyncExternalStore(subscribeCallSigns, () => getCallSigns(pid ?? null))
  const rename = useCallback(
    async (paneId: string, name: string) =>
      pid ? renameCallSign(pid, paneId, name) : { ok: false as const, error: 'No project is open.' },
    [pid]
  )
  return { map, rename }
}

/** One pane's call-sign (for a pane header). */
export function useCallSign(paneId: string, projectId?: string | null): string | null {
  const { map } = useCallSigns(projectId)
  return map[paneId] ?? null
}

/* -------------------------------------------------------- saved prompts */

export function useSavedPrompts(): {
  prompts: SavedPrompt[]
  save: typeof savePrompt
  remove: typeof deletePrompt
  /** Run through the keymap command, so the hotkey and a click do exactly the same thing. */
  run(id: string): boolean
} {
  const prompts = useSyncExternalStore(subscribePrompts, getPrompts)
  const run = useCallback((id: string) => runCommand(`prompt.${id}`), [])
  return { prompts, save: savePrompt, remove: deletePrompt, run }
}

/* --------------------------------------------------------------- keymap */

export function useKeymap(): KeymapView & {
  setKeys: typeof setCommandKeys
  reset: typeof resetCommandKeys
  /** Call while a "press the new keys" field is recording; returns the release. */
  suspend: typeof suspendShortcuts
  run: typeof runCommand
} {
  const view = useSyncExternalStore(subscribeKeymap, getKeymapView)
  return { ...view, setKeys: setCommandKeys, reset: resetCommandKeys, suspend: suspendShortcuts, run: runCommand }
}
