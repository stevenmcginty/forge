import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { extname, isAbsolute, join, resolve } from 'node:path'

/**
 * Real media generation, straight at Google's REST API.
 *
 * Forge needs image generation in two places that share nothing else:
 *
 *   1. the MCP bridge (bridge/gemini-bridge.mjs), so Claude Code panes can make
 *      and edit images;
 *   2. the voice agent's executor, so a brain can return a `make_image` action.
 *
 * Both do the same thing, so the logic lives here once. This module is
 * deliberately free of any Electron import — it is plain Node, disk and fetch —
 * so the main process can import it and a head-less script can drive it.
 *
 * ⚠ The bridge is a standalone `.mjs` that must run under bare `node` with no
 * build step, so it cannot import this file. It carries a *minimal duplicate* of
 * `postImage` instead (see the DUPLICATED marker there). The model id, the
 * error taxonomy and the file naming are asserted identical by
 * `scripts/bridge-smoke.mjs`, so the two cannot drift silently.
 *
 * Why generateContent and not Imagen's `:predict`: the flash-image models take
 * an image *and* text as input, which is what makes `edit_image` possible at
 * all, and they return the bytes inline so nothing has to be downloaded from a
 * second URL.
 *
 * Verified live against Google's v1beta REST API (2026-07-30, key from
 * settings): `gemini-2.5-flash-image` returns `image/png` ~1 MB at 1024², about
 * 6 s per image. `gemini-3.1-flash-image` and `gemini-3-pro-image` also work but
 * return `image/jpeg`, and `responseMimeType` cannot ask for PNG (the API
 * rejects any image mime there). `candidateCount: 2` is refused outright
 * ("Multiple candidates is not enabled for this model"), so `count` is N
 * separate requests.
 */

const HOST = 'https://generativelanguage.googleapis.com'

/**
 * The image model. Stable, public, and the one that returns PNG — which is what
 * the screenshot tray and everything downstream expects.
 * Override with FORGE_GEMINI_IMAGE_MODEL (e.g. `gemini-3.1-flash-image`, which
 * returns JPEG; the saved file's extension follows whatever the API sends).
 */
export const DEFAULT_IMAGE_MODEL = 'gemini-2.5-flash-image'

/** One image generation is slow; four in a row is slower. Per request. */
export const DEFAULT_IMAGE_TIMEOUT_MS = 120_000

export const MAX_IMAGE_COUNT = 4

/** Aspect ratios `imageConfig.aspectRatio` accepts. */
export const ASPECT_RATIOS: readonly string[] = [
  '1:1',
  '2:3',
  '3:2',
  '3:4',
  '4:3',
  '4:5',
  '5:4',
  '9:16',
  '16:9',
  '21:9'
]

/** Input images we are willing to hand to the API, and their mime types. */
const INPUT_MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.bmp': 'image/bmp',
  '.heic': 'image/heic',
  '.heif': 'image/heif'
}

/** 20 MB — the inline-data ceiling for a generateContent request. */
const MAX_INPUT_BYTES = 20 * 1024 * 1024

/* -------------------------------------------------------------------- types */

/**
 * Why a media call produced nothing. Every one of these becomes a different
 * sentence for the user — "no key" and "out of quota" are not the same problem.
 */
export type MediaErrorKind =
  | 'no-key'
  | 'bad-input'
  | 'auth'
  | 'quota'
  | 'safety'
  | 'no-image'
  | 'model'
  | 'network'
  | 'disk'
  /**
   * The key is valid and in quota, but the *account* is not allowed to call
   * this model at all — Veo is billing-only. Distinct from `quota` (spend
   * later, it will work) and from `auth` (the key is wrong): nothing but
   * enabling billing fixes it, so it gets its own sentence.
   */
  | 'tier'

export interface MediaOk {
  ok: true
  /** Absolute paths of the files written. Never empty. */
  paths: string[]
  model: string
  ms: number
  /** Anything the caller should be told, e.g. "asked for 4, got 3". */
  note?: string
  /** Any prose the model returned alongside the image. */
  text?: string
}

