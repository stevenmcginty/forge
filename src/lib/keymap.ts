/**
 * The keymap registry's rules — pure, no DOM, no React, so
 * scripts/canvas-check.mjs can hold them to account.
 *
 * A *command* is something Forge can do (id, title, group, default keys). A
 * *binding* is a key combo pointing at one command. Steve's own choices are
 * *overrides*: per command, the keys that replace its defaults ([] = unbound),
 * saved in keymap.json by the main process.
 *
 * Two promises this file keeps:
 *
 *  - Terminal typing is safe. A combo a CLI needs — a bare letter, Ctrl+C/D/Z/
 *    L/R/V, an arrow, Esc, Alt+letter (readline's word moves) — can never be
 *    bound, not by a default and not by an override. See `reservedReason`.
 *  - Nothing is silently shadowed. Two commands on one combo is a *conflict*:
 *    `resolveKeymap` reports it, and `setBinding` refuses to create one unless
 *    told to take the key over, in which case the other command loses it
 *    explicitly (and that is saved too).
 */

/** "Ctrl+Shift+G" — modifiers in this order, then one key name (see `keyName`). */
export type KeyCombo = string

/**
 * Where a command may fire.
 *
 * `global`: anywhere, including inside a text field — only for combos that are
 *   nobody's editing key (Ctrl+Shift+G, Ctrl+,).
 * `workspace`: only while the terminal workspace is on screen, and not while a
 *   text field has focus (xterm's own textarea excepted — see useShortcuts).
 * `bar`: only inside the Forge bar's text box. The bar reads these itself
 *   (Composer); useShortcuts never fires them.
 */
export type CommandScope = 'global' | 'workspace' | 'bar'

export interface KeyCommandDef {
  id: string
  title: string
  group: string
  defaultKeys: KeyCombo[]
  scope: CommandScope
  /** Shown on the settings page and the cheat sheet. */
  description?: string
  /**
   * 'talk': a voice key (Dictate, Agent). Its keys are ONE key on its own — a
   * lone modifier such as Right Shift, or F1–F24 / Scroll Lock / Pause — stored
   * as the KeyboardEvent.code ('ShiftRight'). useDictation's gesture engine
   * fires it (tap toggles, hold talks); useShortcuts never does.
   */
  kind?: 'talk'
}

export interface KeymapConflict {
  combo: KeyCombo
  /** Every command that wants this combo, in registration order. The first one keeps it. */
  commandIds: string[]
}

export interface KeymapRejection {
  commandId: string
  combo: KeyCombo
  reason: string
}

export interface ResolvedKeymap {
  /** combo → the one command it fires. */
  bindings: Map<KeyCombo, string>
  /** command → its effective keys (after overrides, minus rejections). */
  keysFor: Record<string, KeyCombo[]>
  conflicts: KeymapConflict[]
  /** Keys refused because they are reserved or unreadable. */
  rejected: KeymapRejection[]
}

const MODIFIERS = ['Ctrl', 'Alt', 'Shift', 'Meta'] as const

const CODE_NAMES: Record<string, string> = {
  Comma: ',',
  Period: '.',
  Slash: '/',
  Backslash: '\\',
  BracketLeft: '[',
  BracketRight: ']',
  Semicolon: ';',
  Quote: "'",
  Backquote: '`',
  Minus: '-',
  Equal: '=',
  ArrowLeft: 'Left',
  ArrowRight: 'Right',
  ArrowUp: 'Up',
  ArrowDown: 'Down',
  Escape: 'Esc',
  Space: 'Space',
  Enter: 'Enter',
  Tab: 'Tab',
  Backspace: 'Backspace',
  Delete: 'Delete',
  Insert: 'Insert',
  Home: 'Home',
  End: 'End',
  PageUp: 'PageUp',
  PageDown: 'PageDown',
  NumpadAdd: 'NumpadAdd',
  NumpadSubtract: 'NumpadSubtract',
  NumpadEnter: 'NumpadEnter'
}

