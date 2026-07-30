import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { ipcMain, type BrowserWindow } from 'electron'
import { IPC } from '@shared/ipc'
import type { SttModelSource, SttModelState } from '@shared/types'
import {
  CancelledError,
  HttpStatusError,
  MODEL_FILES,
  PARAKEET_NAME,
  PARAKEET_SIZE_HINT,
  downloadModel,
  inspectModel,
  type ModelFile
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
  source: 'none',
  dir: '',
  forgeDir: '',
  files: [],
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

/**
 * Where Forge puts a model it downloaded itself.
 *
 * Deliberately inside the data root, so FORGE_DATA_DIR isolates a test
 * instance's models too, and so deleting the data folder really does remove
 * everything Forge ever wrote. Not created here — the download creates it, and
 * a folder appearing because somebody opened Settings would make `existsSync`
 * checks elsewhere lie.
 */
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
  const dictationMic = dictationMicModelDir()
  if (existsSync(dictationMic)) return dictationMic
  return ''
}

/** Where DictationMic keeps its copy, whether or not that copy exists. */
export function dictationMicModelDir(): string {
  return join(homedir(), 'Desktop', 'DictationMic', 'models', PARAKEET_NAME)
}

/** The folder dictation will actually read: the setting, or the default. */
export function activeModelDir(): string {
  const configured = getSettings().sttModelDir.trim()
  return configured || defaultModelDir()
}

/** Windows paths differ in case and in trailing slashes; folders do not. */
function samePath(a: string, b: string): boolean {
  const tidy = (p: string): string => p.replace(/[\\/]+$/, '').toLowerCase()
  return Boolean(a) && tidy(a) === tidy(b)
}

/**
 * Whose model `dir` is — which decides what the settings card offers.
 *
 * "external" covers the folder somebody typed in by hand; it is not offered a
 * download because Forge would then quietly stop using the folder they chose.
 */
export function modelSourceFor(dir: string): SttModelSource {
  if (!dir) return 'none'
  if (samePath(dir, forgeModelDir())) return 'forge'
  if (samePath(dir, dictationMicModelDir())) return 'dictationmic'
  return 'external'
}

/* ------------------------------------------------------------------ state */

function patch(next: Partial<SttModelState>): void {
  state = { ...state, ...next, forgeDir: forgeModelDir() }
  send(IPC.sttDownloadProgress, state)
}

/**
 * Turn a look at the disk into the state the UI renders. One function, because
 * a refresh, a finished download and a failed download all have to agree about
 * what "ready" looks like — and when they drifted apart, the card showed a
 * progress bar next to the word "installed".
 */
async function settle(dir: string, message?: string, error?: string): Promise<SttModelState> {
  const report = await inspectModel(dir, modelSource().files)
  const status = report.presence === 'ready' ? 'ready' : report.presence === 'partial' ? 'partial' : 'missing'
  state = {
    ...state,
    status,
    source: status === 'missing' ? modelSourceFor(dir) : modelSourceFor(report.dir),
    dir,
    forgeDir: forgeModelDir(),
    files: report.files,
    bytes: report.bytes,
    totalBytes: report.expectBytes,
    fraction: report.expectBytes ? Math.min(1, report.bytes / report.expectBytes) : 0,
    file: '',
    message:
      message ??
      (report.presence === 'ready'
        ? 'The speech model is installed.'
        : report.presence === 'partial'
          ? `A partly downloaded model is in ${dir || 'no folder yet'} — it will resume where it left off.`
          : `The speech model is not downloaded yet (${PARAKEET_SIZE_HINT}).`),
    ...(error ? { error } : {})
  }
  if (!error) delete state.error
  return state
}

/** Look at the disk and publish what is there. */
export async function refreshModelState(): Promise<SttModelState> {
  if (state.status === 'downloading') return state
  return settle(activeModelDir())
}

/* ---------------------------------------------------------- the source */

/**
 * Where the model is fetched from, and what files to expect.
 *
 * `FORGE_MODEL_SOURCE` points at a JSON file `{ base, files: [{ name, minBytes,
 * expectBytes }] }` and replaces both. It exists because the only other way to
 * watch this download actually drive the settings card — the progress bar, the
 * cancel button, the state it lands in afterwards — is to fetch 660 MB, and
 * nobody does that twice. Point it at a local server serving a few kilobytes
 * and the whole path runs in a second.
 *
 * Unset in every normal run, including a packaged one, and read fresh each time
 * so a test can move it without restarting. Same shape of hook as
 * FORGE_DATA_DIR and FORGE_STT_FROZEN.
 */
function modelSource(): { base: string | undefined; files: ModelFile[] } {
  const override = (process.env['FORGE_MODEL_SOURCE'] ?? '').trim()
  if (!override) return { base: undefined, files: MODEL_FILES }
  try {
    const spec = JSON.parse(readFileSync(override, 'utf8')) as { base?: string; files?: ModelFile[] }
    const files = Array.isArray(spec.files) && spec.files.length > 0 ? spec.files : MODEL_FILES
    console.log(`[stt-model] FORGE_MODEL_SOURCE is set — fetching ${files.length} test file(s) from ${spec.base}`)
    return { base: spec.base, files }
  } catch (err) {
    console.error(`[stt-model] FORGE_MODEL_SOURCE could not be read, using the real host:`, err)
    return { base: undefined, files: MODEL_FILES }
  }
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
  const { base, files } = modelSource()
  const ac = new AbortController()
  controller = ac

  delete state.error
  patch({
    status: 'downloading',
    source: 'forge',
    dir,
    files: [],
    file: files[0]!.name,
    fraction: 0,
    bytes: 0,
    totalBytes: files.reduce((n, f) => n + f.expectBytes, 0),
    message: `Fetching the speech model (${PARAKEET_SIZE_HINT}). This runs once.`
  })

  try {
    await downloadModel({
      dir,
      ...(base ? { base } : {}),
      files,
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
    // right place even if it was pointed somewhere stale. This is the step that
    // actually turns dictation on — the bytes alone change nothing.
    if (getSettings().sttModelDir.trim() !== dir) setSettings({ sttModelDir: dir })
    send(IPC.sttDownloadDone, await settle(dir, 'The speech model is installed.'))
    return state
  } catch (err) {
    controller = null
    const cancelled = err instanceof CancelledError
    const message = cancelled
      ? 'Download cancelled — what has been fetched is kept, so it can resume.'
      : err instanceof HttpStatusError
        ? `Could not reach the model host (${err.message}).`
        : ((err as Error)?.message ?? String(err))

    await settle(dir, message, cancelled ? undefined : message)
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