export interface MediaErr {
  ok: false
  kind: MediaErrorKind
  error: string
}

export type MediaResult = MediaOk | MediaErr

export interface MakeImageOptions {
  key: string
  description: string
  outDir: string
  /** 1–4. Each one is a separate request; the API refuses multiple candidates. */
  count?: number
  aspect?: string
  model?: string
  timeoutMs?: number
}

export interface EditImageOptions {
  key: string
  /** Absolute path to the image being edited. */
  path: string
  instruction: string
  outDir: string
  model?: string
  timeoutMs?: number
}

/* ------------------------------------------------------------------ helpers */

export function imageModel(override?: string): string {
  const env = (process.env['FORGE_GEMINI_IMAGE_MODEL'] ?? '').trim()
  const chosen = (override ?? '').trim() || env || DEFAULT_IMAGE_MODEL
  return /^[a-zA-Z0-9][a-zA-Z0-9.\-_]{1,64}$/.test(chosen) ? chosen : DEFAULT_IMAGE_MODEL
}

function fail(kind: MediaErrorKind, error: string): MediaErr {
  return { ok: false, kind, error }
}

/** Never let a key reach a log, an error string or a stack trace. */
function scrub(text: string, key: string): string {
  return key ? text.split(key).join('«key»') : text
}

export function extensionFor(mime: string): string {
  const m = (mime || '').toLowerCase()
  if (m.includes('jpeg') || m.includes('jpg')) return '.jpg'
  if (m.includes('webp')) return '.webp'
  if (m.includes('gif')) return '.gif'
  if (m.includes('bmp')) return '.bmp'
  return '.png'
}

/** `forge-image-YYYYMMDD-HHMMSS` — sorts chronologically and reads as a date. */
export function mediaStamp(date: Date = new Date()): string {
  const p = (n: number): string => String(n).padStart(2, '0')
  return (
    `${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}` +
    `-${p(date.getHours())}${p(date.getMinutes())}${p(date.getSeconds())}`
  )
}

/** `stem.ext`, or `stem -2.ext` when that name is taken. */
export function freshPath(dir: string, stem: string, ext: string): string {
  let candidate = join(dir, `${stem}${ext}`)
  let n = 2
  while (existsSync(candidate)) {
    candidate = join(dir, `${stem} -${n}${ext}`)
    n += 1
  }
  return candidate
}

/** tmp + rename, so a half-written image never appears in a watcher's folder. */
function writeAtomic(target: string, bytes: Uint8Array): void {
  const tmp = `${target}.tmp`
  writeFileSync(tmp, bytes)
  renameSync(tmp, target)
}

/* ------------------------------------------------------------------- the call */

interface InlineImage {
  mime: string
  bytes: Buffer
}

interface PostOk {
  ok: true
  images: InlineImage[]
  text: string
}

type PostResult = PostOk | MediaErr

/**
 * One `:generateContent` round trip that is expected to come back with image
 * bytes. Kept as the single network funnel so every error is classified in one
 * place. The bridge's duplicate of this must stay in step.
 */
