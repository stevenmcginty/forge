import { app } from 'electron'
import { existsSync, mkdirSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { getDataDir, getSettings } from '../store'

/**
 * The cross-agent bridge's Forge-side half.
 *
 * Forge ships an MCP server (bridge/gemini-bridge.mjs) that lets Claude Code
 * hand work to Google Gemini. For a pane to see it, Claude has to be told
 * about it at launch, so on every app start we write an MCP config file with
 * absolute paths and then append `--mcp-config <file>` to the bootstrap command
 * of any agent profile flagged `mcpBridge`.
 *
 * Why regenerate on every start rather than write it once: the absolute path to
 * the bridge changes when Forge is moved, reinstalled or run from a different
 * checkout, and a stale path would fail silently inside Claude.
 *
 * Deliberately *not* `--strict-mcp-config`: that would hide Steve's own global
 * MCP servers from every Forge pane.
 *
 * ⚠ Key handling. `make_image`/`edit_image` call Google's REST API directly, so
 * the bridge needs the Gemini key. It is passed in this file's `env` block and
 * nowhere else: the generated mcp.json lives under %APPDATA%\Forge\bridge\ (not
 * in the repo, not in the packaged app), is rewritten from settings on every
 * start, and is the *only* file Forge ever writes a key into besides
 * settings.json itself. When no key is set the variable is simply omitted, and
 * the bridge says so instead of failing mysteriously.
 */

const SERVER_KEY = 'forge-bridge'
const SCRIPT = 'gemini-bridge.mjs'

/**
 * The share scratchpad's server, written into the same file.
 *
 * One mcp.json with two servers rather than two files and a repeated
 * `--mcp-config`: the flag's value is variadic, and whether a *repeated* flag
 * appends or replaces is a commander detail nobody should be betting a pane's
 * launch on. This way `applyMcpBridge` is unchanged and
 * scripts/bridge-register-check.mjs — which hands the real generated file to the
 * real `claude --help` — stays the proof that Claude accepts it.
 *
 * It gets no `env` block. That is the whole reason it is a separate *server*
 * rather than five more tools on the one above: the Gemini bridge's environment
 * carries GEMINI_API_KEY, and electron/bridge/share-mcp.ts registers the share
 * server with three more vendors.
 */
const SHARE_KEY = 'forge_share'

let configPath: string | null = null
const scripts = new Map<string, string | null>()

/** Candidate locations for a bridge script, dev and packaged. */
function scriptCandidates(name: string): string[] {
  const appPath = app.getAppPath()
  const list = [
    // Dev / unpacked: <root>/bridge/<name>
    join(appPath, 'bridge', name),
    // Packaged with the bridge as an extraResource.
    join(process.resourcesPath ?? '', 'bridge', name),
    // Packaged inside app.asar.unpacked.
    join(`${appPath}.unpacked`, 'bridge', name),
    // Built output sits in out/main, so the repo root is two levels up.
    join(__dirname, '..', '..', 'bridge', name)
  ]
  return list.filter(Boolean)
}

/**
 * Absolute path to a bridge server, or null when it cannot be found.
 *
 * Cached per name rather than in one variable, because there are two servers now
 * and a single slot would have made the second lookup answer with the first
 * one's path.
 */
export function resolveBridgeScript(name: string = SCRIPT): string | null {
  const cached = scripts.get(name)
  if (cached !== undefined) return cached
  const found = scriptCandidates(name).find((candidate) => existsSync(candidate)) ?? null
  if (!found) {
    console.error(`[bridge] ${name} not found; tried:\n  ` + scriptCandidates(name).join('\n  '))
  }
  scripts.set(name, found)
  return found
}

/**
 * Write %APPDATA%\Forge\bridge\mcp.json. Call once on app start.
 * Returns the config path, or null if the bridge script is missing (in which
 * case no pane gets the flag — better than pointing Claude at nothing).
 */
export function writeBridgeConfig(): string | null {
  const script = resolveBridgeScript()
  if (!script) {
    configPath = null
    return null
  }

  const dir = join(getDataDir(), 'bridge')
  const outDir = join(getDataDir(), 'bridge-out')
  const target = join(dir, 'mcp.json')

  const settings = getSettings()
  const env: Record<string, string> = {
    // Where make_image drops files, so the bridge and Forge agree.
    FORGE_BRIDGE_OUT: outDir
  }
  // The same key the voice agent uses. Absent key => absent variable => the
  // bridge returns "no key, here is how to set one" rather than a bare 401.
  const key = (settings.geminiKey ?? '').trim()
  if (key) env['GEMINI_API_KEY'] = key
  // Only written when the user has deliberately overridden the model, so the
  // bridge's own default stays the single source of truth otherwise.
  const imageModel = (settings.geminiImageModel ?? '').trim()
  if (imageModel) env['FORGE_GEMINI_IMAGE_MODEL'] = imageModel
  // There is deliberately no *setting* for the video model — the cheapest Veo
  // variant is the right default and nobody should be picking one from a
  // dropdown. But Forge's own environment is forwarded, so starting Forge with
  // FORGE_GEMINI_VIDEO_MODEL set reaches the panes too, which is what makes the
  // override testable end to end rather than only inside the main process.
  const videoModel = (process.env['FORGE_GEMINI_VIDEO_MODEL'] ?? '').trim()
  if (videoModel) env['FORGE_GEMINI_VIDEO_MODEL'] = videoModel
  // Same story for the model behind ask_gemini/summarize_video: no setting, a
  // sensible default in the bridge, but Forge's environment is forwarded so the
  // override can be exercised end to end.
  const askModel = (process.env['FORGE_GEMINI_ASK_MODEL'] ?? '').trim()
  if (askModel) env['FORGE_GEMINI_ASK_MODEL'] = askModel

  // Only when the user has asked for the share tools, and only when the server
  // is actually on disk. An mcp.json naming a script that is not there is a
  // Claude pane that spends its first seconds failing to start a server.
  const shareScript = settings.shareTools ? resolveBridgeScript('share-bridge.mjs') : null

  const config = {
    mcpServers: {
      [SERVER_KEY]: {
        command: 'node',
        args: [script],
        env
      },
      ...(shareScript ? { [SHARE_KEY]: { command: 'node', args: [shareScript] } } : {})
    }
  }

  try {
    mkdirSync(dir, { recursive: true })
    mkdirSync(outDir, { recursive: true })
    const tmp = `${target}.tmp`
    writeFileSync(tmp, JSON.stringify(config, null, 2), 'utf8')
    renameSync(tmp, target)
    configPath = target
    return target
  } catch (err) {
    console.error('[bridge] failed to write mcp.json:', err)
    configPath = null
    return null
  }
}

/** The generated config path, writing it on first use if need be. */
export function bridgeConfigPath(): string | null {
  if (configPath) return configPath
  return writeBridgeConfig()
}

/* ------------------------------------------------------------- bootstrapping */

function firstToken(command: string): string {
  return command.trim().split(/\s+/)[0]?.toLowerCase() ?? ''
}

/**
 * Does this bootstrap command belong to a bridge-enabled profile?
 *
 * The profile flag is resolved here in the main process rather than threaded
 * through the renderer: the PTY host only ever receives the command string, and
 * matching it against settings keeps the change to a single call site.
 *
 * Matches an exact command first, then falls back to the executable name, so a
 * customised `claude --resume` still gets the bridge.
 */
function wantsBridge(command: string): boolean {
  const cmd = command.trim()
  if (!cmd) return false
  const enabled = getSettings().agentProfiles.filter((p) => p.mcpBridge && p.command.trim())
  if (enabled.some((p) => p.command.trim() === cmd)) return true
  const exe = firstToken(cmd)
  return enabled.some((p) => firstToken(p.command) === exe)
}

/**
 * Append the bridge registration to a bootstrap command when the profile asks
 * for it. Returns the command unchanged in every other case — a missing bridge,
 * a plain shell, or a profile that opted out.
 *
 * `--mcp-config <configs...>` is variadic (verified against `claude --help`,
 * v2.1.220), so the flag goes last where it cannot swallow other arguments.
 */
export function applyMcpBridge(bootstrapCommand: string): string {
  const cmd = bootstrapCommand.trim()
  if (!cmd) return bootstrapCommand
  if (/--mcp-config\b/.test(cmd)) return cmd
  if (!wantsBridge(cmd)) return cmd

  const path = bridgeConfigPath()
  if (!path) return cmd
  return `${cmd} --mcp-config "${path}"`
}
