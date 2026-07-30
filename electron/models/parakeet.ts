import { createWriteStream } from 'node:fs'
import { mkdir, rename, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'

/**
 * The Parakeet downloader.
 *
 * Forge reuses DictationMic's already-downloaded model when it can — that is
 * the whole reason the model path is a setting. This exists for the case where
 * there is no DictationMic: 660 MB of ONNX, over a domestic connection, with
 * the laptop lid closing halfway through. So it is resumable (HTTP Range into a
 * `.part` file), it retries through a dropped connection rather than starting
 * again, and it verifies size before it will call a file good — a truncated
 * download and an HTML error page both look like a model file otherwise.
 *
 * Ported from DictationMic's app.py (`fetch_resumable` / `download_parakeet`),
 * including the two behaviours that took a real download to discover: a server
 * that answers a Range request with 200 has thrown your resume away and you
 * must start the file over, and a 416 means you already have all of it.
 *
 * This module deliberately imports nothing from Electron: it is exercised
 * directly by `npm run models:check` against a local HTTP server.
 */

export const PARAKEET_NAME = 'parakeet-tdt-0.6b-v2'
export const PARAKEET_SIZE_HINT = '~660 MB'

const DEFAULT_BASE = 'https://huggingface.co/istupakov/parakeet-tdt-0.6b-v2-onnx/resolve/main/'

/**
 * File → minimum plausible size. The floor is what stops a 404 page, a captive
 * portal's login screen or half a file from passing for a model.
 */
export const PARAKEET_FILES: Array<{ name: string; minBytes: number }> = [
  { name: 'config.json', minBytes: 50 },
  { name: 'vocab.txt', minBytes: 5_000 },
  { name: 'decoder_joint-model.int8.onnx', minBytes: 5_000_000 },
  { name: 'encoder-model.int8.onnx', minBytes: 500_000_000 }
]

/** Roughly what the whole set weighs — used for the progress bar's denominator. */
export const PARAKEET_TOTAL_HINT = 692_000_000

export interface FileState {
  name: string
  bytes: number
  ok: boolean
}

/** Size of a file, or 0 if it is not there. Never throws. */
export async function sizeOf(path: string): Promise<number> {
  try {
    const s = await stat(path)
    return s.isFile() ? s.size : 0
  } catch {
    return 0
  }
}

/**
 * Is there a usable model in `dir`? Reports every file so the settings card can
 * say *which* one is missing rather than just "no".
 */
export async function inspectModelDir(
  dir: string,
  files: Array<{ name: string; minBytes: number }> = PARAKEET_FILES
): Promise<{ complete: boolean; bytes: number; files: FileState[] }> {
  const out: FileState[] = []
  let bytes = 0
  for (const f of files) {
    const size = await sizeOf(join(dir, f.name))
    bytes += size
    out.push({ name: f.name, bytes: size, ok: size >= f.minBytes })
  }
  return { complete: out.every((f) => f.ok), bytes, files: out }
}

/* ---------------------------------------------------------------- fetching */

export interface FetchProgress {
  /** Bytes of *this file* on disk so far, including a resumed prefix. */
  received: number
  /** Total bytes of this file, or 0 when the server would not say. */
  total: number
}

export class DownloadCancelled extends Error {
  constructor() {
    super('cancelled')
    this.name = 'DownloadCancelled'
  }
}

/**
 * One HTTP fetch into `part`, resuming whatever a previous attempt left there.
 *
 * Returns the number of bytes the file now holds. Throws on an incomplete
 * transfer so the caller can retry — which, because the bytes are still in the
 * `.part` file, costs only what was actually lost.
 */
export async function fetchResumable(
  url: string,
  part: string,
  onProgress?: (p: FetchProgress) => void,
  signal?: AbortSignal,
  fetchImpl: typeof fetch = fetch
): Promise<number> {
  let existing = await sizeOf(part)
  const headers: Record<string, string> = { 'user-agent': 'Forge/1.0' }
  if (existing > 0) headers['range'] = `bytes=${existing}-`

  const res = await fetchImpl(url, { headers, signal, redirect: 'follow' })

  if (res.status === 416) {
    // Ranged past the end: we already have the whole thing.
    res.body?.cancel?.()
    return existing
  }
  if (!res.ok) {
    res.body?.cancel?.()
    const err = new Error(`HTTP ${res.status}`) as Error & { status?: number }
    err.status = res.status
    throw err
  }

  // A server that ignores Range answers 200 with the *whole* file. Appending
  // that to what we already have would produce a file that is the right size
  // and complete nonsense, so the resume is abandoned instead.
  const resumed = existing > 0 && res.status === 206
  if (existing > 0 && !resumed) existing = 0

  const declared = Number(res.headers.get('content-length') ?? 0)
  const total = Number.isFinite(declared) && declared > 0 ? existing + declared : 0

  let received = existing
  if (!res.body) throw new Error('empty response body')

  const sink = createWriteStream(part, { flags: resumed ? 'a' : 'w' })
  const source = Readable.fromWeb(res.body as Parameters<typeof Readable.fromWeb>[0])
  source.on('data', (chunk: Buffer) => {
    received += chunk.length
    onProgress?.({ received, total })
  })

  await pipeline(source, sink, { signal })

  if (total > 0 && received < total) throw new Error(`incomplete download (${received}/${total})`)
  return received
}

export interface DownloadOptions {
  dir: string
  baseUrl?: string
  files?: Array<{ name: string; minBytes: number }>
  signal?: AbortSignal
  /** Overall progress across the whole set. */
  onProgress?: (p: { file: string; received: number; total: number; fraction: number | null }) => void
  /** Attempts per file before giving up. */
  maxAttempts?: number
  /** Wait between attempts. Zero in tests. */
  retryDelayMs?: number
  fetchImpl?: typeof fetch
  /** Total-bytes estimate for the progress bar, when the server is coy. */
  totalHint?: number
}

export type DownloadResult =
  | { ok: true; bytes: number }
  | { ok: false; error: string; cancelled?: boolean }

const sleep = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    if (ms <= 0) return resolve()
    const t = setTimeout(resolve, ms)
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(t)
        reject(new DownloadCancelled())
      },
      { once: true }
    )
  })

