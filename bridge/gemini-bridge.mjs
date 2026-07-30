#!/usr/bin/env node
/**
 * forge-bridge — the cross-agent bridge.
 *
 * A standalone MCP server (stdio transport) that Forge registers into every
 * Claude Code pane, so Claude can hand work to Google Gemini: things Claude
 * cannot do itself (watch a YouTube video, generate an image or a video) and
 * second opinions from a different model family.
 *
 * Auth model: one key, one road. Every tool here calls Google's REST API
 * directly and needs GEMINI_API_KEY in the environment; Forge puts it there via
 * the mcp.json it generates under %APPDATA%\Forge\bridge\. Nothing is written to
 * disk by this file except the images and videos themselves.
 *
 * `ask_gemini` and `summarize_video` used to shell out to the `gemini` CLI. They
 * no longer can: Google retired the free individual-account tier behind it, and
 * the CLI now answers UNSUPPORTED_CLIENT with an instruction to migrate to the
 * Antigravity suite. Every trace of it is gone from this file — no spawn, no npm
 * shim resolution, no exit codes — leaving pure REST plus the node standard
 * library. (Forge's interactive *Gemini launch profile* is a different thing
 * entirely and is untouched by this.)
 *
 * Run standalone (for testing):  node bridge/gemini-bridge.mjs
 * It speaks JSON-RPC over stdin/stdout, so stdout must stay clean — every
 * diagnostic in this file goes to stderr.
 */

import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { extname, isAbsolute, join, resolve } from 'node:path'
import { homedir } from 'node:os'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'

const SERVER_NAME = 'forge-bridge'
const SERVER_VERSION = '1.0.0'

/* ------------------------------------------------------------- media config
 *
 * DUPLICATED from electron/gemini-media.ts — deliberately. That file is the
 * canonical implementation (the voice agent's executor uses it), but this server
 * has to run under bare `node` with no build step, so it cannot import a .ts
 * module. Only the small parts below are copied; scripts/bridge-smoke.mjs reads
 * both files and asserts the model id, the aspect list and the error wording
 * still match, so the two cannot drift silently.
 */

const GEMINI_HOST = 'https://generativelanguage.googleapis.com'

/**
 * The image model: stable, public, and the one that returns PNG. Overridable
 * with FORGE_GEMINI_IMAGE_MODEL (e.g. gemini-3.1-flash-image, which returns
 * JPEG — the saved file's extension follows whatever the API sends).
 */
const DEFAULT_IMAGE_MODEL = 'gemini-2.5-flash-image'
const IMAGE_TIMEOUT_MS = 120_000
const MAX_IMAGE_COUNT = 4
const ASPECT_RATIOS = ['1:1', '2:3', '3:2', '3:4', '4:3', '4:5', '5:4', '9:16', '16:9', '21:9']
/** Input images the API accepts inline, and their mime types. */
const INPUT_MIME = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.bmp': 'image/bmp',
  '.heic': 'image/heic',
  '.heif': 'image/heif'
}
const MAX_INPUT_BYTES = 20 * 1024 * 1024

/**
 * Video (Veo), also DUPLICATED from electron/gemini-media.ts — see the block
 * comment above. Every constant here is asserted equal to its twin by
 * scripts/bridge-smoke.mjs.
 *
 * `lite` is the cheapest of the three Veo 3.1 variants and the one proven to
 * work on this key. Override with FORGE_GEMINI_VIDEO_MODEL.
 */
const DEFAULT_VIDEO_MODEL = 'veo-3.1-lite-generate-preview'
/** Veo accepts only these two — verified live; 1:1, 4:3, 3:4 and 21:9 are all refused. */
const VIDEO_ASPECT_RATIOS = ['16:9', '9:16']
const MIN_VIDEO_SECONDS = 4
const MAX_VIDEO_SECONDS = 8
const VIDEO_TIMEOUT_MS = 360_000
const VIDEO_POLL_MS = [5_000, 10_000]
const VIDEO_POLL_STEADY_MS = 15_000
const VIDEO_REQUEST_TIMEOUT_MS = 120_000

function videoModel() {
  const chosen = (process.env['FORGE_GEMINI_VIDEO_MODEL'] ?? '').trim() || DEFAULT_VIDEO_MODEL
  return /^[a-zA-Z0-9][a-zA-Z0-9.\-_]{1,64}$/.test(chosen) ? chosen : DEFAULT_VIDEO_MODEL
}

function imageModel() {
  const chosen = (process.env['FORGE_GEMINI_IMAGE_MODEL'] ?? '').trim() || DEFAULT_IMAGE_MODEL
  return /^[a-zA-Z0-9][a-zA-Z0-9.\-_]{1,64}$/.test(chosen) ? chosen : DEFAULT_IMAGE_MODEL
}

function apiKey() {
  return (process.env['GEMINI_API_KEY'] ?? process.env['GOOGLE_API_KEY'] ?? '').trim()
}

/** Where produced images land unless the caller says otherwise. */
function defaultOutDir() {
  if (process.env['FORGE_BRIDGE_OUT']) return process.env['FORGE_BRIDGE_OUT']
  const appData = process.env['APPDATA']
  if (appData) return join(appData, 'Forge', 'bridge-out')
  return join(homedir(), '.forge', 'bridge-out')
}

/* -------------------------------------------------------------- text config
 *
 * `ask_gemini` and `summarize_video`. Unlike the media constants above, none of
 * this is duplicated anywhere — electron/gemini-media.ts is media-only — so
 * there is nothing here for the drift guard to police.
 */

/**
 * The model behind both text tools. `gemini-3.6-flash` is fast and cheap, reads
 * images, PDFs, audio and video, and is verified working on this key. Override
 * with FORGE_GEMINI_ASK_MODEL.
 */
const DEFAULT_ASK_MODEL = 'gemini-3.6-flash'
/** Generous, because a long video is watched end to end before the first token. */
const ASK_TIMEOUT_MS = 300_000
/** Files API: the upload itself, then the wait for Google to finish ingesting it. */
const UPLOAD_TIMEOUT_MS = 300_000
const FILE_READY_TIMEOUT_MS = 180_000
const FILE_POLL_MS = 2_000
/** Total bytes `ask_gemini` will inline into one request before uploading instead. */
const MAX_INLINE_TOTAL_BYTES = 15 * 1024 * 1024
/** A text file bigger than this is uploaded rather than pasted into the prompt. */
const MAX_TEXT_INLINE_BYTES = 1024 * 1024
/**
 * Our own ceiling on an upload, not the API's (which is 2 GB). The body is
 * buffered in memory in one shot, so this keeps a stray 4 GB capture from
 * taking the bridge down with it.
 */
const MAX_UPLOAD_BYTES = 200 * 1024 * 1024

/**
 * What the Files API will take, on top of the images already listed above.
 * Anything not in here is refused by name rather than uploaded hopefully.
 */
