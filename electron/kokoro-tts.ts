import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { basename, extname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { app, BrowserWindow, net, protocol, session, type Session } from 'electron'
import { DEFAULT_KOKORO_VOICE, isKokoroVoice } from '@shared/tts'

/**
 * Kokoro — Claude Voice's voice. Kokoro-82M, local and free, run on the GPU.
 *
 * Measured on Steve's laptop (Core Ultra 5 226V, Arc 140V, 2026-11-04):
 * onnxruntime-node on the CPU is slower than real time (RTF 1.6-2.0) and its
 * DirectML provider fails on a ConvTranspose node, so neither is used. WebGPU
 * in Chromium is the road that works: fp16, model load ~2 s from disk, then
 * ~1 s for the audio of a short sentence (RTF ~0.3). So the engine is a page:
 *
 *   one hidden window   offscreen (never on any screen, no taskbar entry, and
 *                       like the browser mirrors' copies it does not keep
 *                       `window-all-closed` from firing — see guardQuit),
 *                       backgroundThrottling off, in its own partition
 *   the page            assets/kokoro/worker.html + worker.js + the vendored
 *                       kokoro-js browser bundle, served from forge-kokoro://
 *                       — a privileged scheme because WebGPU needs a secure
 *                       context and module scripts need a standard origin
 *   one job at a time   `speakKokoro` queues; a job whose signal fired, or
 *                       whose lane was dropped (`cancelKokoro`, barge-in), is
 *                       skipped before it reaches the GPU
 *
 * The model on disk. kokoro-js fetches the model, the tokenizer, the voices
 * (huggingface.co) and onnxruntime's wasm (cdn.jsdelivr.net) itself. The Cache
 * API it would keep them in refuses a custom scheme's origin (measured:
 * "An error occurred while opening the browser cache"), so this file
 * intercepts https in the engine's own partition instead: each of those
 * addresses is fetched once and kept as a file under `<userData>\kokoro\cache`
 * (about 177 MB with one voice), and every later launch is served from there
 * with no network at all. Anything else the page asks the network for is
 * refused.
 *
 * Never the only voice: everything here can say no (not loaded yet, no GPU, a
 * download that failed, a crashed page) and the caller then speaks the
 * sentence with Edge (electron/voice-bridge.ts, electron/web-host.ts).
 */

export const KOKORO_SCHEME = 'forge-kokoro'
const PARTITION = 'persist:forge-kokoro'
const PAGE_URL = `${KOKORO_SCHEME}://engine/worker.html`
/** The only files the scheme serves. */
const ENGINE_FILES = new Set(['worker.html', 'worker.js', 'kokoro.web.js'])
/** First launch downloads ~177 MB before the warm-up; later ones load in seconds. */
const WARM_TIMEOUT_MS = 10 * 60_000
/** One sentence. Warm, ~2 s for 110 characters; past this the page is wedged. */
const JOB_TIMEOUT_MS = 20_000
/** After a failed load, Edge speaks for this long before Kokoro is tried again. */
const RETRY_AFTER_MS = 60_000
/** Longest text sent to the page (the web's own speak cap). */
const TEXT_MAX = 900

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.wasm': 'application/wasm'
}

/**
 * The page may load its own files, run wasm, and reach the two hosts below —
 * which this file answers from disk. No frames, no forms, no plugins.
 */
const PAGE_CSP = [
  "default-src 'none'",
  `script-src ${KOKORO_SCHEME}: https://cdn.jsdelivr.net 'wasm-unsafe-eval'`,
  `connect-src ${KOKORO_SCHEME}: https://huggingface.co https://cdn.jsdelivr.net blob: data:`,
  `worker-src ${KOKORO_SCHEME}: blob:`,
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'"
].join('; ')

export type KokoroState = 'cold' | 'loading' | 'ready' | 'failed'

export interface KokoroStatus {
  state: KokoroState
  /** Why it failed, in the page's words. Empty otherwise. */
  reason: string
  /** The GPU WebGPU reported, e.g. "intel xe-2lpg". */
  adapter: string
  loadMs: number
  warmMs: number
}

export type KokoroResult =
  | { ok: true; audio: string; sampleRate: number; voice: string; ms: number }
  | { ok: false; kind: 'not-ready' | 'cancelled' | 'failed'; error: string }

interface PageWarm {
  ok: boolean
  status?: string
  reason?: string
  adapter?: string
  loadMs?: number
  warmMs?: number
}

interface PageSpeak {
  ok: boolean
  audio?: string
  sampleRate?: number
  ms?: number
  error?: string
}

interface Job {
  text: string
  voice: string
  lane: string
  signal: AbortSignal | undefined
  resolve: (result: KokoroResult) => void
}

