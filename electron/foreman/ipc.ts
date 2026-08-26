import { closeSync, openSync, readSync, statSync } from 'node:fs'
import { readFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { ipcMain, type BrowserWindow } from 'electron'
import type { McpServerConfig } from '@anthropic-ai/claude-agent-sdk'
import { IPC } from '@shared/ipc'
import { idleForemanState, type ForemanSayRequest, type ForemanStartRequest, type ForemanState } from '@shared/foreman'
import { isSessionId } from '@shared/session'
import type { LayoutNode } from '@shared/types'
import { getProjects, getSettings, getWorkspace } from '../store'
import { bridgeConfigPath } from '../bridge/mcp-config'
import { claudeHome, transcriptPath } from '../bridge/claude-transcripts'
import { installForemanKit } from './kit'
import { foremanKitDir } from './kit-path'
import { getManager, getReplay, liveSessions } from '../pty-host'
import { onAttention } from '../attention-bus'
import { DEFAULT_FOREMAN_MODEL, ForemanHost, type ForemanPaneInfo } from './host'

/**
 * The Electron half of Foreman — and deliberately all of it.
 *
 * `./host.ts` holds the sessions, the trigger loop and the tools, and imports
 * no Electron at all so scripts/foreman-check.mjs can drive the whole loop head
 * -less. Everything that genuinely needs the app is here: the window to push
 * at, the settings store, the PTY host, the renderer round trip, and the
 * ipcMain wiring. Keep it thin — anything with a decision in it belongs in the
 * host, where it can be tested.
 */

let target: BrowserWindow | null = null
let host: ForemanHost | null = null
let unsubscribeAttention: (() => void) | null = null

/**
 * Who else wants every Foreman state push, besides the window.
 *
 * Forge Web and Forge Mobile subscribe here when their links come up, so a
 * pane driven at the desk reaches the browser and the phone without any of the
 * three knowing about the others — the same fan-out shape `IPC.webAttention`
 * gives the attention badge. Each holds its own unsubscribe; the set is walked
 * defensively because a listener that throws must not cost the window its
 * push.
 */
const stateListeners = new Set<(state: ForemanState) => void>()

/**
 * Observe every Foreman state push from main, without going through the
 * renderer. Returns the unsubscribe; a listener that has gone away is not an
 * error and never will be.
 */
export function onForemanState(cb: (state: ForemanState) => void): () => void {
  stateListeners.add(cb)
  return () => {
    stateListeners.delete(cb)
  }
}

/** Renderer round trips in flight, keyed by request id. See `runAppAction`. */
const pending = new Map<string, { resolve: (text: string) => void; timer: ReturnType<typeof setTimeout> }>()

/** A tool round trip the renderer never answered. Never hang a job. */
const TOOL_TIMEOUT_MS = 15_000

/**
 * How far back into a transcript to read for `maxChars` of assistant text.
 *
 * A JSONL line carries far more than the text in it — tool blocks, ids,
 * timestamps, usage — so the bytes on disk are several times the prose. Six is
 * generous rather than exact; over-reading costs one seek, under-reading costs
 * Foreman the context it asked for.
 */
const TRANSCRIPT_BYTES_PER_CHAR = 6

function send(channel: string, payload: unknown): void {
  if (!target || target.isDestroyed()) return
  target.webContents.send(channel, payload)
}

/**
 * The forge-bridge MCP server, read back out of the config Forge already
 * generated for its Claude panes — the same trick, and the same reason, as
 * ../voice-agent/ipc.ts.
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
    console.error('[foreman] could not read the bridge config:', err)
    return null
  }
}

/* ------------------------------------------------------------------- panes */

/** One live pane, in the shape the host reads. */
function paneInfo(paneId: string): ForemanPaneInfo | null {
  const session = getManager()
    .list()
    .find((s) => s.id === paneId)
  if (!session) return null
  const live = liveSessions().find((s) => s.id === paneId)
  return {
    id: paneId,
    cwd: session.cwd ?? '',
    projectName: live?.projectName ?? '',
    title: live?.paneTitle ?? '',
    sessionId: paneSessionId(paneId),
    agent: live?.agent ?? false
  }
}

function listPanes(): ForemanPaneInfo[] {
  return liveSessions()
    .map((s) => paneInfo(s.id))
    .filter((p): p is ForemanPaneInfo => p !== null)
}

/**
 * The Claude session uuid Forge minted for a pane, out of the saved layout.
 *
 * The same two-places-one-fact walk electron/web-host.ts does for the chat
 * view, and for the same reason: the pane's *folder* comes from the live PTY
 * session, and its Claude session uuid lives in `PaneLeaf.sessionId`, which is
 * the field resume-on-restore reads. Anything that is not a real UUID could not
 * name a transcript Claude Code wrote, so it is refused rather than turned into
 * a path.
 */
function paneSessionId(paneId: string): string {
  for (const project of getProjects()) {
    const workspace = getWorkspace(project.id)
    if (!workspace) continue
    for (const tab of workspace.tabs) {
      const leaf = findLeaf(tab.root, paneId)
      if (leaf) return isSessionId(leaf.sessionId) ? leaf.sessionId : ''
    }
  }
  return ''
}

/** One pane in a split tree, by id. */
function findLeaf(node: LayoutNode, paneId: string): Extract<LayoutNode, { type: 'leaf' }> | null {
  if (node.type === 'leaf') return node.id === paneId ? node : null
  return findLeaf(node.a, paneId) ?? findLeaf(node.b, paneId)
}

/* -------------------------------------------------------------- transcript */

/**
 * The recent assistant prose out of a pane's Claude transcript.
 *
 * Read from the end of the file rather than parsed from the start, for the
 * reason electron/jsonl-tail.ts spells out at length: a project whose Claude
 * pane has been going all week has a transcript hundreds of megabytes long, and
 * "read the file" is not a thing this process gets to do to it.
 *
 * Best-effort throughout. A pane with no transcript, a half-written line, a
 * file somebody moved — all of them answer '' and Foreman falls back to the
 * screen, which is never wrong, only thinner.
 */
function readTranscript(paneId: string, maxChars: number): string {
  const info = paneInfo(paneId)
  if (!info?.cwd || !info.sessionId) return ''
  let fd: number | null = null
  try {
    const file = transcriptPath(info.cwd, info.sessionId)
    const size = statSync(file).size
    const want = Math.min(size, Math.max(4096, maxChars * TRANSCRIPT_BYTES_PER_CHAR))
    const start = size - want
    const buffer = Buffer.alloc(want)
    fd = openSync(file, 'r')
    readSync(fd, buffer, 0, want, start)
    // The first line of a mid-file read is half a line. Dropping it is cheaper
    // and safer than trying to decode it.
    const lines = buffer.toString('utf8').split('\n')
    if (start > 0) lines.shift()

    const parts: string[] = []
    for (const line of lines) {
      const text = assistantText(line)
      if (text) parts.push(text)
    }
    const joined = parts.join('\n\n')
    return joined.length <= maxChars ? joined : joined.slice(joined.length - maxChars)
  } catch {
    return ''
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd)
      } catch {
        // A descriptor that will not close is not a reason to fail a read that
        // already succeeded.
      }
    }
  }
}

