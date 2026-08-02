import type { AgentProfile, ClaudePermissionMode, ProfileKind } from './types'

/**
 * Built-in agent profiles. These are *seeded into* settings.json on first run
 * so Steve can edit them by hand (rename, recolour, change the command) or add
 * his own. `builtin: true` only means "cannot be deleted".
 */
export const BUILTIN_AGENT_PROFILES: AgentProfile[] = [
  {
    id: 'pwsh',
    name: 'PowerShell',
    command: '',
    accent: '#7FD1FF',
    badge: 'PS',
    builtin: true,
    kind: 'shell'
  },
  {
    id: 'claude',
    name: 'Claude Code',
    command: 'claude',
    accent: '#C6FF4A',
    badge: 'CC',
    builtin: true,
    kind: 'agent',
    permissionMode: 'default',
    // Claude gets the Gemini bridge: video summaries, image generation and
    // second opinions it cannot produce on its own.
    mcpBridge: true,
    // …and Remote Control, so a pane can be picked up on the phone. Only
    // Claude Code has the flag, so only Claude Code gets the default.
    remoteControl: true
  },
  {
    id: 'codex',
    name: 'Codex',
    // OpenAI's CLI. Bare `codex` on purpose: like Claude Code it reads the
    // permission mode off a flag Forge appends at launch (see
    // PERMISSION_FAMILIES), so baking one in here would only fight the chooser.
    command: 'codex',
    // Near-white, because OpenAI's own mark is monochrome and because nothing
    // else in the roster is: at badge size a hue is how you tell six agents
    // apart, and the neutral greys are spoken for by shells.
    accent: '#E8EAED',
    badge: 'CX',
    builtin: true,
    kind: 'agent',
    permissionMode: 'default'
    // No mcpBridge: Codex speaks MCP through its own config.toml (and the
    // `codex mcp` subcommand) rather than Claude Code's `--mcp-config` flag,
    // so handing it the flag would only make it refuse to start.
  },
  {
    id: 'kimi',
    name: 'Kimi',
    command: 'kimi',
    accent: '#C08BFF',
    badge: 'KI',
    builtin: true,
    kind: 'agent'
  },
  {
    id: 'gemini',
    name: 'Gemini',
    command: 'gemini',
    accent: '#7C9CFF',
    badge: 'GM',
    builtin: true,
    kind: 'agent'
  },
  {
    id: 'opencode',
    name: 'OpenCode',
    command: 'opencode',
    accent: '#5EE6A8',
    badge: 'OC',
    builtin: true,
    kind: 'agent'
    // No mcpBridge: OpenCode does speak MCP, but through its own config file
    // rather than Claude Code's `--mcp-config` flag, so handing it the flag
    // would only make it refuse to start.
  },
  {
    id: 'deepseek',
    name: 'DeepSeek V4',
    // DeepSeek ships no CLI of its own, so "DeepSeek as an agent" is OpenCode
    // pointed at it. Which of OpenCode's two routes to the same model matters:
    //
    // The `deepseek/` provider wants a DeepSeek API key. Without one the pane
    // opens and dies on the first message, and a built-in whose whole job is to
    // work when someone is handed a copy cannot ask for a key first.
    //
    // The `opencode/` provider is OpenCode Zen, which serves this model free and
    // answers with zero credentials configured. It costs a free tier's usual
    // fragility — rate limits, and no promise it stays free — but a rate limit
    // is a bad afternoon and a missing key is a dead profile.
    //
    // The third route — Claude Code with ANTHROPIC_BASE_URL aimed at
    // api.deepseek.com/anthropic — does work, but Anthropic's gateway docs say
    // plainly that routing Claude Code to non-Claude models is not supported.
    // An agent that breaks on somebody else's release day is not a built-in.
    command: 'opencode -m opencode/deepseek-v4-flash-free',
    accent: '#FFB347',
    badge: 'DS',
    builtin: true,
    kind: 'agent'
  }
]