let win: BrowserWindow | null = null
let ses: Session | null = null
let status: KokoroStatus = { state: 'cold', reason: '', adapter: '', loadMs: 0, warmMs: 0 }
let warming: Promise<void> | null = null
let failedAt = 0
let queue: Job[] = []
let running = false
/** Bumped by `cancelKokoro`, per lane: a job queued before the bump is dropped. */
const laneGen = new Map<string, number>()
const downloads = new Map<string, Promise<boolean>>()
let guarded = false
let disposed = false
/** When the page last crashed — three inside CRASH_WINDOW_MS and Kokoro rests as failed. */
let crashes: number[] = []
const CRASH_WINDOW_MS = 10 * 60_000

/**
 * Before `app.ready`, once. Electron allows a single registerSchemesAsPrivileged
 * call per app (each call replaces the last), and this is Forge's only one —
 * forge-artifact:// is deliberately unprivileged (electron/artifact-scheme.ts).
 */
export function registerKokoroScheme(): void {
  protocol.registerSchemesAsPrivileged([
    { scheme: KOKORO_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } }
  ])
}

export function kokoroStatus(): KokoroStatus {
  return { ...status }
}

/** Where the engine page lives, dev and packaged — the same shape as foremanKitDir(). */
function engineDir(): string | null {
  const appPath = app.getAppPath()
  const candidates = [
    join(__dirname, '..', '..', 'assets', 'kokoro'),
    join(appPath, 'assets', 'kokoro'),
    process.resourcesPath ? join(process.resourcesPath, 'kokoro') : '',
    join(`${appPath}.unpacked`, 'assets', 'kokoro')
  ]
  const found = candidates.find((dir) => dir && existsSync(join(dir, 'worker.html'))) ?? null
  if (!found) console.error('[kokoro] engine page not found; tried:\n  ' + candidates.filter(Boolean).join('\n  '))
  return found
}

function cacheDir(): string {
  const dir = join(app.getPath('userData'), 'kokoro', 'cache')
  mkdirSync(dir, { recursive: true })
  return dir
}

/** The network addresses the page may have, and so the ones kept on disk. */
function cacheable(url: URL): boolean {
  if (url.protocol !== 'https:') return false
  if (url.hostname === 'huggingface.co') return url.pathname.startsWith('/onnx-community/Kokoro-82M-v1.0-ONNX/')
  if (url.hostname === 'cdn.jsdelivr.net') return url.pathname.startsWith('/npm/@huggingface/transformers@')
  return false
}

function typeOf(name: string): string {
  return TYPES[extname(name).toLowerCase()] ?? 'application/octet-stream'
}

/** Fetch once, keep as a file. Atomic: a half download is a .part, never the file. */
function download(url: string, file: string): Promise<boolean> {
  const live = downloads.get(file)
  if (live) return live
  const run = (async (): Promise<boolean> => {
    try {
      const res = await ses!.fetch(url, { bypassCustomProtocolHandlers: true })
      if (!res.ok) {
        console.error(`[kokoro] ${url} answered ${res.status}`)
        return false
      }
      const bytes = Buffer.from(await res.arrayBuffer())
      writeFileSync(`${file}.part`, bytes)
      renameSync(`${file}.part`, file)
      console.log(`[kokoro] kept ${basename(new URL(url).pathname)} (${Math.round(bytes.length / 1024)} KB)`)
      return true
    } catch (err) {
      console.error(`[kokoro] could not fetch ${url}:`, err)
      rmSync(`${file}.part`, { force: true })
      return false
    } finally {
      downloads.delete(file)
    }
  })()
  downloads.set(file, run)
  return run
}

async function answerHttps(req: Request): Promise<Response> {
  const url = new URL(req.url)
  if (req.method !== 'GET' || !cacheable(url)) return new Response(null, { status: 403 })
  const file = join(cacheDir(), createHash('sha256').update(url.href).digest('hex'))
  let have = existsSync(file) && statSync(file).size > 0
  if (!have) have = await download(url.href, file)
  if (!have) return new Response(null, { status: 502 })
  const body = await net.fetch(pathToFileURL(file).href)
  return new Response(body.body, {
    status: 200,
    headers: { 'content-type': typeOf(url.pathname), 'access-control-allow-origin': '*' }
  })
}

async function answerEngine(req: Request): Promise<Response> {
  const url = new URL(req.url)
  const name = url.pathname.replace(/^\/+/, '')
  const dir = url.hostname === 'engine' && ENGINE_FILES.has(name) ? engineDir() : null
  if (!dir) return new Response(null, { status: 404 })
  const body = await net.fetch(pathToFileURL(join(dir, name)).href)
  const headers: Record<string, string> = { 'content-type': typeOf(name) }
  if (name.endsWith('.html')) headers['content-security-policy'] = PAGE_CSP
  return new Response(body.body, { status: 200, headers })
}

