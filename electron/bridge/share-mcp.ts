import { app } from 'electron'
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { commandExe } from '@shared/agents'
import { getSettings } from '../store'

/**
 * Four vendors, four different ways of being told about an MCP server, and one
 * rule: **a flag we can verify beats a config file we have to own.**
 *
 * Every string in this file was checked against the installed CLI rather than
 * inferred from its documentation, because getting one of them wrong does not
 * degrade the feature — it stops the pane launching. What was verified, and how:
 *
 *   Claude    `--mcp-config <file>`. Already in tree; the share server is added
 *             as a *second* entry in the mcp.json bridge/mcp-config.ts writes.
 *   Codex     `-c "mcp_servers.forge_share={command='node',args=['<path>']}"`.
 *             Run through PowerShell against a path containing a space:
 *             `codex mcp list -c …` listed `forge_share` as enabled and
 *             persisted nothing.
 *   OpenCode  `OPENCODE_CONFIG_CONTENT` in the environment. `opencode debug
 *             config` with and without it showed the variable *merging* with
 *             ~/.config/opencode/opencode.jsonc rather than replacing it — the
 *             user's own `$schema`, agents and commands all survived.
 *   Qwen      has no MCP flag at all (`qwen --help` offers only `qwen mcp`), so
 *             it is the one vendor that needs a file written. See writeQwen.
 *
 * Three specifics that each cost a debugging session if guessed:
 *
 *  1. **The key must be bare `forge_share`.** `codex -c mcp_servers."forge-share"=…`
 *     produces a server literally named `"forge-share"`, quotes included — Codex
 *     does not unquote a dotted-path segment.
 *  2. **The Codex fragment is typed into PowerShell**, not passed as an argv
 *     entry: electron/pty/session-manager.ts writes the bootstrap command into
 *     pwsh followed by a carriage return. So the fragment carries no `"` and no
 *     `$` — PowerShell double quotes outside, TOML *literal* single-quoted
 *     strings inside, which is also what lets a Windows path keep its
 *     backslashes.
 *  3. **Qwen user scope, never `-s project`.** A `<project>/.qwen/settings.json`
 *     is silently ignored in a folder the CLI does not trust, so a project-scoped
 *     write would look like it worked and do nothing. User scope is always
 *     honoured, and share-bridge.mjs resolves the project from its own cwd
 *     anyway.
 *
 * Antigravity (`agy`), Kimi and Gemini are deliberately absent. They reach the
 * scratchpad the way every agent can — by reading `.forge/share/slot-2.md` with
 * the tools they already have — and adding a fourth registration mechanism for
 * each of them is work with a launch failure at the end of it if it is wrong.
 *
 * Everything here is a no-op while `settings.shareTools` is false, which is the
 * default. A wrong guess about a vendor's flag therefore cannot stop a pane
 * launching for anybody who has not asked for this.
 */

const SERVER_KEY = 'forge_share'
const SCRIPT = 'share-bridge.mjs'

/** How Forge marks a config entry as its own, and as safe to remove again. */
export const QWEN_MARKER = 'forge-managed'
const QWEN_DESCRIPTION = `Forge shared scratchpad — ${QWEN_MARKER}, safe to delete`

let scriptPath: string | null | undefined

/** Candidate locations for the bridge script, dev and packaged. */
function candidates(): string[] {
  const appPath = app.getAppPath()
  return [
    join(appPath, 'bridge', SCRIPT),
    join(process.resourcesPath ?? '', 'bridge', SCRIPT),
    join(`${appPath}.unpacked`, 'bridge', SCRIPT),
    join(__dirname, '..', '..', 'bridge', SCRIPT)
  ].filter(Boolean)
}

/** Absolute path to the share server, or null when it cannot be found. */
export function shareBridgeScript(): string | null {
  if (scriptPath !== undefined) return scriptPath
  scriptPath = candidates().find((c) => existsSync(c)) ?? null
  if (!scriptPath) {
    console.error(`[share] ${SCRIPT} not found; tried:\n  ` + candidates().join('\n  '))
  }
  return scriptPath
}

/** The one switch. Off out of the box; see Settings → Agents. */
function wanted(): boolean {
  return getSettings().shareTools === true
}

/* ------------------------------------------------------------------ codex */