async function postImage(
  model: string,
  key: string,
  parts: unknown[],
  imageConfig: Record<string, unknown> | null,
  timeoutMs: number
): Promise<PostResult> {
  const generationConfig: Record<string, unknown> = { responseModalities: ['IMAGE'] }
  if (imageConfig && Object.keys(imageConfig).length) generationConfig['imageConfig'] = imageConfig

  let res: Response
  try {
    res = await fetch(`${HOST}/v1beta/models/${model}:generateContent`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-goog-api-key': key },
      body: JSON.stringify({ contents: [{ role: 'user', parts }], generationConfig }),
      signal: AbortSignal.timeout(timeoutMs)
    })
  } catch (err) {
    const e = err as Error
    if (e.name === 'TimeoutError' || e.name === 'AbortError') {
      return fail('network', `Gemini did not answer within ${Math.round(timeoutMs / 1000)}s`)
    }
    return fail('network', `Could not reach Gemini: ${scrub(e.message, key)}`)
  }

  const raw = await res.text()
  let parsed: unknown = null
  try {
    parsed = JSON.parse(raw)
  } catch {
    /* keep raw */
  }

  if (!res.ok) {
    const err = (parsed as { error?: { message?: string; status?: string } } | null)?.error
    const message = scrub(err?.message ?? raw.slice(0, 500) ?? res.statusText, key)
    if (res.status === 429 || /RESOURCE_EXHAUSTED|quota/i.test(`${err?.status} ${message}`)) {
      return fail('quota', `Gemini is out of quota for this key (${res.status}): ${message}`)
    }
    if (res.status === 401 || res.status === 403 || /API_KEY_INVALID|API key not valid/i.test(message)) {
      return fail('auth', `Gemini refused the key (${res.status}): ${message}`)
    }
    if (res.status === 404) {
      return fail('model', `The image model “${model}” is not available to this key (404): ${message}`)
    }
    return fail('model', `Gemini rejected the request (${res.status} ${err?.status ?? res.statusText}): ${message}`)
  }

  const data = parsed as {
    candidates?: Array<{
      content?: { parts?: Array<{ text?: string; inlineData?: { mimeType?: string; data?: string } }> }
      finishReason?: string
    }>
    promptFeedback?: { blockReason?: string }
  } | null

  if (data?.promptFeedback?.blockReason) {
    return fail('safety', `Gemini blocked the prompt (${data.promptFeedback.blockReason}) and made no image.`)
  }

  const images: InlineImage[] = []
  const texts: string[] = []
  const candidate = data?.candidates?.[0]
  for (const part of candidate?.content?.parts ?? []) {
    if (part.inlineData?.data) {
      images.push({
        mime: part.inlineData.mimeType ?? 'image/png',
        bytes: Buffer.from(part.inlineData.data, 'base64')
      })
    } else if (part.text) {
      texts.push(part.text)
    }
  }

  if (images.length === 0) {
    // Real, observed shape: finishReason NO_IMAGE with no parts at all is what a
    // refusal looks like — the model simply declines rather than erroring.
    const why = candidate?.finishReason ?? 'no reason given'
    const said = texts.join(' ').trim()
    const kind: MediaErrorKind = /SAFETY|PROHIBITED|BLOCK|RECITATION|NO_IMAGE/i.test(why) ? 'safety' : 'no-image'
    return fail(
      kind,
      `Gemini returned no image (${why}).` +
        (said ? ` It said: ${said}` : '') +
        ' This is usually a refusal — the subject, a real person, or the style was declined.'
    )
  }

  return { ok: true, images, text: texts.join('\n').trim() }
}

/* ------------------------------------------------------------------ make */

function prepareOutDir(outDir: string): MediaErr | null {
  try {
    mkdirSync(outDir, { recursive: true })
    return null
  } catch (err) {
    return fail('disk', `Cannot create the output directory ${outDir}: ${(err as Error).message}`)
  }
}

/**
 * Text → one or more image files on disk. Returns absolute paths, and never a
 * path that was not actually written.
 */
