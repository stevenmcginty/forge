import { formatCombo } from './keymap'
import { getKeymapView, keyForCommand, runCommand } from './keymapRegistry'
import { uiCommands } from './uiCommands'
import { isWindowCommand, lastWindowCommand, RESTART_NOTE, windowControlAvailable, type WindowShape } from './windowCommands'

/**
 * forge_command — run any Forge command Steve could run from a key or the
 * command palette, by id, for every brain and pane agent (the tool's spec is
 * shared/brain-tools.ts; tools-main answers it with `runForgeCommand`).
 *
 * The commands are the palette's own two registries, run the palette's way —
 * never as synthesised keys:
 *
 *  - uiCommands (`uiCommands.run`): the shell's commands, each surface's
 *    `mode-<id>`, `show-browser`, the window commands (./windowCommands.ts),
 *    and the ones that take an argument (`set-mode <mode>`);
 *  - the keymap registry (`runCommand`): the built-ins in ./shortcutCommands.ts
 *    and each agent profile's "new pane". Its `ui.<id>` rows are the uiCommands
 *    again, so they are listed once, under the bare id.
 *
 * Left out of the keymap side, because running them by id does nothing useful:
 * the two talk keys (gestures useDictation fires; voice.live.toggle is the
 * Listen switch), the bar's own keys (they act on the bar's text box while
 * Steve types in it), F12's developer tools (main reads that key itself; the
 * renderer's handler only passes it on) and saved prompts (run_saved_prompt).
 *
 * The planner is pure — scripts/forge-command-check.mjs feeds it lists.
 */

/** Commands that close or kill something: refused until Steve says yes (`confirmed: true`). */
export const DESTRUCTIVE_FORGE_COMMANDS: ReadonlySet<string> = new Set(['pane.close', 'tab.close'])

/** Keymap commands that cannot be run by id (see the header). */
const NOT_BY_ID: ReadonlySet<string> = new Set(['app.devtools'])

export interface ForgeCommandEntry {
  id: string
  title: string
  group: string
  /** Its first key, as the palette shows it, or null. */
  key: string | null
  /** The argument it takes (`set-mode`: mode). */
  arg?: string
  /** True when it runs without its argument too. */
  argOptional?: boolean
  /** Something on screen answers it right now. */
  runnable: boolean
  source: 'ui' | 'keymap'
}

export interface ForgeCommandRequest {
  id?: unknown
  arg?: unknown
  confirmed?: unknown
}

export type ForgeCommandPlan =
  | { kind: 'list'; text: string }
  | { kind: 'refuse'; reason: 'unknown' | 'needs-arg' | 'needs-yes' | 'unavailable'; text: string }
  | { kind: 'run'; entry: ForgeCommandEntry; arg?: string }

/* ---------------------------------------------------------------- the list */

function usage(e: ForgeCommandEntry): string {
  const head = e.arg ? (e.argOptional ? `${e.id} [${e.arg}]` : `${e.id} <${e.arg}>`) : e.id
  const key = e.key ? ` (${e.key})` : ''
  const yes = DESTRUCTIVE_FORGE_COMMANDS.has(e.id) ? " [needs Steve's yes]" : ''
  return `${head} — ${e.title}${key}${yes}`
}

/** The runnable commands, one line per group, in registry order. */
export function formatForgeCommandList(entries: readonly ForgeCommandEntry[]): string {
  const groups = new Map<string, string[]>()
  for (const e of entries) {
    if (!e.runnable) continue
    const list = groups.get(e.group) ?? []
    list.push(usage(e))
    groups.set(e.group, list)
  }
  if (groups.size === 0) return 'No Forge commands can run right now — Forge is still starting up.'
  const lines = [...groups].map(([group, items]) => `${group}: ${items.join(' · ')}`)
  return ['Forge commands — call forge_command with id (and arg where shown):', ...lines].join('\n')
}

/* ------------------------------------------------------------- the planner */

function find(entries: readonly ForgeCommandEntry[], said: string): ForgeCommandEntry | null {
  const bare = said.replace(/^ui\./i, '')
  const lower = bare.toLowerCase()
  return entries.find((e) => e.id === bare) ?? entries.find((e) => e.id.toLowerCase() === lower) ?? null
}

