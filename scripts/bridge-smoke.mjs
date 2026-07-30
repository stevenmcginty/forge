/**
 * bridge-smoke — drives bridge/gemini-bridge.mjs over real MCP stdio.
 *
 * Speaks the wire protocol by hand (no SDK client) so a broken server can't
 * make a broken test pass: initialize → tools/list → tools/call.
 *
 * Run:  node scripts/bridge-smoke.mjs
 *
 * Modes, chosen automatically:
 *   - Gemini absent or signed out  → asserts every tool returns the graceful
 *     error path (isError + a message that names the fix).
 *   - Gemini signed in             → additionally asserts a live round trip.
 *   - A Gemini API key on disk     → additionally generates and edits a real
 *     image, and asserts the returned paths exist (opt in with --live-image;
 *     it costs quota, so it is never part of the default run).
 *
 * Pass --force-absent to hide the CLI from the server (PATH stripped) and test
 * the not-installed branch even on a machine that has it.
 */

import { spawn } from 'node:child_process'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { delimiter, dirname, join } from 'node:path'
import { tmpdir } from 'node:os'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const SERVER = join(root, 'bridge', 'gemini-bridge.mjs')
const MEDIA_TS = join(root, 'electron', 'gemini-media.ts')

const forceAbsent = process.argv.includes('--force-absent')
const liveImage = process.argv.includes('--live-image')
const liveVideo = process.argv.includes('--live-video')

/**
 * Where a Gemini key might be, for the opt-in live-image run only. A path, not
 * a key — nothing secret is committed, and nothing is written back.
 */
function findApiKey() {
  const fromEnv = (process.env['GEMINI_API_KEY'] ?? '').trim()
  if (fromEnv) return { key: fromEnv, source: 'GEMINI_API_KEY' }
  const candidates = [
    join(homedir(), 'Desktop', 'DictationMic', 'gemini.key'),
    join(homedir(), '.gemini-key')
  ]
  for (const path of candidates) {
    if (!existsSync(path)) continue
    const key = readFileSync(path, 'utf8').trim()
    if (key) return { key, source: path }
  }
  return null
}

let failures = 0
let checks = 0

function check(label, condition, detail) {
  checks += 1
  if (condition) {
    console.log(`  ok   ${label}`)
  } else {
    failures += 1
    console.log(`  FAIL ${label}${detail ? `\n       ${String(detail).replace(/\n/g, '\n       ')}` : ''}`)
  }
}

/* ------------------------------------------------------------ MCP transport */