const UPLOAD_MIME = {
  ...INPUT_MIME,
  '.pdf': 'application/pdf',
  '.txt': 'text/plain',
  '.md': 'text/markdown',
  '.csv': 'text/csv',
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm',
  '.mpeg': 'video/mpeg',
  '.mpg': 'video/mpeg',
  '.avi': 'video/x-msvideo',
  '.wmv': 'video/x-ms-wmv',
  '.flv': 'video/x-flv',
  '.3gp': 'video/3gpp',
  '.mp3': 'audio/mp3',
  '.wav': 'audio/wav',
  '.aiff': 'audio/aiff',
  '.aac': 'audio/aac',
  '.ogg': 'audio/ogg',
  '.flac': 'audio/flac',
  '.m4a': 'audio/mp4'
}

/** The subset of the above that `summarize_video` will accept off disk. */
const VIDEO_EXTENSIONS = Object.keys(UPLOAD_MIME).filter((e) => UPLOAD_MIME[e].startsWith('video/'))

function askModel() {
  const chosen = (process.env['FORGE_GEMINI_ASK_MODEL'] ?? '').trim() || DEFAULT_ASK_MODEL
  return /^[a-zA-Z0-9][a-zA-Z0-9.\-_]{1,64}$/.test(chosen) ? chosen : DEFAULT_ASK_MODEL
}

/* --------------------------------------------------------------- messaging */

/**
 * The text tools' no-key message. Deliberately parallel to NO_KEY / NO_KEY_VIDEO
 * further down: same fix, same insistence that nothing be faked in its place.
 */
const NO_KEY_TEXT =
  'Cannot ask Gemini: no Gemini API key is available to the bridge.\n\n' +
  'Tell the user plainly that Gemini was never reached, and how to fix it: open Forge’s voice-agent settings, ' +
  'paste a Google AI Studio key (or press “Import from DictationMic”), and restart the pane — Forge writes the key ' +
  'into the MCP config it generates at %APPDATA%\\Forge\\bridge\\mcp.json, which is read when the pane launches. ' +
  'Running the bridge by hand? Set GEMINI_API_KEY in the environment.\n\n' +
  'Do not answer as though Gemini had replied, and do not invent a summary.'

/** Every failure comes back as readable prose, never as a fabricated success. */
function fail(text) {
  return { content: [{ type: 'text', text }], isError: true }
}

function ok(text) {
  return { content: [{ type: 'text', text }] }
}

/* ------------------------------------------------------------------- inputs */

function asString(v, field) {
  if (typeof v !== 'string' || !v.trim()) throw new Error(`\`${field}\` is required and must be a non-empty string`)
  return v.trim()
}

function asStringArray(v, field) {
  if (v === undefined || v === null) return []
  if (!Array.isArray(v)) throw new Error(`\`${field}\` must be an array of strings`)
  return v.map((x) => {
    if (typeof x !== 'string') throw new Error(`\`${field}\` must be an array of strings`)
    return x.trim()
  }).filter(Boolean)
}

function absPath(p) {
  return isAbsolute(p) ? p : resolve(process.cwd(), p)
}

/**
 * Is this file text, whatever its extension says? Source, logs, config and
 * `.env` files all arrive with extensions no mime table can enumerate, so the
 * bytes decide instead: a NUL byte, or more than 2% odd control characters in
 * the first 8 KB, means binary. UTF-8 high bytes are left alone, so accented
 * text and emoji stay text.
 */
function looksTextual(head) {
  if (head.length === 0) return true
  if (head.includes(0)) return false
  let odd = 0
  for (const b of head) if (b < 9 || (b > 13 && b < 32)) odd += 1
  return odd / head.length < 0.02
}

/** The same question, asked without reading a 200 MB file to answer it. */
function headLooksTextual(path) {
  let fd
  try {
    fd = openSync(path, 'r')
    const buf = Buffer.alloc(8192)
    const read = readSync(fd, buf, 0, buf.length, 0)
    return looksTextual(buf.subarray(0, read))
  } catch {
    return false
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd)
      } catch {
        /* already gone */
      }
    }
  }
}

function mb(bytes) {
  return `${(bytes / 1e6).toFixed(1)} MB`
}

/* -------------------------------------------------------------------- tools */

const TOOLS = [
  {
    name: 'ask_gemini',
    description:
      'Ask Google Gemini any question and get its answer back as plain text. Use this for a genuine second opinion ' +
      'from a different model family, for Google-flavoured knowledge, or when you want an independent review of a ' +
      'design or a diagnosis. Optionally attach local FILES — source code, logs, images, PDFs, audio or video — ' +
      'which are sent to Gemini alongside the prompt; small text and images ride inline, anything larger is ' +
      'uploaded first. Directories are not accepted: name the files you want read. Calls Google\'s REST API ' +
      'directly with the Gemini API key Forge supplies, and its errors are honest and specific (no key, out of ' +
      'quota, refused) — it never invents an answer and attributes it to Gemini.',
    inputSchema: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'The question or instruction for Gemini. Be explicit — Gemini has no view of this conversation.' },
        files: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional absolute paths to FILES (not directories) for Gemini to read alongside the prompt.'
        }
      },
      required: ['prompt']
    }
  },
  {
    name: 'summarize_video',
    description:
      'Summarize a video that Claude cannot watch. Accepts a YouTube URL (ingested natively by Gemini — the ' +
      'cheapest and most reliable path), any other public https video URL, or an absolute path to a local video ' +
      'file, which is uploaded first. Returns a structured summary: one-line gist, chapter-by-chapter beats with ' +
      'timestamps, key claims, and anything actionable. Pass `focus` to steer it (e.g. "just the wiring diagram ' +
      'steps", "only the pricing"). Needs the Gemini API key Forge supplies. If the video cannot be reached — ' +
      'private, deleted, age-gated or region-locked — it says so rather than guessing at the contents.',
    inputSchema: {
      type: 'object',
      properties: {
        url_or_path: { type: 'string', description: 'A public video URL (YouTube works best) or an absolute path to a local video file.' },
        focus: { type: 'string', description: 'Optional: what the summary should concentrate on.' }
      },
      required: ['url_or_path']
    }
  },
  {
    name: 'make_image',
    description:
      'Really generate an image from a text description and save it to disk, returning absolute file paths. ' +
      'Calls Google\'s image-generation API directly, so it needs a ' +
      'Gemini API key in the environment — Forge supplies one from its settings. Use it whenever the user wants a ' +
      'picture, mockup, texture, icon, placeholder art or reference image. Describe subject, style, framing, lighting ' +
      'and mood; a fuller description gives a much better image. Errors are honest and specific (no key, out of ' +
      'quota, refused on safety grounds) and no path is ever returned unless the file was written.',
    inputSchema: {
      type: 'object',
      properties: {
        description: { type: 'string', description: 'What the image should show. Describe subject, style, framing, lighting and mood.' },
        out_dir: { type: 'string', description: 'Optional absolute directory for the image. Defaults to %APPDATA%\\Forge\\bridge-out.' },
        count: { type: 'integer', minimum: 1, maximum: MAX_IMAGE_COUNT, description: 'How many variations to generate, 1-4. Each one is a separate call, so 4 takes ~4x as long.' },
        aspect: { type: 'string', enum: [...ASPECT_RATIOS], description: 'Optional aspect ratio. Defaults to the model\'s own choice (square).' }
      },
      required: ['description']
    }
  },
  {
    name: 'edit_image',
    description:
      'Edit an existing image with a plain-English instruction — recolour it, remove or add something, change the ' +
      'background, restyle it — and save the result as a NEW file, returning its absolute path. The input file is ' +
      'never modified. Pass an absolute path to a png/jpg/webp/gif/bmp under 20 MB and say exactly what to change; ' +
      'saying what to keep the same ("keep the framing and lighting identical") measurably helps. Same direct API, ' +
      'same key and the same honest errors as make_image.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute path to the image to edit. Left untouched on disk.' },
        instruction: { type: 'string', description: 'What to change, in plain English. Also say what must stay the same.' },
        out_dir: { type: 'string', description: 'Optional absolute directory for the result. Defaults to %APPDATA%\\Forge\\bridge-out.' }
      },
      required: ['path', 'instruction']
    }
  },
  {
    name: 'make_video',
    description:
      'Really generate a short video from a text description and save it to disk as an .mp4, returning the absolute ' +
      'file path. Calls Google\'s Veo API directly, so it needs a Gemini API key in the environment — Forge supplies ' +
      'one from its settings. Use it for animated mockups, loops, motion tests, b-roll or a moving version of ' +
      'something you would otherwise draw. Describe subject, camera movement, style and lighting; motion and camera ' +
      'direction matter far more than they do for a still image. IMPORTANT: this takes roughly 1-3 minutes — say so ' +
      'before calling it, and do not call it repeatedly while one is running. Clips are 4-8 seconds, landscape or ' +
      'portrait only. Errors are honest and specific (no key, billing not enabled, out of quota, refused, timed out) ' +
      'and no path is ever returned unless the file was written.',
    inputSchema: {
      type: 'object',
      properties: {
        description: {
          type: 'string',
          description: 'What the video should show. Describe the subject, what MOVES, the camera, the style and the lighting.'
        },
        out_dir: { type: 'string', description: 'Optional absolute directory for the video. Defaults to %APPDATA%\\Forge\\bridge-out.' },
        aspect: {
          type: 'string',
          enum: [...VIDEO_ASPECT_RATIOS],
          description: 'Optional aspect ratio — landscape (16:9) or portrait (9:16) only. Defaults to the model\'s own choice.'
        },
        duration: {
          type: 'integer',
          minimum: MIN_VIDEO_SECONDS,
          maximum: MAX_VIDEO_SECONDS,
          description: `Optional clip length in seconds, ${MIN_VIDEO_SECONDS}-${MAX_VIDEO_SECONDS}. Longer clips take longer to render.`
        }
      },
      required: ['description']
    }
  }
]