export const DEFAULT_PROFILE_ID = 'claude'

/**
 * Commands a built-in used to ship with, keyed by profile id.
 *
 * settings.json remembers every profile, so a built-in whose default command was
 * wrong stays wrong on the machines that already ran it: `normaliseSettings`
 * re-seeds a built-in that was *deleted*, but a stored one is left alone —
 * correctly, since that is where a deliberate edit lives.
 *
 * The distinction this table draws is between an edit and a leftover. A stored
 * command that is character-for-character a default Forge itself once wrote was
 * never chosen by anybody, so replacing it with the current default takes
 * nothing away. Anything else — including a hand-edit that merely resembles one —
 * is the user's and is never touched.
 *
 * Only ever append. Removing a row strands the people still carrying that value,
 * which is the exact bug this exists to fix.
 */
export const SUPERSEDED_BUILTIN_COMMANDS: Record<string, string[]> = {
  // Shipped for one commit. `deepseek/` is DeepSeek's own API, which wants a key
  // nobody handed a copy of Forge has, so the pane opened and died on its first
  // message. The current default routes to the same model through OpenCode Zen,
  // which answers with no credentials configured.
  deepseek: ['opencode -m deepseek/deepseek-v4-flash']
}

/** The current default for a built-in whose stored command is a stale default. */
export function migrateBuiltinCommand(id: string, command: string, builtinCommand: string): string {
  return (SUPERSEDED_BUILTIN_COMMANDS[id] ?? []).includes(command.trim()) ? builtinCommand : command
}

/** Palette offered when creating a custom profile or a project. */
export const ACCENT_PALETTE = [
  '#C6FF4A',
  '#7FD1FF',
  '#C08BFF',
  '#FFB347',
  '#FF6E6E',
  '#5EE6A8',
  '#F2E56B',
  '#9AA3AF'
]

/**
 * Terminal-text tints handed out to new tabs, in the order they are handed out.
 *
 * Every tab in a project is born a different colour, because the mosaic's whole
 * job is telling four sessions apart at a glance and four identical greys do not
 * do that. Right-click a tab to change or clear it — this is only the starting
 * point, never a lock.
 *
 * Red is deliberately absent: in a terminal, red text already means something.
 */
export const TAB_TEXT_PALETTE = ['#C6FF4A', '#7FD1FF', '#C08BFF', '#FFB347', '#5EE6A8', '#F2E56B', '#FF9ED2']

/**
 * The names new tabs are given, in the order they are handed out.
 *
 * A number is a bad name for a session. "Tab 4" tells you nothing about what is
 * running in it, reads the same as every other tab in the strip, and — because
 * numbers get reused as tabs close — can end up on two tabs at once. A name is
 * something you can hold in your head and say out loud: "kill Marlow", "what
 * did Otis say", which is also exactly what voice control needs.
 *
 * Four walks of the alphabet, so consecutive tabs never start with the same
 * letter and are as easy to tell apart in the strip as they are to speak. All
 * short, all one word, all phonetically distinct — a title bar is narrow and
 * dictation has to survive them.
 */