/** A KeyboardEvent.code as a combo's key name. Physical keys, so a layout change does not move a shortcut. */
export function keyName(code: string): string | null {
  if (!code) return null
  if (/^Key[A-Z]$/.test(code)) return code.slice(3)
  if (/^Digit[0-9]$/.test(code)) return code.slice(5)
  if (/^Numpad[0-9]$/.test(code)) return code
  if (/^F([1-9]|1[0-9]|2[0-4])$/.test(code)) return code
  if (CODE_NAMES[code]) return CODE_NAMES[code]!
  // Modifier keys on their own are not a combo.
  if (/^(Control|Shift|Alt|Meta|OS)(Left|Right)?$/.test(code)) return null
  return null
}

export interface KeyEventLike {
  code: string
  ctrlKey: boolean
  altKey: boolean
  shiftKey: boolean
  metaKey: boolean
}

/* ------------------------------------------------------------ talk keys
 *
 * The two voice keys are gestures on one physical key, not combos: Right Ctrl
 * pressed and let go on its own. A lone modifier is therefore a legal key for
 * them — and only for them. Anywhere else it would fire on every capital
 * letter, so an ordinary command still refuses it (see `lonerReason`).
 */

const LONE_MODIFIER = /^(Control|Shift|Alt|Meta)(Left|Right)$/
const TALK_LABELS: Record<string, string> = {
  ControlRight: 'Right Ctrl',
  ControlLeft: 'Left Ctrl',
  ShiftRight: 'Right Shift',
  ShiftLeft: 'Left Shift',
  AltRight: 'Right Alt',
  AltLeft: 'Left Alt',
  MetaRight: 'Right Win',
  MetaLeft: 'Left Win',
  ScrollLock: 'Scroll Lock',
  Pause: 'Pause'
}

/** 'ShiftRight' and friends: a modifier key on its own. Left and right are different keys. */
export function isLoneModifier(code: string): boolean {
  return LONE_MODIFIER.test(code)
}

/** A KeyboardEvent.code that can be a talk key, as itself; null otherwise. */
export function talkKeyFromCode(code: string): KeyCombo | null {
  if (!code) return null
  if (TALK_LABELS[code]) return code
  if (/^F([1-9]|1[0-9]|2[0-4])$/.test(code)) return code
  return null
}

/** Canonical talk key from a stored value — the code ('ShiftRight') or its label ('Right Shift'). */
export function normaliseTalkKey(input: string): KeyCombo | null {
  const raw = String(input ?? '').trim()
  if (!raw) return null
  const byCode = talkKeyFromCode(raw) ?? talkKeyFromCode(raw.toUpperCase())
  if (byCode) return byCode
  const lower = raw.toLowerCase().replace(/\s+/g, ' ')
  const hit = Object.entries(TALK_LABELS).find(([, label]) => label.toLowerCase() === lower)
  return hit ? hit[0] : null
}

export const TALK_KEY_RULE = 'A voice key is one key on its own: a Ctrl, Shift, Alt or Win key (left and right are different), F1–F24, Scroll Lock or Pause.'

/** Why this can never be a talk key, or null when it can. */
export function talkKeyReason(combo: KeyCombo): string | null {
  return talkKeyFromCode(combo) ? null : TALK_KEY_RULE
}

/** The refusal an ordinary command gives a lone modifier, or null when `raw` is not one. */
export function lonerReason(raw: string): string | null {
  const code = normaliseTalkKey(raw)
  if (!code || !isLoneModifier(code)) return null
  return `${TALK_LABELS[code]} on its own only works for the Dictate and Agent voice keys; a shortcut needs Ctrl, Alt or Win with another key.`
}

export function comboFromEvent(e: KeyEventLike): KeyCombo | null {
  const key = keyName(e.code)
  if (!key) return null
  const mods: string[] = []
  if (e.ctrlKey) mods.push('Ctrl')
  if (e.altKey) mods.push('Alt')
  if (e.shiftKey) mods.push('Shift')
  if (e.metaKey) mods.push('Meta')
  return [...mods, key].join('+')
}

const KNOWN_KEYS = new Set<string>([
  ...'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'.split(''),
  ...Array.from({ length: 10 }, (_, i) => `Numpad${i}`),
  ...Array.from({ length: 24 }, (_, i) => `F${i + 1}`),
  ...Object.values(CODE_NAMES)
])