/* ------------------------------------------------------------- text (REST)
 *
 * Everything below here is `ask_gemini` and `summarize_video`, on the same
 * `:generateContent` endpoint the image tools use — only asking for words back
 * instead of pixels. Nothing is duplicated from electron/gemini-media.ts.
 */

/** Classify a text-route HTTP failure. Same spirit as videoHttpError. */
function textHttpError(status, message, model) {
  if (status === 429 || /RESOURCE_EXHAUSTED|quota/i.test(message)) {
    return (
      `Gemini is out of quota for this key (${status}): ${message}\n\n` +
      'No answer was produced. Tell the user the quota is spent and to retry later, or to use a key with billing ' +
      'enabled. Do not answer in Gemini’s place.'
    )
  }
  if (status === 401 || status === 403 || /API_KEY_INVALID|API key not valid/i.test(message)) {
    return `Gemini refused the key (${status}): ${message}\n\nTell the user to check the Gemini key in Forge’s voice-agent settings.`
  }
  if (status === 404) {
    return (
      `The model “${model}” is not available to this key (404): ${message}\n\n` +
      'Set FORGE_GEMINI_ASK_MODEL to a model this key can use.'
    )
  }
  if (status === 400) {
    return (
      `Gemini rejected the request as invalid (400): ${message}\n\n` +
      'When a video or file was attached this is usually the file itself: a private, deleted, age-gated or ' +
      'region-locked video returns exactly this bare error. Nothing was read — do not guess at its contents.'
    )
  }
  return `Gemini rejected the request (${status}): ${message}`
}

/**
 * One `:generateContent` round trip expected to return words. The single
 * network funnel for both text tools, so every failure is classified once.
 * Resolves `{ ok: true, text }` or `{ ok: false, error }`.
 */
async function postText(model, key, parts) {
  let res
  try {
    res = await fetch(`${GEMINI_HOST}/v1beta/models/${model}:generateContent`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-goog-api-key': key },
      body: JSON.stringify({ contents: [{ role: 'user', parts }] }),
      signal: AbortSignal.timeout(ASK_TIMEOUT_MS)
    })
  } catch (err) {
    if (err?.name === 'TimeoutError' || err?.name === 'AbortError') {
      return {
        ok: false,
        error:
          `Gemini did not answer within ${Math.round(ASK_TIMEOUT_MS / 1000)}s, so there is no answer. ` +
          'A shorter prompt, fewer attached files or a shorter video usually fixes it.'
      }
    }
    return { ok: false, error: `Could not reach Gemini: ${scrubKey(err?.message ?? err, key)}` }
  }

  const raw = await res.text()
  let parsed = null
  try {
    parsed = JSON.parse(raw)
  } catch {
    /* keep raw */
  }

  if (!res.ok) {
    const err = parsed?.error
    const message = scrubKey(err?.message ?? raw.slice(0, 500) ?? res.statusText, key)
    return { ok: false, error: textHttpError(res.status, `${err?.status ?? ''} ${message}`.trim(), model) }
  }

  if (parsed?.promptFeedback?.blockReason) {
    return {
      ok: false,
      error:
        `Gemini blocked the prompt (${parsed.promptFeedback.blockReason}) and did not answer. ` +
        'Tell the user it was refused on safety grounds, and do not answer in its place.'
    }
  }

  const candidate = parsed?.candidates?.[0]
  // `thought: true` parts are the model's private reasoning, not its answer —
  // gemini-3.x returns them alongside the real text and they must not be shown.
  const answer = (candidate?.content?.parts ?? [])
    .filter((p) => p?.thought !== true && typeof p?.text === 'string')
    .map((p) => p.text)
    .join('')
    .trim()

  if (!answer) {
    const why = candidate?.finishReason ?? 'no reason given'
    return {
      ok: false,
      error:
        `Gemini returned no text (${why}). ` +
        (why === 'MAX_TOKENS'
          ? 'It spent its whole output budget before saying anything usable; try a narrower question.'
          : 'This is usually a refusal.') +
        ' Do not invent an answer and attribute it to Gemini.'
    }
  }
  return { ok: true, text: answer }
}