export const TAB_NAME_POOL = [
  // A→Z
  'Ada', 'Bo', 'Cleo', 'Dara', 'Eli', 'Fern', 'Gus', 'Hana', 'Iris', 'Jude',
  'Kai', 'Lena', 'Mira', 'Nico', 'Otis', 'Pia', 'Quinn', 'Rex', 'Sana', 'Tobin',
  'Uma', 'Vera', 'Wren', 'Xan', 'Yara', 'Zane',
  // and again
  'Alma', 'Bram', 'Cass', 'Dez', 'Esme', 'Finn', 'Greta', 'Hugo', 'Ines', 'Juno',
  'Kira', 'Lars', 'Mae', 'Nell', 'Olen', 'Pax', 'Quill', 'Remy', 'Soren', 'Thea',
  'Ulla', 'Vance', 'Wyatt', 'Xander', 'Yusuf', 'Zora',
  // and again
  'Anders', 'Beau', 'Colm', 'Dot', 'Elsa', 'Faye', 'Gil', 'Hollis', 'Ivo', 'Jonah',
  'Kess', 'Lior', 'Mona', 'Noor', 'Orla', 'Perry', 'Rhys', 'Sable', 'Tam', 'Ursa',
  'Viggo', 'Wanda', 'Yates', 'Zeb',
  // and again
  'Arlo', 'Bess', 'Cyrus', 'Dane', 'Elia', 'Frida', 'Gwen', 'Hale', 'Isla', 'Jax',
  'Kofi', 'Luca', 'Marlow', 'Nadia', 'Omar', 'Petra', 'Rune', 'Silas', 'Tomas', 'Umi',
  'Vida', 'Wells', 'Yoko', 'Zola'
]

/** The neutral badge tint every shell profile wears, whatever its accent. */
export const SHELL_BADGE_COLOR = '#9AA3AF'

/** Derive a sensible two-letter badge from a profile name. */
export function deriveBadge(name: string): string {
  const words = name.trim().split(/[\s_-]+/).filter(Boolean)
  if (words.length === 0) return '??'
  if (words.length === 1) return words[0]!.slice(0, 2).toUpperCase()
  return (words[0]![0]! + words[1]![0]!).toUpperCase()
}

/* ------------------------------------------------------------------- kinds */

/**
 * What a profile is, for anything loaded before `kind` existed: no command is
 * a shell, a command is an agent. Not clever, and right for every profile
 * anyone has actually written.
 */
export function inferKind(profile: Pick<AgentProfile, 'command' | 'kind'>): ProfileKind {
  if (profile.kind === 'shell' || profile.kind === 'agent') return profile.kind
  return profile.command.trim() ? 'agent' : 'shell'
}

export function isShellProfile(profile: Pick<AgentProfile, 'command' | 'kind'>): boolean {
  return inferKind(profile) === 'shell'
}

/* ------------------------------------------------------- permission modes */

