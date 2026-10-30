import { mkdirSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { app, ipcMain, type BrowserWindow } from 'electron'
import { IPC } from '@shared/ipc'
import type { TelegramStatus, TelegramTestResult } from '@shared/telegram'
import { getSettings, setSettings } from '../store'
import { transcribeAudio } from '../voice-bridge'
import {
  answerConfirm,
  askBrain,
  brainStatus,
  freshStartBrain,
  onBrainSays,
  onBrainStatus,
  sendToBrain
} from '../brain/host'
import { createTelegramApi } from './api'
import { TelegramChannel } from './channel'

/**
 * The Electron half of the Telegram plugin: the real dependencies, the window
 * to push at and the ipcMain wiring. Everything with a decision in it is in
 * ./channel.ts.
 *
 * `telegramEnabled`, `telegramChatId` and `telegramChatName` are main-owned
 * settings (electron/main.ts MAIN_OWNED_SETTINGS): they change only through
 * `setEnabled`, `pair` and `unpair` here, so the renderer's stale whole-object
 * save cannot unpair the chat or switch the bot off. The token is an ordinary
 * renderer setting typed in a form; `applyTelegramSettings` is what
 * electron/main.ts calls when it changed.
 */

let channel: TelegramChannel | null = null
let target: BrowserWindow | null = null
let unsubscribe: (() => void) | null = null

function send(channelName: string, payload: unknown): void {
  if (!target || target.isDestroyed()) return
  target.webContents.send(channelName, payload)
}

function inboxDir(): string {
  return join(app.getPath('userData'), 'telegram-inbox')
}

function saveInboxFile(name: string, bytes: Uint8Array): string {
  const dir = inboxDir()
  mkdirSync(dir, { recursive: true })
  const path = join(dir, basename(name))
  writeFileSync(path, bytes)
  return path
}

function getChannel(): TelegramChannel {
  channel ??= new TelegramChannel({
    api: (token) => createTelegramApi(token),
    brain: {
      ask: askBrain,
      send: sendToBrain,
      status: brainStatus,
      onStatus: onBrainStatus,
      onSays: onBrainSays,
      answerConfirm,
      freshStart: freshStartBrain
    },
    settings: { get: getSettings, set: (patch) => void setSettings(patch) },
    transcribe: transcribeAudio,
    saveInboxFile,
    log: {
      info: (message) => console.log(`[telegram] ${message}`),
      warn: (message) => console.warn(`[telegram] ${message}`)
    }
  })
  return channel
}

/** Where status pushes go. */
export function setTelegramTarget(win: BrowserWindow | null): void {
  target = win
}

/** The token, the switch or the chat changed in settings: start, stop or restart the bot. */
export function applyTelegramSettings(): void {
  channel?.apply()
}

export function registerTelegramHandlers(): void {
  const c = getChannel()
  ipcMain.handle(IPC.telegramStatus, (): TelegramStatus => c.status())
  ipcMain.handle(IPC.telegramSetEnabled, (_e, enabled: unknown): TelegramStatus => c.setEnabled(enabled === true))
  ipcMain.handle(IPC.telegramPair, (): TelegramStatus => c.pair())
  ipcMain.handle(IPC.telegramUnpair, (): TelegramStatus => c.unpair())
  ipcMain.handle(IPC.telegramTest, (): Promise<TelegramTestResult> => c.test())
  unsubscribe ??= c.onStatus((status) => send(IPC.telegramState, status))
  // Off by default: with `telegramEnabled: false` this touches no network.
  c.apply()
}

export function disposeTelegram(): void {
  unsubscribe?.()
  unsubscribe = null
  target = null
  channel?.dispose()
  channel = null
}
