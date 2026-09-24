import type { SavedPrompt, SavedPromptInput } from '@shared/hub'
import { hubApi } from './hubApi'

/**
 * Renderer-side cache of the saved prompts, kept in step with main's pushes.
 * A plain external store (subscribe + snapshot) so the hooks can use
 * useSyncExternalStore and the hub runtime can read it without React.
 */

type Listener = () => void

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