/**
 * The `-c` fragment, or null when this path cannot be expressed safely.
 *
 * Two quoting layers have to be satisfied at once, and between them they leave
 * exactly one form.
 *
 * The outer layer is PowerShell: the bootstrap command is *typed into pwsh*, so a
 * `"` inside it is re-quoted and a `$` is expanded. The inner layer is TOML, where
 * a single-quoted string is *literal* — no escapes at all — which is what lets
 * `C:\Users\steve\Desktop\Forge Dev\bridge\share-bridge.mjs` through with its
 * backslashes and its space intact. Hence: PowerShell double quotes outside, TOML
 * literal strings inside, and neither a `"` nor a `$` anywhere.
 *
 * The one thing that cannot be expressed is a path containing an apostrophe: a
 * TOML literal string has no escape for one, and the alternative — a TOML basic
 * string in PowerShell single quotes — is a second quoting arrangement nobody has
 * verified against the CLI, to rescue a Forge installed under a folder with an
 * apostrophe in its name. So that returns null, the caller logs it, and the pane
 * launches without the share tools rather than not launching at all.
 */
export function codexFragment(script: string): string | null {
  if (!script) return null
  if (script.includes("'") || script.includes('"') || script.includes('$')) return null
  return `-c "mcp_servers.${SERVER_KEY}={command='node',args=['${script}']}"`
}

/* --------------------------------------------------------------- opencode */

/**
 * The `OPENCODE_CONFIG_CONTENT` value. Verified to merge with the user's own
 * config rather than replace it, which is what makes it safe to set on a pane.
 */
export function openCodeConfig(script: string): string {
  return JSON.stringify({
    mcp: {
      [SERVER_KEY]: { type: 'local', command: ['node', script], enabled: true }
    }
  })
}

/* ------------------------------------------------------ the bootstrap flag */

/**
 * Append the share server's registration to a bootstrap command.
 *
 * Only Codex needs anything here: Claude is served by the mcp.json,
 * OpenCode by an environment variable, and Qwen by a file. Every other command —
 * a shell, an agent with no MCP support, an empty string — comes back untouched,
 * which is the property `share-check` asserts one by one.
 *
 * Composes after `applyMcpBridge`, whose `--mcp-config` value is variadic and has
 * to stay last on Claude's command line. Codex and Claude never both match, so
 * the order is a convention rather than a dependency.
 */
export function applyShareBridge(bootstrapCommand: string): string {
  const cmd = bootstrapCommand.trim()
  if (!cmd || !wanted()) return bootstrapCommand
  if (cmd.includes(`mcp_servers.${SERVER_KEY}`)) return cmd

  if (commandExe(cmd) !== 'codex') return cmd

  const script = shareBridgeScript()
  if (!script) return cmd
  const fragment = codexFragment(script)
  if (!fragment) {
    console.error(`[share] cannot express ${script} as a Codex -c fragment; the pane launches without the share tools`)
    return cmd
  }
  return `${cmd} ${fragment}`
}

/**
 * The environment a pane needs, keyed off which CLI it is about to run.
 *
 * `FORGE_SHARE_AGENT` goes to every agent pane, not just the four that get the
 * tools: an agent that writes `.forge/share/slot-2.md` with its own Write tool
 * can read this variable and sign its work, and that is the path every vendor
 * has. The stdio MCP server a CLI spawns inherits the CLI's environment, which is
 * how the tools see it too.
 */
export function shareEnvFor(bootstrapCommand: string, paneName: string): Record<string, string> {
  const cmd = bootstrapCommand.trim()
  if (!cmd) return {}

  const env: Record<string, string> = {}
  if (paneName.trim()) env['FORGE_SHARE_AGENT'] = paneName.trim()
  if (!wanted()) return env

  const script = shareBridgeScript()
  if (script && commandExe(cmd) === 'opencode') env['OPENCODE_CONFIG_CONTENT'] = openCodeConfig(script)
  return env
}

/* -------------------------------------------------------------------- qwen */

function qwenSettingsPath(): string {
  return join(homedir(), '.qwen', 'settings.json')
}

/** The entry Forge writes. Shape verified against what `qwen mcp add` produces. */
export function qwenEntry(script: string): Record<string, unknown> {
  return { command: 'node', args: [script], trust: true, description: QWEN_DESCRIPTION }
}

export type QwenMerge =
  | { action: 'write'; settings: Record<string, unknown> }
  | { action: 'none' }
  | { action: 'refuse'; reason: string }

