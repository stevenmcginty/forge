#!/usr/bin/env node
/**
 * forge-bridge — the cross-agent bridge.
 *
 * A standalone MCP server (stdio transport) that Forge registers into every
 * Claude Code pane, so Claude can hand work to the Gemini CLI: things Claude
 * cannot do itself (watch a YouTube video, generate an image) and second
 * opinions from a different model family.
 *
 * Auth model, in two halves:
 *
 *   • `ask_gemini` / `summarize_video` shell out to the `gemini` binary on PATH,
 *     which uses whatever login *it* holds in %USERPROFILE%\.gemini. If a
 *     GEMINI_API_KEY is in the environment it is passed straight through, so the
 *     CLI works even when nobody has run `gemini` to sign in.
 *   • `make_image` / `edit_image` call Google's REST API directly, because the
 *     CLI has no image tool at all (see README). They need GEMINI_API_KEY in the
 *     environment; Forge puts it there via the mcp.json it generates under
 *     %APPDATA%\Forge\bridge\. Nothing is written to disk by this file except
 *     the images themselves.
 *
 * Run standalone (for testing):  node bridge/gemini-bridge.mjs
 * It speaks JSON-RPC over stdin/stdout, so stdout must stay clean — every
 * diagnostic in this file goes to stderr.
 */

import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { delimiter, dirname, extname, isAbsolute, join, resolve } from 'node:path'
import { homedir } from 'node:os'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'

const SERVER_NAME = 'forge-bridge'
const SERVER_VERSION = '1.0.0'

/** Hard ceiling on any single Gemini invocation. */
const TIMEOUT_MS = 120_000
/** Gemini CLI exit codes (packages/core/src/utils/exitCodes.ts, v0.53). */
const EXIT_AUTH = 41
const EXIT_INPUT = 42
const EXIT_CONFIG = 52

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

/* --------------------------------------------------------------- messaging */

const NOT_INSTALLED =
  'Gemini CLI not installed. Tell the user: Forge needs the Gemini CLI on PATH — ' +
  'run `npm install -g @google/gemini-cli` in a terminal, then run `gemini` once to sign in ' +
  'with their Google account.'

const NOT_LOGGED_IN =
  'Gemini CLI not logged in. Tell the user: run `gemini` once in a terminal to sign in with ' +
  'their Google account (a browser window opens), then retry. Nothing is stored by Forge — ' +
  'the CLI keeps its own credentials.'

/** Every failure comes back as readable prose, never as a fabricated success. */
function fail(text) {
  return { content: [{ type: 'text', text }], isError: true }
}

function ok(text) {
  return { content: [{ type: 'text', text }] }
}

/* ------------------------------------------------------------- gemini shell */

/**
 * How to invoke the CLI: `{ file, prefixArgs }`.
 *
 * On Windows the npm global binary is `gemini.cmd`, and since the 2024 argument-
 * injection fix Node refuses to spawn a `.cmd` at all without `shell: true` —
 * which would reintroduce quoting bugs for prompts full of quotes and newlines.
 * So we read the shim, pull out the real `gemini.js` it points at, and run that
 * under Node directly. `shell` stays off, and prompts are passed as a literal
 * argv entry that nothing can reinterpret.
 *
 * Resolved once and cached; `null` means "not installed".
 */
let launcherCache

function nodeExe() {
  // Under Electron-as-node, execPath is electron.exe — not something to hand a
  // CLI script to. Fall back to PATH's node in that case.
  const p = process.execPath
  return /node(\.exe)?$/i.test(p) ? p : 'node'
}

/**
 * Pull the real target out of an npm cmd-shim / bash shim. npm points these at
 * either a JS entry (run it under Node) or a native launcher (run it directly),
 * so both are matched and the caller decides.
 */