function openServer(env) {
  const child = spawn(process.execPath, [SERVER], {
    cwd: root,
    stdio: ['pipe', 'pipe', 'pipe'],
    env
  })

  let buffer = ''
  let stderr = ''
  const waiters = new Map()

  child.stdout.on('data', (chunk) => {
    buffer += chunk.toString()
    // Newline-delimited JSON is the stdio transport's framing.
    let nl
    while ((nl = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, nl).trim()
      buffer = buffer.slice(nl + 1)
      if (!line) continue
      let msg
      try {
        msg = JSON.parse(line)
      } catch {
        continue
      }
      const w = waiters.get(msg.id)
      if (w) {
        waiters.delete(msg.id)
        w(msg)
      }
    }
  })
  child.stderr.on('data', (d) => {
    stderr += d.toString()
  })

  let nextId = 1
  const request = (method, params) =>
    new Promise((res, rej) => {
      const id = nextId++
      // Longer than the bridge's own 6-minute video budget, so a slow Veo
      // render fails as the tool's honest timeout rather than as a dead test.
      const timer = setTimeout(() => {
        waiters.delete(id)
        rej(new Error(`timeout waiting for ${method}\nstderr: ${stderr}`))
      }, 420_000)
      waiters.set(id, (msg) => {
        clearTimeout(timer)
        res(msg)
      })
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
    })

  const notify = (method, params) => {
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`)
  }

  return { child, request, notify, stderrText: () => stderr, close: () => child.kill() }
}

/** No key in the environment: the media tools' "cannot do this" path. */
function envWithoutKey(base = process.env) {
  const env = { ...base }
  delete env['GEMINI_API_KEY']
  delete env['GOOGLE_API_KEY']
  return env
}

/** Strip every directory that holds a gemini shim, to simulate "not installed". */
function envWithoutGemini() {
  const env = envWithoutKey()
  const kept = (env['PATH'] ?? '')
    .split(delimiter)
    .filter((d) => d && !['gemini', 'gemini.cmd', 'gemini.exe'].some((n) => existsSync(join(d, n))))
  // Windows env lookups are case-insensitive but the object here is not, so
  // clear both spellings or the child inherits the original PATH.
  env['PATH'] = kept.join(delimiter)
  env['Path'] = env['PATH']
  delete env['FORGE_GEMINI_JS']
  return env
}

/* ------------------------------------------------------------------- checks */

function textOf(result) {
  const content = result?.content ?? []
  return content.map((c) => c?.text ?? '').join('\n')
}

async function handshake(session, label) {
  const init = await session.request('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'bridge-smoke', version: '1.0.0' }
  })
  check(`${label}: initialize returns a result`, !!init.result, JSON.stringify(init).slice(0, 400))
  check(
    `${label}: server identifies as forge-bridge`,
    init.result?.serverInfo?.name === 'forge-bridge',
    JSON.stringify(init.result?.serverInfo)
  )
  check(`${label}: advertises tools capability`, !!init.result?.capabilities?.tools, JSON.stringify(init.result?.capabilities))
  session.notify('notifications/initialized', {})
  return init
}

const TOOL_NAMES = ['ask_gemini', 'edit_image', 'make_image', 'make_video', 'summarize_video']

async function listTools(session, label) {
  const res = await session.request('tools/list', {})
  const tools = res.result?.tools ?? []
  const names = tools.map((t) => t.name).sort()
  check(
    `${label}: tools/list returns exactly the four bridge tools`,
    JSON.stringify(names) === JSON.stringify(TOOL_NAMES),
    JSON.stringify(names)
  )
  for (const t of tools) {
    check(
      `${label}: ${t.name} has a described object input schema`,
      t.inputSchema?.type === 'object' && !!t.inputSchema.properties && typeof t.description === 'string' && t.description.length > 40,
      JSON.stringify(t.inputSchema)
    )
  }
  const required = {
    ask_gemini: ['prompt'],
    summarize_video: ['url_or_path'],
    make_image: ['description'],
    edit_image: ['path', 'instruction'],
    make_video: ['description']
  }
  for (const t of tools) {
    check(
      `${label}: ${t.name} requires ${required[t.name].join(', ')}`,
      JSON.stringify(t.inputSchema?.required) === JSON.stringify(required[t.name]),
      JSON.stringify(t.inputSchema?.required)
    )
  }
  return tools
}

/** Every graceful failure must be flagged AND actionable. */
function expectGraceful(label, res, patterns) {
  const result = res.result
  check(`${label}: returned a tool result (not a protocol error)`, !!result && !res.error, JSON.stringify(res.error))
  if (!result) return
  const text = textOf(result)
  check(`${label}: flagged isError`, result.isError === true, JSON.stringify(result).slice(0, 300))
  check(`${label}: non-empty explanation`, text.trim().length > 20, text)
  check(
    `${label}: explanation tells the user what to do`,
    patterns.some((p) => p.test(text)),
    text.slice(0, 500)
  )
  check(`${label}: did not fabricate success`, !/^Image saved to/.test(text), text.slice(0, 200))
}

/* --------------------------------------------------------------------- main */

async function runAbsentSuite() {
  console.log('\n[1] CLI hidden from the server (not-installed path)')
  const session = openServer(envWithoutGemini())
  try {
    await handshake(session, 'absent')
    await listTools(session, 'absent')

    const fixIt = [/npm install -g @google\/gemini-cli/, /run `gemini` once/, /not installed/i, /not logged in/i]

    expectGraceful(
      'absent: ask_gemini',
      await session.request('tools/call', { name: 'ask_gemini', arguments: { prompt: 'hello' } }),
      fixIt
    )
    expectGraceful(
      'absent: summarize_video',
      await session.request('tools/call', {
        name: 'summarize_video',
        arguments: { url_or_path: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' }
      }),
      fixIt
    )
    // The media tools no longer touch the CLI at all, so "no CLI" is not their
    // problem — "no API key" is, and the fix they name has to be the right one.
    const noKey = [/no Gemini API key/i, /voice-agent settings/i, /GEMINI_API_KEY/]
    expectGraceful(
      'absent: make_image',
      await session.request('tools/call', { name: 'make_image', arguments: { description: 'a red car' } }),
      noKey
    )
    expectGraceful(
      'absent: edit_image',
      await session.request('tools/call', {
        name: 'edit_image',
        arguments: { path: 'C:\\nope.png', instruction: 'make it blue' }
      }),
      noKey
    )

    // Bad input and unknown tools must be tool errors, not crashes.
    expectGraceful('absent: missing required arg', await session.request('tools/call', { name: 'ask_gemini', arguments: {} }), [
      /required/i
    ])
    expectGraceful('absent: unknown tool', await session.request('tools/call', { name: 'nope', arguments: {} }), [/unknown tool/i])

    // Argument validation happens before anything is spent, so it must be
    // reported even with no key at all.
    expectGraceful(
      'absent: make_image rejects a silly count',
      await session.request('tools/call', { name: 'make_image', arguments: { description: 'a red car', count: 40 } }),
      [/`count` must be a whole number from 1 to 4/]
    )
    expectGraceful(
      'absent: make_image rejects an unknown aspect',
      await session.request('tools/call', {
        name: 'make_image',
        arguments: { description: 'a red car', aspect: 'square-ish' }
      }),
      [/`aspect` must be one of/]
    )
    expectGraceful(
      'absent: make_image rejects an empty description',
      await session.request('tools/call', { name: 'make_image', arguments: { description: '   ' } }),
      [/`description` is required/]
    )
    expectGraceful(
      'absent: edit_image rejects a missing instruction',
      await session.request('tools/call', { name: 'edit_image', arguments: { path: 'C:\\a.png' } }),
      [/`instruction` is required/]
    )

    // make_video: no key is its problem too, and its own arguments are checked
    // before anything is spent — a Veo call is far more expensive than an image.
    expectGraceful(
      'absent: make_video',
      await session.request('tools/call', { name: 'make_video', arguments: { description: 'a red go-kart' } }),
      [/no Gemini API key/i, /voice-agent settings/i, /GEMINI_API_KEY/]
    )
    expectGraceful(
      'absent: make_video rejects an empty description',
      await session.request('tools/call', { name: 'make_video', arguments: { description: '  ' } }),
      [/`description` is required/]
    )
    expectGraceful(
      'absent: make_video rejects an image-only aspect ratio',
      await session.request('tools/call', { name: 'make_video', arguments: { description: 'a go-kart', aspect: '1:1' } }),
      [/`aspect` must be one of: 16:9, 9:16/]
    )
    expectGraceful(
      'absent: make_video rejects an out-of-range duration',
      await session.request('tools/call', { name: 'make_video', arguments: { description: 'a go-kart', duration: 30 } }),
      [/`duration` must be a whole number of seconds from 4 to 8/]
    )
    expectGraceful(
      'absent: make_video rejects a duration below the floor',
      await session.request('tools/call', { name: 'make_video', arguments: { description: 'a go-kart', duration: 1 } }),
      [/`duration` must be a whole number of seconds from 4 to 8/]
    )

    // A crashed server would have failed the requests above, but be explicit.
    check('absent: server still alive after all calls', session.child.exitCode === null, `exit ${session.child.exitCode}`)
  } finally {
    session.close()
  }
}

async function runInstalledSuite() {
  console.log('\n[2] Real CLI on PATH, no API key (live path)')
  const session = openServer(envWithoutKey())
  try {
    await handshake(session, 'live')
    await listTools(session, 'live')

    // With the CLI present but no key, make_image must still refuse — it does
    // not go anywhere near the CLI, and it must never invent a path.
    const img = await session.request('tools/call', { name: 'make_image', arguments: { description: 'a red car' } })
    const imgText = textOf(img.result)
    check('live: make_image refuses without a key', img.result?.isError === true, imgText.slice(0, 300))
    check(
      'live: make_image names the fix and forbids claiming success',
      /voice-agent settings/i.test(imgText) && /Do not claim an image exists/i.test(imgText),
      imgText.slice(0, 600)
    )
    check('live: make_image did not fabricate a path', !/Image saved to/.test(imgText), imgText.slice(0, 300))

    const res = await session.request('tools/call', {
      name: 'ask_gemini',
      arguments: { prompt: 'reply with exactly: bridge-ok' }
    })
    const text = textOf(res.result)
    const loggedOut = res.result?.isError === true && /not logged in|set an auth method|GEMINI_API_KEY/i.test(text)

    if (loggedOut) {
      console.log('  --   Gemini is signed out (the expected state until Steve logs in).')
      console.log('  --   Exact message from the CLI:')
      console.log(
        text
          .split('\n')
          .map((l) => `       | ${l}`)
          .join('\n')
      )
      expectGraceful('live: ask_gemini (signed out)', res, [/run `gemini` once/])
    } else {
      check('live: ask_gemini round-trips', res.result?.isError !== true, text.slice(0, 400))
      check('live: Gemini answered bridge-ok', /bridge-ok/i.test(text), text.slice(0, 400))
    }
  } finally {
    session.close()
  }
}

/**
 * The bridge carries a deliberate copy of electron/gemini-media.ts's REST logic,
 * because it has to run under bare `node` with no build step. A copy that
 * quietly diverges is worse than no copy at all, so the pieces that matter are
 * compared here rather than trusted.
 */
function runDriftSuite() {
  console.log('\n[3] Bridge/gemini-media.ts drift guard')
  const bridge = readFileSync(SERVER, 'utf8')
  const media = readFileSync(MEDIA_TS, 'utf8')

  const model = (src, name) => new RegExp(`${name}\\s*=\\s*'([^']+)'`).exec(src)?.[1]
  const bridgeModel = model(bridge, 'DEFAULT_IMAGE_MODEL')
  const mediaModel = model(media, 'DEFAULT_IMAGE_MODEL')
  check(
    `drift: both default to the same image model (${bridgeModel})`,
    !!bridgeModel && bridgeModel === mediaModel,
    `bridge=${bridgeModel} media=${mediaModel}`
  )

  const aspects = (src) => (/ASPECT_RATIOS[^=]*=\s*\[([^\]]+)\]/.exec(src)?.[1] ?? '').replace(/[\s'"]/g, '')
  check('drift: both accept the same aspect ratios', aspects(bridge) === aspects(media) && aspects(bridge).length > 10, `bridge=${aspects(bridge)}\n       media=${aspects(media)}`)

  const num = (src, name) => new RegExp(`${name}\\s*=\\s*([0-9_*\\s]+)`).exec(src)?.[1]?.replace(/[\s_]/g, '')
  for (const name of ['MAX_IMAGE_COUNT', 'MAX_INPUT_BYTES']) {
    check(`drift: ${name} matches`, num(bridge, name) === num(media, name), `bridge=${num(bridge, name)} media=${num(media, name)}`)
  }

  const mimes = (src) => (/INPUT_MIME[^{]*\{([^}]+)\}/.exec(src)?.[1] ?? '').replace(/[\s'"]/g, '')
  check('drift: both accept the same input image types', mimes(bridge) === mimes(media) && mimes(bridge).includes('.png'), `bridge=${mimes(bridge)}\n       media=${mimes(media)}`)

  check(
    'drift: the copy is labelled as one in both files',
    /DUPLICATED from electron\/gemini-media\.ts/.test(bridge) && /cannot import this file/.test(media),
    'each file must point at the other'
  )

  /* --- video (Veo) — the same duplication, so the same guard --- */

  const bridgeVideo = model(bridge, 'DEFAULT_VIDEO_MODEL')
  const mediaVideo = model(media, 'DEFAULT_VIDEO_MODEL')
  check(
    `drift: both default to the same video model (${bridgeVideo})`,
    !!bridgeVideo && bridgeVideo === mediaVideo,
    `bridge=${bridgeVideo} media=${mediaVideo}`
  )
  check('drift: the video model is a Veo model', /^veo-/.test(bridgeVideo ?? ''), `${bridgeVideo}`)

  const videoAspects = (src) =>
    (/VIDEO_ASPECT_RATIOS[^=]*=\s*\[([^\]]+)\]/.exec(src)?.[1] ?? '').replace(/[\s'"]/g, '')
  check(
    'drift: both accept the same video aspect ratios',
    videoAspects(bridge) === videoAspects(media) && videoAspects(bridge) === '16:9,9:16',
    `bridge=${videoAspects(bridge)}\n       media=${videoAspects(media)}`
  )

  for (const name of [
    'MIN_VIDEO_SECONDS',
    'MAX_VIDEO_SECONDS',
    'VIDEO_POLL_STEADY_MS',
    'VIDEO_REQUEST_TIMEOUT_MS'
  ]) {
    check(`drift: ${name} matches`, num(bridge, name) === num(media, name), `bridge=${num(bridge, name)} media=${num(media, name)}`)
  }

  // The overall budget is spelled differently either side (the TS one is
  // exported under a longer name), so compare the numbers rather than the text.
  const bridgeBudget = num(bridge, 'VIDEO_TIMEOUT_MS')
  const mediaBudget = num(media, 'DEFAULT_VIDEO_TIMEOUT_MS')
  check(
    `drift: the video timeout budget matches (${bridgeBudget}ms)`,
    bridgeBudget === mediaBudget,
    `bridge=${bridgeBudget} media=${mediaBudget}`
  )

  const pollSteps = (src) => (/VIDEO_POLL_MS[^=]*=\s*\[([^\]]+)\]/.exec(src)?.[1] ?? '').replace(/[\s_]/g, '')
  check(
    'drift: both back off on the same poll schedule',
    pollSteps(bridge) === pollSteps(media) && pollSteps(bridge) === '5000,10000',
    `bridge=${pollSteps(bridge)}\n       media=${pollSteps(media)}`
  )

  // The tier error is the one nobody can test live on a working key, so assert
  // both copies still classify it — and still say the word "billing".
  for (const [label, src] of [['bridge', bridge], ['media', media]]) {
    check(
      `drift: ${label} still classifies the paid-only (tier) refusal`,
      /billed users\|billing\|FAILED_PRECONDITION/.test(src) && /billing enabled/i.test(src),
      'the Veo paid-only branch must survive edits'
    )
  }
  check('drift: media declares a `tier` error kind', /\|\s*'tier'/.test(media), 'MediaErrorKind must carry tier')

  // The key is sent to a URL the API chose, so both copies must still check it.
  for (const [label, src] of [['bridge', bridge], ['media', media]]) {
    check(`drift: ${label} still pins the download host`, /function safeVideoUri/.test(src), 'safeVideoUri must not be dropped')
  }
}

/**
 * The only checks that spend quota. Opt in with --live-image. Generates a real
 * image, asserts the file is on disk and is a real PNG/JPEG, then feeds it back
 * through edit_image and asserts the original survived untouched.
 */
async function runLiveImageSuite() {
  const found = findApiKey()
  console.log('\n[4] Live image generation')
  if (!found) {
    console.log('  --   skipped: no GEMINI_API_KEY and no key file on disk')
    return
  }
  console.log(`  --   key from ${found.source}`)

  const outDir = join(tmpdir(), `forge-bridge-smoke-${Date.now()}`)
  const session = openServer({ ...process.env, GEMINI_API_KEY: found.key, FORGE_BRIDGE_OUT: outDir })
  try {
    await handshake(session, 'image')

    const t0 = Date.now()
    const made = await session.request('tools/call', {
      name: 'make_image',
      arguments: { description: 'A single ripe red apple on a plain white studio background, soft light, photographic.' }
    })
    const madeText = textOf(made.result)
    const madeMs = Date.now() - t0
    check('image: make_image succeeded', made.result?.isError !== true, madeText.slice(0, 600))

    const path = /Image saved to (.+)/.exec(madeText)?.[1]?.trim()
    check('image: it named a path', !!path, madeText.slice(0, 300))
    if (!path) return
    check(`image: the file exists (${madeMs}ms)`, existsSync(path), path)
    const bytes = existsSync(path) ? statSync(path).size : 0
    check(`image: the file has real content (${Math.round(bytes / 1024)} KB)`, bytes > 10_000, `${bytes} bytes`)
    // First bytes must be a real image header, not a text apology saved as .png.
    const head = existsSync(path) ? readFileSync(path).subarray(0, 4) : Buffer.alloc(0)
    const isPng = head[0] === 0x89 && head[1] === 0x50
    const isJpg = head[0] === 0xff && head[1] === 0xd8
    check('image: the bytes really are an image', isPng || isJpg, [...head].map((b) => b.toString(16)).join(' '))
    check('image: it reported which model made it', /Model [a-z0-9.\-]+image/i.test(madeText), madeText.slice(0, 400))
    console.log(`  --   ${path}`)

    const t1 = Date.now()
    const edited = await session.request('tools/call', {
      name: 'edit_image',
      arguments: { path, instruction: 'Make the apple bright blue. Keep the framing and lighting identical.' }
    })
    const editText = textOf(edited.result)
    check('image: edit_image succeeded', edited.result?.isError !== true, editText.slice(0, 600))
    const editedPath = /Edited image saved to (.+)/.exec(editText)?.[1]?.trim()
    check(`image: the edited file exists (${Date.now() - t1}ms)`, !!editedPath && existsSync(editedPath), editText.slice(0, 300))
    check('image: the edit is a NEW file', editedPath !== path, `${editedPath}`)
    check('image: the original was not modified', existsSync(path) && statSync(path).size === bytes, path)
    if (editedPath) console.log(`  --   ${editedPath}`)

    // A path that is not an image must be refused before anything is spent.
    const badInput = await session.request('tools/call', {
      name: 'edit_image',
      arguments: { path: SERVER, instruction: 'make it blue' }
    })
    expectGraceful('image: edit_image refuses a non-image', badInput, [/not an image Gemini accepts/])
    const missing = await session.request('tools/call', {
      name: 'edit_image',
      arguments: { path: join(outDir, 'not-here.png'), instruction: 'make it blue' }
    })
    expectGraceful('image: edit_image refuses a missing file', missing, [/No such file/])
  } finally {
    session.close()
  }
}

/**
 * The most expensive check in the repo, and the slowest: one real Veo clip.
 * Opt in with --live-video. Asserts the file is on disk, is a real mp4 (ftyp at
 * offset 4, not an apology saved with an .mp4 name) and is big enough to be
 * video rather than a stub.
 *
 * A refusal is a legitimate outcome, not a test failure: if the key is not
 * billed for Veo the tool must SAY so rather than invent a file, and that is
 * exactly what gets asserted instead.
 */
async function runLiveVideoSuite() {
  const found = findApiKey()
  console.log('\n[5] Live video generation (Veo)')
  if (!found) {
    console.log('  --   skipped: no GEMINI_API_KEY and no key file on disk')
    return
  }
  console.log(`  --   key from ${found.source}`)

  const outDir = join(tmpdir(), `forge-bridge-smoke-video-${Date.now()}`)
  const session = openServer({ ...process.env, GEMINI_API_KEY: found.key, FORGE_BRIDGE_OUT: outDir })
  try {
    await handshake(session, 'video')

    const t0 = Date.now()
    const made = await session.request('tools/call', {
      name: 'make_video',
      arguments: {
        description: 'A red pixel-art go-kart driving across the screen from left to right, retro 8-bit game style, flat side-on view.',
        aspect: '16:9',
        duration: 4
      }
    })
    const text = textOf(made.result)
    const secs = ((Date.now() - t0) / 1000).toFixed(1)

    if (made.result?.isError === true) {
      // Honest refusal is a pass for the error path — but it must be honest.
      console.log(`  --   refused after ${secs}s. Exact message:`)
      console.log(text.split('\n').map((l) => `       | ${l}`).join('\n'))
      check('video: a refusal names a cause and a fix', /billing|quota|key|refus|timed out|rendering/i.test(text), text.slice(0, 400))
      check('video: a refusal does not claim a file', !/Video saved to/.test(text), text.slice(0, 300))
      return
    }

    check(`video: make_video succeeded (${secs}s)`, made.result?.isError !== true, text.slice(0, 600))
    const path = /Video saved to (.+)/.exec(text)?.[1]?.trim()
    check('video: it named a path', !!path, text.slice(0, 300))
    if (!path) return
    check('video: the file exists', existsSync(path), path)
    const bytes = existsSync(path) ? statSync(path).size : 0
    check(`video: the file has real content (${Math.round(bytes / 1024)} KB)`, bytes > 100_000, `${bytes} bytes`)
    const head = existsSync(path) ? readFileSync(path).subarray(0, 12) : Buffer.alloc(0)
    check(
      'video: the bytes really are an mp4 (ftyp at offset 4)',
      head.subarray(4, 8).toString('latin1') === 'ftyp',
      [...head].map((b) => b.toString(16).padStart(2, '0')).join(' ')
    )
    check('video: it reported which model made it', /Model veo-[a-z0-9.\-]+/i.test(text), text.slice(0, 400))
    check('video: it reported how long it took', /\d+\.\d+s/.test(text), text.slice(0, 400))
    check('video: the file is .mp4', /\.mp4$/i.test(path), path)
    console.log(`  --   ${path}`)
    console.log(`  --   ${text.split('\n').filter(Boolean).pop()}`)
  } finally {
    session.close()
  }
}

async function main() {
  console.log(`bridge-smoke → ${SERVER}`)
  await runAbsentSuite()
  if (!forceAbsent) await runInstalledSuite()
  runDriftSuite()
  if (liveImage) await runLiveImageSuite()
  if (liveVideo) await runLiveVideoSuite()

  console.log(`\n${failures === 0 ? 'PASS' : 'FAIL'} — ${checks - failures}/${checks} checks passed`)
  if (!liveImage) console.log('(run with --live-image to also generate and edit a real image — spends quota)')
  if (!liveVideo) console.log('(run with --live-video to also generate a real ~4s Veo clip — spends more, takes ~1min)')
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((err) => {
  console.error('bridge-smoke crashed:', err)
  process.exit(1)
})