/** The prose out of one transcript line, or '' for anything else. */
function assistantText(line: string): string {
  const trimmed = line.trim()
  if (!trimmed || trimmed[0] !== '{') return ''
  try {
    const entry = JSON.parse(trimmed) as {
      type?: string
      message?: { role?: string; content?: unknown }
    }
    if (entry.type !== 'assistant' || entry.message?.role !== 'assistant') return ''
    const content = entry.message.content
    if (typeof content === 'string') return content
    if (!Array.isArray(content)) return ''
    return content
      .filter((b): b is { type: string; text: string } => {
        const block = b as { type?: unknown; text?: unknown }
        return block?.type === 'text' && typeof block.text === 'string'
      })
      .map((b) => b.text)
      .join('\n')
      .trim()
  } catch {
    return ''
  }
}

/* ------------------------------------------------------- the renderer trip */

/**
 * Ask the renderer to do something and wait, but never for ever.
 *
 * Only the renderer knows what is open, so opening a pane is a question asked
 * of it — the same request/answer pair the voice agent uses, on its own channel
 * because that one is single-tenant: `voice-agent:tool-request` is consumed by
 * src/state/VoiceAgent.tsx and answered on `voice-agent:tool-result`, and two
 * hosts sharing it would have each other's answers resolving their promises.
 *
 * A timeout resolves with an error *string* rather than rejecting: a rejected
 * MCP handler is an exception in the model's turn, whereas "Forge did not
 * answer" is a fact it can carry on from.
 */
function runAppAction(action: Record<string, unknown>): Promise<string> {
  return new Promise<string>((resolve) => {
    const id = randomUUID()
    const timer = setTimeout(() => {
      pending.delete(id)
      resolve(`Forge did not answer within ${TOOL_TIMEOUT_MS / 1000} seconds. Nothing was opened.`)
    }, TOOL_TIMEOUT_MS)
    pending.set(id, { resolve, timer })
    try {
      send(IPC.foremanToolRequest, { id, name: 'run_app_action', args: action })
    } catch (err) {
      pending.delete(id)
      clearTimeout(timer)
      resolve(`Forge could not be reached: ${err instanceof Error ? err.message : String(err)}`)
    }
  })
}

/* -------------------------------------------------------------------- host */