function targetFromShim(shimPath) {
  let text
  try {
    text = readFileSync(shimPath, 'utf8')
  } catch {
    return null
  }
  const base = dirname(shimPath)
  for (const m of text.matchAll(/"?(?:%dp0%|\$basedir|%~dp0)[\\/]?([^"\s]+\.(?:[cm]?js|exe))"?/g)) {
    const candidate = resolve(base, m[1].replace(/\\/g, '/'))
    if (existsSync(candidate)) return candidate
  }
  return null
}

/** Turn a shim target into a spawnable `{ file, prefixArgs }`. */
function launcherFor(target) {
  return /\.exe$/i.test(target) ? { file: target, prefixArgs: [] } : { file: nodeExe(), prefixArgs: [target] }
}

function resolveLauncher() {
  if (launcherCache !== undefined) return launcherCache
  launcherCache = null

  const override = process.env['FORGE_GEMINI_JS']
  if (override && existsSync(override)) {
    launcherCache = { file: nodeExe(), prefixArgs: [override] }
    return launcherCache
  }

  const dirs = (process.env['PATH'] ?? '').split(delimiter).filter(Boolean)
  const names = process.platform === 'win32' ? ['gemini.cmd', 'gemini.exe', 'gemini'] : ['gemini']

  for (const dir of dirs) {
    for (const name of names) {
      const p = join(dir, name)
      if (!existsSync(p)) continue
      if (name.endsWith('.exe')) {
        launcherCache = { file: p, prefixArgs: [] }
        return launcherCache
      }
      const target = targetFromShim(p)
      if (target) {
        launcherCache = launcherFor(target)
        return launcherCache
      }
      // A real executable (POSIX) — spawn it as-is.
      if (process.platform !== 'win32') {
        launcherCache = { file: p, prefixArgs: [] }
        return launcherCache
      }
    }
  }
  return launcherCache
}

/**
 * Spawn the Gemini CLI with the given argv. Never uses a shell, so prompts
 * containing quotes, backticks or newlines cannot be reinterpreted.
 */
function runGemini(args, { cwd } = {}) {
  return new Promise((done) => {
    const launcher = resolveLauncher()
    if (!launcher) {
      done({ spawnFailed: true, code: null, stdout: '', stderr: 'gemini not found on PATH' })
      return
    }

    let child
    try {
      child = spawn(launcher.file, [...launcher.prefixArgs, ...args], {
        cwd: cwd && existsSync(cwd) ? cwd : process.cwd(),
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: cleanEnv()
      })
    } catch (err) {
      done({ spawnFailed: true, code: null, stdout: '', stderr: String(err?.message ?? err) })
      return
    }

    let stdout = ''
    let stderr = ''
    let settled = false
    const finish = (result) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      done(result)
    }

    const timer = setTimeout(() => {
      try {
        child.kill()
      } catch {
        /* already gone */
      }
      finish({ timedOut: true, code: null, stdout, stderr })
    }, TIMEOUT_MS)

    child.stdout.on('data', (d) => {
      stdout += d.toString()
    })
    child.stderr.on('data', (d) => {
      stderr += d.toString()
    })
    child.on('error', (err) => {
      // ENOENT here is the "CLI is not installed" signal.
      finish({ spawnFailed: err?.code === 'ENOENT', code: null, stdout, stderr: String(err?.message ?? err) })
    })
    child.on('close', (code) => finish({ code, stdout, stderr }))
  })
}

/**
 * Electron injects variables that break child Node processes (notably
 * ELECTRON_RUN_AS_NODE). Claude Code spawns us, and it may itself have been
 * started from a Forge pane, so scrub them before reaching Gemini.
 */
function cleanEnv() {
  const env = {}
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined) continue
    if (/^ELECTRON_(RUN_AS_NODE|NO_ATTACH_CONSOLE|IS_DEV|ENABLE_LOGGING)$/.test(k)) continue
    if (k === 'NODE_OPTIONS') continue
    env[k] = v
  }
  // Gemini's TUI does clever things with a live terminal; we want plain text.
  env['NO_COLOR'] = '1'
  env['TERM'] = 'dumb'
  // GEMINI_API_KEY (when Forge put one in our environment) is passed straight
  // through by the copy above: the CLI reads it and works signed-out, which
  // makes ask_gemini/summarize_video usable without a browser login.
  return env
}