/** Canonical form ("shift+ctrl+g" → "Ctrl+Shift+G"), or null if it is not a combo. */
export function normaliseCombo(input: string): KeyCombo | null {
  const raw = String(input ?? '').trim()
  if (!raw) return null
  // "Ctrl++" style: a trailing plus is the = key's shifted face; spell it NumpadAdd or = instead.
  const parts = raw.split('+').map((p) => p.trim()).filter(Boolean)
  if (parts.length === 0) return null
  const mods = new Set<string>()
  let key: string | null = null
  for (const part of parts) {
    const lower = part.toLowerCase()
    const mod =
      lower === 'ctrl' || lower === 'control' ? 'Ctrl'
      : lower === 'alt' || lower === 'option' ? 'Alt'
      : lower === 'shift' ? 'Shift'
      : lower === 'meta' || lower === 'win' || lower === 'cmd' || lower === 'super' ? 'Meta'
      : null
    if (mod) {
      mods.add(mod)
      continue
    }
    if (key !== null) return null // two non-modifier keys
    const upper = part.length === 1 ? part.toUpperCase() : part
    const named =
      KNOWN_KEYS.has(upper) ? upper
      : /^f\d{1,2}$/i.test(part) ? part.toUpperCase()
      : lower === 'escape' ? 'Esc'
      : lower === 'arrowleft' ? 'Left'
      : lower === 'arrowright' ? 'Right'
      : lower === 'arrowup' ? 'Up'
      : lower === 'arrowdown' ? 'Down'
      : [...KNOWN_KEYS].find((k) => k.toLowerCase() === lower) ?? null
    if (!named || !KNOWN_KEYS.has(named)) return null
    key = named
  }
  if (!key) return null
  return [...MODIFIERS.filter((m) => mods.has(m)), key].join('+')
}

const TERMINAL_CTRL_KEYS = new Set(['C', 'D', 'Z', 'L', 'R', 'V'])
const ARROWS = new Set(['Left', 'Right', 'Up', 'Down'])

/**
 * Why a combo can never be a Forge shortcut, or null when it can.
 *
 * Everything here is a key some CLI in a pane depends on. Forge's shortcuts run
 * in the capture phase, ahead of xterm, so a bad binding would not merely
 * clash — it would silently eat the key before the agent ever saw it.
 */
export function reservedReason(combo: KeyCombo): string | null {
  const parts = combo.split('+')
  const key = parts[parts.length - 1]!
  const mods = new Set(parts.slice(0, -1))
  const ctrl = mods.has('Ctrl')
  const alt = mods.has('Alt')
  const shift = mods.has('Shift')
  const meta = mods.has('Meta')

  if (key === 'Esc') return 'Esc belongs to the terminal (it interrupts agents).'
  if (!ctrl && !alt && !meta && !/^F\d+$/.test(key)) {
    return 'A key without Ctrl, Alt or Win would be stolen from whatever you are typing.'
  }
  if (ctrl && !alt && !shift && !meta && TERMINAL_CTRL_KEYS.has(key)) {
    return `Ctrl+${key} belongs to the terminal (${key === 'C' ? 'interrupt' : key === 'D' ? 'end of input' : key === 'Z' ? 'suspend/undo' : key === 'L' ? 'clear screen' : key === 'R' ? 'history search' : 'paste'}).`
  }
  if (ARROWS.has(key) && !alt && !(ctrl && shift)) {
    return 'Arrows (and Ctrl/Shift+arrows) move the cursor in the terminal.'
  }
  if (alt && !ctrl && !meta && /^[A-Z]$/.test(key)) {
    return `Alt+${key} is a word-editing key in shells (readline, PSReadLine).`
  }
  if (ctrl && alt && !meta) {
    return 'Ctrl+Alt is AltGr on many keyboards — it types characters like € and @.'
  }
  return null
}

/**
 * The effective keymap: defaults, then overrides, minus anything reserved.
 * Registration order decides who keeps a conflicted combo — built-ins are
 * registered first — and every conflict is reported, never hidden.
 */