/* ----------------------------------------------------------------- Files API
 *
 * How a local file reaches Gemini. Verified live 2026-07-30 against Steve's key.
 * Three steps, and the first one's answer is in the HEADERS — its body is empty:
 *
 *   1. POST /upload/v1beta/files
 *        X-Goog-Upload-Protocol: resumable
 *        X-Goog-Upload-Command: start
 *        X-Goog-Upload-Header-Content-Length: <size>
 *        X-Goog-Upload-Header-Content-Type: <mime>
 *        body { "file": { "display_name": "…" } }
 *      → 200, header x-goog-upload-url: <one-shot session URL>
 *
 *   2. POST <that URL>
 *        X-Goog-Upload-Command: "upload, finalize"
 *        X-Goog-Upload-Offset: 0
 *        body = the raw bytes
 *      → { "file": { "name": "files/<id>", "uri": "…", "state": "PROCESSING" } }
 *
 *   3. GET /v1beta/files/<id> until state is ACTIVE — a 4.9 MB mp4 took ~2 s.
 *      Handing a PROCESSING file to generateContent is an error, not a wait.
 *
 * Then reference it as `{ file_data: { file_uri, mime_type } }`. Google expires
 * uploads after 48 h on its own; the bridge deletes them as soon as it is done,
 * so nothing of the user's lingers on Google's side.
 */

async function uploadFile(path, mime, key, displayName) {
  const size = statSync(path).size
  if (size > MAX_UPLOAD_BYTES) {
    return { ok: false, error: `${path} is ${mb(size)} — the bridge uploads at most ${mb(MAX_UPLOAD_BYTES)}.` }
  }

  let start
  try {
    start = await fetch(`${GEMINI_HOST}/upload/v1beta/files`, {
      method: 'POST',
      headers: {
        'x-goog-api-key': key,
        'content-type': 'application/json',
        'X-Goog-Upload-Protocol': 'resumable',
        'X-Goog-Upload-Command': 'start',
        'X-Goog-Upload-Header-Content-Length': String(size),
        'X-Goog-Upload-Header-Content-Type': mime
      },
      body: JSON.stringify({ file: { display_name: displayName } }),
      signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS)
    })
  } catch (err) {
    return { ok: false, error: `Could not start the upload to Gemini: ${scrubKey(err?.message ?? err, key)}` }
  }
  if (!start.ok) {
    const body = scrubKey((await start.text()).slice(0, 400), key)
    return { ok: false, error: textHttpError(start.status, body, askModel()) }
  }
  const sessionUrl = start.headers.get('x-goog-upload-url')
  if (!sessionUrl) {
    return { ok: false, error: 'Gemini accepted the upload request but returned no upload URL, so nothing was sent.' }
  }

  let bytes
  try {
    bytes = readFileSync(path)
  } catch (err) {
    return { ok: false, error: `${path} could not be read: ${err?.message ?? err}` }
  }

  let up
  try {
    up = await fetch(sessionUrl, {
      method: 'POST',
      headers: {
        'content-length': String(size),
        'X-Goog-Upload-Offset': '0',
        'X-Goog-Upload-Command': 'upload, finalize'
      },
      body: bytes,
      signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS)
    })
  } catch (err) {
    if (err?.name === 'TimeoutError' || err?.name === 'AbortError') {
      return { ok: false, error: `Uploading ${mb(size)} to Gemini timed out after ${Math.round(UPLOAD_TIMEOUT_MS / 1000)}s.` }
    }
    return { ok: false, error: `The upload to Gemini failed: ${scrubKey(err?.message ?? err, key)}` }
  }
  const upRaw = await up.text()
  if (!up.ok) {
    return { ok: false, error: textHttpError(up.status, scrubKey(upRaw.slice(0, 400), key), askModel()) }
  }
  let file = null
  try {
    file = JSON.parse(upRaw).file
  } catch {
    /* handled below */
  }
  if (!file?.name || !file?.uri) {
    return { ok: false, error: `Gemini accepted the upload but described it oddly: ${upRaw.slice(0, 200)}` }
  }

  /* Wait for ingestion. */
  const deadline = Date.now() + FILE_READY_TIMEOUT_MS
  let current = file
  while (current.state !== 'ACTIVE') {
    if (current.state === 'FAILED') {
      await deleteFile(current.name, key)
      return {
        ok: false,
        error:
          `Gemini could not process ${path}: ${current.error?.message ?? 'no reason given'}. ` +
          'The file was uploaded but is unusable — nothing was read from it.'
      }
    }
    if (Date.now() > deadline) {
      await deleteFile(current.name, key)
      return {
        ok: false,
        error:
          `Gemini was still processing ${path} after ${Math.round(FILE_READY_TIMEOUT_MS / 1000)}s, so it was never ` +
          'read. Try a shorter or smaller file.'
      }
    }
    await new Promise((r) => setTimeout(r, FILE_POLL_MS))
    let res
    try {
      res = await fetch(`${GEMINI_HOST}/v1beta/${current.name}`, {
        headers: { 'x-goog-api-key': key },
        signal: AbortSignal.timeout(VIDEO_REQUEST_TIMEOUT_MS)
      })
    } catch (err) {
      return { ok: false, error: `Lost contact with Gemini while it processed the upload: ${scrubKey(err?.message ?? err, key)}` }
    }
    const raw = await res.text()
    if (!res.ok) return { ok: false, error: textHttpError(res.status, scrubKey(raw.slice(0, 400), key), askModel()) }
    try {
      current = JSON.parse(raw)
    } catch {
      return { ok: false, error: `Checking the uploaded file returned non-JSON: ${raw.slice(0, 200)}` }
    }
  }

  return { ok: true, file: current, part: { file_data: { file_uri: current.uri, mime_type: mime } } }
}

/** Best-effort tidy-up. A failure here is not worth telling anyone about. */
async function deleteFile(name, key) {
  if (!name) return
  try {
    await fetch(`${GEMINI_HOST}/v1beta/${name}`, {
      method: 'DELETE',
      headers: { 'x-goog-api-key': key },
      signal: AbortSignal.timeout(30_000)
    })
  } catch {
    /* it expires in 48 h regardless */
  }
}

/* -------------------------------------------------------------- ask_gemini */

/**
 * Turn caller-supplied paths into request parts, by three roads:
 *
 *   • text of any extension, up to 1 MB → a text part, headed by its path
 *   • an image inside the inline budget → an inline_data part (no upload hop)
 *   • anything else Gemini reads        → uploaded, then a file_data part
 *
 * Whatever cannot travel any of the three is *reported*, never dropped in
 * silence. Returns the parts, the notes, and the uploads to clean up after.
 */
