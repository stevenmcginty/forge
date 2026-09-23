import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import {
  assignCallSigns,
  normalisePrompt,
  renameCallSign,
  type CallSignMap,
  type KeymapFile,
  type SavedPrompt,
  type SavedPromptInput
} from '@shared/hub'

/**
 * The hub's own small JSON files, beside settings.json in the data dir:
 *
 *   prompts.json            saved prompts
 *   keymap.json             the user's shortcut overrides
 *   callsigns/<project>.json  paneId → call-sign, one file per project
 *
 * Deliberately not in settings.json or the layout files: those have their own
 * owners and their own wire shapes (the phone reads the layouts). Same write
 * discipline as electron/store.ts — tmp file + rename, a corrupt file is moved
 * aside and read as empty rather than crashing the app.
 *
 * No `electron` import, so scripts/canvas-check.mjs can drive it against a
 * temp folder.
 */
export class HubStore {
  private prompts: SavedPrompt[] | null = null
  private keymap: KeymapFile | null = null
  private readonly callSigns = new Map<string, CallSignMap>()
  private readonly dataDir: string

  constructor(dataDir: string) {
    this.dataDir = dataDir
  }

  /* ------------------------------------------------------------ prompts */

  listPrompts(): SavedPrompt[] {
    if (!this.prompts) {
      const raw = this.read<unknown>('prompts.json', [])
      this.prompts = Array.isArray(raw)
        ? raw.filter((p): p is SavedPrompt => Boolean(p && typeof p === 'object' && (p as SavedPrompt).id && (p as SavedPrompt).title))
        : []
    }
    return this.prompts
  }

  savePrompt(
    input: SavedPromptInput,
    now = Date.now()
  ): { ok: true; prompt: SavedPrompt; prompts: SavedPrompt[] } | { ok: false; error: string } {
    const list = this.listPrompts()
    const existing = input?.id ? list.find((p) => p.id === input.id) : undefined
    const result = normalisePrompt(input, existing, now, () => `prompt-${randomUUID().slice(0, 8)}`)
    if (!result.ok) return result
    const next = existing ? list.map((p) => (p.id === existing.id ? result.prompt : p)) : [...list, result.prompt]
    this.prompts = next
    this.write('prompts.json', next)
    return { ok: true, prompt: result.prompt, prompts: next }
  }

  deletePrompt(id: string): SavedPrompt[] {
    const list = this.listPrompts()
    const next = list.filter((p) => p.id !== id)
    if (next.length !== list.length) {
      this.prompts = next
      this.write('prompts.json', next)
    }
    return next
  }

  /* ------------------------------------------------------------- keymap */

  getKeymap(): KeymapFile {
    if (!this.keymap) this.keymap = cleanKeymap(this.read<unknown>('keymap.json', null))
    return this.keymap
  }

  setKeymap(file: KeymapFile): KeymapFile {
    this.keymap = cleanKeymap(file)
    this.write('keymap.json', this.keymap)
    return this.keymap
  }

  /* --------------------------------------------------------- call-signs */

  getCallSigns(projectId: string): CallSignMap {
    const key = safeId(projectId)
    let map = this.callSigns.get(key)
    if (!map) {
      const raw = this.read<unknown>(join('callsigns', `${key}.json`), {})
      map = {}
      if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
        for (const [id, name] of Object.entries(raw as Record<string, unknown>)) {
          if (typeof name === 'string' && name.trim()) map[id] = name
        }
      }
      this.callSigns.set(key, map)
    }
    return map
  }

  /** Name every live pane that has no name yet. Writes only when something changed. */
  syncCallSigns(projectId: string, paneIds: readonly string[], prune: boolean): { map: CallSignMap; changed: boolean } {
    const result = assignCallSigns(this.getCallSigns(projectId), paneIds, { prune })
    if (result.changed) this.putCallSigns(projectId, result.map)
    return result
  }

  renameCallSign(
    projectId: string,
    paneId: string,
    name: string
  ): { ok: true; map: CallSignMap } | { ok: false; error: string } {
    const result = renameCallSign(this.getCallSigns(projectId), paneId, name)
    if (result.ok) this.putCallSigns(projectId, result.map)
    return result
  }

  private putCallSigns(projectId: string, map: CallSignMap): void {
    const key = safeId(projectId)
    this.callSigns.set(key, map)
    this.write(join('callsigns', `${key}.json`), map)
  }

  /* ------------------------------------------------------------- files */

  private path(name: string): string {
    return join(this.dataDir, name)
  }

  private read<T>(name: string, fallback: T): T {
    const p = this.path(name)
    if (!existsSync(p)) return fallback
    try {
      return JSON.parse(readFileSync(p, 'utf8')) as T
    } catch (err) {
      console.error(`[hub] ${name} is unreadable, starting empty:`, err)
      try {
        renameSync(p, `${p}.corrupt`)
      } catch {
        /* best effort */
      }
      return fallback
    }
  }

  private write(name: string, value: unknown): void {
    const p = this.path(name)
    const tmp = `${p}.tmp`
    try {
      mkdirSync(join(p, '..'), { recursive: true })
      writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf8')
      renameSync(tmp, p)
    } catch (err) {
      console.error(`[hub] failed to write ${name}:`, err)
    }
  }
}

function cleanKeymap(raw: unknown): KeymapFile {
  const overrides: Record<string, string[]> = {}
  const src = raw && typeof raw === 'object' ? (raw as { overrides?: unknown }).overrides : null
  if (src && typeof src === 'object' && !Array.isArray(src)) {
    for (const [id, keys] of Object.entries(src as Record<string, unknown>)) {
      if (Array.isArray(keys)) overrides[id] = keys.filter((k): k is string => typeof k === 'string' && k.trim() !== '')
    }
  }
  return { version: 1, overrides }
}

/** Same rule as the layout files: a project id becomes a safe file name. */
export function safeId(id: string): string {
  return String(id ?? '').replace(/[^a-zA-Z0-9_-]/g, '_') || '_'
}
