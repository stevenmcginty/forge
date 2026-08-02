/**
 * The Claude voice brain, driven for real and without Electron.
 *
 *   node scripts/voice-brain-smoke.mjs
 *
 * This is not a mock. It opens a genuine Claude Agent SDK session against the
 * `claude` login already on this machine — the same subscription every Forge
 * pane runs on — and talks to it. What is stubbed is only the app: the tool
 * round trip answers out of a canned two-project snapshot instead of a
 * renderer, and `captureScreen` returns a 1×1 PNG instead of a display.
 *
 * That split is the whole reason electron/voice-agent/host.ts imports no
 * Electron. Everything with a decision in it lives in the host and is
 * exercised here; electron/voice-agent/ipc.ts is the thin part that is not.
 *
 * Four things have to hold, and they are the four that would each be silent
 * failures in production:
 *
 *  1. The session opens and answers — auth works, the CLI spawns on Windows.
 *  2. The agent asks `get_app_state` instead of guessing, and its answer
 *     reflects what the tool said rather than what it assumed.
 *  3. A second utterance lands in the SAME session. If it did not, every turn
 *     would be paying a fresh spawn and the conversation would have no thread.
 *  4. `interrupt()` ends the turn and leaves the session usable. Barge-in
 *     happens mid-sentence; a session that dies on it is a session that dies
 *     every time Steve talks over it.
 */
import { registerHooks } from 'node:module'

registerHooks({
  resolve(spec, context, next) {
    if (spec.startsWith('@shared/')) {
      return next(new URL(`../shared/${spec.slice('@shared/'.length)}.ts`, import.meta.url).href, context)
    }
    if (spec.startsWith('.') && !/\.[a-z]+$/i.test(spec)) return next(`${spec}.ts`, context)
    return next(spec, context)
  },
  load(url, context, next) {
    if (url.endsWith('.ts')) return next(url, { ...context, format: 'module-typescript' })
    return next(url, context)
  }
})

const { VoiceAgentHost } = await import('../electron/voice-agent/host.ts')
const { VOICE_PERSONA } = await import('../electron/voice-agent/persona.ts')

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

/** A turn takes as long as it takes; this is the "it has hung" bound. */
const TURN_TIMEOUT_MS = 180_000

/* ------------------------------------------------------------ the fake app */

/**
 * What the renderer would have said. Two projects, deliberately, so "how many
 * projects" has an answer the model cannot get right by guessing "one".
 */
const APP_STATE = [
  '# CURRENT STATE',
  'forge version: 0.1.0 · shell: pwsh.exe',
  'projects:',
  '- alpha — C:\\work\\alpha  [ACTIVE]',
  '- beta — C:\\work\\beta',
  'tabs in the active project:',
  '- 1. "build" [CURRENT]',
  '  · Terminal 1 — "claude" (Claude Code, running, FOCUSED)',
  '',
  '# WHAT YOU CAN DO',
  'run_app_action kinds: open_tabs, close_tab, send_prompt, switch_project, focus_tab'
].join('\n')

/** Every tool call the host asked for, in order. */
const toolCalls = []

/* --------------------------------------------------------------- the host */

const events = []
/** Resolves when the current turn's `result` event lands. */
let turnDone = null

const host = new VoiceAgentHost({
  sendEvent(event) {
    events.push(event)
    if (event.type === 'delta') process.stdout.write(event.text)
    if (event.type === 'error') console.log(`\n  [error] ${event.message}`)
    if (event.type === 'result' && turnDone) {
      const done = turnDone
      turnDone = null
      done(event)
    }
  },
  sendToolRequest(request) {
    toolCalls.push(request.name)
    // The renderer's job, inlined. Answered on a later tick so the round trip
    // is genuinely asynchronous, exactly as the IPC one is.
    setTimeout(() => {
      if (request.name === 'get_app_state') {
        host.resolveTool({ id: request.id, ok: true, result: APP_STATE })
      } else if (request.name === 'get_project_memory') {
        host.resolveTool({ id: request.id, ok: true, result: 'Nothing remembered yet.' })
      } else if (request.name === 'remember') {
        // Nothing is written here — there is no memory store without a
        // renderer — but a turn that decides to remember something must not
        // hit the else and come back as a failed tool.
        host.resolveTool({ id: request.id, ok: true, result: 'Noted.' })
      } else if (request.name === 'run_app_action') {
        host.resolveTool({ id: request.id, ok: true, result: 'OK: pretended to do that.' })
      } else {
        host.resolveTool({ id: request.id, ok: false, error: `no such tool: ${request.name}` })
      }
    }, 10)
  },
  getModel: () => process.env['FORGE_VOICE_MODEL'] || 'sonnet',
  // No bridge and no screen: this runs where neither exists, and the host has
  // to be fine with that rather than assuming Electron is underneath it.
  getBridgeServer: () => null,
  captureScreen: async () => null
})

