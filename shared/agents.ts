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
  }
]

export const DEFAULT_PROFILE_ID = 'claude'

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
 * Whether a profile's command is Claude Code — i.e. whether the permission-mode
 * flags mean anything to it. Matches `claude`, a full path to it, and the .cmd
 * shim npm drops on Windows.
 */
export function isClaudeCommand(command: string): boolean {
  return commandExe(command) === 'claude'
}

/** The flag each mode adds. `default` adds nothing at all. */
export const PERMISSION_FLAGS: Record<ClaudePermissionMode, string> = {
  default: '',
  acceptEdits: '--permission-mode acceptEdits',
  plan: '--permission-mode plan',
  bypass: '--dangerously-skip-permissions'
}

export const PERMISSION_MODES: Array<{
  id: ClaudePermissionMode
  label: string
  note: string
  danger?: boolean
}> = [
  { id: 'default', label: 'Default', note: 'Claude asks before it acts' },
  { id: 'acceptEdits', label: 'Accept edits', note: 'file edits go through, commands still ask' },
  { id: 'plan', label: 'Plan', note: 'read and think, change nothing' },
  { id: 'bypass', label: 'Bypass', note: 'never asks — it can do anything you can', danger: true }
]

export function isPermissionMode(value: unknown): value is ClaudePermissionMode {
  return value === 'default' || value === 'acceptEdits' || value === 'plan' || value === 'bypass'
}