/**
 * The single funnel every tool goes through: run a non-interactive prompt and
 * turn the outcome into either the model's answer or a human-readable
 * explanation of why there isn't one.
 *
 * `-p/--prompt` is the Gemini CLI's documented headless flag (verified against
 * `gemini --help`, v0.53.0). `-o text` keeps output free of JSON wrapping.
 */
async function ask(prompt, { cwd, extraArgs = [] } = {}) {
  const args = ['-p', prompt, '-o', 'text', ...extraArgs]
  const r = await runGemini(args, { cwd })

  if (r.spawnFailed) return { ok: false, text: NOT_INSTALLED }
  if (r.timedOut) {
    return {
      ok: false,
      text:
        `Gemini timed out after ${Math.round(TIMEOUT_MS / 1000)}s and was killed. ` +
        'Tell the user the request was too large or the network stalled; a shorter prompt or ' +
        'fewer attached files usually fixes it.' +
        tail(r.stderr)
    }
  }
  if (r.code === EXIT_AUTH || looksLoggedOut(r.stderr) || looksLoggedOut(r.stdout)) {
    return { ok: false, text: `${NOT_LOGGED_IN}\n\nGemini said:${tail(r.stderr || r.stdout)}` }
  }
  if (r.code === EXIT_INPUT) {
    return { ok: false, text: `Gemini rejected the input (exit 42).${tail(r.stderr)}` }
  }
  if (r.code === EXIT_CONFIG) {
    return {
      ok: false,
      text:
        'Gemini CLI is misconfigured (exit 52) — check %USERPROFILE%\\.gemini\\settings.json.' +
        tail(r.stderr)
    }
  }
  if (r.code !== 0) {
    return { ok: false, text: `Gemini exited ${r.code}.${tail(r.stderr || r.stdout)}` }
  }

  const answer = r.stdout.trim()
  if (!answer) {
    return { ok: false, text: `Gemini returned nothing (exit 0).${tail(r.stderr)}` }
  }
  return { ok: true, text: answer, stderr: r.stderr }
}

/** The CLI reports the auth wall on stderr; match it without relying on exit codes alone. */
function looksLoggedOut(s) {
  if (!s) return false
  return (
    /set an auth method/i.test(s) ||
    /GEMINI_API_KEY/.test(s) ||
    /please (sign|log) ?in/i.test(s) ||
    /not authenticated/i.test(s) ||
    /oauth/i.test(s) && /expired|invalid/i.test(s)
  )
}