export async function makeImage(opts: MakeImageOptions): Promise<MediaResult> {
  const key = (opts.key ?? '').trim()
  if (!key) {
    return fail('no-key', 'No Gemini API key. Set one in Forge’s voice-agent settings (or import it) and retry.')
  }
  const description = (opts.description ?? '').trim()
  if (!description) return fail('bad-input', '`description` is required and must be a non-empty string')

  const count = Math.min(MAX_IMAGE_COUNT, Math.max(1, Math.floor(Number(opts.count ?? 1) || 1)))
  const aspect = (opts.aspect ?? '').trim()
  if (aspect && !ASPECT_RATIOS.includes(aspect)) {
    return fail('bad-input', `\`aspect\` must be one of: ${ASPECT_RATIOS.join(', ')}`)
  }

  const outDir = resolve(opts.outDir)
  const dirErr = prepareOutDir(outDir)
  if (dirErr) return dirErr

  const model = imageModel(opts.model)
  const timeout = opts.timeoutMs ?? DEFAULT_IMAGE_TIMEOUT_MS
  const started = Date.now()
  const paths: string[] = []
  const notes: string[] = []
  let text = ''
  let lastError: MediaErr | null = null

  for (let i = 0; i < count; i++) {
    const r = await postImage(model, key, [{ text: description }], aspect ? { aspectRatio: aspect } : null, timeout)
    if (!r.ok) {
      lastError = r
      break
    }
    if (r.text && !text) text = r.text
    for (const img of r.images) {
      const target = freshPath(outDir, `forge-image-${mediaStamp()}`, extensionFor(img.mime))
      try {
        writeAtomic(target, img.bytes)
      } catch (err) {
        return fail('disk', `Gemini made the image but it could not be saved to ${target}: ${(err as Error).message}`)
      }
      paths.push(target)
    }
  }

  if (paths.length === 0) return lastError ?? fail('no-image', 'Gemini produced no image and gave no reason.')
  if (lastError) notes.push(`asked for ${count}, got ${paths.length} — then: ${lastError.error}`)
  else if (paths.length !== count) notes.push(`asked for ${count}, got ${paths.length}`)

  const result: MediaOk = { ok: true, paths, model, ms: Date.now() - started }
  if (notes.length) result.note = notes.join('; ')
  if (text) result.text = text
  return result
}

/* ------------------------------------------------------------------ edit */

/** Read an image off disk into an inlineData part, or explain why not. */
function inlinePart(path: string): { part: unknown; stem: string } | MediaErr {
  const abs = isAbsolute(path) ? path : resolve(process.cwd(), path)
  if (!existsSync(abs)) return fail('bad-input', `No such file: ${abs}`)
  let size = 0
  try {
    const st = statSync(abs)
    if (!st.isFile()) return fail('bad-input', `${abs} is not a file`)
    size = st.size
  } catch (err) {
    return fail('bad-input', `Cannot read ${abs}: ${(err as Error).message}`)
  }
  const ext = extname(abs).toLowerCase()
  const mime = INPUT_MIME[ext]
  if (!mime) {
    return fail('bad-input', `${ext || 'that file'} is not an image Gemini accepts (${Object.keys(INPUT_MIME).join(', ')})`)
  }
  if (size > MAX_INPUT_BYTES) {
    return fail('bad-input', `${abs} is ${(size / 1e6).toFixed(1)} MB — inline images must be under 20 MB`)
  }
  let bytes: Buffer
  try {
    bytes = readFileSync(abs)
  } catch (err) {
    return fail('bad-input', `Cannot read ${abs}: ${(err as Error).message}`)
  }
  const stem = abs
    .split(/[\\/]/)
    .pop()!
    .replace(/\.[^.]+$/, '')
  return { part: { inlineData: { mimeType: mime, data: bytes.toString('base64') } }, stem }
}

