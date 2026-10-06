import { useSyncExternalStore } from 'react'
import type { ForgeApi } from '@shared/api'

/**
 * The Read mode's memory, outside React.
 *
 * The surface only mounts while Read is on screen, but two things must outlive
 * it: which file the reader is showing (so Agents → Read comes back to the same
 * page), and a half-written edit (so a trip to a terminal and back never loses
 * it). Both live here, in one tiny store the open-controller and the surface
 * share.
 *
 * Every request to show a file goes through `requestFile`. With unsaved edits
 * to a different file it does not switch: it parks the request in `pending`,
 * and the page asks Save / Discard / Keep editing before anything is lost.
 */

export type ReaderApi = ForgeApi['reader']

let warned = false

/**
 * `window.forge.reader`, or null on a preload that predates it. Always reached
 * through here: the desktop hot-reloads the renderer but not the preload, and an
 * unguarded call to a missing channel throws in an effect and unmounts the whole
 * renderer (and strands the phone).
 */
export function readerApi(): ReaderApi | null {
  const api = (window as unknown as { forge?: { reader?: ReaderApi } }).forge?.reader ?? null
  if (!api && !warned) {
    warned = true
    console.error('[reader] window.forge.reader is missing — the preload is older than the Read view. Restart Forge.')
  }
  return api
}

/** One edit in progress. `original` is the text as read, so "Not saved" is a comparison, not a flag. */
export interface ReaderDraft {
  path: string
  text: string
  original: string
  /** The hash the original was read with; `write` checks it. */
  baseHash: string
}

export interface ReaderState {
  /** The file on the page, or null before anything is chosen. */
  current: string | null
  /** Asked for while `draft` had unsaved changes to another file. */
  pending: string | null
  draft: ReaderDraft | null
}

let state: ReaderState = { current: null, pending: null, draft: null }
const listeners = new Set<() => void>()

function set(patch: Partial<ReaderState>): void {
  state = { ...state, ...patch }
  for (const cb of listeners) cb()
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb)
  return () => {
    listeners.delete(cb)
  }
}

export function readerState(): ReaderState {
  return state
}

export function useReaderState(): ReaderState {
  return useSyncExternalStore(subscribe, readerState)
}

/** Windows paths, compared as Windows does: case and slash direction do not matter. */
export function samePath(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false
  return a.replace(/\//g, '\\').toLowerCase() === b.replace(/\//g, '\\').toLowerCase()
}

export function isDirty(draft: ReaderDraft | null): boolean {
  return !!draft && draft.text !== draft.original
}

/** Show this file — unless that would drop unsaved edits, in which case ask first. */
export function requestFile(path: string): void {
  if (samePath(path, state.current)) {
    if (state.pending) set({ pending: null })
    return
  }
  if (isDirty(state.draft)) {
    set({ pending: path })
    return
  }
  set({ current: path, pending: null, draft: null })
}

/** The page's answer to a pending request: go there (edits already saved or discarded), or stay. */
export function settlePending(go: boolean): void {
  if (!state.pending) return
  if (go) set({ current: state.pending, pending: null, draft: null })
  else set({ pending: null })
}

/** The surface picking a first file by itself (last opened, HANDOFF.md, README.md). Never over a choice. */
export function chooseDefault(path: string): void {
  if (state.current) return
  set({ current: path })
}

export function setDraft(draft: ReaderDraft | null): void {
  set({ draft })
}
