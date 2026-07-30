/**
 * Unit test for the dictation host's decision-making — the restart budget, the
 * degraded/typed-error states and the event reduction — plus an end-to-end run
 * of the spawn/parse/reconnect loop against a *mock* sidecar (a small Node
 * script that speaks the real line protocol and can be told to crash).
 *
 *   node scripts/stt-manager-test.mjs
 *
 * No Electron, no Python, no model: this is about what the manager decides.
 * Types are stripped by Node when importing electron/stt-protocol.ts, which is
 * why that module only ever `import type`s.
 */
import { spawn } from 'node:child_process'
import { createConnection } from 'node:net'
import { writeFileSync, readFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, join } from 'node:path'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const dir = mkdtempSync(join(tmpdir(), 'forge-stt-'))

/*
 * Node strips types from .ts, but the package is "type": "commonjs", so a .ts
 * file here is read as CJS and its `export`s are a syntax error. Copying the
 * real source to a .mts alongside makes it ESM without touching the repo's
 * module setting — and because it is the actual file, the test cannot drift
 * away from what ships.
 */
const shim = join(dir, 'stt-protocol.mts')
writeFileSync(shim, readFileSync(join(ROOT, 'electron', 'stt-protocol.ts'), 'utf8'), 'utf8')
const {
  MAX_RAPID_RESTARTS,
  OFF_STATUS,
  RestartBudget,
  isTransientSttError,
  pythonLooksMissing,
  reduceSttEvent,
  sttStatusEqual
} = await import(pathToFileURL(shim).href)

let pass = 0
let fail = 0
const ok = (cond, label, detail = '') => {
  if (cond) {
    pass++
    console.log(`  ✓ ${label}`)
  } else {
    fail++
    console.log(`  ✕ ${label}${detail ? ` — ${detail}` : ''}`)
  }
}
const eq = (a, b, label) => ok(a === b, label, `got ${JSON.stringify(a)}, want ${JSON.stringify(b)}`)

/* ------------------------------------------------------- restart budget */

console.log('\nrestart budget')
{
  const b = new RestartBudget(60_000, 3)
  const t = 1_000_000
  eq(b.record(t), true, 'first crash restarts')
  eq(b.record(t + 100), true, 'second crash restarts')
  eq(b.record(t + 200), true, 'third crash restarts')
  eq(b.record(t + 300), false, 'fourth rapid crash gives up')
  eq(b.count, 4, 'all four are inside the window')

  // Crashes spread out are not a crash loop.
  const slow = new RestartBudget(60_000, 3)
  ok(
    [0, 61_000, 122_000, 183_000, 244_000, 305_000].every((dt) => slow.record(t + dt)),
    'crashes a minute apart never exhaust the budget'
  )
  eq(slow.count, 1, 'the window only ever holds the latest')

  // A successful load resets the budget.
  const fixed = new RestartBudget(60_000, 3)
  fixed.record(t)
  fixed.record(t + 1)
  fixed.record(t + 2)
  fixed.clear()
  eq(fixed.record(t + 3), true, 'a `ready` clears the budget and buys three more')
  eq(MAX_RAPID_RESTARTS, 3, 'the shipped budget is three restarts')
}

/* --------------------------------------------------- python pre-flight */

console.log('\npython path pre-flight')
{
  const none = () => false
  const all = () => true
  eq(pythonLooksMissing('', none), true, 'blank path is missing')
  eq(pythonLooksMissing('   ', none), true, 'whitespace path is missing')
  eq(pythonLooksMissing('C:/nope/python.exe', none), true, 'absolute path that is not there')
  eq(pythonLooksMissing('C:/yes/python.exe', all), false, 'absolute path that is there')
  eq(pythonLooksMissing('python.exe', none), false, 'a bare name is left to PATH, not pre-judged')
  eq(pythonLooksMissing('py', none), false, 'a bare launcher name is left to PATH')
}

/* -------------------------------------------------------- degraded states */

console.log('\ndegraded / typed errors')
{
  eq(isTransientSttError('audio'), true, 'a busy microphone is worth retrying')
  eq(isTransientSttError('internal'), true, 'an internal blip is worth retrying')
  eq(isTransientSttError('not-ready'), true, 'too-early start is worth retrying')
  eq(isTransientSttError('model-missing'), false, 'a missing model needs fixing, not retrying')
  eq(isTransientSttError('model-load'), false, 'an unloadable model needs fixing')
  eq(isTransientSttError('python-missing'), false, 'a missing interpreter needs fixing')
  eq(isTransientSttError('crash-loop'), false, 'a crash loop needs fixing')

  // A setup error parks the pill in its amber state.
  const starting = { ...OFF_STATUS, phase: 'starting' }
  const missing = reduceSttEvent(starting, {
    evt: 'error',
    kind: 'model-missing',
    msg: 'Model folder not found: C:/nope'
  }).status
  eq(missing.phase, 'error', 'model-missing -> error phase')
  eq(missing.error.kind, 'model-missing', 'the kind survives to the UI')
  eq(missing.ready, false, 'never marked ready')

  // A transient error on a working sidecar leaves it usable.
  const ready = reduceSttEvent(starting, { evt: 'ready' }).status
  eq(ready.phase, 'idle', 'ready -> idle')
  eq(ready.ready, true, 'ready flag set')
  const micBusy = reduceSttEvent(ready, { evt: 'error', kind: 'audio', msg: 'device in use' }).status
  eq(micBusy.phase, 'idle', 'a mic error on a ready sidecar stays idle')
  eq(micBusy.error.kind, 'audio', 'but the error is still reported')

  // ready clears a previous error, so a fixed path stops nagging.
  const recovered = reduceSttEvent(missing, { evt: 'ready' }).status
  eq(recovered.error, null, '`ready` clears a stale setup error')
  eq(recovered.phase, 'idle', 'and returns to idle')
}