function ensureHost(): ForemanHost {
  if (host) return host
  host = new ForemanHost({
    // Two doors for the same push: the window that draws the footer, and
    // whoever else asked — today the web and mobile links, whose browsers and
    // phones draw the same footer from the same object.
    sendState: (state) => {
      send(IPC.foremanState, state)
      for (const listener of stateListeners) {
        try {
          listener(state)
        } catch (err) {
          console.error('[foreman] a state listener failed:', err)
        }
      }
    },
    // The manager's own write, not `viewerWrite`: the grid follows the *typist*
    // (../pty/grid-owner.ts) and Foreman is not a device. Typing on the desk's
    // behalf must not take a pane's grid away from the phone that owns it.
    writePane: (paneId, data) => getManager().write(paneId, data),
    readScreen: (paneId) => getReplay(paneId),
    readTranscript,
    paneInfo,
    listPanes,
    getModel: () => getSettings().foremanModel || DEFAULT_FOREMAN_MODEL,
    getStandingBrief: () => getSettings().foremanBrief,
    runAppAction,
    getBridgeServer: bridgeServer
  })
  // The renderer's attention transitions are the trigger for the whole loop.
  // Subscribed here rather than in the host so the host stays Electron-free.
  unsubscribeAttention?.()
  unsubscribeAttention = onAttention((event) => host?.noteAttention(event))
  return host
}

/** Where Foreman's state pushes and its renderer questions go. */
export function setForemanTarget(win: BrowserWindow | null): void {
  target = win
  // The window that was drawing the jobs is gone, and with it every pending
  // round trip. A Foreman left driving would be typing into panes nobody can
  // see, with no way to switch it off.
  if (!win && host) {
    for (const state of host.list()) {
      if (state.status !== 'off' && state.status !== 'done') host.stop(state.paneId)
    }
  }
}

/* ---------------------------------------------------- the second front door
 *
 * The same three verbs the IPC handlers expose, as functions for the other
 * links this process serves — Forge Web and Forge Mobile, whose browsers and
 * phones flip the same switch the desktop's footer does. They call what the
 * handlers call, never pretending to be a window: one host, one loop, one set
 * of decisions, whichever surface asked.
 */

/**
 * Switch Foreman on for one pane. The kit install lives here rather than in
 * the handler so a start asked from a browser gets the skills and agents
 * Foreman drives the pane with exactly as a click at the desk does.
 */
export function foremanStart(request: ForemanStartRequest): ForemanState {
  // The skills and agents Foreman drives the pane with (/gaffer, /fable-method,
  // the gaffer crew) ship inside Forge and land in this machine's Claude home
  // the first time Foreman is switched on. Idempotent, and never overwrites a
  // file the user wrote themselves — see ./kit.ts.
  const kitDir = foremanKitDir()
  if (kitDir) {
    const report = installForemanKit({ kitDir, claudeHome: claudeHome() })
    for (const f of report.failed) console.error(`[foreman:kit] ${f.name}: ${f.error}`)
  }
  return ensureHost().start(request ?? { paneId: '', seed: '' })
}

/** Never lazily starts a host: stopping something that is not running is a no-op, not a reason to build one. */
export function foremanStop(paneId: string): ForemanState {
  return host ? host.stop(String(paneId ?? '')) : idleForemanState(String(paneId ?? ''))
}

/** A word in Foreman's ear. Same rule as stop: no host means nobody is being driven, so nobody is listening. */
export function foremanSay(request: ForemanSayRequest): ForemanState {
  const paneId = String(request?.paneId ?? '')
  return host ? host.say({ paneId, text: String(request?.text ?? '') }) : idleForemanState(paneId)
}

/** Every pane main is holding Foreman state for. Empty until anything has been driven. */
export function foremanList(): ForemanState[] {
  return host?.list() ?? []
}

export function registerForemanHandlers(): void {
  ipcMain.handle(IPC.foremanStart, (_e, request: ForemanStartRequest): ForemanState => foremanStart(request))
  // Never lazily starts a host: stopping something that is not running is a
  // no-op, not a reason to build one.
  ipcMain.handle(IPC.foremanStop, (_e, paneId: string): ForemanState => foremanStop(paneId))
  ipcMain.handle(IPC.foremanSay, (_e, request: ForemanSayRequest): ForemanState => foremanSay(request))
  ipcMain.handle(IPC.foremanList, (): ForemanState[] => foremanList())
  ipcMain.handle(IPC.foremanToolResult, (_e, result: { id?: string; ok?: boolean; result?: unknown; error?: string }): boolean => {
    const id = String(result?.id ?? '')
    const entry = pending.get(id)
    // Late, duplicate or invented — all three are the same non-event; the
    // timeout has already answered in the late case.
    if (!entry) return false
    pending.delete(id)
    clearTimeout(entry.timer)
    entry.resolve(
      result.ok
        ? typeof result.result === 'string'
          ? result.result
          : JSON.stringify(result.result ?? null)
        : `That failed: ${result.error?.trim() || 'the app did not say why'}`
    )
    return true
  })
}

export function disposeForeman(): void {
  unsubscribeAttention?.()
  unsubscribeAttention = null
  // The links that subscribed are being torn down with the app; leaving their
  // callbacks registered would keep every ForemanState alive past the exit.
  stateListeners.clear()
  for (const [, entry] of pending) clearTimeout(entry.timer)
  pending.clear()
  host?.dispose()
  host = null
  target = null
}
