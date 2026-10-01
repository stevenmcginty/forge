import { ipcMain, type BrowserWindow } from 'electron'
import { IPC } from '@shared/ipc'
import {
  isBrainEngine,
  type BrainAskResult,
  type BrainConfirmAnswer,
  type BrainEngine,
  type BrainFreshStartResult,
  type BrainSendResult,
  type BrainStatus
} from '@shared/brain'
import type { ChatUpdate } from '@shared/chat'
import { getSettings, setSettings } from '../store'
import {
  answerConfirm,
  applyBrainSettings,
  askBrain,
  brainStatus,
  disposeBrain,
  freshStartBrain,
  initBrain,
  notePaneBusy,
  onBrainSays,
  onBrainStatus,
  sendToBrain,
  stopBrainTranscript,
  watchBrainTranscript
} from './host'

/**
 * The Electron half of Forge Brain: the window to push at and the ipcMain
 * wiring. Everything with a decision in it is in ./host.ts.
 *
 * `brainEnabled` and `brainEngine` are main-owned settings (electron/main.ts
 * MAIN_OWNED_SETTINGS): a surface changes them only through `enable`,
 * `disable` and `setEngine` here or Forge Web's brain ops, so a renderer's
 * stale settings copy can never switch the brain off behind a browser's back.
 * `brainModel` is an ordinary renderer setting; `applyBrainModel` is what
 * electron/main.ts calls when it changed.
 */

let target: BrowserWindow | null = null
let unsubscribe: (() => void) | null = null
let unsubscribeSays: (() => void) | null = null

function send(channel: string, payload: unknown): void {
  if (!target || target.isDestroyed()) return
  target.webContents.send(channel, payload)
}

const toRenderer = (update: ChatUpdate): void => send(IPC.brainTranscript, update)

/** Where status and transcript pushes go. */
export function setBrainTarget(win: BrowserWindow | null): void {
  target = win
  if (!win) stopBrainTranscript()
}

/** Turn the brain on or off, and bring it in line. The one way either setting changes. */
export function setBrainEnabled(on: boolean): Promise<BrainStatus> {
  if (getSettings().brainEnabled !== on) setSettings({ brainEnabled: on })
  return applyBrainSettings()
}

/** Pick the engine; a running brain restarts on it. */
export function setBrainEngine(engine: BrainEngine): Promise<BrainStatus> {
  if (!isBrainEngine(engine)) return Promise.resolve(brainStatus())
  if (getSettings().brainEngine !== engine) setSettings({ brainEngine: engine })
  return applyBrainSettings()
}

/** The model setting changed: a running Claude brain restarts on it, keeping its conversation. */
export function applyBrainModel(): void {
  void applyBrainSettings()
}

export function registerBrainHandlers(): void {
  ipcMain.handle(IPC.brainStatus, (): BrainStatus => brainStatus())
  ipcMain.handle(IPC.brainEnable, (): Promise<BrainStatus> => setBrainEnabled(true))
  ipcMain.handle(IPC.brainDisable, (): Promise<BrainStatus> => setBrainEnabled(false))
  ipcMain.handle(IPC.brainSetEngine, (_e, engine: unknown): Promise<BrainStatus> =>
    setBrainEngine(isBrainEngine(engine) ? engine : getSettings().brainEngine)
  )
  ipcMain.handle(IPC.brainSend, (_e, text: unknown): BrainSendResult => sendToBrain(String(text ?? '')))
  ipcMain.handle(IPC.brainAsk, (_e, text: unknown, timeoutMs: unknown): Promise<BrainAskResult> =>
    askBrain(String(text ?? ''), typeof timeoutMs === 'number' ? timeoutMs : undefined)
  )
  ipcMain.handle(IPC.brainConfirm, (_e, answer: BrainConfirmAnswer): boolean =>
    answerConfirm({ id: String(answer?.id ?? ''), allow: answer?.allow === true })
  )
  ipcMain.handle(IPC.brainFreshStart, (): Promise<BrainFreshStartResult> => freshStartBrain())
  ipcMain.handle(IPC.brainTranscriptWatch, (): boolean => watchBrainTranscript(toRenderer))
  ipcMain.handle(IPC.brainTranscriptStop, (): void => stopBrainTranscript())
  unsubscribe ??= onBrainStatus((status) => send(IPC.brainState, status))
  unsubscribeSays ??= onBrainSays((event) => send(IPC.brainSays, event))
  // The renderer's busy light, heard beside Forge Web's own listener
  // (electron/web-host.ts): how the brain knows a pane it opened has stopped.
  ipcMain.on(IPC.webBusy, (_e, payload: { sessionId?: string; busy?: boolean }) => {
    const paneId = String(payload?.sessionId ?? '')
    if (paneId) notePaneBusy(paneId, Boolean(payload?.busy))
  })
  // Starts the pane when the brain was on at the last quit; nothing at all when it is off.
  initBrain()
}

export function disposeBrainIpc(): void {
  unsubscribe?.()
  unsubscribe = null
  unsubscribeSays?.()
  unsubscribeSays = null
  target = null
  disposeBrain()
}
