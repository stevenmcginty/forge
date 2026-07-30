import { ipcMain, type BrowserWindow } from 'electron'
import { join } from 'node:path'
import { IPC } from '@shared/ipc'
import type { EngineProgress, EngineState } from '@shared/types'
import { getModelsDir, getSettings, setSettings } from '../store'
import { downloadParakeet, inspectModelDir, PARAKEET_NAME } from './parakeet'

/**
 * The speech engine's state card, and the one download Forge is capable of.
 *
 * Three states the UI has to be able to tell apart, because the advice is
 * different in each:
 *
 *   dictationmic  DictationMic's model is right there and we are pointed at it.
 *                 Nothing to install; say so and get out of the way.
 *   forge         Forge downloaded its own copy into %APPDATA%\Forge\models.
 *   missing       The configured folder has no usable model. This is the only
 *                 state with an Install button.
 *
 * A download is a singleton: one at a time, cancellable, and progress is
 * broadcast rather than polled so the card can show a real bar.
 */

let target: BrowserWindow | null = null
let controller: AbortController | null = null
let lastProgress: EngineProgress | null = null

export function setEngineTarget(win: BrowserWindow | null): void {
  target = win
}

function emit(progress: EngineProgress): void {
  lastProgress = progress
  if (!target || target.isDestroyed()) return
  target.webContents.send(IPC.modelsEngineProgress, progress)
}

/** Forge's own model folder — where a download lands. */
export function forgeModelDir(): string {
  return join(getModelsDir(), PARAKEET_NAME)
}

export async function engineState(): Promise<EngineState> {
  const settings = getSettings()
  const configured = settings.sttModelDir
  const forgeDir = forgeModelDir()

  const found = configured ? await inspectModelDir(configured) : { complete: false, bytes: 0, files: [] }

  if (found.complete) {
    const isForge = configured.replace(/[\\/]+$/, '').toLowerCase() === forgeDir.toLowerCase()
    return {
      source: isForge ? 'forge' : 'dictationmic',
      dir: configured,
      bytes: found.bytes,
      forgeDir,
      files: found.files,
      downloading: controller !== null
    }
  }

  // Nothing at the configured path — but Forge may have downloaded one already
  // and the setting simply points somewhere else.
  const ours = await inspectModelDir(forgeDir)
  if (ours.complete) {
    return {
      source: 'forge',
      dir: forgeDir,
      bytes: ours.bytes,
      forgeDir,
      files: ours.files,
      downloading: controller !== null
    }
  }

  return {
    source: 'missing',
    dir: configured,
    bytes: found.bytes,
    forgeDir,
    files: found.files.length > 0 ? found.files : ours.files,
    downloading: controller !== null
  }
}

async function install(): Promise<EngineProgress> {
  if (controller) {
    return lastProgress ?? { fraction: null, file: '', receivedBytes: 0, totalBytes: 0 }
  }
  const dir = forgeModelDir()
  controller = new AbortController()
  emit({ fraction: null, file: '', receivedBytes: 0, totalBytes: 0 })

  try {
    const result = await downloadParakeet({
      dir,
      signal: controller.signal,
      onProgress: (p) =>
        emit({ fraction: p.fraction, file: p.file, receivedBytes: p.received, totalBytes: p.total })
    })

    if (result.ok) {
      // The sidecar reads its model path out of the store when it spawns, so
      // pointing the setting at what we just downloaded is what actually makes
      // dictation work — the download alone changes nothing.
      setSettings({ sttModelDir: dir })
      const done: EngineProgress = {
        fraction: 1,
        file: '',
        receivedBytes: result.bytes,
        totalBytes: result.bytes,
        done: 'ok'
      }
      emit(done)
      return done
    }

    const failed: EngineProgress = {
      fraction: lastProgress?.fraction ?? null,
      file: '',
      receivedBytes: lastProgress?.receivedBytes ?? 0,
      totalBytes: lastProgress?.totalBytes ?? 0,
      done: result.cancelled ? 'cancelled' : 'error',
      error: result.cancelled ? 'Cancelled' : result.error
    }
    emit(failed)
    return failed
  } finally {
    controller = null
  }
}

export function registerEngineHandlers(): void {
  ipcMain.handle(IPC.modelsEngineState, () => engineState())
  ipcMain.handle(IPC.modelsEngineInstall, () => install())
  ipcMain.handle(IPC.modelsEngineCancel, () => {
    controller?.abort()
  })
}

export function disposeEngineHost(): void {
  controller?.abort()
  controller = null
}