/** Image + instruction → a new, edited image file. The input is never touched. */
export async function editImage(opts: EditImageOptions): Promise<MediaResult> {
  const key = (opts.key ?? '').trim()
  if (!key) {
    return fail('no-key', 'No Gemini API key. Set one in Forge’s voice-agent settings (or import it) and retry.')
  }
  const instruction = (opts.instruction ?? '').trim()
  if (!instruction) return fail('bad-input', '`instruction` is required and must be a non-empty string')
  if (!(opts.path ?? '').trim()) return fail('bad-input', '`path` is required and must be a non-empty string')

  const loaded = inlinePart(opts.path)
  if ('ok' in loaded) return loaded

  const outDir = resolve(opts.outDir)
  const dirErr = prepareOutDir(outDir)
  if (dirErr) return dirErr

  const model = imageModel(opts.model)
  const started = Date.now()
  const r = await postImage(
    model,
    key,
    [loaded.part, { text: instruction }],
    null,
    opts.timeoutMs ?? DEFAULT_IMAGE_TIMEOUT_MS
  )
  if (!r.ok) return r

  const paths: string[] = []
  for (const img of r.images) {
    const target = freshPath(outDir, `${loaded.stem}-edited-${mediaStamp()}`, extensionFor(img.mime))
    try {
      writeAtomic(target, img.bytes)
    } catch (err) {
      return fail('disk', `Gemini edited the image but it could not be saved to ${target}: ${(err as Error).message}`)
    }
    paths.push(target)
  }
  if (paths.length === 0) return fail('no-image', 'Gemini returned no edited image.')

  const result: MediaOk = { ok: true, paths, model, ms: Date.now() - started }
  if (r.text) result.text = r.text
  return result
}

/* ------------------------------------------------------------------- video
 *
 * Veo is a completely different shape from the image calls above, and every
 * detail below was verified live against Steve's key on 2026-07-30 rather than
 * taken from documentation:
 *
 *   1. POST /v1beta/models/<model>:predictLongRunning
 *        { instances: [{ prompt }], parameters: { aspectRatio, durationSeconds } }
 *      → 200 { "name": "models/<model>/operations/<id>" }   (nothing else)
 *
 *   2. GET /v1beta/<that name>  → { name } while running, then
 *        { name, done: true, response: { generateVideoResponse: {
 *            generatedSamples: [ { video: { uri } } ] } } }
 *      A failure arrives as `{ done: true, error: { code, message } }`.
 *      There is no progress percentage — `done` is the only signal.
 *
 *   3. GET <uri>  where uri is
 *        https://generativelanguage.googleapis.com/v1beta/files/<id>:download?alt=media
 *      The URI already carries `:download?alt=media`; it needs the API key and
 *      nothing else. Verified: bare (no auth) → 403 PERMISSION_DENIED
 *      ("Method doesn't allow unregistered callers"); `x-goog-api-key` header →
 *      200 video/mp4; `?key=` query → 200 as well. The header is used here, for
 *      the same reason as everywhere else: a key in a URL ends up in logs.
 *
 * Measured: veo-3.1-lite-generate-preview, 4 s of 16:9 → done at ~47 s,
 * 4.9 MB, `ftypisom`, mvhd duration exactly 4.00 s.
 *
 * Parameter limits, all confirmed by deliberately invalid requests (which are
 * rejected at submit time, before any generation is billed):
 *   • aspectRatio accepts ONLY `16:9` and `9:16` — 1:1, 4:3, 3:4, 21:9 and
 *     16:10 are all refused with "`aspectRatio` does not support `x`".
 *   • durationSeconds must be 4–8 inclusive ("out of bound. Please provide a
 *     value between 4 and 8, inclusive").
 *   • an empty prompt is refused with "Text to video requires prompt to be set."
 */

/**
 * The video model. `lite` is the cheapest of the three Veo 3.1 variants and is
 * the one proven to work on Steve's key, so it is the default: a minute of
 * waiting is bad enough without it also being the most expensive call Forge can
 * make. `veo-3.1-fast-generate-preview` and `veo-3.1-generate-preview` are both
 * present in /v1beta/models for the same key; reach them with
 * FORGE_GEMINI_VIDEO_MODEL.
 */
export const DEFAULT_VIDEO_MODEL = 'veo-3.1-lite-generate-preview'

/** The only two Veo accepts. Not the image list — that one is much longer. */
export const VIDEO_ASPECT_RATIOS: readonly string[] = ['16:9', '9:16']

export const MIN_VIDEO_SECONDS = 4
export const MAX_VIDEO_SECONDS = 8

/**
 * How long to wait for the whole thing. A lite 4-second clip took ~47 s; the
 * bigger models and longer clips take several times that, so six minutes is the
 * point at which something has genuinely gone wrong rather than "it is slow".
 */
