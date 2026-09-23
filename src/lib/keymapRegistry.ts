import type { KeymapFile } from '@shared/hub'
import { hubApi } from './hubApi'
import {
  resetBinding,
  resolveKeymap,
  setBinding,
  type KeyCombo,
  type KeyCommandDef,
  type ResolvedKeymap,
  type SetBindingResult
} from './keymap'
import { BUILTIN_COMMANDS } from './shortcutCommands'

/**
 * The live keymap registry — one per renderer.
 *
 * Commands come from *sources*: 'builtin' (src/lib/shortcutCommands.ts) is
 * always first, then whatever registers later — saved prompts' hotkeys, one
 * "new pane" command per agent profile, D1's uiCommands, B3's browser. A
 * source re-registering replaces its own commands and nobody else's.
 *
 * Handlers are separate from definitions, on purpose: a command can be listed
 * (and rebound on the settings page) before whatever runs it has mounted, and
 * a combo whose command has no handler yet simply passes through to the
 * terminal instead of vanishing.
 *
 * useShortcuts is the only keydown listener; it asks `commandForCombo` and
 * calls `runCommand`. Everything else — the settings page, the cheat sheet,
 * the palette — reads through `getKeymapView` / src/hooks/useKeymap.ts.
 */

/** A handler answers false when it did nothing, so the key reaches the terminal after all. */
export type CommandHandler = () => boolean | void

const sources = new Map<string, KeyCommandDef[]>([['builtin', BUILTIN_COMMANDS]])
const handlers = new Map<string, CommandHandler>()
const listeners = new Set<() => void>()
let overrides: Record<string, KeyCombo[]> = {}
let suspended = 0
let resolved: ResolvedKeymap | null = null
let view: KeymapView | null = null
let loaded = false

export interface KeymapCommandView extends KeyCommandDef {
  keys: KeyCombo[]
  customised: boolean
  /** False until something that can run it has mounted. */
  available: boolean
}

export interface KeymapView {
  commands: KeymapCommandView[]
  conflicts: ResolvedKeymap['conflicts']
  rejected: ResolvedKeymap['rejected']
}

function allCommands(): KeyCommandDef[] {
  const seen = new Set<string>()
  const out: KeyCommandDef[] = []
  for (const defs of sources.values()) {
    for (const def of defs) {
      if (seen.has(def.id)) continue
      seen.add(def.id)
      out.push(def)
    }
  }
  return out
}

function invalidate(): void {
  resolved = null
  view = null
  for (const l of listeners) {
    try {
      l()
    } catch (err) {
      console.error('[keymap] listener threw', err)
    }
  }
}

function current(): ResolvedKeymap {
  if (!resolved) {
    resolved = resolveKeymap(allCommands(), overrides)
    for (const c of resolved.conflicts) {
      console.warn(`[keymap] ${c.combo} is wanted by ${c.commandIds.join(', ')} — ${c.commandIds[0]} keeps it`)
    }
  }
  return resolved
}

/** Add or replace one source's commands. Returns a function that removes them. */
export function defineCommands(sourceId: string, defs: KeyCommandDef[]): () => void {
  if (sourceId === 'builtin') throw new Error('the builtin source is fixed')
  sources.set(sourceId, defs)
  invalidate()
  return () => {
    if (sources.get(sourceId) === defs) {
      sources.delete(sourceId)
      invalidate()
    }
  }
}

export function setCommandHandler(id: string, handler: CommandHandler): () => void {
  handlers.set(id, handler)
  if (view) invalidate()
  return () => {
    if (handlers.get(id) === handler) {
      handlers.delete(id)
      if (view) invalidate()
    }
  }
}

/** Run a command by id (the palette, a button). False when nothing ran. */
export function runCommand(id: string): boolean {
  const handler = handlers.get(id)
  if (!handler) return false
  try {
    return handler() !== false
  } catch (err) {
    console.error(`[keymap] ${id} threw`, err)
    return true
  }
}

/** The command a combo fires right now, or null. Null too while a rebind is capturing keys. */
export function commandForCombo(combo: KeyCombo): KeyCommandDef | null {
  if (suspended > 0) return null
  const id = current().bindings.get(combo)
  if (!id) return null
  return allCommands().find((c) => c.id === id) ?? null
}

export function hasHandler(id: string): boolean {
  return handlers.has(id)
}

/**
 * Stop every shortcut while a "press the new keys" field is listening, so
 * Ctrl+W can be recorded instead of closing a pane. Returns the release.
 */
export function suspendShortcuts(): () => void {
  suspended += 1
  let released = false
  return () => {
    if (released) return
    released = true
    suspended = Math.max(0, suspended - 1)
  }
}

export function getKeymapView(): KeymapView {
  if (!view) {
    const r = current()
    view = {
      commands: allCommands().map((c) => ({
        ...c,
        keys: r.keysFor[c.id] ?? [],
        customised: Object.prototype.hasOwnProperty.call(overrides, c.id),
        available: handlers.has(c.id)
      })),
      conflicts: r.conflicts,
      rejected: r.rejected
    }
  }
  return view
}

export function subscribeKeymap(cb: () => void): () => void {
  listeners.add(cb)
  return () => {
    listeners.delete(cb)
  }
}

function persist(): void {
  const file: KeymapFile = { version: 1, overrides }
  void hubApi()?.keymap.set(file).catch((err: unknown) => console.error('[keymap] could not save keymap.json', err))
}

/** Rebind a command. Refuses reserved keys and, unless `takeOver`, keys another command has. */
export function setCommandKeys(id: string, keys: string[], opts: { takeOver?: boolean } = {}): SetBindingResult {
  const result = setBinding(allCommands(), overrides, id, keys, opts)
  if (result.ok) {
    overrides = result.overrides
    persist()
    invalidate()
  }
  return result
}

/** Back to the default keys for one command, or for all of them. */
export function resetCommandKeys(id?: string): void {
  overrides = resetBinding(overrides, id)
  persist()
  invalidate()
}

/** Read keymap.json once. Safe to call again; later calls are no-ops. */
export async function loadKeymapOverrides(): Promise<void> {
  if (loaded) return
  loaded = true
  const hub = hubApi()
  if (!hub) return
  try {
    const file = await hub.keymap.get()
    overrides = file?.overrides ?? {}
    invalidate()
  } catch (err) {
    console.error('[keymap] could not read keymap.json', err)
  }
}