/** What one forge_command call should do. Pure. */
export function planForgeCommand(req: ForgeCommandRequest, entries: readonly ForgeCommandEntry[]): ForgeCommandPlan {
  const said = typeof req.id === 'string' ? req.id.trim() : ''
  if (!said) return { kind: 'list', text: formatForgeCommandList(entries) }
  const entry = find(entries, said)
  if (!entry) {
    return { kind: 'refuse', reason: 'unknown', text: `Unknown command "${said}". Call forge_command with no id for the list.` }
  }
  const arg = typeof req.arg === 'string' && req.arg.trim() ? req.arg.trim() : undefined
  if (entry.arg && !arg && !entry.argOptional) {
    return { kind: 'refuse', reason: 'needs-arg', text: `${entry.title} needs its ${entry.arg}: pass it as arg.` }
  }
  if (DESTRUCTIVE_FORGE_COMMANDS.has(entry.id) && req.confirmed !== true) {
    return {
      kind: 'refuse',
      reason: 'needs-yes',
      text: `${entry.title} needs Steve's yes. Ask him, then call again with confirmed true.`
    }
  }
  if (!entry.runnable) {
    return { kind: 'refuse', reason: 'unavailable', text: `${entry.title} is not available right now: nothing on screen answers it.` }
  }
  return { kind: 'run', entry, ...(entry.arg && arg ? { arg } : {}) }
}

/* ------------------------------------------------------------ live, in Forge */

function shown(combo: string | null): string | null {
  return combo ? formatCombo(combo) : null
}

/** Every command the two registries know right now, uiCommands first. */
export function collectForgeCommands(): ForgeCommandEntry[] {
  const out: ForgeCommandEntry[] = []
  const seen = new Set<string>()
  for (const spec of uiCommands.list()) {
    if (seen.has(spec.id)) continue
    seen.add(spec.id)
    out.push({
      id: spec.id,
      title: spec.title,
      group: spec.group,
      key: spec.arg ? null : shown(keyForCommand(`ui.${spec.id}`)),
      ...(spec.arg ? { arg: spec.arg } : {}),
      ...(spec.argOptional ? { argOptional: true } : {}),
      runnable: uiCommands.canRun(spec.id),
      source: 'ui'
    })
  }
  for (const c of getKeymapView().commands) {
    if (c.id.startsWith('ui.') || c.id.startsWith('prompt.') || c.kind === 'talk' || c.scope === 'bar' || NOT_BY_ID.has(c.id)) continue
    if (seen.has(c.id)) continue
    seen.add(c.id)
    out.push({ id: c.id, title: c.title, group: c.group, key: shown(c.keys[0] ?? null), runnable: c.available, source: 'keymap' })
  }
  return out
}

const SHAPE_WORDS: Record<WindowShape, string> = {
  minimised: 'Forge is now minimised.',
  maximised: 'Forge is now maximised.',
  normal: 'Forge is now on screen, not maximised.',
  hidden: 'Forge is now hidden (in the tray).'
}

/**
 * Run one forge_command call. `ok` false whenever nothing ran, and then the
 * text starts with FAILED, as every Forge tool's does. Never rejects.
 */
export async function runForgeCommand(req: ForgeCommandRequest): Promise<{ ok: boolean; text: string }> {
  try {
    const plan = planForgeCommand(req, collectForgeCommands())
    if (plan.kind === 'list') return { ok: true, text: plan.text }
    if (plan.kind === 'refuse') return { ok: false, text: `FAILED: ${plan.text}` }
    const { entry, arg } = plan
    if (entry.source === 'ui' && isWindowCommand(entry.id)) {
      if (!windowControlAvailable()) return { ok: false, text: `FAILED: ${RESTART_NOTE}` }
      if (!uiCommands.run(entry.id)) return { ok: false, text: `FAILED: ${entry.title} is not available right now.` }
      const shape = await lastWindowCommand()
      if (!shape) return { ok: false, text: `FAILED: ${RESTART_NOTE}` }
      return { ok: true, text: `Done: ${entry.title}. ${SHAPE_WORDS[shape]}` }
    }
    const ran = entry.source === 'ui' ? uiCommands.run(entry.id, arg) : runCommand(entry.id)
    if (!ran) return { ok: false, text: `FAILED: ${entry.title} did nothing right now.` }
    return { ok: true, text: `Done: ${entry.title}.` }
  } catch (err) {
    return { ok: false, text: `FAILED: ${err instanceof Error ? err.message : String(err)}` }
  }
}