export const DEFAULT_VIDEO_TIMEOUT_MS = 360_000

/**
 * Gaps between polls: quick twice in case it is already done, then settle at
 * 15 s. Polling an operation is free, but hammering it is still rude.
 */
export const VIDEO_POLL_MS: readonly number[] = [5_000, 10_000]
export const VIDEO_POLL_STEADY_MS = 15_000

/** Each individual HTTP call. The *wait* is the poll loop's problem, not fetch's. */
const VIDEO_REQUEST_TIMEOUT_MS = 120_000

export function videoModel(override?: string): string {
  const env = (process.env['FORGE_GEMINI_VIDEO_MODEL'] ?? '').trim()
  const chosen = (override ?? '').trim() || env || DEFAULT_VIDEO_MODEL
  return /^[a-zA-Z0-9][a-zA-Z0-9.\-_]{1,64}$/.test(chosen) ? chosen : DEFAULT_VIDEO_MODEL
}

export interface MakeVideoOptions {
  key: string
  description: string
  outDir: string
  model?: string
  /** `16:9` or `9:16`. Defaults to the model's own choice. */
  aspect?: string
  /** Seconds, 4–8. Defaults to the model's own choice. */
  duration?: number
  /** Overall budget for submit + poll + download. */
  timeoutMs?: number
  /** Test seam: how to wait between polls. Real code never passes this. */
  sleep?: (ms: number) => Promise<void>
}

/**
 * Classify an HTTP failure from any of the three Veo calls. Shared by submit,
 * poll and download so one status never means two different things.
 */
function videoHttpError(status: number, message: string, model: string): MediaErr {
  if (status === 429 || /RESOURCE_EXHAUSTED|quota/i.test(message)) {
    return fail('quota', `Gemini is out of quota for this key (${status}): ${message}`)
  }
  // Veo is billing-only on a plain AI Studio key. That is not a quota problem
  // and waiting will not fix it, so it must not be reported as one.
  if (/billed users|billing|FAILED_PRECONDITION|paid tier|not available in your|free tier/i.test(message)) {
    return fail(
      'tier',
      `Video generation is a paid-only Google feature and this key is not billed (${status}): ${message} ` +
        'Say exactly that: Veo needs billing enabled on the Google Cloud project behind the API key. Nothing else fixes it.'
    )
  }
  if (status === 401 || status === 403 || /API_KEY_INVALID|API key not valid/i.test(message)) {
    return fail('auth', `Gemini refused the key (${status}): ${message}`)
  }
  if (status === 404) {
    return fail('model', `The video model “${model}” is not available to this key (404): ${message}`)
  }
  if (/safety|blocked|prohibited|policy/i.test(message)) {
    return fail('safety', `Gemini refused to make that video (${status}): ${message}`)
  }
  return fail('model', `Gemini rejected the video request (${status}): ${message}`)
}

/** One JSON round trip, with the network failures already classified. */
async function videoFetch(
  url: string,
  key: string,
  init: RequestInit,
  model: string
): Promise<{ ok: true; res: Response; raw: string } | MediaErr> {
  let res: Response
  try {
    res = await fetch(url, {
      ...init,
      headers: { ...(init.headers as Record<string, string>), 'x-goog-api-key': key },
      signal: AbortSignal.timeout(VIDEO_REQUEST_TIMEOUT_MS)
    })
  } catch (err) {
    const e = err as Error
    if (e.name === 'TimeoutError' || e.name === 'AbortError') {
      return fail('network', `Gemini did not answer within ${Math.round(VIDEO_REQUEST_TIMEOUT_MS / 1000)}s`)
    }
    return fail('network', `Could not reach Gemini: ${scrub(e.message, key)}`)
  }
  const raw = await res.text()
  if (!res.ok) {
    let parsed: unknown = null
    try {
      parsed = JSON.parse(raw)
    } catch {
      /* keep raw */
    }
    const err = (parsed as { error?: { message?: string; status?: string } } | null)?.error
    const message = scrub(err?.message ?? raw.slice(0, 500) ?? res.statusText, key)
    return videoHttpError(res.status, `${err?.status ?? ''} ${message}`.trim(), model)
  }
  return { ok: true, res, raw }
}

