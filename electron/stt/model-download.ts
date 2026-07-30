/**
 * Fetching the Parakeet speech model.
 *
 * Forge ships the dictation *engine* (a 129 MB PyInstaller folder) but not the
 * *model*: Parakeet TDT 0.6B is another ~660 MB, most people will never dictate,
 * and a 790 MB installer for a terminal app is absurd. So the model is fetched
 * on demand into %APPDATA%\Forge\models\parakeet-tdt-0.6b-v2 the first time
 * somebody asks for it.
 *
 * This is a port of DictationMic's `download_parakeet` / `fetch_resumable`
 * (app.py), which has already survived a lot of hotel wifi. The behaviour worth
 * keeping:
 *
 *  - **Resume.** Every file goes to `<name>.part` with a `Range:` header, so a
 *    dropped connection at 600 MB costs the last chunk, not the download.
 *  - **Wait rather than fail.** A network error is retried with a pause; only an
 *    HTTP error the server *means* (404, 401) is fatal.
 *  - **Size validation.** Each file has a minimum plausible size, so an HTML
 *    error page or a truncated body can never pass for a model. The same table
 *    guards the read side in stt_service.py — keep them in step.
 *  - **416 means done.** Ranging past the end of a complete `.part` is success.
 *
 * Kept free of Electron and of Forge's store so it can be driven directly by
 * scripts/stt-download-test.mjs against a local server. Only `import type` is
 * used, so the module runs unmodified under Node's type stripping.
 */

import { createWriteStream } from 'node:fs'
import { mkdir, rename, stat, unlink } from 'node:fs/promises'
import { join } from 'node:path'

export const PARAKEET_NAME = 'parakeet-tdt-0.6b-v2'
/** What to tell the user before they commit to it. */
export const PARAKEET_SIZE_HINT = '~660 MB'

export const PARAKEET_BASE = 'https://huggingface.co/istupakov/parakeet-tdt-0.6b-v2-onnx/resolve/main/'

export interface ModelFile {
  name: string
  /** Below this the file is a lie — an error page, or a truncated body. */
  minBytes: number
  /** Real size, used only to weight the progress bar before headers arrive. */
  expectBytes: number
}

/**
 * The four files onnx-asr needs, with the same floors stt_service.py enforces.
 * Ordered smallest first so an obviously broken base URL fails in a second
 * rather than after 600 MB.
 *
 * `expectBytes` are the sizes the host actually reports (checked with ranged
 * requests, not guessed), so the progress bar is honest before any
 * Content-Length arrives. They are only used for weighting — a file that comes
 * back a different size is judged by `minBytes`, never by these.
 */
export const MODEL_FILES: ModelFile[] = [
  { name: 'config.json', minBytes: 50, expectBytes: 97 },
  { name: 'vocab.txt', minBytes: 5_000, expectBytes: 9_384 },
  { name: 'decoder_joint-model.int8.onnx', minBytes: 5_000_000, expectBytes: 8_998_286 },
  { name: 'encoder-model.int8.onnx', minBytes: 500_000_000, expectBytes: 652_184_014 }
]

const CHUNK_LOG_BYTES = 262_144
const DEFAULT_RETRY_DELAY_MS = 4_000
const DEFAULT_MAX_ATTEMPTS = 20
const USER_AGENT = 'Forge/0.1 (+dictation model fetch)'

/* --------------------------------------------------------------- inspection */

export type ModelPresence = 'ready' | 'partial' | 'missing'

/**
 * One file as found. `ok` is the only judgement that matters — a file below its
 * floor is an error page or a truncation, not a model.
 */
export interface ModelFileReport {
  name: string
  bytes: number
  ok: boolean
}

export interface ModelReport {
  presence: ModelPresence
  dir: string
  /** Files absent or below their minimum size, in download order. */
  missing: string[]
  /**
   * Every expected file with what is actually on disk, in download order.
   *
   * `missing` above answers "what is wrong"; this answers "show me", which is
   * what the settings card needs — "no model here" is a dead end, whereas
   * "encoder-model.int8.onnx: 412 MB of 652 MB" tells you the download was
   * interrupted and will resume.
   */
  files: ModelFileReport[]
  /** Bytes on disk that count toward the model. */
  bytes: number
  /** Total the finished model will take. */
  expectBytes: number
}

async function sizeOf(path: string): Promise<number> {
  try {
    const s = await stat(path)
    return s.isFile() ? s.size : 0
  } catch {
    return 0
  }
}

/**
 * What is on disk. `partial` covers both a half-finished download and a folder
 * that has some files but not others; either way the fix is the same, so the
 * caller only ever has to distinguish "usable" from "not yet".
 */