/* ----------------------------------------------------- event reduction */

console.log('\nevent reduction')
{
  let s = reduceSttEvent({ ...OFF_STATUS, phase: 'starting' }, { evt: 'ready' }).status
  eq(reduceSttEvent(s, { evt: 'ready' }).becameReady, true, 'ready reports becameReady')

  s = reduceSttEvent(s, { evt: 'state', v: 'listening' }).status
  eq(s.phase, 'listening', 'state -> listening')

  s = reduceSttEvent(s, { evt: 'level', rms: 0.42 }).status
  eq(s.level, 0.42, 'level lands on the status')
  eq(reduceSttEvent(s, { evt: 'level', rms: 9 }).status.level, 1, 'out-of-range level is clamped high')
  eq(reduceSttEvent(s, { evt: 'level', rms: -3 }).status.level, 0, 'out-of-range level is clamped low')
  eq(reduceSttEvent(s, { evt: 'level', rms: 'x' }).status.level, 0.42, 'junk level is ignored')

  eq(reduceSttEvent(s, { evt: 'phrase', text: '  hello  ' }).phrase, 'hello', 'phrase text is trimmed')
  eq(reduceSttEvent(s, { evt: 'phrase', text: '   ' }).phrase, undefined, 'a blank phrase is dropped')

  const finishing = reduceSttEvent(s, { evt: 'state', v: 'finishing', reason: 'autostop' }).status
  eq(finishing.phase, 'finishing', 'auto-stop lands as finishing')
  eq(finishing.level, 0, 'the meter drops to zero when the mic closes')

  eq(reduceSttEvent(s, { evt: 'state', v: 'nonsense' }).status, s, 'an unknown state is ignored')
  eq(reduceSttEvent(s, { evt: 'wat' }).status, s, 'an unknown event is ignored')

  // The sidecar greets a connection with state=idle while it is still loading
  // the model; believing it would have the pill claim it was ready early.
  const loading = { ...OFF_STATUS, phase: 'starting' }
  eq(
    reduceSttEvent(loading, { evt: 'state', v: 'idle' }).status.phase,
    'starting',
    'state=idle before `ready` still reads as starting'
  )
  eq(
    reduceSttEvent({ ...s, phase: 'finishing' }, { evt: 'state', v: 'idle' }).status.phase,
    'idle',
    'state=idle after `ready` really is idle'
  )

  ok(sttStatusEqual(s, { ...s }), 'identical statuses compare equal (no pointless IPC)')
  ok(!sttStatusEqual(s, { ...s, level: 0.9 }), 'a changed level compares unequal')
  ok(!sttStatusEqual(s, { ...s, error: { kind: 'audio', msg: 'x' } }), 'a new error compares unequal')
}

/* ------------------------------------------- mock sidecar: spawn + crash */

/**
 * The manager's process handling is exercised against a stand-in that speaks
 * the protocol: it announces a port, answers `status`/`start`, and can be told
 * to die mid-session so the restart path is real rather than asserted.
 */
const MOCK = `
import { createServer } from 'node:net'
const crashAfterMs = Number(process.env.MOCK_CRASH_MS || 0)
const srv = createServer((s) => {
  const say = (o) => s.write(JSON.stringify(o) + '\\n')
  say({ evt: 'state', v: 'idle' })
  if (process.env.MOCK_ERROR_KIND) {
    say({ evt: 'error', kind: process.env.MOCK_ERROR_KIND, msg: 'mock failure' })
  } else {
    setTimeout(() => say({ evt: 'ready' }), 30)
  }
  let acc = ''
  s.on('data', (d) => {
    acc += d
    let i
    while ((i = acc.indexOf('\\n')) >= 0) {
      const line = acc.slice(0, i).trim()
      acc = acc.slice(i + 1)
      if (!line) continue
      const msg = JSON.parse(line)
      if (msg.cmd === 'start') {
        say({ evt: 'state', v: 'listening' })
        say({ evt: 'level', rms: 0.5 })
        say({ evt: 'phrase', text: 'mock phrase' })
      }
      if (msg.cmd === 'stop') say({ evt: 'state', v: 'idle' })
      if (msg.cmd === 'shutdown') process.exit(0)
    }
  })
  s.on('error', () => {})
})
srv.listen(0, '127.0.0.1', () => {
  console.log('FORGE_STT_PORT=' + srv.address().port)
  if (crashAfterMs > 0) setTimeout(() => process.exit(7), crashAfterMs)
})
`

