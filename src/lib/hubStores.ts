import type { CallSignMap, SavedPrompt, SavedPromptInput } from '@shared/hub'
import { hubApi } from './hubApi'

/**
 * Renderer-side caches of the call-sign maps and the saved prompts, kept in
 * step with main's pushes. Plain external stores (subscribe + snapshot) so
 * the hooks can use useSyncExternalStore and the hub runtime can read them
 * without React.
 */

type Listener = () => void

/* ----------------------------------------------------------- call-signs */

const callSigns = new Map<string, CallSignMap>()
const callSignListeners = new Set<Listener>()
const EMPTY_MAP: CallSignMap = Object.freeze({}) as CallSignMap
let callSignWired = false

function notifyCallSigns(): void {
  for (const l of callSignListeners) l()
}

function wireCallSigns(): void {
  if (callSignWired) return
  const hub = hubApi()
  if (!hub) return
  callSignWired = true
  hub.callSigns.onChanged((projectId, map) => {
    callSigns.set(projectId, map)
    notifyCallSigns()
  })
}

export function subscribeCallSigns(cb: Listener): () => void {
  wireCallSigns()
  callSignListeners.add(cb)
  return () => {
    callSignListeners.delete(cb)
  }
}

export function getCallSigns(projectId: string | null): CallSignMap {
  return (projectId && callSigns.get(projectId)) || EMPTY_MAP
}

/** Name the project's live panes. `prune` only once its saved layout is loaded. */
export async function syncCallSigns(projectId: string, paneIds: string[], prune: boolean): Promise<void> {
  const hub = hubApi()
  if (!hub) return
  wireCallSigns()
  try {
    const map = await hub.callSigns.sync(projectId, paneIds, prune)
    const before = callSigns.get(projectId)
    if (!before || JSON.stringify(before) !== JSON.stringify(map)) {
      callSigns.set(projectId, map)
      notifyCallSigns()
    }
  } catch (err) {
    console.error('[callsigns] sync failed', err)
  }
}

export async function renameCallSign(
  projectId: string,
  paneId: string,
  name: string
): Promise<{ ok: true } | { ok: false; error: string }> {
  const hub = hubApi()
  if (!hub) return { ok: false, error: 'Call-signs are not available in this build — restart Forge.' }
  const result = await hub.callSigns.rename(projectId, paneId, name)
  if (!result.ok) return result
  callSigns.set(projectId, result.map)
  notifyCallSigns()
  return { ok: true }
}

/* -------------------------------------------------------- saved prompts */

let prompts: SavedPrompt[] = []
const promptListeners = new Set<Listener>()
let promptsWired = false

function setPrompts(next: SavedPrompt[]): void {
  prompts = Array.isArray(next) ? next : []
  for (const l of promptListeners) l()
}

function wirePrompts(): void {
  if (promptsWired) return
  const hub = hubApi()
  if (!hub) return
  promptsWired = true
  hub.prompts.onChanged(setPrompts)
  void hub.prompts
    .list()
    .then(setPrompts)
    .catch((err: unknown) => console.error('[prompts] could not load', err))
}

export function subscribePrompts(cb: Listener): () => void {
  wirePrompts()
  promptListeners.add(cb)
  return () => {
    promptListeners.delete(cb)
  }
}

export function getPrompts(): SavedPrompt[] {
  return prompts
}

export async function savePrompt(input: SavedPromptInput): Promise<{ ok: true; prompt: SavedPrompt } | { ok: false; error: string }> {
  const hub = hubApi()
  if (!hub) return { ok: false, error: 'Saved prompts are not available in this build — restart Forge.' }
  const result = await hub.prompts.save(input)
  if (!result.ok) return result
  setPrompts(result.prompts)
  return { ok: true, prompt: result.prompt }
}

export async function deletePrompt(id: string): Promise<void> {
  const hub = hubApi()
  if (!hub) return
  setPrompts(await hub.prompts.remove(id))
}