async function attachFiles(files, key) {
  const parts = []
  const notes = []
  const uploads = []
  let inlineLeft = MAX_INLINE_TOTAL_BYTES

  for (const f of files) {
    const abs = absPath(f)
    let st
    try {
      st = statSync(abs)
    } catch {
      notes.push(`no such path: ${abs}`)
      continue
    }
    if (st.isDirectory()) {
      notes.push(`${abs} is a directory — name the individual files you want read`)
      continue
    }
    if (!st.isFile()) {
      notes.push(`${abs} is not a regular file`)
      continue
    }

    const ext = extname(abs).toLowerCase()
    let mime = UPLOAD_MIME[ext]
    if (!mime) {
      // No table entry, so the bytes decide. Source, logs, config and `.env`
      // files are all welcome as text; unknown binary is not.
      if (!headLooksTextual(abs)) {
        notes.push(
          `${abs} is neither text nor a file type Gemini reads — those are ${Object.keys(UPLOAD_MIME).join(' ')}`
        )
        continue
      }
      mime = 'text/plain'
    }

    /* 1 — text small enough to paste straight into the prompt. */
    if (mime.startsWith('text/') && st.size <= MAX_TEXT_INLINE_BYTES) {
      if (st.size > inlineLeft) {
        notes.push(`${abs} did not fit in the ${mb(MAX_INLINE_TOTAL_BYTES)} attachment budget`)
        continue
      }
      let bytes
      try {
        bytes = readFileSync(abs)
      } catch (err) {
        notes.push(`${abs} could not be read: ${err?.message ?? err}`)
        continue
      }
      inlineLeft -= bytes.length
      parts.push({ text: `--- ${abs} ---\n${bytes.toString('utf8')}` })
      continue
    }

    /* 2 — an image small enough to ride along inline, skipping the upload hop. */
    if (INPUT_MIME[ext] && st.size <= MAX_INPUT_BYTES && st.size <= inlineLeft) {
      try {
        const bytes = readFileSync(abs)
        inlineLeft -= bytes.length
        parts.push({ inline_data: { mime_type: mime, data: bytes.toString('base64') } })
        continue
      } catch (err) {
        notes.push(`${abs} could not be read: ${err?.message ?? err}`)
        continue
      }
    }

    /* 3 — everything else goes up to the Files API. */
    const up = await uploadFile(abs, mime, key, abs.split(/[\\/]/).pop())
    if (!up.ok) {
      notes.push(`${abs} was not attached — ${up.error}`)
      continue
    }
    uploads.push(up.file.name)
    parts.push(up.part)
  }

  return { parts, notes, uploads }
}

async function askGemini(args) {
  const prompt = asString(args?.['prompt'], 'prompt')
  const files = asStringArray(args?.['files'], 'files')

  const key = apiKey()
  if (!key) return fail(NO_KEY_TEXT)

  const attached = files.length ? await attachFiles(files, key) : { parts: [], notes: [], uploads: [] }
  const notes = attached.notes.length ? `\n\n(Not attached — ${attached.notes.join('; ')})` : ''

  const model = askModel()
  try {
    const r = await postText(model, key, [...attached.parts, { text: prompt }])
    return r.ok ? ok(r.text + notes) : fail(r.error + notes)
  } finally {
    for (const name of attached.uploads) await deleteFile(name, key)
  }
}

/* --------------------------------------------------------- summarize_video */

function isYouTube(url) {
  let host
  try {
    host = new URL(url).hostname.toLowerCase()
  } catch {
    return false
  }
  return /(^|\.)(youtube\.com|youtu\.be|youtube-nocookie\.com)$/.test(host)
}

/**
 * Gemini fetches a plain https URL itself but wants to be told what it is;
 * YouTube links are the exception and must carry no mime type at all.
 */
function urlVideoPart(url) {
  if (isYouTube(url)) return { file_data: { file_uri: url } }
  let ext = ''
  try {
    ext = extname(new URL(url).pathname).toLowerCase()
  } catch {
    /* leave it blank */
  }
  const mime = UPLOAD_MIME[ext]
  return { file_data: { file_uri: url, mime_type: mime?.startsWith('video/') ? mime : 'video/mp4' } }
}

