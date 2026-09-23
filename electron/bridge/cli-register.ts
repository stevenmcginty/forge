import { join } from 'node:path'

/**
 * forge-bridge (bridge/gemini-bridge.mjs — the built-in browser, the canvas
 * board and the Gemini tools) for every agent CLI, not just Claude.
 *
 * Pure: no Electron, no disk, no spawning. electron/bridge/mcp-config.ts and
 * share-mcp.ts use the per-pane half at launch; scripts/bridge-install.mjs uses
 * the file half for the CLIs that have no launch flag; and
 * scripts/bridge-register-check.mjs holds both to their shapes against a temp
 * home.
 *
 * Which mechanism each CLI gets, by share-mcp.ts's rule — a flag we can verify
 * beats a config file we have to own:
 *
 *   Claude, GLM  `--mcp-config <mcp.json>`, per pane (mcp-config.ts).
 *   Codex        `-c mcp_servers.forge-bridge={…}`, per pane. Verified against
 *                codex-cli 0.155.1: `codex mcp get forge-bridge --json -c …`
 *                reads the dashed key bare and lists `env_vars`.
 *   OpenCode     `OPENCODE_CONFIG_CONTENT`, per pane — it merges (share-mcp.ts),
 *                and 1.18.29 accepts `instructions` in it too.
 *   Gemini CLI   ~/.gemini/settings.json `mcpServers`: no launch flag.
 *   Qwen         ~/.qwen/settings.json `mcpServers`: no launch flag.
 *   Antigravity  `agy mcp add` (an idempotent upsert into
 *                ~/.gemini/config/mcp_config.json): no launch flag.
 *   Kimi         skipped — see KIMI_SKIP.
 *
 * ⚠ Codex does not hand its environment to an MCP server. Verified by running
 * `codex exec` with a server that dumps `process.env`: without `env_vars` it
 * receives the Windows basics (PATH, APPDATA, USERPROFILE…) and nothing else,
 * so FORGE_BROWSER_LINK_FILE never arrives and every browser_* call answers
 * "not reachable". Gemini CLI, Qwen and OpenCode pass the pane's environment
 * through (Gemini CLI redacts names matching /KEY|TOKEN|…/, hence the
 * `${GEMINI_API_KEY}` reference in its entry, which it expands itself).
 *
 * The Gemini key is never written by anything here. It stays in the per-pane
 * mcp.json, as mcp-config.ts promises; the global entries only *name* the
 * variable, and only for the CLI that redacts it.
 */

export const BRIDGE_KEY = 'forge-bridge'

/** Marks an entry, or a line, as Forge's and safe to remove. Qwen's marker. */
export const BRIDGE_MARKER = 'forge-managed'
export const BRIDGE_DESCRIPTION = `Forge bridge: built-in browser, canvas board, Gemini — ${BRIDGE_MARKER}, safe to delete`

/**
 * The pane variables forge-bridge reads (browser-tools.mjs, canvas-tools.mjs,
 * gemini-bridge.mjs) — what Codex has to be told to forward by name.
 */
export const BRIDGE_PANE_ENV = [
  'FORGE_PANE_ID',
  'FORGE_PANE_AGENT',
  'FORGE_SHARE_AGENT',
  'FORGE_BROWSER_LINK_FILE',
  'FORGE_CANVAS_DIR',
  'GEMINI_API_KEY',
  'GOOGLE_API_KEY'
] as const

/* ------------------------------------------------------------- the one line */

export const INSTRUCTION_MARKER = `<!-- ${BRIDGE_MARKER}:browser -->`

/**
 * The line every CLI's instructions file gets. One line, so that finding and
 * refreshing it needs no parser: the marker at its end is the whole of the
 * ownership claim.
 */
export const BROWSER_INSTRUCTION_LINE =
  "When you need a web browser, use Forge's built-in browser — the forge-bridge browser_open / browser_read / browser_click / browser_type tools — instead of any other browser tool or a desktop browser, and use show_on_canvas to put an image, video or .html/.md artifact on the Forge board. " +
  'To start another agent, call open_agent_pane — never launch a CLI in a new window. ' +
  INSTRUCTION_MARKER

export type TextMerge = { action: 'write'; text: string } | { action: 'none' }

/**
 * Add or refresh the marked line in an instructions file's text. Every other
 * line is left exactly as it was; `null` is a file that does not exist yet.
 */