/** The first word of a command line, stripped of quotes and any path. */
export function commandExe(command: string): string {
  const first = command.trim().split(/\s+/)[0] ?? ''
  const bare = first.replace(/^["']|["']$/g, '')
  const leaf = bare.split(/[\\/]/).pop() ?? bare
  return leaf.replace(/\.(cmd|bat|exe|ps1)$/i, '').toLowerCase()
}

/**
 * Whether a profile's command is Claude Code specifically. Matches `claude`, a
 * full path to it, and the .cmd shim npm drops on Windows.
 *
 * This is the narrow test, and the callers that want it want it: the session-id
 * handshake, Remote Control and the `--mcp-config` bridge are Claude Code
 * features, not "agent" features. For "does this thing have permission modes?"
 * use `permissionFamily` — Codex has them too, and they are not these flags.
 */
export function isClaudeCommand(command: string): boolean {
  return permissionFamily(command) === 'claude'
}

/* ------------------------------------------------------------------ families */

/**
 * A CLI whose permission ladder Forge knows how to drive.
 *
 * Adding one is: a key here, a row in PERMISSION_FAMILIES, and nothing else —
 * every chooser, sheet and settings row reads the table rather than testing for
 * a particular agent.
 */
export type PermissionFamily = 'claude' | 'codex'

export interface PermissionModeSpec {
  id: ClaudePermissionMode
  /** What the row is called in the chooser. */
  label: string
  /** The one-line explanation under it. */
  note: string
  /** What the pane header is badged with. Empty for the mode that is silent. */
  chip: string
  /** The flag appended to the command. Empty means "add nothing". */
  flag: string
  danger?: boolean
}

/**
 * The ladder each family climbs, rung by rung.
 *
 * The rungs are Claude Code's names because Claude Code got here first, but
 * each family spells its own flags and — importantly — its own *words*. Codex's
 * middle rung is not "accept edits": `--full-auto` lets it run commands too, so
 * long as they stay inside the folder. Calling that "accept edits" would be
 * describing Claude's mode while launching Codex's.
 */
export const PERMISSION_FAMILIES: Record<PermissionFamily, PermissionModeSpec[]> = {
  claude: [
    { id: 'default', label: 'Default', note: 'Claude asks before it acts', chip: '', flag: '' },
    {
      id: 'acceptEdits',
      label: 'Accept edits',
      note: 'file edits go through, commands still ask',
      chip: 'EDITS',
      flag: '--permission-mode acceptEdits'
    },
    { id: 'plan', label: 'Plan', note: 'read and think, change nothing', chip: 'PLAN', flag: '--permission-mode plan' },
    {
      id: 'bypass',
      label: 'Bypass',
      note: 'never asks — it can do anything you can',
      chip: 'BYPASS',
      flag: '--dangerously-skip-permissions',
      danger: true
    }
  ],
  codex: [
    { id: 'default', label: 'Default', note: 'Codex asks before it acts', chip: '', flag: '' },
    {
      id: 'acceptEdits',
      label: 'Full auto',
      // --full-auto is workspace-write plus on-failure approval: it edits and
      // runs without asking, but the sandbox keeps it inside this folder, and
      // anything that needs out comes back to you.
      note: 'edits and runs inside this folder without asking',
      chip: 'AUTO',
      flag: '--full-auto'
    },
    {
      id: 'plan',
      label: 'Read-only',
      // Codex has no plan mode. A read-only sandbox is the honest equivalent:
      // it can look at everything and change nothing, and anything that would
      // write comes back as an approval request rather than happening.
      note: 'read and think, change nothing',
      chip: 'READ-ONLY',
      flag: '--sandbox read-only'
    },
    {
      id: 'bypass',
      label: 'Bypass',
      note: 'no approvals, no sandbox — it can do anything you can',
      chip: 'BYPASS',
      flag: '--dangerously-bypass-approvals-and-sandbox',
      danger: true
    }
  ]
}

/**
 * Which ladder this command climbs, or null for something Forge has no flags
 * for. A bare PowerShell, `gemini`, a batch file: null, and every permission
 * control disappears rather than offering a choice that does nothing.
 */
export function permissionFamily(command: string): PermissionFamily | null {
  const exe = commandExe(command)
  if (exe === 'claude') return 'claude'
  if (exe === 'codex') return 'codex'
  return null
}

/** The modes offered for a command — empty for anything with no ladder. */
export function permissionModes(command: string): PermissionModeSpec[] {
  const family = permissionFamily(command)
  return family ? PERMISSION_FAMILIES[family] : []
}

/** One rung, by id. Null when the command has no ladder or the id is junk. */
export function permissionSpec(command: string, mode: ClaudePermissionMode): PermissionModeSpec | null {
  return permissionModes(command).find((m) => m.id === mode) ?? null
}

/**
 * Flags a command already carries by hand, which Forge must not duplicate or
 * contradict. Written per family because they share no spelling at all — and
 * Codex's are short options too, so `-s read-only` has to count.
 */
const EXPLICIT_FLAGS: Record<PermissionFamily, RegExp> = {
  claude: /--permission-mode\b|--dangerously-skip-permissions\b/,
  codex:
    /--full-auto\b|--yolo\b|--dangerously-bypass-approvals-and-sandbox\b|--sandbox\b|--ask-for-approval\b|(?:^|\s)-[as](?:\s|=|$)/
}

/** True when the command line already says what mode it wants. */
export function hasExplicitPermissionFlag(command: string): boolean {
  const family = permissionFamily(command)
  return family ? EXPLICIT_FLAGS[family].test(command) : false
}

export function isPermissionMode(value: unknown): value is ClaudePermissionMode {
  return value === 'default' || value === 'acceptEdits' || value === 'plan' || value === 'bypass'
}
