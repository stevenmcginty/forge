import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { desktopCapturer, ipcMain, screen, type BrowserWindow } from 'electron'
import type { McpServerConfig } from '@anthropic-ai/claude-agent-sdk'
import { IPC } from '@shared/ipc'
import type {
  VoiceAgentStartRequest,
  VoiceAgentStatus,
  VoiceAgentToolResult
} from '@shared/types'
import { getDataDir, getSettings } from '../store'
import { bridgeConfigPath } from '../bridge/mcp-config'
import { DEFAULT_VOICE_CLAUDE_MODEL, VoiceAgentHost, type VoiceAgentShot } from './host'

/**
 * The Electron half of the voice brain — and deliberately all of it.
 *
 * `./host.ts` holds the session, the streaming and the tools, and imports no
 * Electron at all so it can be driven head-less by
 * `scripts/voice-brain-smoke.mjs`. Everything that genuinely needs the app
 * lives here: the window to push at, the settings store, `desktopCapturer`,
 * and the ipcMain wiring. Keep it thin — anything with a decision in it
 * belongs in the host, where it can be tested.
 */

let target: BrowserWindow | null = null
let host: VoiceAgentHost | null = null

function send(channel: string, payload: unknown): void {
  if (!target || target.isDestroyed()) return
  target.webContents.send(channel, payload)
}

/**
 * The forge-bridge MCP server, read back out of the config Forge already
 * generated for its Claude panes.
 *
 * Parsed rather than rebuilt on purpose: the pane config is the single source
 * of truth for the bridge's absolute path and its Gemini key, and a second
 * construction of the same object here would be a second thing to keep in
 * step. See electron/bridge/mcp-config.ts.
 */
function bridgeServer(): McpServerConfig | null {
  const path = bridgeConfigPath()
  if (!path) return null
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as {
      mcpServers?: Record<string, McpServerConfig>
    }
    return parsed.mcpServers?.['forge-bridge'] ?? null
  } catch (err) {
    console.error('[voice-agent] could not read the bridge config:', err)
    return null
  }
}

/**
 * The primary display, as base64 PNG.
 *
 * Scaled to the display's own width rather than a fixed number so a laptop
 * screen does not come back upscaled; capped, because a 4K screenshot is
 * megabytes of base64 the model has to read.
 */
async function captureScreen(): Promise<VoiceAgentShot | null> {
  const primary = screen.getPrimaryDisplay()
  const width = Math.min(1920, Math.round(primary.size.width * primary.scaleFactor))
  const height = Math.round(width * (primary.size.height / primary.size.width))

  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: { width, height }
  })
  // getSources returns one entry per display; the primary is the one whose id
  // matches, and the first entry is the sane fallback when it does not.
  const source =
    sources.find((s) => s.display_id === String(primary.id)) ?? sources[0] ?? null
  if (!source || source.thumbnail.isEmpty()) return null
  return { base64: source.thumbnail.toPNG().toString('base64'), mime: 'image/png' }
}

function ensureHost(): VoiceAgentHost {
  if (host) return host
  host = new VoiceAgentHost({
    sendEvent: (event) => send(IPC.voiceAgentEvent, event),
    sendToolRequest: (request) => send(IPC.voiceAgentToolRequest, request),
    getModel: () => getSettings().voiceClaudeModel || DEFAULT_VOICE_CLAUDE_MODEL,
    getBridgeServer: bridgeServer,
    captureScreen,
    // The same `<data dir>\bridge-out` the bridge subprocess is told to write
    // to (electron/bridge/mcp-config.ts), so list_files and make_image can
    // never disagree about where an image went — --data-dir runs included.
    getAssetsDir: () => join(getDataDir(), 'bridge-out'),
    // Jarvis's own Chrome profile, beside the data dir rather than inside
    // Steve's own browser: it is a dedicated persistent profile, so the
    // sign-ins he does in that window are still there next time Forge opens.
    getChromeProfileDir: () => join(getDataDir(), 'chrome-jarvis')
  })
  return host
}

/** Where the brain's events and tool questions go. */
export function setVoiceAgentTarget(win: BrowserWindow | null): void {
  target = win
  // The window that owned the conversation is gone, and with it every pending
  // tool round trip. A session left running would be talking to nobody.
  if (!win && host) host.stop()
}

export function registerVoiceAgentHandlers(): void {
  ipcMain.handle(IPC.voiceAgentStart, (_e, request: VoiceAgentStartRequest): VoiceAgentStatus =>
    ensureHost().start(request ?? {})
  )
  ipcMain.handle(IPC.voiceAgentStop, (): VoiceAgentStatus =>
    host ? host.stop() : { running: false, model: '', error: null }
  )
  ipcMain.handle(IPC.voiceAgentUtterance, (_e, text: string): VoiceAgentStatus =>
    ensureHost().sendUtterance(String(text ?? ''))
  )
  // Never lazily starts a session: interrupting something that is not running
  // is a no-op, not a reason to spawn a subprocess.
  ipcMain.handle(IPC.voiceAgentInterrupt, async (): Promise<boolean> =>
    host ? await host.interrupt() : false
  )
  ipcMain.handle(IPC.voiceAgentToolResult, (_e, result: VoiceAgentToolResult): boolean => {
    if (!host) return false
    host.resolveTool(result)
    return true
  })
}

export function disposeVoiceAgent(): void {
  host?.dispose()
  host = null
  target = null
}