export async function inspectModel(dir: string, files: ModelFile[] = MODEL_FILES): Promise<ModelReport> {
  const expectBytes = files.reduce((n, f) => n + f.expectBytes, 0)
  if (!dir) {
    return {
      presence: 'missing',
      dir,
      missing: files.map((f) => f.name),
      files: files.map((f) => ({ name: f.name, bytes: 0, ok: false })),
      bytes: 0,
      expectBytes
    }
  }

  const missing: string[] = []
  const found: ModelFileReport[] = []
  let bytes = 0
  for (const file of files) {
    const whole = await sizeOf(join(dir, file.name))
    if (whole >= file.minBytes) {
      bytes += whole
      found.push({ name: file.name, bytes: whole, ok: true })
      continue
    }
    missing.push(file.name)
    // A `.part` is real progress even though the file is not usable yet, and it
    // is the number the card should show: "412 MB of 652 MB, will resume".
    const partial = whole > 0 ? whole : await sizeOf(join(dir, `${file.name}.part`))
    bytes += partial
    found.push({ name: file.name, bytes: partial, ok: false })
  }

  const presence: ModelPresence = missing.length === 0 ? 'ready' : bytes > 0 ? 'partial' : 'missing'
  return { presence, dir, missing, files: found, bytes, expectBytes }
}

/* ------------------------------------------------------------------ errors */

/** An HTTP status the server meant. Retrying will not help. */
export class HttpStatusError extends Error {
  readonly status: number
  constructor(status: number, statusText: string, url: string) {
    super(`HTTP ${status} ${statusText} for ${url}`)
    this.name = 'HttpStatusError'
    this.status = status
  }
}

export class CancelledError extends Error {
  constructor() {
    super('The download was cancelled')
    this.name = 'CancelledError'
  }
}

function isCancel(err: unknown): boolean {
  if (err instanceof CancelledError) return true
  const name = (err as { name?: string })?.name
  return name === 'AbortError' || name === 'CancelledError'
}

/* -------------------------------------------------------------- one fetch */

export interface FetchProgress {
  /** Bytes of this file on disk, including whatever a previous run left. */
  received: number
  /** Total bytes for this file once headers are in, or 0 while unknown. */
  total: number
}

export interface FetchOptions {
  onProgress?: (p: FetchProgress) => void
  signal?: AbortSignal
  /** Injectable for the tests; defaults to the global. */
  fetchImpl?: typeof fetch
}

/**
 * One HTTP fetch into `part`, resuming whatever is already there.
 *
 * Returns the number of bytes the file holds afterwards. Throws
 * `HttpStatusError` for a status the server meant (the caller decides that 416
 * is success and 404 is not), and a plain Error for a broken body — which the
 * caller retries.
 */
export async function fetchResumable(url: string, part: string, opts: FetchOptions = {}): Promise<number> {
  const doFetch = opts.fetchImpl ?? fetch
  let existing = await sizeOf(part)

  const headers: Record<string, string> = { 'user-agent': USER_AGENT }
  if (existing > 0) headers['range'] = `bytes=${existing}-`

  const res = await doFetch(url, { headers, signal: opts.signal, redirect: 'follow' })
  if (!res.ok) throw new HttpStatusError(res.status, res.statusText, url)

  // A server that ignores `Range` answers 200 with the whole body; keeping the
  // old bytes then would corrupt the file, so start again from zero.
  if (existing > 0 && res.status !== 206) existing = 0

  const declared = Number(res.headers.get('content-length') ?? 0)
  const total = Number.isFinite(declared) && declared > 0 ? existing + declared : 0

  let done = existing
  opts.onProgress?.({ received: done, total })

  const body = res.body
  if (!body) throw new Error(`No response body for ${url}`)

  const out = createWriteStream(part, { flags: existing > 0 ? 'a' : 'w' })
  const reader = body.getReader()
  let sinceReport = 0

  try {
    for (;;) {
      if (opts.signal?.aborted) throw new CancelledError()
      const { done: finished, value } = await reader.read()
      if (finished) break
      if (!value) continue
      const chunk = Buffer.from(value.buffer, value.byteOffset, value.byteLength)
      if (!out.write(chunk)) await new Promise<void>((r) => out.once('drain', r))
      done += chunk.length
      sinceReport += chunk.length
      if (sinceReport >= CHUNK_LOG_BYTES) {
        sinceReport = 0
        opts.onProgress?.({ received: done, total })
      }
    }
  } finally {
    await new Promise<void>((resolve, reject) => {
      out.end((err?: Error | null) => (err ? reject(err) : resolve()))
    }).catch(() => {
      /* the throw already in flight is the more useful one */
    })
    try {
      await reader.cancel()
    } catch {
      /* already finished */
    }
  }

  opts.onProgress?.({ received: done, total })
  // A truncated body is the common shape of a dropped connection, and it is
  // exactly the case resume exists for — so complain and let the caller retry.
  if (total > 0 && done < total) throw new Error(`Incomplete download: ${done} of ${total} bytes`)
  return done
}