/**
 * The operation's video URI points at Google's own file service. It is a URL
 * the *API* chose, and it is about to be sent an API key, so it is checked
 * against the host we meant to talk to rather than trusted.
 */
function safeVideoUri(uri: string): string | null {
  let parsed: URL
  try {
    parsed = new URL(uri)
  } catch {
    return null
  }
  if (parsed.protocol !== 'https:') return null
  if (parsed.host !== new URL(HOST).host) return null
  return parsed.toString()
}

/** Dig the video URI out of a finished operation, whichever shape it arrived in. */
function videoUriOf(op: unknown): string | null {
  const o = op as {
    response?: {
      generateVideoResponse?: { generatedSamples?: Array<{ video?: { uri?: string } }> }
      generatedVideos?: Array<{ video?: { uri?: string } }>
    }
  } | null
  const samples = o?.response?.generateVideoResponse?.generatedSamples ?? o?.response?.generatedVideos ?? []
  for (const s of samples) {
    const uri = s?.video?.uri
    if (typeof uri === 'string' && uri) return uri
  }
  return null
}

const realSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/**
 * Text → one .mp4 on disk. Submit, poll, download; returns the absolute path,
 * and never a path that was not actually written.
 *
 * This takes one to three minutes. Every caller is expected to have already
 * told the user that.
 */
export async function makeVideo(opts: MakeVideoOptions): Promise<MediaResult> {
  const key = (opts.key ?? '').trim()
  if (!key) {
    return fail('no-key', 'No Gemini API key. Set one in Forge’s voice-agent settings (or import it) and retry.')
  }
  const description = (opts.description ?? '').trim()
  if (!description) return fail('bad-input', '`description` is required and must be a non-empty string')

  const aspect = (opts.aspect ?? '').trim()
  if (aspect && !VIDEO_ASPECT_RATIOS.includes(aspect)) {
    return fail('bad-input', `\`aspect\` must be one of: ${VIDEO_ASPECT_RATIOS.join(', ')}`)
  }

  let duration = 0
  if (opts.duration !== undefined && opts.duration !== null && `${opts.duration}`.trim() !== '') {
    const n = Number(opts.duration)
    if (!Number.isFinite(n) || n < MIN_VIDEO_SECONDS || n > MAX_VIDEO_SECONDS) {
      return fail('bad-input', `\`duration\` must be a whole number of seconds from ${MIN_VIDEO_SECONDS} to ${MAX_VIDEO_SECONDS}`)
    }
    duration = Math.round(n)
  }

  const outDir = resolve(opts.outDir)
  const dirErr = prepareOutDir(outDir)
  if (dirErr) return dirErr

  const model = videoModel(opts.model)
  const budget = opts.timeoutMs ?? DEFAULT_VIDEO_TIMEOUT_MS
  const sleep = opts.sleep ?? realSleep
  const started = Date.now()
  const left = (): number => budget - (Date.now() - started)

  /* 1 — submit */
  const parameters: Record<string, unknown> = {}
  if (aspect) parameters['aspectRatio'] = aspect
  if (duration) parameters['durationSeconds'] = duration

  const submitted = await videoFetch(
    `${HOST}/v1beta/models/${model}:predictLongRunning`,
    key,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ instances: [{ prompt: description }], parameters })
    },
    model
  )
  if (!('res' in submitted)) return submitted

  let operation: string
  try {
    operation = String((JSON.parse(submitted.raw) as { name?: string }).name ?? '')
  } catch {
    return fail('model', `Gemini accepted the video request but its reply was not JSON: ${submitted.raw.slice(0, 200)}`)
  }
  if (!operation) {
    return fail('model', 'Gemini accepted the video request but named no operation to poll, so there is nothing to wait for.')
  }

  /* 2 — poll */
  let op: unknown = null
  let polls = 0
  for (;;) {
    const gap = VIDEO_POLL_MS[polls] ?? VIDEO_POLL_STEADY_MS
    polls += 1
    if (left() <= gap) {
      return fail(
        'network',
        `The video was still rendering after ${Math.round((Date.now() - started) / 1000)}s and Forge stopped waiting. ` +
          `It may still finish on Google's side, but no file was downloaded — do not claim one was. ` +
          `A shorter clip, or ${DEFAULT_VIDEO_MODEL}, is faster.`
      )
    }
    await sleep(gap)

    const polled = await videoFetch(`${HOST}/v1beta/${operation}`, key, { method: 'GET' }, model)
    if (!('res' in polled)) return polled
    try {
      op = JSON.parse(polled.raw)
    } catch {
      return fail('model', `Polling the video operation returned non-JSON: ${polled.raw.slice(0, 200)}`)
    }

    const done = (op as { done?: boolean }).done === true
    if (!done) continue

    // A finished-but-failed operation carries an error instead of a response.
    const opErr = (op as { error?: { code?: number; message?: string } }).error
    if (opErr) {
      return videoHttpError(Number(opErr.code ?? 0), scrub(String(opErr.message ?? 'no reason given'), key), model)
    }
    break
  }

  const rawUri = videoUriOf(op)
  if (!rawUri) {
    return fail(
      'no-image',
      'Gemini finished the video operation but returned no file to download. This is usually a silent refusal — ' +
        'no file was written, so do not claim one was.'
    )
  }
  const uri = safeVideoUri(rawUri)
  if (!uri) {
    // Refusing here is the point: the key is about to be sent to this URL.
    return fail('model', `Gemini returned a video URL Forge will not fetch (not ${new URL(HOST).host}): ${scrub(rawUri, key)}`)
  }

  /* 3 — download */
  return finishVideoDownload(uri, key, model, outDir, started)
}