function ensureSession(): Session {
  if (ses) return ses
  const s = session.fromPartition(PARTITION)
  ses = s
  s.setPermissionRequestHandler((_wc, _permission, callback) => callback(false))
  s.protocol.handle(KOKORO_SCHEME, answerEngine)
  s.protocol.handle('https', answerHttps)
  return s
}

/**
 * The engine window is offscreen, like the browser and chat mirrors' copies,
 * so their quit guards already treat it as leftover. This is its own: when a
 * window closes and nothing but offscreen windows is left, the engine goes
 * too, so it never keeps a closed Forge alive.
 */
function guardQuit(): void {
  if (guarded) return
  guarded = true
  const check = (): void => {
    const left = BrowserWindow.getAllWindows().filter((w) => !w.isDestroyed() && w !== win)
    if (win && left.every((w) => w.webContents.isOffscreen())) closeWindow()
  }
  for (const w of BrowserWindow.getAllWindows()) w.once('closed', check)
  app.on('browser-window-created', (_event, w) => w.once('closed', check))
}

function closeWindow(): void {
  const w = win
  win = null
  if (w && !w.isDestroyed()) w.destroy()
}

function setStatus(next: Partial<KokoroStatus>): void {
  const was = status.state
  status = { ...status, ...next }
  if (status.state !== was) {
    console.log(`[kokoro] ${status.state}${status.reason ? ` — ${status.reason}` : ''}${status.state === 'ready' ? ` (${status.adapter}, load ${status.loadMs} ms, warm-up ${status.warmMs} ms)` : ''}`)
  }
}

function fail(reason: string): void {
  failedAt = Date.now()
  closeWindow()
  setStatus({ state: 'failed', reason })
}

async function openWindow(): Promise<BrowserWindow> {
  if (win && !win.isDestroyed()) return win
  if (!engineDir()) throw new Error('the Kokoro engine page is missing from this install')
  const partition = ensureSession()
  guardQuit()
  const w = new BrowserWindow({
    show: false,
    width: 320,
    height: 240,
    frame: false,
    skipTaskbar: true,
    focusable: false,
    webPreferences: {
      offscreen: true,
      session: partition,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false
    }
  })
  win = w
  w.webContents.setFrameRate(1)
  w.webContents.setAudioMuted(true)
  w.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  w.webContents.on('will-navigate', (event) => event.preventDefault())
  w.webContents.on('render-process-gone', (_event, details) => {
    if (win !== w) return
    console.error(`[kokoro] the engine page went away (${details.reason})`)
    const now = Date.now()
    crashes = [...crashes.filter((t) => now - t < CRASH_WINDOW_MS), now]
    warming = null
    if (crashes.length >= 3) {
      fail(`the engine page crashed ${crashes.length} times (${details.reason})`)
      return
    }
    // Reopened by the next sentence's warm-up; Edge speaks until it is ready.
    closeWindow()
    setStatus({ state: 'cold', reason: '' })
  })
  await w.loadURL(PAGE_URL)
  return w
}