function aborted(err: unknown, signal?: AbortSignal): boolean {
  if (signal?.aborted) return true
  const e = err as { name?: string }
  return e?.name === 'AbortError' || e?.name === 'DownloadCancelled'
}

/**
 * Fetch the whole model into `dir`, skipping files that are already there and
 * big enough. Progress is reported across the *set*, not per file, because "83%
 * of file 4 of 4" is not a thing anyone wants to have to translate.
 */
export async function downloadParakeet(options: DownloadOptions): Promise<DownloadResult> {
  const {
    dir,
    baseUrl = DEFAULT_BASE,
    files = PARAKEET_FILES,
    signal,
    onProgress,
    maxAttempts = 6,
    retryDelayMs = 4000,
    fetchImpl = fetch,
    totalHint = PARAKEET_TOTAL_HINT
  } = options

  await mkdir(dir, { recursive: true })

  // Bytes already banked in completed files, so the bar does not restart when
  // a resumed download picks up at file three.
  let banked = 0
  for (const f of files) {
    const size = await sizeOf(join(dir, f.name))
    if (size >= f.minBytes) banked += size
  }

  const estimate = Math.max(totalHint, banked)

  for (const f of files) {
    if (signal?.aborted) return { ok: false, error: 'cancelled', cancelled: true }

    const dest = join(dir, f.name)
    const have = await sizeOf(dest)
    if (have >= f.minBytes) continue

    const part = `${dest}.part`
    let lastError = 'unknown error'
    let done = false

    for (let attempt = 1; attempt <= maxAttempts && !done; attempt++) {
      try {
        const bytes = await fetchResumable(
          baseUrl + f.name,
          part,
          (p) => {
            const fraction = estimate > 0 ? Math.min(0.999, (banked + p.received) / estimate) : null
            onProgress?.({ file: f.name, received: banked + p.received, total: estimate, fraction })
          },
          signal,
          fetchImpl
        )
        if (bytes < f.minBytes) {
          // A short file is a broken file: throw the fragment away rather than
          // resume onto rubbish next time.
          await rm(part, { force: true })
          throw new Error(`${f.name} came back short (${bytes} bytes)`)
        }
        await rename(part, dest)
        banked += bytes
        done = true
      } catch (err) {
        if (aborted(err, signal)) return { ok: false, error: 'cancelled', cancelled: true }
        const status = (err as { status?: number }).status
        lastError = (err as Error).message || String(err)
        // A 4xx that is not 416 will not fix itself by waiting.
        if (typeof status === 'number' && status >= 400 && status < 500) break
        if (attempt < maxAttempts) {
          try {
            await sleep(retryDelayMs, signal)
          } catch {
            return { ok: false, error: 'cancelled', cancelled: true }
          }
        }
      }
    }

    if (!done) return { ok: false, error: `Could not fetch ${f.name}: ${lastError}` }
  }

  const final = await inspectModelDir(dir, files)
  if (!final.complete) {
    const missing = final.files.filter((f) => !f.ok).map((f) => f.name)
    return { ok: false, error: `Download finished but these are still wrong: ${missing.join(', ')}` }
  }
  onProgress?.({ file: '', received: final.bytes, total: final.bytes, fraction: 1 })
  return { ok: true, bytes: final.bytes }
}