const mockPath = join(dir, 'mock-sidecar.mjs')
writeFileSync(mockPath, MOCK, 'utf8')

/**
 * A miniature of the manager's process half: spawn, parse the port line,
 * connect, feed lines through the real reducer, and restart on unexpected exit
 * under the real budget. If this and stt-sidecar.ts ever disagree, the reducer
 * and budget — the parts that decide anything — are still the shared ones.
 */
function runManaged({ env = {}, budget = new RestartBudget(60_000, 3), onEvent, onGiveUp }) {
  let status = { ...OFF_STATUS }
  let child = null
  let retired = false
  const spawnOne = () => {
    if (retired) return
    let buf = ''
    let acc = ''
    let port = 0
    const proc = spawn(process.execPath, [mockPath], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, ...env }
    })
    child = proc
    proc.stdout.setEncoding('utf8')
    proc.stdout.on('data', (c) => {
      buf += c
      const m = /FORGE_STT_PORT=(\d+)/.exec(buf)
      if (!m || port) return
      port = Number(m[1])
      const s = createConnection({ port }, () => s.write('{"cmd":"status"}\n'))
      s.setEncoding('utf8')
      s.on('error', () => {})
      s.on('data', (d) => {
        acc += d
        let i
        while ((i = acc.indexOf('\n')) >= 0) {
          const line = acc.slice(0, i).trim()
          acc = acc.slice(i + 1)
          if (!line) continue
          const r = reduceSttEvent(status, JSON.parse(line))
          status = r.status
          onEvent?.({ status, ...r, write: (o) => s.write(JSON.stringify(o) + '\n'), port })
        }
      })
    })
    proc.on('exit', () => {
      if (proc !== child || retired) return
      child = null
      if (budget.record()) spawnOne()
      else {
        status = { ...status, phase: 'error', error: { kind: 'crash-loop', msg: 'gave up' } }
        onGiveUp?.(status)
      }
    })
  }
  spawnOne()
  return {
    stop: () => {
      retired = true
      child?.kill()
    },
    get status() {
      return status
    }
  }
}

console.log('\nmock sidecar: spawn, port parse, round trip')
await new Promise((resolve) => {
  const seen = []
  const m = runManaged({
    onEvent: ({ status, becameReady, phrase, write, port }) => {
      seen.push(status.phase)
      if (becameReady) {
        ok(port > 0 && port < 65536, 'port parsed off stdout', String(port))
        write({ cmd: 'start' })
      }
      if (phrase) {
        eq(phrase, 'mock phrase', 'phrase came back through the reducer')
        ok(seen.includes('listening'), 'listening state was seen first')
        m.stop()
        resolve()
      }
    }
  })
  setTimeout(() => {
    ok(false, 'mock round trip completed')
    m.stop()
    resolve()
  }, 8000)
})

console.log('\nmock sidecar: restart on crash, then give up')
await new Promise((resolve) => {
  let spawns = 0
  const budget = new RestartBudget(60_000, 3)
  const m = runManaged({
    env: { MOCK_CRASH_MS: '120' },
    budget,
    onEvent: ({ becameReady }) => {
      if (becameReady) spawns++
    },
    onGiveUp: (status) => {
      // 1 original + 3 restarts, then the 4th crash exhausts the budget.
      ok(spawns >= 3, `restarted after each crash (${spawns} sessions became ready)`)
      eq(budget.count, 4, 'four crashes recorded inside the window')
      eq(status.phase, 'error', 'gives up in the error phase')
      eq(status.error.kind, 'crash-loop', 'and says why: crash-loop')
      m.stop()
      resolve()
    }
  })
  setTimeout(() => {
    ok(false, 'crash loop reached the give-up state')
    m.stop()
    resolve()
  }, 15000)
})

console.log('\nmock sidecar: degraded model path')
await new Promise((resolve) => {
  const m = runManaged({
    env: { MOCK_ERROR_KIND: 'model-missing' },
    onEvent: ({ status }) => {
      if (status.error) {
        eq(status.phase, 'error', 'a model-missing sidecar parks in error')
        eq(status.error.kind, 'model-missing', 'with the typed kind the setup card needs')
        eq(status.ready, false, 'and is never marked ready')
        m.stop()
        resolve()
      }
    }
  })
  setTimeout(() => {
    ok(false, 'degraded state reached')
    m.stop()
    resolve()
  }, 8000)
})

console.log(`\n${pass}/${pass + fail} checks passed`)
process.exit(fail === 0 ? 0 : 1)