function withTimeout<T>(work: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${what} took longer than ${Math.round(ms / 1000)} s`)), ms)
    work.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (err: unknown) => {
        clearTimeout(timer)
        reject(err instanceof Error ? err : new Error(String(err)))
      }
    )
  })
}

function voiceOf(voice: string | undefined): string {
  return voice && isKokoroVoice(voice) ? voice.trim() : DEFAULT_KOKORO_VOICE
}

/**
 * Load the model and pay the GPU's first-run cost now, in the background, so
 * the first reply does not. Safe to call any number of times. A load that
 * failed is tried again once RETRY_AFTER_MS has passed.
 */
export function warmKokoro(voice?: string): Promise<void> {
  if (disposed || status.state === 'ready') return Promise.resolve()
  if (warming) return warming
  if (status.state === 'failed' && Date.now() - failedAt < RETRY_AFTER_MS) return Promise.resolve()
  setStatus({ state: 'loading', reason: '' })
  const run = (async (): Promise<void> => {
    try {
      const w = await openWindow()
      const res = (await withTimeout(
        w.webContents.executeJavaScript(`window.kokoro.warm(${JSON.stringify(voiceOf(voice))})`),
        WARM_TIMEOUT_MS,
        'Loading Kokoro'
      )) as PageWarm
      if (win !== w) return
      if (!res?.ok) {
        fail(res?.reason || 'the model did not load')
        return
      }
      setStatus({
        state: 'ready',
        reason: '',
        adapter: res.adapter ?? '',
        loadMs: res.loadMs ?? 0,
        warmMs: res.warmMs ?? 0
      })
    } catch (err) {
      fail(err instanceof Error ? err.message : String(err))
    } finally {
      warming = null
    }
  })()
  warming = run
  return run
}

/** Drop every job of `lane` not yet on the GPU — barge-in. The one running finishes, and is thrown away by its caller. */
export function cancelKokoro(lane: string): void {
  laneGen.set(lane, (laneGen.get(lane) ?? 0) + 1)
  const keep: Job[] = []
  for (const job of queue) {
    if (job.lane === lane) job.resolve({ ok: false, kind: 'cancelled', error: 'Interrupted' })
    else keep.push(job)
  }
  queue = keep
}

async function drain(): Promise<void> {
  if (running) return
  running = true
  try {
    for (;;) {
      const job = queue.shift()
      if (!job) break
      if (job.signal?.aborted) {
        job.resolve({ ok: false, kind: 'cancelled', error: 'Interrupted' })
        continue
      }
      const w = win
      if (!w || w.isDestroyed() || status.state !== 'ready') {
        job.resolve({ ok: false, kind: 'not-ready', error: 'Kokoro is not loaded' })
        continue
      }
      try {
        const res = (await withTimeout(
          w.webContents.executeJavaScript(`window.kokoro.speak(${JSON.stringify(job.text)}, ${JSON.stringify(job.voice)}, 1)`),
          JOB_TIMEOUT_MS,
          'A Kokoro sentence'
        )) as PageSpeak
        if (job.signal?.aborted) job.resolve({ ok: false, kind: 'cancelled', error: 'Interrupted' })
        else if (res?.ok && res.audio) {
          job.resolve({ ok: true, audio: res.audio, sampleRate: res.sampleRate ?? 24000, voice: job.voice, ms: res.ms ?? 0 })
        } else job.resolve({ ok: false, kind: 'failed', error: res?.error || 'Kokoro made no audio' })
      } catch (err) {
        // A page that stops answering is wedged; the next warm opens a fresh one.
        const message = err instanceof Error ? err.message : String(err)
        fail(message)
        job.resolve({ ok: false, kind: 'failed', error: message })
      }
    }
  } finally {
    running = false
  }
}

/**
 * One sentence in a Kokoro voice: base64 PCM16, mono, 24 kHz. Answers
 * `not-ready` at once (and starts loading) while the model is not warm, so the
 * caller speaks that sentence with Edge rather than waiting on a cold GPU.
 * `lane` groups the jobs a barge-in drops together (`cancelKokoro`).
 */
export function speakKokoro(
  text: string,
  voice?: string,
  opts: { signal?: AbortSignal; lane?: string } = {}
): Promise<KokoroResult> {
  const body = String(text ?? '').trim().slice(0, TEXT_MAX)
  if (!body) return Promise.resolve({ ok: false, kind: 'failed', error: 'There was nothing to say' })
  if (disposed) return Promise.resolve({ ok: false, kind: 'not-ready', error: 'Forge is closing' })
  if (status.state !== 'ready') {
    void warmKokoro(voice)
    return Promise.resolve({
      ok: false,
      kind: 'not-ready',
      error: status.state === 'failed' ? `Kokoro failed: ${status.reason}` : 'Kokoro is still loading'
    })
  }
  const lane = opts.lane ?? 'desk'
  const gen = laneGen.get(lane) ?? 0
  return new Promise<KokoroResult>((resolve) => {
    queue.push({
      text: body,
      voice: voiceOf(voice),
      lane,
      signal: opts.signal,
      resolve: (result) => resolve(result.ok && (laneGen.get(lane) ?? 0) !== gen ? { ok: false, kind: 'cancelled', error: 'Interrupted' } : result)
    })
    void drain()
  })
}

export function disposeKokoro(): void {
  disposed = true
  for (const job of queue) job.resolve({ ok: false, kind: 'not-ready', error: 'Forge is closing' })
  queue = []
  closeWindow()
}

/** Mono PCM16 as a WAV file — what a browser's decodeAudioData takes (Forge Web's Claude Voice). */
export function pcm16Wav(pcm: Buffer, sampleRate: number): Buffer {
  const head = Buffer.alloc(44)
  head.write('RIFF', 0, 'ascii')
  head.writeUInt32LE(36 + pcm.length, 4)
  head.write('WAVE', 8, 'ascii')
  head.write('fmt ', 12, 'ascii')
  head.writeUInt32LE(16, 16)
  head.writeUInt16LE(1, 20)
  head.writeUInt16LE(1, 22)
  head.writeUInt32LE(sampleRate, 24)
  head.writeUInt32LE(sampleRate * 2, 28)
  head.writeUInt16LE(2, 32)
  head.writeUInt16LE(16, 34)
  head.write('data', 36, 'ascii')
  head.writeUInt32LE(pcm.length, 40)
  return Buffer.concat([head, pcm])
}
