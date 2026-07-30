/**
 * bridge-smoke — drives bridge/gemini-bridge.mjs over real MCP stdio.
 *
 * Speaks the wire protocol by hand (no SDK client) so a broken server can't
 * make a broken test pass: initialize → tools/list → tools/call.
 *
 * Run:  node scripts/bridge-smoke.mjs
 *
 * Two modes, chosen automatically:
 *   - Gemini absent or signed out  → asserts every tool returns the graceful
 *     error path (isError + a message that names the fix).
 *   - Gemini signed in             → additionally asserts a live round trip.
 *
 * Pass --force-absent to hide the CLI from the server (PATH stripped) and test
 * the not-installed branch even on a machine that has it.
 */

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { delimiter, dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const SERVER = join(root, 'bridge', 'gemini-bridge.mjs')

const forceAbsent = process.argv.includes('--force-absent')

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
      const timer = setTimeout(() => {
        waiters.delete(id)
        rej(new Error(`timeout waiting for ${method}\nstderr: ${stderr}`))
      }, 180_000)
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

/** Strip every directory that holds a gemini shim, to simulate "not installed". */
function envWithoutGemini() {
  const env = { ...process.env }
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

async function listTools(session, label) {
  const res = await session.request('tools/list', {})
  const tools = res.result?.tools ?? []
  const names = tools.map((t) => t.name).sort()
  check(
    `${label}: tools/list returns exactly the three bridge tools`,
    JSON.stringify(names) === JSON.stringify(['ask_gemini', 'make_image', 'summarize_video']),
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
    make_image: ['description']
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
    expectGraceful(
      'absent: make_image',
      await session.request('tools/call', { name: 'make_image', arguments: { description: 'a red car' } }),
      [...fixIt, /image-generation/i]
    )

    // Bad input and unknown tools must be tool errors, not crashes.
    expectGraceful('absent: missing required arg', await session.request('tools/call', { name: 'ask_gemini', arguments: {} }), [
      /required/i
    ])
    expectGraceful('absent: unknown tool', await session.request('tools/call', { name: 'nope', arguments: {} }), [/unknown tool/i])

    // A crashed server would have failed the requests above, but be explicit.
    check('absent: server still alive after all calls', session.child.exitCode === null, `exit ${session.child.exitCode}`)
  } finally {
    session.close()
  }
}

async function runInstalledSuite() {
  console.log('\n[2] Real CLI on PATH (live path)')
  const session = openServer({ ...process.env })
  try {
    await handshake(session, 'live')
    await listTools(session, 'live')

    // Image support is probed via `gemini extensions list`, which needs no
    // login — so this asserts the honesty of make_image against the real CLI
    // regardless of auth state.
    const img = await session.request('tools/call', { name: 'make_image', arguments: { description: 'a red car' } })
    const imgText = textOf(img.result)
    if (/no image-generation tool/i.test(imgText) || /image-generation/i.test(imgText)) {
      check('live: make_image admits the CLI cannot generate images', img.result?.isError === true, imgText.slice(0, 300))
      check(
        'live: make_image names the fix and forbids claiming success',
        /genmedia|Imagen|extensions install/i.test(imgText) && /Do not claim an image exists/i.test(imgText),
        imgText.slice(0, 600)
      )
    } else {
      check('live: make_image did not fabricate a path', !/^Image saved to/.test(imgText) || existsSync(imgText.split('\n')[0].replace('Image saved to ', '')), imgText.slice(0, 300))
    }

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

async function main() {
  console.log(`bridge-smoke → ${SERVER}`)
  await runAbsentSuite()
  if (!forceAbsent) await runInstalledSuite()

  console.log(`\n${failures === 0 ? 'PASS' : 'FAIL'} — ${checks - failures}/${checks} checks passed`)
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((err) => {
  console.error('bridge-smoke crashed:', err)
  process.exit(1)
})