export function mergeInstructionLine(existing: string | null, line: string = BROWSER_INSTRUCTION_LINE): TextMerge {
  if (existing === null || existing.trim() === '') return { action: 'write', text: `${line}\n` }
  const eol = existing.includes('\r\n') ? '\r\n' : '\n'
  const lines = existing.split(/\r?\n/)
  const at = lines.findIndex((l) => l.includes(INSTRUCTION_MARKER))
  if (at !== -1) {
    if (lines[at] === line) return { action: 'none' }
    lines[at] = line
    return { action: 'write', text: lines.join(eol) }
  }
  const body = existing.endsWith('\n') ? existing : `${existing}${eol}`
  return { action: 'write', text: `${body}${eol}${line}${eol}` }
}

/* ------------------------------------------------------------------- codex */

/** Safe as a TOML literal string typed into PowerShell: see share-mcp.ts codexFragment. */
export function tomlLiteralSafe(value: string): boolean {
  return !!value && !/['"$\r\n]/.test(value)
}

/** `env_vars=[…]`, the names Codex forwards to a server. */
export function codexEnvVars(names: readonly string[]): string {
  return `env_vars=[${names.map((n) => `'${n}'`).join(',')}]`
}

/**
 * The `-c` fragment that gives a Codex pane forge-bridge, or null when the path
 * cannot be expressed. Same quoting as share-mcp.ts `codexFragment`: PowerShell
 * double quotes outside, TOML literal strings inside, no `"` or `$` anywhere.
 *
 * `forge-bridge` is a legal TOML bare key (letters, digits, `-`, `_`), so the
 * dash needs no quoting — which is what matters, because Codex keeps quotes in
 * a dotted-path segment as part of the name.
 */
export function codexBridgeFragment(script: string, outDir: string | null): string | null {
  if (!tomlLiteralSafe(script)) return null
  const env = outDir && tomlLiteralSafe(outDir) ? `,env={FORGE_BRIDGE_OUT='${outDir}'}` : ''
  return `-c "mcp_servers.${BRIDGE_KEY}={command='node',args=['${script}']${env},${codexEnvVars(BRIDGE_PANE_ENV)}}"`
}

/* ---------------------------------------------------------------- opencode */

export interface OpenCodePaneConfig {
  bridgeScript: string | null
  outDir: string | null
  instructionsPath: string | null
  /** The share server, when settings.shareTools is on. */
  shareScript: string | null
}

/**
 * The whole `OPENCODE_CONFIG_CONTENT` for a pane: forge-bridge, the share
 * server when it is on, and the instructions file. One value, because it is one
 * variable. Null when there is nothing to say.
 *
 * With forge-bridge present the share server runs without its browser tools,
 * exactly as Claude's copy does — one set of browser_* tools, not two.
 */
export function openCodePaneConfig(c: OpenCodePaneConfig): string | null {
  const mcp: Record<string, unknown> = {}
  if (c.bridgeScript) {
    mcp[BRIDGE_KEY] = {
      type: 'local',
      command: ['node', c.bridgeScript],
      enabled: true,
      ...(c.outDir ? { environment: { FORGE_BRIDGE_OUT: c.outDir } } : {})
    }
  }
  if (c.shareScript) {
    mcp['forge_share'] = {
      type: 'local',
      command: ['node', c.shareScript],
      enabled: true,
      ...(c.bridgeScript ? { environment: { FORGE_BROWSER_TOOLS: 'off' } } : {})
    }
  }
  const config: Record<string, unknown> = {}
  if (Object.keys(mcp).length > 0) config['mcp'] = mcp
  if (c.bridgeScript && c.instructionsPath) config['instructions'] = [c.instructionsPath]
  return Object.keys(config).length > 0 ? JSON.stringify(config) : null
}

/* ------------------------------------------------- gemini cli and qwen files */

export type Cli = 'claude' | 'codex' | 'opencode' | 'gemini' | 'qwen' | 'antigravity' | 'kimi'

/** The `mcpServers` entry for a CLI that reads a settings.json. */
export function settingsEntry(cli: 'gemini' | 'qwen', script: string): Record<string, unknown> {
  return {
    command: 'node',
    args: [script],
    // Gemini CLI strips any variable named like a secret before it spawns a
    // server, but expands `${VAR}` in `env` from the unfiltered environment.
    // Forge gives Gemini panes GEMINI_API_KEY; this lets the bridge see it
    // without the key ever being written here.
    ...(cli === 'gemini' ? { env: { GEMINI_API_KEY: '${GEMINI_API_KEY}' } } : {}),
    description: BRIDGE_DESCRIPTION
  }
}

export type JsonMerge =
  | { action: 'write'; text: string }
  | { action: 'none' }
  | { action: 'refuse'; reason: string }

/**
 * What a settings.json should become with `mcpServers["forge-bridge"]` added
 * or refreshed — share-mcp.ts `mergeQwenSettings`'s rules, for this key:
 *
 *   • nothing outside `mcpServers["forge-bridge"]` is touched;
 *   • an existing entry without the marker was written by somebody else and is
 *     refused, not overwritten;
 *   • an entry already exactly right is `none`, so a second run writes nothing
 *     (and makes no backup).
 */
export function mergeSettingsEntry(existing: string | null, entry: Record<string, unknown>): JsonMerge {
  let settings: Record<string, unknown> = {}
  if (existing !== null && existing.trim() !== '') {
    let parsed: unknown
    try {
      parsed = JSON.parse(existing)
    } catch (err) {
      return { action: 'refuse', reason: `it is not valid JSON (${(err as Error).message})` }
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { action: 'refuse', reason: 'it is not a JSON object' }
    settings = parsed as Record<string, unknown>
  }
  const raw = settings['mcpServers']
  if (raw !== undefined && (!raw || typeof raw !== 'object' || Array.isArray(raw))) {
    return { action: 'refuse', reason: 'its mcpServers is not an object' }
  }
  const servers = { ...((raw as Record<string, unknown> | undefined) ?? {}) }
  const current = servers[BRIDGE_KEY] as { description?: unknown } | undefined
  if (current && !String(current.description ?? '').includes(BRIDGE_MARKER)) {
    return { action: 'refuse', reason: `it already has an mcpServers.${BRIDGE_KEY} that Forge did not write` }
  }
  if (current && JSON.stringify(current) === JSON.stringify(entry)) return { action: 'none' }
  servers[BRIDGE_KEY] = entry
  return { action: 'write', text: `${JSON.stringify({ ...settings, mcpServers: servers }, null, 2)}\n` }
}

/* ------------------------------------------------------------- antigravity */

/** `agy mcp add` for forge-bridge. No flags, so the flags-before-name rule is moot. */
export function agyAddArgs(script: string): string[] {
  return ['mcp', 'add', BRIDGE_KEY, 'node', script]
}

/**
 * Whether ~/.gemini/config/mcp_config.json already has the entry `agy mcp add`
 * would write — read rather than asked, so a second run spawns nothing. A
 * disabled entry with the right command is left disabled: the user turned it
 * off, and "add" would turn it back on.
 */
export function agyUpToDate(existing: string | null, script: string): boolean {
  if (!existing) return false
  try {
    const entry = (JSON.parse(existing) as { mcpServers?: Record<string, { command?: unknown; args?: unknown }> })?.mcpServers?.[BRIDGE_KEY]
    return !!entry && entry.command === 'node' && JSON.stringify(entry.args) === JSON.stringify([script])
  } catch {
    return false
  }
}

/* ------------------------------------------------------------------- plan */

export const KIMI_SKIP =
  "kimi is Steve's kimi.cmd: Claude Code against OpenRouter, launched with `call claude.cmd` and no argument pass-through, so it cannot take --mcp-config; the only other route is Claude's user scope (~/.claude.json), which every Claude pane already reading forge-bridge from its mcp.json would then see twice"

export type PlanItem =
  | { cli: Cli; what: 'mcp' | 'instructions'; kind: 'skip'; reason: string }
  | { cli: Cli; what: 'mcp' | 'instructions'; kind: 'per-pane'; mechanism: string }
  | { cli: Cli; what: 'mcp' | 'instructions'; kind: 'file'; path: string; merge: JsonMerge | TextMerge }
  | { cli: Cli; what: 'mcp'; kind: 'cli'; path: string; exe: 'agy'; args: string[]; upToDate: boolean }

export interface PlanInput {
  home: string
  /** Codex's home. Defaults to <home>/.codex. */
  codexHome?: string
  script: string
  installed: (cli: Cli) => boolean
  /** File contents, or null when the file does not exist. */
  read: (path: string) => string | null
}

/** The instructions file each file-based CLI reads from its user scope. */
export function instructionFiles(home: string, codexHome: string = join(home, '.codex')): Partial<Record<Cli, string>> {
  return {
    // codex-rs codex-home/src/instructions: AGENTS.override.md, then AGENTS.md.
    codex: join(codexHome, 'AGENTS.md'),
    gemini: join(home, '.gemini', 'GEMINI.md'),
    qwen: join(home, '.qwen', 'QWEN.md'),
    // agy's global customization root is ~/.gemini/config (where its
    // mcp_config.json and skills/ live); a standalone GEMINI.md there is
    // "always active", per the rules doc embedded in agy 1.2.9.
    antigravity: join(home, '.gemini', 'config', 'GEMINI.md')
  }
}

/**
 * Every change a registration run would make, decided without touching a disk.
 * The script prints this for `--dry-run` and applies it otherwise.
 */
export function planRegistration(input: PlanInput): PlanItem[] {
  const { home, script, installed, read } = input
  const files = instructionFiles(home, input.codexHome)
  const items: PlanItem[] = []
  const notInstalled = (cli: Cli): PlanItem[] => [
    { cli, what: 'mcp', kind: 'skip', reason: 'not installed' },
    { cli, what: 'instructions', kind: 'skip', reason: 'not installed' }
  ]
  const instructions = (cli: Cli): PlanItem => {
    const path = files[cli]!
    return { cli, what: 'instructions', kind: 'file', path, merge: mergeInstructionLine(read(path)) }
  }

  items.push(
    { cli: 'claude', what: 'mcp', kind: 'per-pane', mechanism: '--mcp-config <data dir>\\bridge\\mcp.json (Claude and GLM profiles)' },
    { cli: 'claude', what: 'instructions', kind: 'per-pane', mechanism: "forge-bridge's MCP instructions, which Claude Code reads" }
  )

  if (!installed('codex')) items.push(...notInstalled('codex'))
  else items.push({ cli: 'codex', what: 'mcp', kind: 'per-pane', mechanism: '-c mcp_servers.forge-bridge={…} on the pane command' }, instructions('codex'))

  if (!installed('opencode')) items.push(...notInstalled('opencode'))
  else
    items.push(
      { cli: 'opencode', what: 'mcp', kind: 'per-pane', mechanism: 'OPENCODE_CONFIG_CONTENT mcp["forge-bridge"]' },
      {
        cli: 'opencode',
        what: 'instructions',
        kind: 'per-pane',
        // A ~/.config/opencode/AGENTS.md would *replace* OpenCode's fallback to
        // ~/.claude/CLAUDE.md (it reads the first of the two that exists), so the
        // line goes in through the pane's config instead of a file.
        mechanism: 'OPENCODE_CONFIG_CONTENT instructions → <data dir>\\bridge\\agent-instructions.md'
      }
    )

  for (const cli of ['gemini', 'qwen'] as const) {
    if (!installed(cli)) {
      items.push(...notInstalled(cli))
      continue
    }
    const path = join(home, cli === 'gemini' ? '.gemini' : '.qwen', 'settings.json')
    items.push({ cli, what: 'mcp', kind: 'file', path, merge: mergeSettingsEntry(read(path), settingsEntry(cli, script)) }, instructions(cli))
  }

  if (!installed('antigravity')) items.push(...notInstalled('antigravity'))
  else {
    const path = join(home, '.gemini', 'config', 'mcp_config.json')
    items.push(
      { cli: 'antigravity', what: 'mcp', kind: 'cli', path, exe: 'agy', args: agyAddArgs(script), upToDate: agyUpToDate(read(path), script) },
      instructions('antigravity')
    )
  }

  items.push({ cli: 'kimi', what: 'mcp', kind: 'skip', reason: KIMI_SKIP }, { cli: 'kimi', what: 'instructions', kind: 'skip', reason: 'no MCP route, so nothing to point it at' })
  return items
}

/** Whether a plan item would change anything on disk. */
export function itemWrites(item: PlanItem): boolean {
  if (item.kind === 'file') return item.merge.action === 'write'
  if (item.kind === 'cli') return !item.upToDate
  return false
}