/** Say something and wait for the turn to finish. Resolves the result event. */
function turn(text) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      turnDone = null
      reject(new Error(`the turn did not finish within ${TURN_TIMEOUT_MS / 1000}s`))
    }, TURN_TIMEOUT_MS)
    turnDone = (event) => {
      clearTimeout(timer)
      resolve(event)
    }
    host.sendUtterance(text)
  })
}

/** Everything spoken since `from`, joined. */
const assistantTextSince = (from) =>
  events
    .slice(from)
    .filter((e) => e.type === 'assistant')
    .map((e) => e.text)
    .join(' ')

/* ------------------------------------------------------------ the persona */

console.log('\nthe persona is static and speakable')
ok(!/\$\{/.test(VOICE_PERSONA), 'nothing is interpolated into it, so it caches')
ok(!/```/.test(VOICE_PERSONA), 'it contains no code fence to teach the model one')
ok(VOICE_PERSONA.includes('spoken'), 'it says out loud that it will be read out loud')

/* ---------------------------------------------------------------- turn one */

console.log('\nturn one — it opens the session and uses the tool')
host.start({ cwd: process.cwd() })
ok(host.status().running, 'the session is running')

let mark = events.length
console.log('  > "How many projects are open? Answer in one short sentence."')
process.stdout.write('  < ')

let result
try {
  result = await turn('How many projects are open? Answer in one short sentence.')
} catch (err) {
  console.log(`\n  ✕ the first turn failed — ${err.message}`)
  console.log('\n  This runs the real SDK against this machine\'s Claude login.')
  console.log('  If that is the problem, `claude` must be installed and logged in.\n')
  process.exit(1)
}
console.log('')

const firstText = assistantTextSince(mark)
ok(result.ok, 'the turn came back without error', result.text)
ok(firstText.trim().length > 0, 'a non-empty assistant reply arrived', JSON.stringify(firstText))
ok(events.slice(mark).some((e) => e.type === 'delta' && e.text), 'text streamed in as deltas')
ok(toolCalls.includes('get_app_state'), 'it asked for app state rather than guessing', toolCalls.join(', '))
// The canned snapshot says two, and only the tool could have told it that.
ok(/\b(2|two)\b/i.test(firstText), 'the answer reflects the tool result, not a guess', firstText)

/* ---------------------------------------------------------------- turn two */

console.log('\nturn two — the same session carries the conversation')
mark = events.length
console.log('  > "And what is the second one called? One short sentence."')
process.stdout.write('  < ')
const second = await turn('And what is the second one called? One short sentence.')
console.log('')

ok(second.ok, 'the second turn came back without error', second.text)
ok(assistantTextSince(mark).trim().length > 0, 'it answered again')
ok(host.status().running, 'the session survived the first turn rather than respawning')
// A brand-new session would have no idea what "the second one" referred to.
ok(/beta/i.test(assistantTextSince(mark)), 'it remembered the earlier answer', assistantTextSince(mark))

/* -------------------------------------------------------------- turn three */

console.log('\nturn three — interrupt mid-turn, and keep the session')
mark = events.length
const longTurn = turn('Describe in detail what a good project structure looks like. Take your time.')
// Long enough that the model is genuinely mid-answer, short enough that it is
// nowhere near finished.
await new Promise((r) => setTimeout(r, 4000))
const interrupted = await host.interrupt()
ok(interrupted === true, 'interrupt() was accepted')

try {
  await longTurn
} catch (err) {
  // An interrupted turn may end without a result event; that is not a failure.
  console.log(`  (the interrupted turn produced no result: ${err.message})`)
}
ok(host.status().running, 'the session is STILL running after the interrupt')

console.log('\nturn four — it still answers after being interrupted')
mark = events.length
console.log('  > "Never mind. Which project is active? One short sentence."')
process.stdout.write('  < ')
let fourth
try {
  fourth = await turn('Never mind. Which project is active? One short sentence.')
  console.log('')
  ok(fourth.ok, 'the turn after the interrupt came back without error', fourth.text)
  ok(assistantTextSince(mark).trim().length > 0, 'it spoke again after being cut off')
} catch (err) {
  console.log('')
  ok(false, 'the turn after the interrupt came back', err.message)
}

/* ------------------------------------------------------------------ tidy */

host.dispose()
ok(!host.status().running, 'dispose() closes the session')

console.log(`\n${pass} passed, ${fail} failed\n`)
process.exit(fail === 0 ? 0 : 1)