function tail(s, limit = 1200) {
  const t = (s ?? '').trim()
  if (!t) return ''
  return `\n\n${t.length > limit ? `…${t.slice(t.length - limit)}` : t}`
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

/**
 * Turn caller-supplied paths into Gemini `@path` references. The CLI resolves
 * `@`-prefixed tokens in the prompt into file contents (atCommandUtils, v0.53),
 * which is the only file-attach route the headless mode offers.
 *
 * Returns the prompt suffix plus the list of directories Gemini must be allowed
 * to read (`--include-directories`), since `@` only reaches inside the workspace.
 */
function attachFiles(files) {
  const refs = []
  const dirs = new Set()
  const missing = []
  for (const f of files) {
    const abs = isAbsolute(f) ? f : resolve(process.cwd(), f)
    if (!existsSync(abs)) {
      missing.push(abs)
      continue
    }
    refs.push(`@${abs.replace(/\\/g, '/')}`)
    dirs.add(statSync(abs).isDirectory() ? abs : join(abs, '..'))
  }
  return { refs, dirs: [...dirs], missing }
}

/* -------------------------------------------------------------------- tools */

const TOOLS = [
  {
    name: 'ask_gemini',
    description:
      'Ask Google Gemini (via the local Gemini CLI, using the user\'s own Google login) any question. ' +
      'Use this for a genuine second opinion from a different model family, for Google-flavoured knowledge, ' +
      'or when you want an independent review of a design or a diagnosis. Optionally attach local files or ' +
      'directories, which are inlined into the prompt for Gemini to read. ' +
      'Returns Gemini\'s plain-text answer, or a plain-English explanation if the CLI is missing or signed out.',
    inputSchema: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'The question or instruction for Gemini. Be explicit — Gemini has no view of this conversation.' },
        files: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional absolute paths to files or directories for Gemini to read alongside the prompt.'
        }
      },
      required: ['prompt']
    }
  },
  {
    name: 'summarize_video',
    description:
      'Summarize a video that Claude cannot watch. Accepts a YouTube (or other public video) URL, which Gemini ' +
      'ingests natively, or an absolute path to a local video file. Returns a structured summary: one-line gist, ' +
      'chapter-by-chapter beats with timestamps, key claims, and anything actionable. Pass `focus` to steer it ' +
      '(e.g. "just the wiring diagram steps", "only the pricing"). Local-file support depends on the signed-in ' +
      'account\'s upload limits; URLs are the reliable path.',
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
      'Calls Google\'s image-generation API directly (not the Gemini CLI, which has no image tool), so it needs a ' +
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
  }
]

/* -------------------------------------------------------------- ask_gemini */

async function askGemini(args) {
  const prompt = asString(args?.['prompt'], 'prompt')
  const files = asStringArray(args?.['files'], 'files')

  let finalPrompt = prompt
  const extraArgs = []
  let notes = ''

  if (files.length) {
    const { refs, dirs, missing } = attachFiles(files)
    if (missing.length) notes += `\n\n(Not attached — no such path: ${missing.join(', ')})`
    if (refs.length) {
      finalPrompt = `${prompt}\n\nRelevant files:\n${refs.join('\n')}`
      for (const d of dirs) extraArgs.push('--include-directories', d)
    }
  }

  const r = await ask(finalPrompt, { extraArgs })
  return r.ok ? ok(r.text + notes) : fail(r.text + notes)
}

/* --------------------------------------------------------- summarize_video */

async function summarizeVideo(args) {
  const target = asString(args?.['url_or_path'], 'url_or_path')
  const focus = typeof args?.['focus'] === 'string' ? args['focus'].trim() : ''

  const isUrl = /^https?:\/\//i.test(target)
  const extraArgs = []
  let reference

  if (isUrl) {
    reference = target
  } else {
    const abs = isAbsolute(target) ? target : resolve(process.cwd(), target)
    if (!existsSync(abs)) {
      return fail(
        `No such file: ${abs}. Pass a public video URL (YouTube is handled natively) or an absolute path ` +
          'to a video file that exists on this machine.'
      )
    }
    reference = `@${abs.replace(/\\/g, '/')}`
    extraArgs.push('--include-directories', join(abs, '..'))
  }

  const prompt = [
    'Watch this video and summarize it for a software engineer who cannot watch it.',
    '',
    `Video: ${reference}`,
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

  const r = await ask(prompt, { extraArgs })
  if (!r.ok) return fail(r.text)

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

/* -------------------------------------------------------------------- serve */

const HANDLERS = {
  ask_gemini: askGemini,
  summarize_video: summarizeVideo,
  make_image: makeImage,
  edit_image: editImage
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
    `[${SERVER_NAME}] ready (out dir: ${defaultOutDir()}, image model: ${imageModel()}, ` +
      `api key: ${apiKey() ? 'present' : 'ABSENT — make_image/edit_image will refuse'})\n`
  )
}

main().catch((err) => {
  process.stderr.write(`[${SERVER_NAME}] fatal: ${err?.stack ?? err}\n`)
  process.exit(1)
})