async function summarizeVideo(args) {
  const target = asString(args?.['url_or_path'], 'url_or_path')
  const focus = typeof args?.['focus'] === 'string' ? args['focus'].trim() : ''

  const key = apiKey()
  if (!key) return fail(NO_KEY_TEXT)

  let videoPart
  let uploaded = ''

  if (/^https?:\/\//i.test(target)) {
    videoPart = urlVideoPart(target)
  } else if (/^[a-z][a-z0-9+.-]*:\/\//i.test(target)) {
    return fail(`${target} is not a URL the bridge will fetch — pass an https link or an absolute file path.`)
  } else {
    const abs = absPath(target)
    if (!existsSync(abs)) {
      return fail(
        `No such file: ${abs}. Pass a public video URL (YouTube is ingested natively) or an absolute path ` +
          'to a video file that exists on this machine.'
      )
    }
    const ext = extname(abs).toLowerCase()
    const mime = UPLOAD_MIME[ext]
    if (!mime?.startsWith('video/')) {
      return fail(`${ext || 'That file'} is not a video type Gemini reads (${VIDEO_EXTENSIONS.join(' ')}).`)
    }
    const up = await uploadFile(abs, mime, key, abs.split(/[\\/]/).pop())
    if (!up.ok) return fail(up.error)
    uploaded = up.file.name
    videoPart = up.part
  }

  const prompt = [
    'Watch this video and summarize it for a software engineer who cannot watch it.',
    focus ? `Concentrate on: ${focus}` : '',
    '',
    'Reply in Markdown with exactly these sections:',
    '## Gist — one sentence.',
    '## Timeline — the main beats in order, each with an approximate timestamp.',
    '## Key points — the substantive claims, specifics and numbers.',
    '## Actionable — concrete steps, commands, settings or part numbers mentioned. Write "none" if there are none.',
    '',
    'Only describe what is actually in the video. If you cannot access it, say so plainly and explain why ' +
      'instead of guessing at its contents.'
  ]
    .filter((l) => l !== '')
    .join('\n')

  const model = askModel()
  let r
  try {
    r = await postText(model, key, [videoPart, { text: prompt }])
  } finally {
    await deleteFile(uploaded, key)
  }
  if (!r.ok) return fail(r.error)

  // Gemini is prone to answering "I can't watch videos" — surface that rather
  // than passing an apology off as a summary.
  if (/^\s*(i (can|could)(not|n't)|sorry|unfortunately)\b/i.test(r.text) && !/## Gist/i.test(r.text)) {
    return fail(
      `Gemini did not produce a summary. It replied:\n\n${r.text}\n\n` +
        'Tell the user Gemini could not access that video (private, age-gated, region-locked, or too large).'
    )
  }
  return ok(r.text)
}

/* ------------------------------------------------------------- media (REST)
 *
 * DUPLICATED from electron/gemini-media.ts — see the note at the top of the
 * media-config block. Behaviour, wording and file naming are kept identical.
 */

const NO_KEY =
  'Cannot generate images: no Gemini API key is available to the bridge.\n\n' +
  'Tell the user plainly that no image was created, and how to fix it: open Forge’s voice-agent settings, paste ' +
  'a Google AI Studio key (or press “Import from DictationMic”), and restart the pane — Forge writes the key into ' +
  'the MCP config it generates at %APPDATA%\\Forge\\bridge\\mcp.json, which is read when the pane launches. ' +
  'Running the bridge by hand? Set GEMINI_API_KEY in the environment.\n\n' +
  'Do not claim an image exists. Offer to describe the image in words instead.'

function extensionFor(mime) {
  const m = (mime || '').toLowerCase()
  if (m.includes('jpeg') || m.includes('jpg')) return '.jpg'
  if (m.includes('webp')) return '.webp'
  if (m.includes('gif')) return '.gif'
  if (m.includes('bmp')) return '.bmp'
  return '.png'
}

function mediaStamp(date = new Date()) {
  const p = (n) => String(n).padStart(2, '0')
  return (
    `${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}` +
    `-${p(date.getHours())}${p(date.getMinutes())}${p(date.getSeconds())}`
  )
}

function freshPath(dir, stem, ext) {
  let candidate = join(dir, `${stem}${ext}`)
  let n = 2
  while (existsSync(candidate)) {
    candidate = join(dir, `${stem} -${n}${ext}`)
    n += 1
  }
  return candidate
}

/** tmp + rename, so a half-written PNG never appears in a watched folder. */
function writeAtomic(target, bytes) {
  const tmp = `${target}.tmp`
  writeFileSync(tmp, bytes)
  renameSync(tmp, target)
}

function scrubKey(text, key) {
  return key ? String(text).split(key).join('«key»') : String(text)
}

/**
 * One `:generateContent` round trip expected to return image bytes. The single
 * network funnel, so every failure is classified in one place.
 * Resolves `{ ok: true, images, text }` or `{ ok: false, error }`.
 */
async function postImage(model, key, parts, imageConfig) {
  const generationConfig = { responseModalities: ['IMAGE'] }
  if (imageConfig && Object.keys(imageConfig).length) generationConfig.imageConfig = imageConfig

  let res
  try {
    res = await fetch(`${GEMINI_HOST}/v1beta/models/${model}:generateContent`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-goog-api-key': key },
      body: JSON.stringify({ contents: [{ role: 'user', parts }], generationConfig }),
      signal: AbortSignal.timeout(IMAGE_TIMEOUT_MS)
    })
  } catch (err) {
    if (err?.name === 'TimeoutError' || err?.name === 'AbortError') {
      return {
        ok: false,
        error: `Gemini did not answer within ${Math.round(IMAGE_TIMEOUT_MS / 1000)}s. No image was made.`
      }
    }
    return { ok: false, error: `Could not reach Gemini: ${scrubKey(err?.message ?? err, key)}` }
  }

  const raw = await res.text()
  let parsed = null
  try {
    parsed = JSON.parse(raw)
  } catch {
    /* keep raw */
  }

  if (!res.ok) {
    const err = parsed?.error
    const message = scrubKey(err?.message ?? raw.slice(0, 500) ?? res.statusText, key)
    if (res.status === 429 || /RESOURCE_EXHAUSTED|quota/i.test(`${err?.status} ${message}`)) {
      return {
        ok: false,
        error:
          `Gemini is out of quota for this key (${res.status}): ${message}\n\n` +
          'No image was made. Tell the user the daily/free-tier image quota is spent and to retry later or ' +
          'use a key with billing enabled.'
      }
    }
    if (res.status === 401 || res.status === 403 || /API_KEY_INVALID|API key not valid/i.test(message)) {
      return {
        ok: false,
        error: `Gemini refused the key (${res.status}): ${message}\n\nTell the user to check the Gemini key in Forge’s voice-agent settings.`
      }
    }
    if (res.status === 404) {
      return {
        ok: false,
        error:
          `The image model “${model}” is not available to this key (404): ${message}\n\n` +
          'Set FORGE_GEMINI_IMAGE_MODEL to a model this key can use.'
      }
    }
    return { ok: false, error: `Gemini rejected the request (${res.status} ${err?.status ?? res.statusText}): ${message}` }
  }

  if (parsed?.promptFeedback?.blockReason) {
    return {
      ok: false,
      error:
        `Gemini blocked the prompt (${parsed.promptFeedback.blockReason}) and made no image. ` +
        'Tell the user it was refused on safety grounds and suggest a different description.'
    }
  }

  const images = []
  const texts = []
  const candidate = parsed?.candidates?.[0]
  for (const part of candidate?.content?.parts ?? []) {
    if (part?.inlineData?.data) {
      images.push({ mime: part.inlineData.mimeType ?? 'image/png', bytes: Buffer.from(part.inlineData.data, 'base64') })
    } else if (part?.text) {
      texts.push(part.text)
    }
  }

  if (images.length === 0) {
    const why = candidate?.finishReason ?? 'no reason given'
    const said = texts.join(' ').trim()
    return {
      ok: false,
      error:
        `Gemini returned no image (${why}).${said ? ` It said: ${said}` : ''}\n\n` +
        'This is usually a refusal — the subject, a real person, or the style was declined. No file was written; ' +
        'do not claim one was. Try a different description.'
    }
  }

  return { ok: true, images, text: texts.join('\n').trim() }
}

function prepareOutDir(args) {
  const outDir =
    typeof args?.['out_dir'] === 'string' && args['out_dir'].trim() ? resolve(args['out_dir'].trim()) : defaultOutDir()
  try {
    mkdirSync(outDir, { recursive: true })
  } catch (err) {
    return { error: `Cannot create output directory ${outDir}: ${err?.message ?? err}` }
  }
  return { outDir }
}

/* --------------------------------------------------------------- make_image */

async function makeImage(args) {
  const description = asString(args?.['description'], 'description')

  const rawCount = args?.['count']
  if (rawCount !== undefined && rawCount !== null) {
    const n = Number(rawCount)
    if (!Number.isFinite(n) || n < 1 || n > MAX_IMAGE_COUNT) {
      throw new Error(`\`count\` must be a whole number from 1 to ${MAX_IMAGE_COUNT}`)
    }
  }
  const count = Math.min(MAX_IMAGE_COUNT, Math.max(1, Math.floor(Number(rawCount ?? 1) || 1)))

  const aspect = typeof args?.['aspect'] === 'string' ? args['aspect'].trim() : ''
  if (aspect && !ASPECT_RATIOS.includes(aspect)) {
    throw new Error(`\`aspect\` must be one of: ${ASPECT_RATIOS.join(', ')}`)
  }

  const key = apiKey()
  if (!key) return fail(NO_KEY)

  const prepared = prepareOutDir(args)
  if (prepared.error) return fail(prepared.error)

  const model = imageModel()
  const started = Date.now()
  const paths = []
  let lastError = null
  let note = ''

  for (let i = 0; i < count; i++) {
    const r = await postImage(model, key, [{ text: description }], aspect ? { aspectRatio: aspect } : null)
    if (!r.ok) {
      lastError = r.error
      break
    }
    if (r.text && !note) note = r.text
    for (const img of r.images) {
      const target = freshPath(prepared.outDir, `forge-image-${mediaStamp()}`, extensionFor(img.mime))
      try {
        writeAtomic(target, img.bytes)
      } catch (err) {
        return fail(`Gemini made the image but it could not be saved to ${target}: ${err?.message ?? err}`)
      }
      paths.push(target)
    }
  }

  if (paths.length === 0) return fail(lastError ?? 'Gemini produced no image and gave no reason.')

  const secs = ((Date.now() - started) / 1000).toFixed(1)
  const lines = [
    paths.length === 1 ? `Image saved to ${paths[0]}` : `${paths.length} images saved:`,
    ...(paths.length === 1 ? [] : paths.map((p) => `  ${p}`)),
    '',
    `Model ${model}, ${secs}s. The file(s) above exist on disk — you may reference them by path.`
  ]
  if (paths.length < count) lines.push(`Asked for ${count}, produced ${paths.length}.${lastError ? ` Then: ${lastError}` : ''}`)
  if (note) lines.push(`Gemini also said: ${note}`)
  return ok(lines.join('\n'))
}

/* --------------------------------------------------------------- edit_image */

/** Read an image off disk into an inlineData part, or throw a readable reason. */
function inlinePart(path) {
  const abs = isAbsolute(path) ? path : resolve(process.cwd(), path)
  if (!existsSync(abs)) throw new Error(`No such file: ${abs}`)
  const st = statSync(abs)
  if (!st.isFile()) throw new Error(`${abs} is not a file`)
  const ext = extname(abs).toLowerCase()
  const mime = INPUT_MIME[ext]
  if (!mime) {
    throw new Error(`${ext || 'that file'} is not an image Gemini accepts (${Object.keys(INPUT_MIME).join(', ')})`)
  }
  if (st.size > MAX_INPUT_BYTES) {
    throw new Error(`${abs} is ${(st.size / 1e6).toFixed(1)} MB — inline images must be under 20 MB`)
  }
  const bytes = readFileSync(abs)
  const stem = abs.split(/[\\/]/).pop().replace(/\.[^.]+$/, '')
  return { part: { inlineData: { mimeType: mime, data: bytes.toString('base64') } }, stem }
}

async function editImage(args) {
  const path = asString(args?.['path'], 'path')
  const instruction = asString(args?.['instruction'], 'instruction')

  const key = apiKey()
  if (!key) return fail(NO_KEY.replace('generate images', 'edit images'))

  const loaded = inlinePart(path)

  const prepared = prepareOutDir(args)
  if (prepared.error) return fail(prepared.error)

  const model = imageModel()
  const started = Date.now()
  const r = await postImage(model, key, [loaded.part, { text: instruction }], null)
  if (!r.ok) return fail(r.error)

  const paths = []
  for (const img of r.images) {
    const target = freshPath(prepared.outDir, `${loaded.stem}-edited-${mediaStamp()}`, extensionFor(img.mime))
    try {
      writeAtomic(target, img.bytes)
    } catch (err) {
      return fail(`Gemini edited the image but it could not be saved to ${target}: ${err?.message ?? err}`)
    }
    paths.push(target)
  }
  if (paths.length === 0) return fail('Gemini returned no edited image. No file was written; do not claim one was.')

  const secs = ((Date.now() - started) / 1000).toFixed(1)
  return ok(
    [
      `Edited image saved to ${paths.join('\n')}`,
      '',
      `Model ${model}, ${secs}s. The original at ${path} was not modified.`,
      r.text ? `Gemini also said: ${r.text}` : ''
    ]
      .filter(Boolean)
      .join('\n')
  )
}

/* --------------------------------------------------------------- make_video
 *
 * DUPLICATED from electron/gemini-media.ts's makeVideo() — same three-step
 * shape, same wording, same limits. See that file for the full write-up of the
 * API's mechanics; the short version:
 *
 *   POST :predictLongRunning  → { name: "models/<m>/operations/<id>" }
 *   GET  /v1beta/<name>       → { done: true, response.generateVideoResponse
 *                                 .generatedSamples[0].video.uri }
 *   GET  <uri>                → video/mp4 bytes; needs the API key (a bare
 *                               request is 403 PERMISSION_DENIED)
 */

const NO_KEY_VIDEO =
  'Cannot generate video: no Gemini API key is available to the bridge.\n\n' +
  'Tell the user plainly that no video was created, and how to fix it: open Forge’s voice-agent settings, paste ' +
  'a Google AI Studio key (or press “Import from DictationMic”), and restart the pane — Forge writes the key into ' +
  'the MCP config it generates at %APPDATA%\\Forge\\bridge\\mcp.json, which is read when the pane launches. ' +
  'Running the bridge by hand? Set GEMINI_API_KEY in the environment.\n\n' +
  'Do not claim a video exists.'

/** Classify a Veo HTTP failure. Kept identical to gemini-media.ts's videoHttpError. */
function videoHttpError(status, message, model) {
  if (status === 429 || /RESOURCE_EXHAUSTED|quota/i.test(message)) {
    return (
      `Gemini is out of quota for this key (${status}): ${message}\n\n` +
      'No video was made. Tell the user the video quota is spent and to retry later.'
    )
  }
  if (/billed users|billing|FAILED_PRECONDITION|paid tier|not available in your|free tier/i.test(message)) {
    return (
      `Video generation is a paid-only Google feature and this key is not billed (${status}): ${message}\n\n` +
      'Say exactly that: Veo needs billing enabled on the Google Cloud project behind the API key. Nothing else ' +
      'fixes it — not waiting, not a different prompt. No video was made.'
    )
  }
  if (status === 401 || status === 403 || /API_KEY_INVALID|API key not valid/i.test(message)) {
    return `Gemini refused the key (${status}): ${message}\n\nTell the user to check the Gemini key in Forge’s voice-agent settings.`
  }
  if (status === 404) {
    return (
      `The video model “${model}” is not available to this key (404): ${message}\n\n` +
      'Set FORGE_GEMINI_VIDEO_MODEL to a model this key can use.'
    )
  }
  if (/safety|blocked|prohibited|policy/i.test(message)) {
    return (
      `Gemini refused to make that video (${status}): ${message}\n\n` +
      'No file was written; do not claim one was. Try a different description.'
    )
  }
  return `Gemini rejected the video request (${status}): ${message}`
}

/** One JSON round trip against the Veo endpoints, errors already classified. */
async function videoFetch(url, key, init, model) {
  let res
  try {
    res = await fetch(url, {
      ...init,
      headers: { ...(init.headers ?? {}), 'x-goog-api-key': key },
      signal: AbortSignal.timeout(VIDEO_REQUEST_TIMEOUT_MS)
    })
  } catch (err) {
    if (err?.name === 'TimeoutError' || err?.name === 'AbortError') {
      return { ok: false, error: `Gemini did not answer within ${Math.round(VIDEO_REQUEST_TIMEOUT_MS / 1000)}s. No video was made.` }
    }
    return { ok: false, error: `Could not reach Gemini: ${scrubKey(err?.message ?? err, key)}` }
  }
  const raw = await res.text()
  if (!res.ok) {
    let parsed = null
    try {
      parsed = JSON.parse(raw)
    } catch {
      /* keep raw */
    }
    const err = parsed?.error
    const message = scrubKey(err?.message ?? raw.slice(0, 500) ?? res.statusText, key)
    return { ok: false, error: videoHttpError(res.status, `${err?.status ?? ''} ${message}`.trim(), model) }
  }
  return { ok: true, raw }
}

/** The key is about to be sent to this URL, so it is checked, not trusted. */
function safeVideoUri(uri) {
  let parsed
  try {
    parsed = new URL(uri)
  } catch {
    return null
  }
  if (parsed.protocol !== 'https:') return null
  if (parsed.host !== new URL(GEMINI_HOST).host) return null
  return parsed.toString()
}

function videoUriOf(op) {
  const samples = op?.response?.generateVideoResponse?.generatedSamples ?? op?.response?.generatedVideos ?? []
  for (const s of samples) {
    if (typeof s?.video?.uri === 'string' && s.video.uri) return s.video.uri
  }
  return null
}

async function makeVideo(args) {
  const description = asString(args?.['description'], 'description')

  const aspect = typeof args?.['aspect'] === 'string' ? args['aspect'].trim() : ''
  if (aspect && !VIDEO_ASPECT_RATIOS.includes(aspect)) {
    throw new Error(`\`aspect\` must be one of: ${VIDEO_ASPECT_RATIOS.join(', ')}`)
  }

  const rawDuration = args?.['duration']
  let duration = 0
  if (rawDuration !== undefined && rawDuration !== null && `${rawDuration}`.trim() !== '') {
    const n = Number(rawDuration)
    if (!Number.isFinite(n) || n < MIN_VIDEO_SECONDS || n > MAX_VIDEO_SECONDS) {
      throw new Error(`\`duration\` must be a whole number of seconds from ${MIN_VIDEO_SECONDS} to ${MAX_VIDEO_SECONDS}`)
    }
    duration = Math.round(n)
  }

  const key = apiKey()
  if (!key) return fail(NO_KEY_VIDEO)

  const prepared = prepareOutDir(args)
  if (prepared.error) return fail(prepared.error)

  const model = videoModel()
  const started = Date.now()
  const left = () => VIDEO_TIMEOUT_MS - (Date.now() - started)

  /* 1 — submit */
  const parameters = {}
  if (aspect) parameters.aspectRatio = aspect
  if (duration) parameters.durationSeconds = duration

  const submitted = await videoFetch(
    `${GEMINI_HOST}/v1beta/models/${model}:predictLongRunning`,
    key,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ instances: [{ prompt: description }], parameters })
    },
    model
  )
  if (!submitted.ok) return fail(submitted.error)

  let operation = ''
  try {
    operation = String(JSON.parse(submitted.raw).name ?? '')
  } catch {
    return fail(`Gemini accepted the video request but its reply was not JSON: ${submitted.raw.slice(0, 200)}`)
  }
  if (!operation) {
    return fail('Gemini accepted the video request but named no operation to poll, so there is nothing to wait for.')
  }

  /* 2 — poll */
  let op = null
  let polls = 0
  for (;;) {
    const gap = VIDEO_POLL_MS[polls] ?? VIDEO_POLL_STEADY_MS
    polls += 1
    if (left() <= gap) {
      return fail(
        `The video was still rendering after ${Math.round((Date.now() - started) / 1000)}s and the bridge stopped ` +
          'waiting. It may still finish on Google’s side, but nothing was downloaded — no file exists, so do not ' +
          'claim one does. Tell the user to try a shorter clip.'
      )
    }
    await new Promise((r) => setTimeout(r, gap))

    const polled = await videoFetch(`${GEMINI_HOST}/v1beta/${operation}`, key, { method: 'GET' }, model)
    if (!polled.ok) return fail(polled.error)
    try {
      op = JSON.parse(polled.raw)
    } catch {
      return fail(`Polling the video operation returned non-JSON: ${polled.raw.slice(0, 200)}`)
    }
    if (op?.done !== true) continue
    if (op.error) {
      return fail(videoHttpError(Number(op.error.code ?? 0), scrubKey(op.error.message ?? 'no reason given', key), model))
    }
    break
  }

  const rawUri = videoUriOf(op)
  if (!rawUri) {
    return fail(
      'Gemini finished the video operation but returned no file to download. This is usually a silent refusal — ' +
        'no file was written, so do not claim one was.'
    )
  }
  const uri = safeVideoUri(rawUri)
  if (!uri) {
    return fail(`Gemini returned a video URL the bridge will not fetch (not ${new URL(GEMINI_HOST).host}).`)
  }

  /* 3 — download (binary, so it cannot go through videoFetch) */
  let res
  try {
    res = await fetch(uri, { headers: { 'x-goog-api-key': key }, signal: AbortSignal.timeout(VIDEO_REQUEST_TIMEOUT_MS) })
  } catch (err) {
    if (err?.name === 'TimeoutError' || err?.name === 'AbortError') {
      return fail('The video was generated but the download timed out, so no file was saved.')
    }
    return fail(`The video was generated but could not be downloaded: ${scrubKey(err?.message ?? err, key)}`)
  }
  if (!res.ok) {
    const body = scrubKey((await res.text()).slice(0, 400), key)
    return fail(videoHttpError(res.status, body, model))
  }

  const bytes = Buffer.from(await res.arrayBuffer())
  // `ftyp` at offset 4 is the ISO base-media signature. An error page saved as
  // .mp4 is worse than an honest failure.
  if (!(bytes.length > 12 && bytes.subarray(4, 8).toString('latin1') === 'ftyp')) {
    return fail(`The download did not return a video (${bytes.length} bytes, no mp4 header). No file was written.`)
  }

  const target = freshPath(prepared.outDir, `forge-video-${mediaStamp()}`, '.mp4')
  try {
    writeAtomic(target, bytes)
  } catch (err) {
    return fail(`Gemini made the video but it could not be saved to ${target}: ${err?.message ?? err}`)
  }

  const secs = ((Date.now() - started) / 1000).toFixed(1)
  return ok(
    [
      `Video saved to ${target}`,
      '',
      `Model ${model}, ${secs}s, ${(bytes.length / 1e6).toFixed(1)} MB` +
        `${duration ? `, ${duration}s` : ''}${aspect ? `, ${aspect}` : ''}. ` +
        'The file above exists on disk — you may reference it by path.'
    ].join('\n')
  )
}