/* ----------------------------------------------------------- the whole set */

export type DownloadPhase = 'downloading' | 'waiting' | 'verifying'

export interface DownloadProgress {
  phase: DownloadPhase
  /** File being worked on. */
  file: string
  fileIndex: number
  fileCount: number
  /** 0..1 across the whole model, weighted by expected file sizes. */
  fraction: number
  /** Bytes fetched or already present, across the whole model. */
  bytes: number
  totalBytes: number
  /** Set while phase is `waiting`: why we are pausing, and for how long. */
  retryIn?: number
  detail?: string
}

export interface DownloadOptions {
  dir: string
  base?: string
  files?: ModelFile[]
  onProgress?: (p: DownloadProgress) => void
  signal?: AbortSignal
  /** Attempts per file before giving up. */
  maxAttempts?: number
  retryDelayMs?: number
  fetchImpl?: typeof fetch
  /** Injected by the tests so a retry does not cost four real seconds. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>
}

function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new CancelledError())
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = (): void => {
      clearTimeout(timer)
      reject(new CancelledError())
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

/**
 * Fetch every model file that is not already there, resuming and retrying.
 *
 * Resolves once all four files are present and big enough. Rejects with
 * `CancelledError` if the signal fires, `HttpStatusError` for a status that will
 * not improve, and a plain Error when the retries run out.
 */
export async function downloadModel(opts: DownloadOptions): Promise<ModelReport> {
  const files = opts.files ?? MODEL_FILES
  const base = opts.base ?? PARAKEET_BASE
  const maxAttempts = opts.maxAttempts ?? DEFAULT_MAX_ATTEMPTS
  const retryDelayMs = opts.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS
  const sleep = opts.sleep ?? defaultSleep
  const totalExpect = files.reduce((n, f) => n + f.expectBytes, 0)

  await mkdir(opts.dir, { recursive: true })

  /** Expected bytes of the files before this one — the progress bar's floor. */
  let doneExpect = 0

  const report = (
    phase: DownloadPhase,
    file: ModelFile,
    index: number,
    fileBytes: number,
    fileTotal: number,
    extra: { retryIn?: number; detail?: string } = {}
  ): void => {
    const expect = fileTotal > 0 ? fileTotal : file.expectBytes
    const within = expect > 0 ? Math.min(1, fileBytes / expect) : 0
    opts.onProgress?.({
      phase,
      file: file.name,
      fileIndex: index,
      fileCount: files.length,
      fraction: Math.min(1, (doneExpect + within * file.expectBytes) / totalExpect),
      bytes: doneExpect + fileBytes,
      totalBytes: totalExpect,
      ...extra
    })
  }

  for (const [index, file] of files.entries()) {
    const dest = join(opts.dir, file.name)
    const part = `${dest}.part`

    const already = await sizeOf(dest)
    if (already >= file.minBytes) {
      doneExpect += file.expectBytes
      continue
    }

    let attempt = 0
    let lastError: unknown = null
    for (;;) {
      if (opts.signal?.aborted) throw new CancelledError()
      attempt += 1
      try {
        let seen = await sizeOf(part)
        report('downloading', file, index, seen, 0)
        await fetchResumable(base + file.name, part, {
          signal: opts.signal,
          fetchImpl: opts.fetchImpl,
          onProgress: ({ received, total }) => {
            seen = received
            report('downloading', file, index, received, total)
          }
        })
        await rename(part, dest)
        lastError = null
        break
      } catch (err) {
        if (isCancel(err)) throw new CancelledError()
        // Ranged past the end of a `.part` that is in fact complete.
        if (err instanceof HttpStatusError && err.status === 416) {
          await rename(part, dest).catch(() => undefined)
          lastError = null
          break
        }
        // Anything else the server said on purpose is not going to improve.
        if (err instanceof HttpStatusError) throw err
        lastError = err
        if (attempt >= maxAttempts) break
        report('waiting', file, index, await sizeOf(part), 0, {
          retryIn: retryDelayMs,
          detail: (err as Error)?.message ?? String(err)
        })
        await sleep(retryDelayMs, opts.signal)
      }
    }

    if (lastError) {
      throw new Error(
        `Could not fetch ${file.name} after ${maxAttempts} attempts: ${(lastError as Error)?.message ?? String(lastError)}`
      )
    }

    // Validate rather than trust: a 200 with an HTML error page is a complete,
    // successful, useless download.
    report('verifying', file, index, file.expectBytes, 0)
    const size = await sizeOf(dest)
    if (size < file.minBytes) {
      await unlink(dest).catch(() => undefined)
      throw new Error(
        `${file.name} came back too small (${size} bytes, expected at least ${file.minBytes}) — that is not the model`
      )
    }
    doneExpect += file.expectBytes
  }

  return inspectModel(opts.dir, files)
}
