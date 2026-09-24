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
import { isCodexClaudeModel } from '@shared/agent-brain'
import type { WebVoiceClaudeEvent } from '@shared/web'
import { getDataDir, getSettings } from '../store'
import { bridgeConfigPath, resolveBridgeScript } from '../bridge/mcp-config'
import type { BrowserLink } from '../browser-panes/link'
import { createBrainLink } from './brain-link'
import { findWindowsLaunchable } from '../cli-launch'
import { whichCommand } from '../which'
import { CODEX_VOICE_MODELS, DEFAULT_VOICE_CLAUDE_MODEL, VoiceAgentHost, type VoiceAgentShot } from './host'
import type { CliBrainSetup } from './cli-brains'

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
/** The brain link: how a CLI brain's bridge/brain-mcp.mjs reaches the host's tools. */
let brainLink: BrowserLink | null = null
let brainLinkReady: Promise<string> | null = null

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
export async function captureScreen(): Promise<VoiceAgentShot | null> {
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

/**
 * What a CLI brain needs to have Forge's tools: the relay script, a node to run
 * it, and the brain link — the browser link's authenticated pipe class, with a
 * token of its own under `<data dir>\brain`. Started on the first CLI turn.
 */
async function cliBrainSetup(): Promise<CliBrainSetup | null> {
  const script = resolveBridgeScript('brain-mcp.mjs')
  if (!script) return null
  const node = (process.platform === 'win32' ? findWindowsLaunchable('node') : whichCommand('node')) ?? 'node'
  brainLink ??= createBrainLink(join(getDataDir(), 'brain'), ensureHost)
  brainLinkReady ??= brainLink.listen()
  try {
    await brainLinkReady
  } catch (err) {
    console.error('[voice-agent] the brain link did not start:', err)
    brainLinkReady = null
    return null
  }
  const settings = getSettings()
  // Forge's saved key only (decrypted by main), or the Google login — never the
  // environment's GEMINI_API_KEY, which may be some other shell's refused key.
  const key = settings.geminiKey.trim().startsWith('enc:') ? '' : settings.geminiKey.trim()
  return { node, mcpScript: script, linkFile: brainLink.linkFile, workDir: join(getDataDir(), 'brains'), geminiKey: key }
}

function ensureHost(): VoiceAgentHost {
  if (host) return host
  host = new VoiceAgentHost({
    sendEvent: (event) => send(IPC.voiceAgentEvent, event),
    sendToolRequest: (request) => send(IPC.voiceAgentToolRequest, request),
    getModel: () => getSettings().voiceClaudeModel || DEFAULT_VOICE_CLAUDE_MODEL,
    getBrain: () => getSettings().agentBrain,
    getCliSetup: cliBrainSetup,
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

/* ------------------------------------------------ Claude for a browser
 *
 * Forge Web's Listen, with Claude picked (web/src/deck/voiceAgent.ts): a
 * second host, so a browser conversation never lands in the desk's voice bar
 * and the desk's never lands in the browser. Its events go to the browser that
 * opened it (electron/web/server.ts's `voice-claude`), never to the window;
 * its tool questions go to the window like the desk's, because only the
 * renderer knows what is on screen — `resolveTool` below hands each answer to
 * both hosts, and ids are UUIDs, so only the asker takes it.
 */

let webHost: VoiceAgentHost | null = null
/** The browser that owns `webHost` now. Replaced by the next `openWebVoiceAgent`. */
let webSink: ((event: WebVoiceClaudeEvent) => void) | null = null

export interface WebVoiceAgentLink {
  /** One turn, context block and all. */
  say(text: string): void
  /** Barge-in: the turn stops, the conversation stays. */
  interrupt(): Promise<boolean>
  /** The browser is done with it. A no-op once another browser has taken over. */
  close(): void
}

/**
 * The Claude model a browser turn runs on: the desk's Claude setting — but a
 * browser that picked Claude hears Claude, so a Codex model left in that
 * setting (the codex-cli adapter, ./host.ts `route`) falls back to Opus here.
 */
function webClaudeModel(): string {
  const model = (getSettings().voiceClaudeModel || '').trim()
  if (!model || CODEX_VOICE_MODELS.has(model) || isCodexClaudeModel(model)) return DEFAULT_VOICE_CLAUDE_MODEL
  return model
}

function ensureWebHost(): VoiceAgentHost {
  if (webHost) return webHost
  webHost = new VoiceAgentHost({
    sendEvent: (event) => webSink?.(event),
    sendToolRequest: (request) => send(IPC.voiceAgentToolRequest, request),
    getModel: webClaudeModel,
    // Always this Claude session: `agentBrain` picks the desk's brain, and a
    // CLI brain there must not answer a browser that asked for Claude.
    getBrain: () => 'claude',
    getBridgeServer: bridgeServer,
    captureScreen,
    getAssetsDir: () => join(getDataDir(), 'bridge-out'),
    getChromeProfileDir: () => join(getDataDir(), 'chrome-jarvis')
  })
  return webHost
}

/**
 * A browser takes the Claude voice session: a fresh conversation, opened now
 * so the first turn does not wait on the SDK starting. A browser that held it
 * before is told `closed`.
 */
export function openWebVoiceAgent(onEvent: (event: WebVoiceClaudeEvent) => void): WebVoiceAgentLink {
  const previous = webSink
  webSink = onEvent
  if (previous && previous !== onEvent) previous({ type: 'closed', reason: 'Claude is listening in another browser now.' })
  const brain = ensureWebHost()
  brain.stop()
  brain.start({})
  const mine = (): boolean => webSink === onEvent
  return {
    say: (text) => {
      if (mine()) brain.sendUtterance(text)
    },
    interrupt: async () => (mine() ? brain.interrupt() : false),
    close: () => {
      if (!mine()) return
      webSink = null
      brain.stop()
    }
  }
}

/** Where the brain's events and tool questions go. */
export function setVoiceAgentTarget(win: BrowserWindow | null): void {
  target = win
  // The window that owned the conversation is gone, and with it every pending
  // tool round trip. A session left running would be talking to nobody. The
  // browser's session asks that window its tool questions too, so it goes as
  // well — and its browser is told why.
  if (!win && host) host.stop()
  if (!win && webHost && webSink) {
    const sink = webSink
    webSink = null
    webHost.stop()
    sink({ type: 'closed', reason: 'The Forge window on the desktop closed.' })
  }
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
    if (!host && !webHost) return false
    // Both hosts ask on the one channel; each ignores ids it did not issue.
    host?.resolveTool(result)
    webHost?.resolveTool(result)
    return true
  })
}

/**
 * Run one Forge tool in the renderer on someone else's behalf — a pane agent's
 * open_agent_pane arrives here from the bridge link. Same answer path as the
 * brain's own tool calls; resolves with the tool's sentence.
 */
export function askRendererTool(name: string, args: unknown): Promise<string> {
  return ensureHost().askTool(name, args)
}

export function disposeVoiceAgent(): void {
  host?.dispose()
  host = null
  webSink = null
  webHost?.dispose()
  webHost = null
  brainLink?.close()
  brainLink = null
  brainLinkReady = null
  target = null
}