/* -------------------------------------------------------------------- serve */

const HANDLERS = {
  ask_gemini: askGemini,
  summarize_video: summarizeVideo,
  make_image: makeImage,
  edit_image: editImage,
  make_video: makeVideo
}

const server = new Server(
  { name: SERVER_NAME, version: SERVER_VERSION },
  { capabilities: { tools: {} } }
)

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }))

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params
  const handler = HANDLERS[name]
  if (!handler) return fail(`Unknown tool: ${name}. This server offers: ${Object.keys(HANDLERS).join(', ')}.`)
  try {
    return await handler(args ?? {})
  } catch (err) {
    // Bad arguments and unexpected throws both come back as tool errors so the
    // agent can correct itself instead of the connection dropping.
    return fail(`${name} failed: ${err?.message ?? String(err)}`)
  }
})

async function main() {
  await server.connect(new StdioServerTransport())
  process.stderr.write(
    `[${SERVER_NAME}] ready (out dir: ${defaultOutDir()}, ask model: ${askModel()}, ` +
      `image model: ${imageModel()}, video model: ${videoModel()}, ` +
      `api key: ${apiKey() ? 'present' : 'ABSENT — every tool will refuse'})\n`
  )
}

main().catch((err) => {
  process.stderr.write(`[${SERVER_NAME}] fatal: ${err?.stack ?? err}\n`)
  process.exit(1)
})
