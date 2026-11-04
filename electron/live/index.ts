import { ipcMain } from 'electron'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { McpServerConfig } from '@anthropic-ai/claude-agent-sdk'
import {
  DEFAULT_LIVE_CONDUCTOR_MODEL,
  DEFAULT_LIVE_VOICE_MODEL,
  LIVE_IPC,
  type LiveActionResult,
  type LiveAskOpts,
  type LiveEvent,
  type LiveJobAction,
  type LiveLatencySample,
  type LiveLedgerSnapshot,
  type LiveStatus
} from '@shared/live'
import type { Settings } from '@shared/types'
import { onAttention } from '../attention-bus'
import { bridgeConfigPath } from '../bridge/mcp-config'
import { getMainWindow } from '../main-window'
import { isMainMinimised } from '../minibar-window'
import { getDataDir, getSettings } from '../store'
import { askRendererTool, captureScreen } from '../voice-agent/ipc'
import { anthropicKeyOf } from './brain-helpers'
import { Conductor } from './conductor'
import { LiveLedger } from './ledger'
import type { LiveBrainContext, LiveConductor, LiveConductorFactory, LiveVoiceBrain, LiveVoiceBrainFactory } from './types'
import { createVoiceBrain } from './voice-brain'

/**
 * Claude Live's host in main (shared/live.ts, docs/live-agent-plan.md): the
 * job ledger, the `live:*` IPC behind `window.forge.live`, the `live:event`
 * push to the main window, and the status. The two brains sit behind
 * ./types.ts: ./voice-brain.ts and ./conductor.ts (./stubs.ts stays for tests).
 *
 * Same posture as the other hosts: `initLive` loads the ledger and registers
 * handlers. No brain starts, no key is read and no session opens until the
 * renderer calls `live.start()` or `live.ask()`.
 */

export interface LiveDeps {
  voiceBrain: LiveVoiceBrainFactory
  conductor: LiveConductorFactory
  getSettings: () => Settings
  getDataDir: () => string
}

let ledger: LiveLedger | null = null
let voice: LiveVoiceBrain | null = null
let conductor: LiveConductor | null = null
let started = false
let lastError: string | undefined
let readSettings: () => Settings = getSettings
let unsubscribers: Array<() => void> = []

/** Main-side listeners (Forge Web's host): every event, before the main window's filter. */
const listeners = new Set<(event: LiveEvent) => void>()
/** Turns asked from outside the main window (a phone): their replies are not the desk's to speak. */
const elsewhereTurns = new Set<string>()

/**
 * Push to the main window's renderer (dropped while there is none) and to the
 * main-side listeners. A turn asked from elsewhere (`liveAsk` with a `lane`)
 * keeps its `say` and `turn-end` off the main window: the desk would speak a
 * reply meant for the phone.
 */
export function emitLive(event: LiveEvent): void {
  for (const fn of listeners) {
    try {
      fn(event)
    } catch (err) {
      console.error('[live] a listener threw:', err)
    }
  }
  if (event.type === 'say' || event.type === 'turn-end') {
    const elsewhere = elsewhereTurns.has(event.turnId)
    if (event.type === 'turn-end') elsewhereTurns.delete(event.turnId)
    if (elsewhere) return
  }
  const win = getMainWindow()
  if (!win) return
  win.webContents.send(LIVE_IPC.event, event)
}

/** Every Live event, as main sees it (the web host's link). Returns the unsubscribe. */
export function onLiveEvent(fn: (event: LiveEvent) => void): () => void {
  listeners.add(fn)
  return () => {
    listeners.delete(fn)
  }
}

/** The ledger, for the brains and other hosts. Null before `initLive`. */
export function getLiveLedger(): LiveLedger | null {
  return ledger
}

