import { app } from 'electron'
import { existsSync, mkdirSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { getDataDir, getSettings } from '../store'

/**
 * The cross-agent bridge's Forge-side half.
 *
 * Forge ships an MCP server (bridge/gemini-bridge.mjs) that lets Claude Code
 * hand work to the Gemini CLI. For a pane to see it, Claude has to be told
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
 */

const SERVER_KEY = 'forge-bridge'
const SCRIPT = 'gemini-bridge.mjs'

let configPath: string | null = null
let bridgeScript: string | null = null

/** Candidate locations for the bridge script, dev and packaged. */
function scriptCandidates(): string[] {
  const appPath = app.getAppPath()
  const list = [
    // Dev / unpacked: <root>/bridge/gemini-bridge.mjs
    join(appPath, 'bridge', SCRIPT),
    // Packaged with the bridge as an extraResource.
    join(process.resourcesPath ?? '', 'bridge', SCRIPT),
    // Packaged inside app.asar.unpacked.
    join(`${appPath}.unpacked`, 'bridge', SCRIPT),
    // Built output sits in out/main, so the repo root is two levels up.
    join(__dirname, '..', '..', 'bridge', SCRIPT)
  ]
  return list.filter(Boolean)
}

/** Absolute path to the bridge server, or null when it cannot be found. */
export function resolveBridgeScript(): string | null {
  if (bridgeScript !== null) return bridgeScript
  for (const candidate of scriptCandidates()) {
    if (existsSync(candidate)) {
      bridgeScript = candidate
      return bridgeScript
    }
  }
  console.error('[bridge] gemini-bridge.mjs not found; tried:\n  ' + scriptCandidates().join('\n  '))
  return null
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

  const config = {
    mcpServers: {
      [SERVER_KEY]: {
        command: 'node',
        args: [script],
        env: {
          // Where make_image drops files, so the bridge and Forge agree.
          FORGE_BRIDGE_OUT: outDir
        }
      }
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