/**
 * What `~/.qwen/settings.json` should become — decided without touching a disk.
 *
 * Pure, and split out from the write for one reason: this is somebody else's
 * config file, hand-edited, and the rules below are the whole of Forge's claim to
 * be a good guest in it. scripts/share-check.mjs holds them to it against
 * fixtures rather than against Steve's real settings.
 *
 * The rules are electron/skills-store.ts's, applied to a JSON key instead of a
 * directory:
 *
 *   • Ownership lives in `description`, which is a field Qwen supports
 *     (`qwen mcp add --description`) rather than an unknown key a settings
 *     validator might reject. An existing `forge_share` *without* the marker was
 *     written by somebody else and is left completely alone.
 *   • Nothing outside `mcpServers.forge_share` is ever touched.
 *   • `null` for `script` means "take it out again" — and only when the entry is
 *     ours to take.
 */
export function mergeQwenSettings(existingText: string | null, script: string | null): QwenMerge {
  let settings: Record<string, unknown> = {}
  if (existingText !== null) {
    let parsed: unknown
    try {
      parsed = JSON.parse(existingText)
    } catch (err) {
      // A hand-edited file that no longer parses is somebody's problem to fix,
      // and rewriting it from scratch would delete their settings.
      return { action: 'refuse', reason: `it is not valid JSON (${(err as Error).message})` }
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { action: 'refuse', reason: 'it is not a JSON object' }
    }
    settings = parsed as Record<string, unknown>
  } else if (!script) {
    return { action: 'none' }
  }

  const raw = settings['mcpServers']
  const servers = (raw && typeof raw === 'object' && !Array.isArray(raw) ? { ...(raw as Record<string, unknown>) } : {}) as Record<
    string,
    unknown
  >

  const existing = servers[SERVER_KEY] as { description?: unknown } | undefined
  if (existing && !String(existing.description ?? '').includes(QWEN_MARKER)) {
    return { action: 'refuse', reason: `it already has an mcpServers.${SERVER_KEY} that Forge did not write` }
  }

  if (script) {
    servers[SERVER_KEY] = qwenEntry(script)
  } else {
    if (!existing) return { action: 'none' }
    delete servers[SERVER_KEY]
  }

  const next: Record<string, unknown> = { ...settings, mcpServers: servers }
  // An empty mcpServers left behind after a removal is litter, not a setting.
  if (Object.keys(servers).length === 0) delete next['mcpServers']
  return { action: 'write', settings: next }
}

/**
 * Add or remove `mcpServers.forge_share` in `~/.qwen/settings.json`.
 *
 * The one config file Forge writes for this feature, because Qwen is the one
 * vendor with no launch flag. Written directly rather than by spawning
 * `qwen mcp add`: a subprocess at app start is slower, less predictable, and
 * gives no way to *refuse* when there is already an entry under our name that we
 * did not write.
 *
 * Qwen's own `mcpServers` merges shallowly and reloads without a restart, so this
 * reaches panes that are already open — which is why the write is worth doing at
 * all rather than waiting for the next launch.
 */
export function syncQwenConfig(): void {
  const path = qwenSettingsPath()
  const script = shareBridgeScript()
  const wantedScript = wanted() && script ? script : null

  const existingText = existsSync(path) ? safeRead(path) : null
  if (existingText === undefined) return

  const merge = mergeQwenSettings(existingText, wantedScript)
  if (merge.action === 'refuse') {
    console.error(`[share] leaving ${path} alone: ${merge.reason}`)
    return
  }
  if (merge.action === 'none') return

  try {
    mkdirSync(join(homedir(), '.qwen'), { recursive: true })
    const tmp = `${path}.tmp`
    writeFileSync(tmp, `${JSON.stringify(merge.settings, null, 2)}\n`, 'utf8')
    renameSync(tmp, path)
  } catch (err) {
    console.error(`[share] could not write ${path}:`, err)
    try {
      if (existsSync(`${path}.tmp`)) unlinkSync(`${path}.tmp`)
    } catch {
      /* best effort */
    }
  }
}

/** `undefined` for a file that exists and cannot be read — leave it alone. */
function safeRead(path: string): string | undefined {
  try {
    return readFileSync(path, 'utf8')
  } catch (err) {
    console.error(`[share] could not read ${path}:`, err)
    return undefined
  }
}