export function liveStatus(): LiveStatus {
  const s = readSettings()
  const hasApiKey = Boolean(anthropicKeyOf(s))
  return {
    ready: started && !lastError,
    voiceModel: s.liveVoiceModel || DEFAULT_LIVE_VOICE_MODEL,
    conductorModel: s.liveConductorModel || DEFAULT_LIVE_CONDUCTOR_MODEL,
    // With a key the voice brain answers over the API; without one, the claude login.
    voiceRoute: hasApiKey ? 'api' : 'subscription',
    hasApiKey,
    conductorBusy: conductor?.busy() ?? false,
    ...(lastError ? { error: lastError } : {})
  }
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function pushStatus(): LiveStatus {
  const status = liveStatus()
  emitLive({ type: 'status', status })
  return status
}

async function startLive(): Promise<LiveStatus> {
  lastError = undefined
  try {
    await Promise.all([voice?.start(), conductor?.start()])
    started = true
  } catch (err) {
    lastError = errText(err)
    console.error('[live] start failed:', err)
  }
  return pushStatus()
}

async function stopLive(): Promise<void> {
  started = false
  await Promise.allSettled([voice?.stop(), conductor?.stop()])
  pushStatus()
}

async function jobAction(jobId: string, action: LiveJobAction): Promise<LiveActionResult> {
  const job = ledger?.get(String(jobId ?? ''))
  if (!job) return { ok: false, error: 'No such job.' }
  if (action === 'show') {
    if (!job.paneId) return { ok: false, error: 'This job has no pane to show.' }
    emitLive({ type: 'show', target: { kind: 'pane', paneId: job.paneId }, note: job.paneName || job.title })
    return { ok: true }
  }
  if (action === 'stop') {
    if (!conductor) return { ok: false, error: 'Claude Live is not running.' }
    try {
      return await conductor.cancel(job.id)
    } catch (err) {
      return { ok: false, error: errText(err) }
    }
  }
  return { ok: false, error: `Unknown action: ${String(action)}` }
}

/**
 * One user turn to the voice brain — the one conversation, wherever he said
 * it. Ends with exactly one `turn-end` for `turnId`, an error included. A
 * `lane` other than the desk's ('web': Forge Web) keeps the reply off the
 * main window (see `emitLive`). Resolves when the turn is over.
 */
export async function liveAsk(turnId: string, text: string, opts: LiveAskOpts = {}, lane: 'desk' | 'web' = 'desk'): Promise<void> {
  const id = String(turnId ?? '')
  if (!voice) {
    if (lane !== 'desk') elsewhereTurns.delete(id)
    for (const fn of listeners) fn({ type: 'turn-end', turnId: id, ok: false, error: 'Claude Live is not running on the desktop.' })
    return
  }
  if (lane !== 'desk') elsewhereTurns.add(id)
  try {
    await voice.ask(id, String(text ?? ''), { typed: opts.typed === true })
  } catch (err) {
    emitLive({ type: 'turn-end', turnId: id, ok: false, error: errText(err) })
  }
}

/** Barge-in on one turn: its reply stops, the jobs keep running. */
export async function liveCancel(turnId: string): Promise<void> {
  try {
    await voice?.cancel(String(turnId ?? ''))
  } catch (err) {
    console.error('[live] cancel failed:', err)
  }
}

/** A tap on a job card (desk or phone): stop it, or show its pane on the desk. */
export function liveJobAction(jobId: string, action: LiveJobAction): Promise<LiveActionResult> {
  return jobAction(jobId, action)
}

/** Warm the brains if nobody has yet (a phone opening Live). Never stops anything. */
export async function ensureLiveStarted(): Promise<LiveStatus> {
  return started ? liveStatus() : startLive()
}

/** A latency sample from Forge Web: the same line as the desk's, marked `web`. */
export function logWebLatency(sample: LiveLatencySample): void {
  logLatency(sample, 'web latency')
}

function ms(value: unknown): string {
  return typeof value === 'number' && Number.isFinite(value) ? `${Math.round(value)}ms` : '-'
}

/** One dev-log line per turn: `[live] latency turn=… eos→send=… …` (`web latency` for Forge Web's). */
function logLatency(sample: LiveLatencySample, label = 'latency'): void {
  if (!sample || typeof sample !== 'object') return
  const turn = String(sample.turnId ?? '').slice(0, 60)
  console.log(
    `[live] ${label} turn=${turn} eos→send=${ms(sample.eosToSendMs)} send→text=${ms(sample.sendToFirstTextMs)} ` +
      `text→audio=${ms(sample.firstTextToAudioMs)} eos→audio=${ms(sample.eosToAudioMs)} ack=${sample.ack === true}`
  )
}

/** The forge-bridge server out of the config Forge wrote for its panes, as electron/voice-agent/ipc.ts reads it. */
function bridgeServer(): McpServerConfig | null {
  const path = bridgeConfigPath()
  if (!path) return null
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as { mcpServers?: Record<string, McpServerConfig> }
    return parsed.mcpServers?.['forge-bridge'] ?? null
  } catch (err) {
    console.error('[live] could not read the bridge config:', err)
    return null
  }
}

