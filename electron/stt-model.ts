import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { ipcMain, type BrowserWindow } from 'electron'
import { IPC } from '@shared/ipc'
import type { SttModelState } from '@shared/types'
import {
  CancelledError,
  HttpStatusError,
  MODEL_FILES,
  PARAKEET_NAME,
  PARAKEET_SIZE_HINT,
  downloadModel,
  inspectModel
} from './stt/model-download'
import { getDataDir, getSettings, setSettings } from './store'

/**
 * The speech model's Forge-side half: where it lives, whether it is there, and
 * fetching it when it is not.
 *
 * One download at a time, owned here rather than by the renderer, because it
 * outlives any particular window: closing the Settings popover mid-download must
 * not abandon 600 MB. The renderer only ever starts one, cancels one, or watches
 * `stt:download-progress`.
 *
 * The bytes themselves are handled by ./stt/model-download.ts, which is kept
 * Electron-free so the resume and validation logic can be tested against a local
 * server (scripts/stt-download-test.mjs).
 */

let target: BrowserWindow | null = null
let controller: AbortController | null = null
let state: SttModelState = {
  status: 'unknown',
  dir: '',
  bytes: 0,
  totalBytes: 0,
  fraction: 0,
  file: '',
  message: '',
  sizeHint: PARAKEET_SIZE_HINT
}

export function setSttModelTarget(win: BrowserWindow | null): void {
  target = win
}

function send(channel: string, payload: unknown): void {
  if (!target || target.isDestroyed()) return
  target.webContents.send(channel, payload)
}

/* ------------------------------------------------------------- discovery */

/** Where Forge puts a model it downloaded itself. */
export function forgeModelDir(): string {
  return join(getDataDir(), 'models', PARAKEET_NAME)
}

/**
 * The model folder to use when settings.json has not named one.
 *
 * Forge's own copy wins; failing that, a machine that already has DictationMic
 * has already paid the 660 MB, so borrow it rather than fetch a second copy.
 * On anyone else's machine both are absent and the answer is the empty string —
 * which the sidecar reports as `model-missing`, which is the setup card.
 */
export function defaultModelDir(): string {
  const own = forgeModelDir()
  if (existsSync(own)) return own
  const dictationMic = join(homedir(), 'Desktop', 'DictationMic', 'models', PARAKEET_NAME)
  if (existsSync(dictationMic)) return dictationMic
  return ''
}

/** The folder dictation will actually read: the setting, or the default. */
export function activeModelDir(): string {
  const configured = getSettings().sttModelDir.trim()
  return configured || defaultModelDir()
}

/* ------------------------------------------------------------------ state */

function patch(next: Partial<SttModelState>): void {
  state = { ...state, ...next }
  send(IPC.sttDownloadProgress, state)
}

/** Look at the disk and publish what is there. */
export async function refreshModelState(): Promise<SttModelState> {
  if (state.status === 'downloading') return state
  const dir = activeModelDir()
  const report = await inspectModel(dir)
  state = {
    ...state,
    status: report.presence === 'ready' ? 'ready' : report.presence === 'partial' ? 'partial' : 'missing',
    dir,
    bytes: report.bytes,
    totalBytes: report.expectBytes,
    fraction: report.expectBytes ? Math.min(1, report.bytes / report.expectBytes) : 0,
    file: '',
    message:
      report.presence === 'ready'
        ? 'The speech model is installed.'
        : report.presence === 'partial'
          ? `A partly downloaded model is in ${dir || 'no folder yet'} — it will resume where it left off.`
          : `The speech model is not downloaded yet (${PARAKEET_SIZE_HINT}).`
  }
  return state
}

/* -------------------------------------------------------------- download */

/**
 * Fetch the model into Forge's own folder, and point the setting at it when it
 * lands. Safe to call while one is already running — the running one is
 * returned rather than a second one started.
 */
export async function startDownload(): Promise<SttModelState> {
  if (controller) return state

  const dir = forgeModelDir()
  const ac = new AbortController()
  controller = ac

  patch({
    status: 'downloading',
    dir,
    file: MODEL_FILES[0]!.name,
    fraction: 0,
    bytes: 0,
    totalBytes: MODEL_FILES.reduce((n, f) => n + f.expectBytes, 0),
    message: `Fetching the speech model (${PARAKEET_SIZE_HINT}). This runs once.`
  })

  try {
    const report = await downloadModel({
      dir,
      signal: ac.signal,
      onProgress: (p) => {
        if (controller !== ac) return
        patch({
          status: 'downloading',
          file: p.file,
          fraction: p.fraction,
          bytes: p.bytes,
          totalBytes: p.totalBytes,
          message:
            p.phase === 'waiting'
              ? `Waiting for the network — retrying ${p.file}${p.detail ? ` (${p.detail})` : ''}`
              : p.phase === 'verifying'
                ? `Checking ${p.file}`
                : `Downloading ${p.file}`
        })
      }
    })

    controller = null
    // Nail the setting to what we just fetched, so the sidecar looks in the
    // right place even if it was pointed somewhere stale.
    if (getSettings().sttModelDir.trim() !== dir) setSettings({ sttModelDir: dir })
    state = {
      ...state,
      status: 'ready',
      dir,
      file: '',
      fraction: 1,
      bytes: report.bytes,
      totalBytes: report.expectBytes,
      message: 'The speech model is installed.'
    }
    send(IPC.sttDownloadDone, state)
    return state
  } catch (err) {
    controller = null
    const cancelled = err instanceof CancelledError
    const message = cancelled
      ? 'Download cancelled — what has been fetched is kept, so it can resume.'
      : err instanceof HttpStatusError
        ? `Could not reach the model host (${err.message}).`
        : ((err as Error)?.message ?? String(err))

    const report = await inspectModel(dir)
    state = {
      ...state,
      status: report.presence === 'ready' ? 'ready' : report.presence === 'partial' ? 'partial' : 'missing',
      dir,
      file: '',
      bytes: report.bytes,
      totalBytes: report.expectBytes,
      fraction: report.expectBytes ? Math.min(1, report.bytes / report.expectBytes) : 0,
      message
    }
    if (!cancelled) console.error(`[stt-model] ${message}`)
    send(cancelled ? IPC.sttDownloadDone : IPC.sttDownloadError, state)
    return state
  }
}

export function cancelDownload(): SttModelState {
  controller?.abort()
  return state
}

/* -------------------------------------------------------------------- ipc */

export function registerSttModelHandlers(): void {
  ipcMain.handle(IPC.sttDownloadModel, () => startDownload())
  ipcMain.handle(IPC.sttDownloadCancel, () => cancelDownload())
  ipcMain.handle(IPC.sttDownloadState, () => refreshModelState())
}

export function disposeSttModel(): void {
  controller?.abort()
  controller = null
  target = null
}
