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

/* ------------------------------------------------------------------ probes */

/**
 * Is video generation reachable with this key? Reported, not used: Veo is a
 * `:predictLongRunning` call that returns an operation to poll and then a file
 * to download — a different shape from everything above, so no tool is built on
 * it. See bridge/README.md.
 */
export const VIDEO_MODEL = 'veo-3.1-fast-generate-preview'

export const NO_VIDEO_TOOL =
  'Forge has no video-generation tool. Google\'s Veo models are reachable with a Gemini API key, but they use a ' +
  'long-running-operation API (submit, poll, then download a file) rather than the inline call the image tools use, ' +
  'so nothing here can make a video yet. Do not claim a video was made. `summarize_video` can *watch* one.'