/** The real brains, wired to main: the renderer round trip the voice agent uses, the screen, the data dir. */
const realVoiceBrain: LiveVoiceBrainFactory = (ctx) => createVoiceBrain(ctx, { askRenderer: askRendererTool })
const realConductor: LiveConductorFactory = (ctx) =>
  new Conductor(ctx, {
    askRenderer: askRendererTool,
    bridgeServer,
    captureScreen,
    getAssetsDir: () => join(getDataDir(), 'bridge-out'),
    getChromeProfileDir: () => join(getDataDir(), 'chrome-jarvis'),
    isForgeMinimised: isMainMinimised
  })

/**
 * Load the ledger, build the brains (the real ones unless told otherwise), register
 * the `live:*` handlers and feed pane attention into the ledger. Once.
 */
export function initLive(deps: Partial<LiveDeps> = {}): void {
  if (ledger) return
  readSettings = deps.getSettings ?? getSettings
  const dataDir = (deps.getDataDir ?? getDataDir)()
  ledger = new LiveLedger({ file: join(dataDir, 'live', 'ledger.jsonl') })
  ledger.load()

  const ctx: LiveBrainContext = {
    emit: emitLive,
    ledger,
    settings: () => readSettings(),
    conductor: () => conductor,
    statusChanged: () => void pushStatus()
  }
  // The Conductor first: it closes the jobs a restart lost before the voice brain starts watching for news.
  conductor = (deps.conductor ?? realConductor)(ctx)
  voice = (deps.voiceBrain ?? realVoiceBrain)(ctx)

  unsubscribers.push(ledger.subscribe((snapshot) => emitLive({ type: 'ledger', snapshot })))
  unsubscribers.push(
    onAttention((event) => {
      const news = ledger?.handleAttention(event)
      if (news) emitLive(news)
    })
  )

  ipcMain.handle(LIVE_IPC.ask, async (_e, turnId: unknown, text: unknown, opts?: LiveAskOpts): Promise<void> => {
    if (!voice) return
    await liveAsk(String(turnId ?? ''), String(text ?? ''), { typed: opts?.typed === true })
  })
  ipcMain.handle(LIVE_IPC.cancel, (_e, turnId: unknown): Promise<void> => liveCancel(String(turnId ?? '')))
  ipcMain.handle(LIVE_IPC.jobAction, (_e, jobId: string, action: LiveJobAction) => jobAction(jobId, action))
  ipcMain.handle(LIVE_IPC.ledger, (): LiveLedgerSnapshot => ledger?.snapshot() ?? { jobs: [], seq: 0 })
  ipcMain.handle(LIVE_IPC.status, (): LiveStatus => liveStatus())
  ipcMain.handle(LIVE_IPC.start, () => startLive())
  ipcMain.handle(LIVE_IPC.stop, () => stopLive())
  ipcMain.on(LIVE_IPC.latency, (_e, sample: LiveLatencySample) => logLatency(sample))
}

/** Quit: stop both brains and drop the subscriptions. The log is already on disk. */
export function disposeLive(): void {
  for (const off of unsubscribers) off()
  unsubscribers = []
  started = false
  void Promise.allSettled([voice?.stop(), conductor?.stop()])
  voice = null
  conductor = null
}
