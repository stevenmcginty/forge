#!/usr/bin/env node
/**
 * forge-bridge — the cross-agent bridge.
 *
 * A standalone MCP server (stdio transport) that Forge registers into every
 * Claude Code pane, so Claude can hand work to the Gemini CLI: things Claude
 * cannot do itself (watch a YouTube video, generate an image) and second
 * opinions from a different model family.
 *
 * Auth model: none of Steve's credentials pass through here. Every call shells
 * out to the `gemini` binary already on PATH, which uses whatever login *it*
 * holds in %USERPROFILE%\.gemini. Forge stores no tokens and no API keys.
 *
 * Run standalone (for testing):  node bridge/gemini-bridge.mjs
 * It speaks JSON-RPC over stdin/stdout, so stdout must stay clean — every
 * diagnostic in this file goes to stderr.
 */

import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { delimiter, dirname, isAbsolute, join, resolve } from 'node:path'
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

const IMAGE_EXT = /\.(png|jpg|jpeg|webp|gif|bmp|avif)$/i

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
      'Generate an image from a text description via Gemini and save it to disk, returning the file path. ' +
      'IMPORTANT CAPABILITY NOTE: the Gemini CLI has no built-in image-generation tool — it can only produce ' +
      'images if an image/media-generation MCP extension (e.g. Google\'s genmedia MCP server, exposing Imagen) ' +
      'is installed into the CLI, or an equivalent tool is configured. This tool probes for that at call time. ' +
      'If nothing can generate an image it returns a clear error explaining exactly what to install — it never ' +
      'invents a file path. Verify the returned path exists before telling the user an image was made.',
    inputSchema: {
      type: 'object',
      properties: {
        description: { type: 'string', description: 'What the image should show. Describe subject, style, framing and mood.' },
        out_dir: { type: 'string', description: 'Optional absolute directory for the image. Defaults to %APPDATA%\\Forge\\bridge-out.' }
      },
      required: ['description']
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

/* --------------------------------------------------------------- make_image */

/**
 * Does the installed CLI have anything that can actually make an image?
 * Checked live rather than assumed: an extension can be added at any time.
 */
async function probeImageSupport() {
  const r = await runGemini(['extensions', 'list'])
  if (r.spawnFailed) return { available: false, reason: NOT_INSTALLED }
  const listing = `${r.stdout}\n${r.stderr}`
  if (/no extensions installed/i.test(listing)) return { available: false, reason: null, listing }
  const hit = /genmedia|imagen|image|veo|media/i.test(listing)
  return { available: hit, reason: null, listing }
}

function newestImageSince(dir, since) {
  if (!existsSync(dir)) return null
  let best = null
  for (const name of readdirSync(dir)) {
    if (!IMAGE_EXT.test(name)) continue
    const p = join(dir, name)
    let st
    try {
      st = statSync(p)
    } catch {
      continue
    }
    if (!st.isFile() || st.mtimeMs < since) continue
    if (!best || st.mtimeMs > best.mtimeMs) best = { path: p, mtimeMs: st.mtimeMs }
  }
  return best?.path ?? null
}

const NO_IMAGE_GEN =
  'Cannot generate images: the installed Gemini CLI has no image-generation tool.\n\n' +
  'Tell the user plainly that no image was created, and that to enable it they need ONE of:\n' +
  '  1. An image/media-generation MCP extension in the Gemini CLI — e.g. Google\'s genmedia MCP server ' +
  '(Imagen/Veo/Lyria), added with `gemini extensions install <source>` or configured in ' +
  '%USERPROFILE%\\.gemini\\settings.json.\n' +
  '  2. Any other image tool exposed to the CLI that can write a file to disk.\n\n' +
  'Do not claim an image exists. Offer to describe the image in words, or to write the prompt out so ' +
  'they can paste it into an image tool themselves.'

async function makeImage(args) {
  const description = asString(args?.['description'], 'description')
  const outDir = typeof args?.['out_dir'] === 'string' && args['out_dir'].trim() ? args['out_dir'].trim() : defaultOutDir()

  try {
    mkdirSync(outDir, { recursive: true })
  } catch (err) {
    return fail(`Cannot create output directory ${outDir}: ${err?.message ?? err}`)
  }

  const probe = await probeImageSupport()
  if (probe.reason) return fail(probe.reason)
  if (!probe.available) return fail(NO_IMAGE_GEN)

  // An image tool is present — ask for the file, then verify on disk rather
  // than trusting the model's word for it.
  const startedAt = Date.now() - 2000
  const prompt = [
    'Generate an image and save it to disk.',
    '',
    `Description: ${description}`,
    `Save the image file into this exact directory: ${outDir}`,
    '',
    'Use your image-generation tool, write the file, then reply with only the absolute path of the file ' +
      'you wrote. If you have no tool that can generate an image, reply with exactly: NO_IMAGE_TOOL'
  ].join('\n')

  const r = await ask(prompt, { cwd: outDir, extraArgs: ['--include-directories', outDir, '--approval-mode', 'yolo'] })
  if (!r.ok) return fail(r.text)
  if (/NO_IMAGE_TOOL/.test(r.text)) return fail(NO_IMAGE_GEN)

  // Prefer a path Gemini named, but only if it actually exists.
  const claimed = (r.text.match(/[A-Za-z]:[\\/][^\s"'`<>|]+|\/[^\s"'`<>|]+/g) ?? [])
    .map((p) => p.replace(/[.,)]+$/, ''))
    .find((p) => IMAGE_EXT.test(p) && existsSync(p))

  const found = claimed ?? newestImageSince(outDir, startedAt)
  if (!found) {
    return fail(
      `Gemini reported success but no image file appeared in ${outDir}. Do not tell the user an image ` +
        `was created. Gemini said:\n\n${r.text}`
    )
  }
  return ok(`Image saved to ${found}\n\nGemini said: ${r.text}`)
}

/* -------------------------------------------------------------------- serve */

const HANDLERS = {
  ask_gemini: askGemini,
  summarize_video: summarizeVideo,
  make_image: makeImage
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
  process.stderr.write(`[${SERVER_NAME}] ready (out dir: ${defaultOutDir()})\n`)
}

main().catch((err) => {
  process.stderr.write(`[${SERVER_NAME}] fatal: ${err?.stack ?? err}\n`)
  process.exit(1)
})
