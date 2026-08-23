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
    id: 'grok',
    name: 'Grok',
    // xAI's own terminal agent, Grok Build — `grok` is the binary — added the
    // day grok-4.6 shipped (2026-08-12), which is the CLI's default model.
    // Like Qwen and Antigravity it carries its own sign-in: first launch opens
    // a browser to authenticate with a grok.com account (SuperGrok or
    // X Premium+), with XAI_API_KEY as the headless fallback. So there is no
    // key field in Forge for it, and the ENV_DENYLIST rule cannot break it.
    //
    // Bare `grok` on purpose: like Claude Code and Codex it reads its
    // permission mode off a flag Forge appends at launch (see the grok row in
    // PERMISSION_FAMILIES, verified against `grok --help` 1.0.3), so baking
    // one in here would only fight the chooser.
    command: 'grok',
    permissionMode: 'default',
    // Yellow, because it is the hue left: blues, greens, purples, orange,
    // magenta and Codex's near-white are all spoken for above and below.
    accent: '#F2E56B',
    // GK on the Codex CX pattern — 'GR' next to Gemini's 'GM' is two grey-area
    // G-badges a glance can confuse.
    badge: 'GK',
    builtin: true,
    kind: 'agent'
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
    id: 'antigravity',
    name: 'Antigravity',
    // Google retired personal Gemini Code Assist sign-in in Gemini CLI.
    // Antigravity CLI (`agy`) is the supported individual-account terminal
    // agent and opens the browser sign-in flow on first launch.
    command: 'agy',
    accent: '#8AB4F8',
    badge: 'AG',
    builtin: true,
    kind: 'agent',
    permissionMode: 'default'
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
  },
  {
    id: 'glm',
    name: 'GLM 5.3',
    // Official Z.ai path: Claude Code aimed at the GLM Coding Plan gateway
    // (docs.z.ai/devpack/tool/claude). Its own selector, not a hijack of the
    // Claude Code row — that one stays on claude.ai OAuth.
    //
    // `--model 'glm-5.3[1m]'` is the whole of how this command is told apart
    // from a bare `claude`. Permission modes, the MCP bridge and resume-on-restore
    // all still apply because the executable is Claude Code. Remote Control
    // does not: Anthropic disables it when ANTHROPIC_BASE_URL is not
    // api.anthropic.com, and wantsRemoteControl skips this command so the
    // Claude profile's remoteControl: true cannot leak onto it via the exe
    // fallback.
    //
    // The gateway env (token, base URL, 1M model aliases) is injected by
    // electron/pty-host.ts after ENV_DENYLIST, and only for this command.
    // ~/.claude/settings.json is never written — that is what would steal
    // every other Claude pane. The key lives in Settings as `zaiKey`; Steve
    // pastes it once after signing up at z.ai/subscribe.
    //
    // `[1m]` is the 1M context window. Quoted because the bootstrap is typed
    // into pwsh, and unquoted `[1m]` is a wildcard. The same alias is also set
    // via ANTHROPIC_DEFAULT_*_MODEL so `/model sonnet` and `/model opus`
    // inside a session stay on 1M. `--model glm-5.3` (no suffix) is 200k and
    // beats those defaults, which is why the suffix has to live on the flag.
    command: "claude --model 'glm-5.3[1m]'",
    // Teal, because the mint is OpenCode's and the cyan is PowerShell's, and
    // at badge size those two already sit next to each other.
    accent: '#2EC4B6',
    badge: 'GL',
    builtin: true,
    kind: 'agent',
    permissionMode: 'default',
    mcpBridge: true
  },
  {
    id: 'qwen',
    name: 'Qwen',
    // Alibaba's own terminal agent, so unlike DeepSeek above this is not a
    // wrapper around somebody else's CLI: `qwen` *is* the thing, and it carries
    // its own sign-in (`/auth` on first run, or `qwen` opens straight into the
    // provider picker) rather than reading a key out of the environment. Which
    // matters here more than it looks: Forge strips inherited `ANTHROPIC_*` from
    // every pane (ENV_DENYLIST in electron/pty/session-manager.ts), so an agent
    // that authenticates itself is one that cannot be broken by that rule.
    //
    // Bare, and deliberately not `qwen -m qwen3.8-max-preview`. Qwen3.8-Max is
    // the model this profile exists for, but it is served only to Alibaba's
    // Token Plan tier — verified in the CLI's own provider table, where
    // `qwen3.8-max-preview` appears in TOKEN_PLAN_MODELS and in no other preset
    // (Coding Plan stops at qwen3.7-plus). Pinning a model the account cannot
    // reach is exactly the dead-profile bug the DeepSeek note above is about, so
    // the model stays a `-m` flag or a `/model` away for the machines that have
    // the subscription, and the pane opens for the machines that do not.
    command: 'qwen',
    // Magenta, because it is the hue left: the six accents above have the
    // blues, greens, purples and oranges, and at badge size a free colour is
    // the whole of how a pane is told apart at a glance.
    accent: '#FF7AC8',
    badge: 'QW',
    builtin: true,
    kind: 'agent'
    // No mcpBridge, for the Codex and OpenCode reason: qwen speaks MCP through
    // `qwen mcp` and its own settings file, not Claude Code's --mcp-config, so
    // handing it the flag would only make it refuse to start.
  },
  {
    id: 'gemini',
    name: 'Gemini',
    // Last on purpose: since June 2026 the `gemini` CLI serves API-key users
    // only — personal Google-account sign-in moved to Antigravity above. The
    // profile stays because a pane with a paid key still works (the PTY host
    // hands GEMINI_API_KEY to gemini panes), but Antigravity is the one to
    // reach for, so it gets the shelf position and this one gets the bottom.
    command: 'gemini',
    accent: '#7C9CFF',
    badge: 'GM',
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
  deepseek: ['opencode -m deepseek/deepseek-v4-flash'],
  // Shipped for one session as an OpenCode wrapper. The official Z.ai path is
  // Claude Code on the Coding Plan gateway, with its own selector — that is
  // what the current default is.
  glm: [
    'opencode -m zai-coding-plan/glm-5.3',
    // Shipped as 200k. `--model glm-5.3` beats the 1M env aliases, so every
    // pane opened on the short window. The current default quotes `[1m]`.
    'claude --model glm-5.3'
  ]
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

/**
 * Claude Code launched as the GLM 5.3 selector — `claude --model glm-5.3`
 * or `claude --model 'glm-5.3[1m]'`, plus any flags Forge appends
 * (permission mode, session, MCP).
 *
 * The regular Claude profile is a bare `claude`. This is how the two stay
 * apart when they share an executable: Remote Control, env injection and the
 * missing-key notice all key off this rather than the profile id, because the
 * PTY host only ever sees the command string.
 */
export function isGlmClaudeCommand(command: string): boolean {
  return commandExe(command) === 'claude' && /\bglm-5\.3\b/.test(command)
}

/** Official Z.ai Anthropic-compatible Coding Plan gateway. */
export const ZAI_ANTHROPIC_BASE_URL = 'https://api.z.ai/api/anthropic'

/* ------------------------------------------------------------------ families */

/**
 * A CLI whose permission ladder Forge knows how to drive.
 *
 * Adding one is: a key here, a row in PERMISSION_FAMILIES, and nothing else —
 * every chooser, sheet and settings row reads the table rather than testing for
 * a particular agent.
 */
export type PermissionFamily = 'claude' | 'codex' | 'agy' | 'grok'

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
  ],
  // Verified against `agy --help` (Antigravity CLI v1.0.0, Aug 2026): its mode
  // flag is `--mode` with kebab-case values (accept-edits, plan), not Claude's
  // `--permission-mode`. Full autonomy is Antigravity's own "Turbo" — same
  // shared rung id as Claude/Codex's bypass, relabelled in its own vocabulary.
  agy: [
    { id: 'default', label: 'Default', note: 'Antigravity asks before it acts', chip: '', flag: '' },
    {
      id: 'acceptEdits',
      label: 'Accept edits',
      note: 'file edits go through, commands still ask',
      chip: 'EDITS',
      flag: '--mode accept-edits'
    },
    { id: 'plan', label: 'Plan', note: 'read and think, change nothing', chip: 'PLAN', flag: '--mode plan' },
    {
      id: 'bypass',
      label: 'Turbo',
      note: 'auto-approves everything — it can do anything you can',
      chip: 'TURBO',
      flag: '--dangerously-skip-permissions',
      danger: true
    }
  ],
  // Verified against `grok --help` (Grok Build 1.0.3, installed 2026-08-13):
  // its `--permission-mode` flag takes Claude's own rung names verbatim —
  // `[possible values: default, acceptEdits, auto, dontAsk, bypassPermissions,
  // plan]` — so unlike agy there is no respelling to do. `auto` and `dontAsk`
  // are extra rungs Forge's ladder does not model; the four it does model all
  // exist under their Claude names, so those are the four offered.
  grok: [
    { id: 'default', label: 'Default', note: 'Grok asks before it acts', chip: '', flag: '' },
    {
      id: 'acceptEdits',
      label: 'Accept edits',
      note: 'file edits go through, commands still ask',
      chip: 'EDITS',
      flag: '--permission-mode acceptEdits'
    },
    {
      id: 'plan',
      label: 'Plan',
      note: 'read and think, change nothing',
      chip: 'PLAN',
      flag: '--permission-mode plan'
    },
    {
      id: 'bypass',
      label: 'Bypass',
      // `--always-approve` exists as a shorthand for the same thing; the long
      // spelling is used so every family's bypass reads the same way in a
      // pane's command line.
      note: 'never asks — it can do anything you can',
      chip: 'BYPASS',
      flag: '--permission-mode bypassPermissions',
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
  if (exe === 'agy' || exe === 'antigravity') return 'agy'
  if (exe === 'grok') return 'grok'
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
    /--full-auto\b|--yolo\b|--dangerously-bypass-approvals-and-sandbox\b|--sandbox\b|--ask-for-approval\b|(?:^|\s)-[as](?:\s|=|$)/,
  // \b after "mode" (not a wildcard match) so this doesn't fire on agy's
  // separate --model flag.
  agy: /--mode\b|--dangerously-skip-permissions\b/,
  // `--sandbox` counts for the Codex reason: it is a permission decision made
  // by hand, and appending a mode flag on top would fight it. `--allow` /
  // `--deny` rules deliberately do not count — they refine a mode rather than
  // choose one.
  grok: /--permission-mode\b|--always-approve\b|--sandbox\b/
}

/** True when the command line already says what mode it wants. */
export function hasExplicitPermissionFlag(command: string): boolean {
  const family = permissionFamily(command)
  return family ? EXPLICIT_FLAGS[family].test(command) : false
}

export function isPermissionMode(value: unknown): value is ClaudePermissionMode {
  return value === 'default' || value === 'acceptEdits' || value === 'plan' || value === 'bypass'
}

/* ------------------------------------------------------------------- effort */

/**
 * How hard the model works, on the ladder the effort-capable CLIs share.
 *
 * The rungs are Claude Code's names (`/effort low|medium|high|xhigh|max`), and
 * every driver below spells its own dialect over the same five. A shell has no
 * dial at all and never reaches this code.
 */
export type EffortLevel = 'low' | 'medium' | 'high' | 'xhigh' | 'max'

export interface EffortLevelSpec {
  id: EffortLevel
  label: string
  /** One line under the label in the picker — what choosing it costs or buys. */
  note: string
}

export const EFFORT_LEVELS: EffortLevelSpec[] = [
  { id: 'low', label: 'Low', note: 'fast and cheap — routine edits, known steps' },
  { id: 'medium', label: 'Medium', note: 'trades some thoroughness for cost' },
  { id: 'high', label: 'High', note: 'the balanced default for most coding work' },
  { id: 'xhigh', label: 'Xhigh', note: 'deeper reasoning at a higher token spend' },
  { id: 'max', label: 'Max', note: 'the deepest — session-only in Claude Code' }
]

/** The picker row for a level, or null for junk. */
export function effortLevelSpec(level: string): EffortLevelSpec | null {
  return EFFORT_LEVELS.find((l) => l.id === level) ?? null
}

/**
 * The rungs *this* pane's effort picker should list. Empty when the CLI has
 * no dial Forge can reach — the picker itself then stays off the composer
 * rather than offering Claude's words for a tool that does not speak them.
 *
 *  - **Claude Code** (every `claude`-exe profile, including GLM): the five
 *    names `/effort` takes, verified against code.claude.com/docs/en/commands
 *    (2026-08-23).
 *  - **Grok Build**: the same ladder minus `max`, which Grok treats as an
 *    alias of `xhigh` rather than a fifth rung (grok `--help` / `/effort`,
 *    2026-08-23).
 *  - **Codex, OpenCode, Kimi, Qwen, Gemini, a shell**: empty.
 */
export function effortLevels(command: string): EffortLevelSpec[] {
  const exe = commandExe(command)
  if (exe === 'claude') return EFFORT_LEVELS
  if (exe === 'grok') return EFFORT_LEVELS.filter((l) => l.id !== 'max')
  return []
}

/**
 * What typing "set the effort to X" looks like in *this* pane's own TUI.
 *
 * A function per pane command rather than one global string, because the CLIs
 * disagree about where the dial lives:
 *
 *  - **Claude Code** (the `claude` profile and the GLM selector built on it)
 *    takes a literal `/effort <level>` in the composer — verified against
 *    code.claude.com/docs/en/commands (2026-08-23). This covers every
 *    claude-exe profile by construction, which is most of the roster.
 *  - **Grok Build** takes the same `/effort <level>` spelling (verified
 *    against grok `--help` 2026-08-23).
 *  - **Codex** keeps reasoning effort behind its interactive `/model` picker
 *    (developers.openai.com/codex/cli, 2026-08-23): there is no slash command
 *    a helper can type blind, so this answers null and the caller says so
 *    rather than firing keystrokes into a menu it cannot see.
 *  - **OpenCode, Kimi, Qwen, Gemini** have no effort concept at all — null,
 *    and honestly so.
 *
 * Null is not an error state; it is the control's reason to explain itself.
 * Adding a dialect is one more branch down here and nothing else anywhere.
 */
export function effortSlash(command: string): ((level: EffortLevel) => string) | null {
  const exe = commandExe(command)
  if (exe !== 'claude' && exe !== 'grok') return null
  return (level) => `/effort ${level}`
}

/** Why the effort picker cannot drive this pane, when effortSlash is null. */
export function effortRefusal(command: string): string {
  const exe = commandExe(command)
  if (exe === 'codex') return 'Codex sets effort through its /model picker — type /model in the pane.'
  return `${exe || 'This CLI'} has no effort dial Forge can reach.`
}

/* -------------------------------------------------------------------- model */

/**
 * One row of the model picker: the name the composer shows, and the id `/model`
 * actually types. Same shape as an effort rung so the two dropdowns paint alike.
 */
export interface AgentModelSpec {
  id: string
  label: string
  note: string
}

/**
 * The models *this* pane's picker should list. Empty when Forge has no `/model`
 * dialect for the CLI — the chip then stays off, rather than offering Claude's
 * aliases to a tool that does not speak them.
 *
 *  - **Grok Build**: the version names the TUI and `grok models` use
 *    (`grok-4.7` … `grok-2`). Labels are the product names ("Grok 4.6"),
 *    because that is how the picker is supposed to read, not the id.
 *  - **Claude Code** (every `claude`-exe profile, including GLM): the `/model`
 *    aliases from code.claude.com/docs/en/model-config (2026-08-23) — Fable,
 *    Opus, Sonnet, Haiku. Version numbers move under those names.
 *  - **Codex, OpenCode, Kimi, Qwen, Gemini, a shell**: empty. Codex keeps the
 *    choice behind its own `/model` menu, same as effort.
 */
export function agentModels(command: string): AgentModelSpec[] {
  const exe = commandExe(command)
  if (exe === 'grok') {
    return [
      { id: 'grok-4.7', label: 'Grok 4.7', note: 'the newest' },
      { id: 'grok-4.6', label: 'Grok 4.6', note: 'Grok Build’s current default' },
      { id: 'grok-4.5', label: 'Grok 4.5', note: 'the previous flagship' },
      { id: 'grok-3', label: 'Grok 3', note: 'the older generation' },
      { id: 'grok-2', label: 'Grok 2', note: 'the oldest this picker still names' }
    ]
  }
  if (exe === 'claude') {
    return [
      { id: 'fable', label: 'Fable', note: 'the hardest, longest-running tasks' },
      { id: 'opus', label: 'Opus', note: 'complex reasoning — the usual default' },
      { id: 'sonnet', label: 'Sonnet', note: 'daily coding, faster and cheaper' },
      { id: 'haiku', label: 'Haiku', note: 'simple tasks, the lightest' }
    ]
  }
  return []
}

/**
 * What typing "switch to this model" looks like in *this* pane's own TUI.
 *
 * Claude and Grok both take `/model <id>` as words, then Enter as its own
 * keystroke — the same two-write rhythm as `/effort`. Null for everything
 * else, and the caller says so rather than firing keystrokes into a menu.
 */
export function modelSlash(command: string): ((id: string) => string) | null {
  const exe = commandExe(command)
  if (exe !== 'claude' && exe !== 'grok') return null
  return (id) => `/model ${id}`
}

/** Why the model picker cannot drive this pane, when modelSlash is null. */
export function modelRefusal(command: string): string {
  const exe = commandExe(command)
  if (exe === 'codex') return 'Codex sets the model through its /model picker — type /model in the pane.'
  return `${exe || 'This CLI'} has no model dial Forge can reach.`
}

/**
 * Which of `models` the status strip is talking about, or null when the
 * printed name does not match anything on the list.
 *
 * Longest id wins, so "grok-4.6" does not land on "grok-4" and "Opus 4.1"
 * still matches the `opus` alias.
 */
export function matchAgentModel(models: AgentModelSpec[], printed: string | undefined): AgentModelSpec | null {
  if (!printed || !models.length) return null
  const raw = printed.trim().toLowerCase()
  const compact = raw.replace(/\s+/g, '-')
  const exact = models.find((m) => {
    const id = m.id.toLowerCase()
    return id === compact || id === raw || m.label.toLowerCase() === raw
  })
  if (exact) return exact
  let best: AgentModelSpec | null = null
  for (const m of models) {
    const id = m.id.toLowerCase()
    const family = id.replace(/\[.*\]$/, '')
    if (compact.includes(id) || raw.includes(family) || raw.includes(m.label.toLowerCase())) {
      if (!best || m.id.length > best.id.length) best = m
    }
  }
  return best
}

/**
 * The rungs Shift+Tab actually walks in a live TUI, in cycle order.
 *
 * Not the same list as PERMISSION_FAMILIES: that table is what a pane can be
 * *launched* with. The cycle is what the running CLI will land on, and bypass
 * is often a launch-only flag (Claude) or a cycle member (Grok).
 *
 *  - **Claude / Antigravity**: default → acceptEdits → plan → default.
 *    Claude's docs (code.claude.com/docs/en/permission-modes, 2026-08-21):
 *    bypass joins the cycle only when the session started in it; auto sits
 *    *before* default and is handled by the caller, not listed here.
 *  - **Grok**: default → plan → bypass → default (Shift+Tab: Normal → Plan
 *    → Always-approve, grok user-guide 2026-08-23).
 *  - **Codex**: empty. There is no Shift+Tab cycle; Codex opens its own
 *    `/permissions` menu (see `modePickerSlash`).
 */
export function permissionCycle(
  command: string,
  current?: ClaudePermissionMode | 'auto' | null
): ClaudePermissionMode[] {
  const family = permissionFamily(command)
  if (family === 'claude' || family === 'agy') {
    // Bypass only walks the live cycle when the session started in it.
    return current === 'bypass' ? ['default', 'acceptEdits', 'plan', 'bypass'] : ['default', 'acceptEdits', 'plan']
  }
  if (family === 'grok') return ['default', 'plan', 'bypass']
  return []
}

/**
 * Slash command that opens this CLI's own mode picker, when Forge cannot land
 * on a named rung itself. Codex is the one today: `/permissions` is a menu,
 * not a setter.
 */
export function modePickerSlash(command: string): string | null {
  return commandExe(command) === 'codex' ? '/permissions' : null
}

/** Why a named mode cannot be applied in this pane. */
export function modeRefusal(command: string): string {
  const exe = commandExe(command)
  if (exe === 'codex') return 'Codex sets permissions through its /permissions picker — pick the mode there.'
  return `${exe || 'This CLI'} has no permission modes Forge can reach.`
}

/**
 * How many Shift+Tabs take `from` to `to` on this command's cycle.
 *
 * `from` of `'auto'` is Claude's extra rung that sits before default: one
 * press lands on default, then the cycle runs as usual. `null` means the
 * pane has not printed a mode Forge recognises, so the distance is unknown.
 *
 * Returns null when the target is not on the cycle (Claude bypass, typically)
 * or when the starting point is unknown.
 */
export function tabsToPermissionMode(
  command: string,
  from: ClaudePermissionMode | 'auto' | null,
  to: ClaudePermissionMode
): number | null {
  const cycle = permissionCycle(command, from)
  if (!cycle.length) return null
  const toIndex = cycle.indexOf(to)
  if (toIndex < 0) return null
  if (from === to) return 0
  if (from === 'auto') return toIndex + 1
  if (from === null) return null
  const fromIndex = cycle.indexOf(from)
  if (fromIndex < 0) return null
  return (toIndex - fromIndex + cycle.length) % cycle.length
}