/**
 * The download is the one call whose body is binary, so it cannot go through
 * `videoFetch` (which reads text to classify errors). Errors here are rare —
 * the URI has just been handed to us by a successful operation — but a 403 is
 * still possible if the file expired, so they are classified the same way.
 */
async function finishVideoDownload(
  uri: string,
  key: string,
  model: string,
  outDir: string,
  started: number
): Promise<MediaResult> {
  let res: Response
  try {
    res = await fetch(uri, {
      headers: { 'x-goog-api-key': key },
      signal: AbortSignal.timeout(VIDEO_REQUEST_TIMEOUT_MS)
    })
  } catch (err) {
    const e = err as Error
    if (e.name === 'TimeoutError' || e.name === 'AbortError') {
      return fail('network', 'The video was generated but the download timed out, so no file was saved.')
    }
    return fail('network', `The video was generated but could not be downloaded: ${scrub(e.message, key)}`)
  }

  if (!res.ok) {
    const body = scrub((await res.text()).slice(0, 400), key)
    return videoHttpError(res.status, body, model)
  }

  const bytes = Buffer.from(await res.arrayBuffer())
  // `ftyp` at offset 4 is the ISO base-media signature every mp4 starts with.
  // An error page saved as .mp4 is worse than an honest failure.
  const looksMp4 = bytes.length > 12 && bytes.subarray(4, 8).toString('latin1') === 'ftyp'
  if (!looksMp4) {
    return fail(
      'no-image',
      `The download did not return a video (${bytes.length} bytes, no mp4 header). No file was written.`
    )
  }

  const target = freshPath(outDir, `forge-video-${mediaStamp()}`, '.mp4')
  try {
    writeAtomic(target, bytes)
  } catch (err) {
    return fail('disk', `Gemini made the video but it could not be saved to ${target}: ${(err as Error).message}`)
  }

  return { ok: true, paths: [target], model, ms: Date.now() - started }
}