export function resolveKeymap(
  commands: readonly KeyCommandDef[],
  overrides: Record<string, KeyCombo[]> = {}
): ResolvedKeymap {
  const bindings = new Map<KeyCombo, string>()
  const wanted = new Map<KeyCombo, string[]>()
  const keysFor: Record<string, KeyCombo[]> = {}
  const rejected: KeymapRejection[] = []

  for (const cmd of commands) {
    const source = Object.prototype.hasOwnProperty.call(overrides, cmd.id) ? overrides[cmd.id]! : cmd.defaultKeys
    const keys: KeyCombo[] = []
    for (const raw of source) {
      const combo = cmd.kind === 'talk' ? normaliseTalkKey(raw) : normaliseCombo(raw)
      if (!combo) {
        rejected.push({ commandId: cmd.id, combo: raw, reason: cmd.kind === 'talk' ? TALK_KEY_RULE : (lonerReason(raw) ?? 'Not a key combination Forge can read.') })
        continue
      }
      const reason = cmd.kind === 'talk' ? talkKeyReason(combo) : reservedReason(combo)
      if (reason) {
        rejected.push({ commandId: cmd.id, combo, reason })
        continue
      }
      if (keys.includes(combo)) continue
      keys.push(combo)
      const list = wanted.get(combo) ?? []
      list.push(cmd.id)
      wanted.set(combo, list)
    }
    keysFor[cmd.id] = keys
  }

  const conflicts: KeymapConflict[] = []
  for (const [combo, ids] of wanted) {
    bindings.set(combo, ids[0]!)
    if (ids.length > 1) {
      conflicts.push({ combo, commandIds: ids })
      // The losers do not have the key — say so in their own key list too.
      for (const id of ids.slice(1)) keysFor[id] = (keysFor[id] ?? []).filter((k) => k !== combo)
    }
  }
  return { bindings, keysFor, conflicts, rejected }
}

export type SetBindingResult =
  | { ok: true; overrides: Record<string, KeyCombo[]> }
  | { ok: false; error: string; conflictsWith?: string[] }

/**
 * Give a command a new set of keys.
 *
 * Refuses a reserved or unreadable combo, and refuses a combo another command
 * already fires — unless `takeOver`, which moves the key: the other command's
 * keys are rewritten without it, as an override of its own, so the settings
 * page can show exactly what changed.
 */
export function setBinding(
  commands: readonly KeyCommandDef[],
  overrides: Record<string, KeyCombo[]>,
  commandId: string,
  keys: readonly string[],
  opts: { takeOver?: boolean } = {}
): SetBindingResult {
  const cmd = commands.find((c) => c.id === commandId)
  if (!cmd) return { ok: false, error: `There is no command called ${commandId}.` }
  const talk = cmd.kind === 'talk'
  const combos: KeyCombo[] = []
  for (const raw of keys) {
    const combo = talk ? normaliseTalkKey(raw) : normaliseCombo(raw)
    if (!combo) return { ok: false, error: talk ? TALK_KEY_RULE : (lonerReason(raw) ?? `"${raw}" is not a key combination Forge can read.`) }
    const reason = talk ? talkKeyReason(combo) : reservedReason(combo)
    if (reason) return { ok: false, error: reason }
    if (!combos.includes(combo)) combos.push(combo)
  }
  const current = resolveKeymap(commands, overrides)
  const clashes = new Set<string>()
  for (const combo of combos) {
    const owner = current.bindings.get(combo)
    if (owner && owner !== commandId) clashes.add(owner)
  }
  if (clashes.size > 0 && !opts.takeOver) {
    const titles = [...clashes].map((id) => commands.find((c) => c.id === id)?.title ?? id)
    return { ok: false, error: `Already used by ${titles.join(', ')}.`, conflictsWith: [...clashes] }
  }
  const next: Record<string, KeyCombo[]> = { ...overrides, [commandId]: combos }
  for (const id of clashes) next[id] = (current.keysFor[id] ?? []).filter((k) => !combos.includes(k))
  return { ok: true, overrides: next }
}

/** Back to the defaults — one command, or every command when `commandId` is omitted. */
export function resetBinding(overrides: Record<string, KeyCombo[]>, commandId?: string): Record<string, KeyCombo[]> {
  if (commandId === undefined) return {}
  const next = { ...overrides }
  delete next[commandId]
  return next
}

/** "Ctrl+Shift+G" for display, and a talk key by name ('ShiftRight' → "Right Shift"). */
export function formatCombo(combo: KeyCombo): string {
  return TALK_LABELS[combo] ?? combo
}
