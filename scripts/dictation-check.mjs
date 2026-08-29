/**
 * DictationMic-shaped talk-key gestures, plus the warm-start wiring.
 *
 *   node scripts/dictation-check.mjs      (npm run dictation:check)
 *
 * The gesture machine has no DOM in it, so it can be driven here rather than
 * by holding Right Ctrl and hoping. The source checks below insist the
 * sidecar actually warms itself — a comment that says "warm-start" with no
 * call is how the 3–6 s first-press wait comes back.
 */
import { readFileSync } from 'node:fs'
import { registerHooks } from 'node:module'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const SHARED = new URL('../shared', import.meta.url).href

registerHooks({
  resolve(spec, context, next) {
    if (spec.startsWith('@shared/')) return next(`${SHARED}/${spec.slice('@shared/'.length)}.ts`, context)
    if (spec.startsWith('.') && !/\.[a-z]+$/i.test(spec)) return next(`${spec}.ts`, context)
    return next(spec, context)
  },
  load(url, context, next) {
    if (url.endsWith('.ts')) return next(url, { ...context, format: 'module-typescript' })
    return next(url, context)
  }
})

const G = await import('../src/lib/stt-gesture.ts')

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

console.log('\ngesture: modifier tap / hold')
{
  eq(G.isModifierHotkey('ControlRight'), true, 'Right Ctrl is a modifier')
  eq(G.isModifierHotkey('F8'), false, 'F8 is a direct key')
  eq(G.MODIFIER_TAP_MS, 450, 'tap window is DictationMic\'s 450ms')
  eq(G.DIRECT_PTT_MS, 700, 'direct-key PTT is DictationMic\'s 700ms')

  let s = G.idleGesture()
  s = G.modifierDown(s, 1000)
  eq(s.down, true, 'keydown arms the gesture')
  const tap = G.modifierUp(s, 1200, false)
  eq(tap.intent, 'toggle', 'a clean tap under 450ms toggles')
  eq(tap.state.down, false, 'release returns to idle')

  s = G.modifierDown(G.idleGesture(), 1000)
  const held = G.modifierHeld(s, 1000 + G.MODIFIER_TAP_MS, false)
  eq(held.intent, 'ptt-start', 'holding past the tap window starts PTT')
  eq(held.state.ptt, true, 'PTT flag is set')
  const released = G.modifierUp(held.state, 2000, true)
  eq(released.intent, 'ptt-end', 'releasing PTT stops listening')

  s = G.modifierDown(G.idleGesture(), 1000)
  const tooSoon = G.modifierHeld(s, 1200, false)
  eq(tooSoon.intent, null, 'held() before the tap window is a no-op')

  s = G.modifierDown(G.idleGesture(), 1000)
  const already = G.modifierHeld(s, 1600, true)
  eq(already.intent, null, 'hold while already listening does not re-start')
  eq(G.modifierUp(already.state, 2000, true).intent, 'ptt-end', '…but release still ends it if the mic is open')

  s = G.modifierOther(G.modifierDown(G.idleGesture(), 1000))
  eq(G.modifierUp(s, 1100, false).intent, null, 'Ctrl+C (other key) never toggles')
  eq(G.modifierHeld(s, 1600, false).intent, null, 'Ctrl+C hold never starts PTT')
}

console.log('\ngesture: direct key')
{
  let s = G.idleGesture()
  const down = G.directDown(s, 1000, false)
  eq(down.intent, 'toggle', 'F8 press toggles immediately')
  eq(down.state.startedListening, true, 'a press that opened the mic is remembered')

  const repeat = G.directDown(down.state, 1016, false)
  eq(repeat.intent, null, 'auto-repeat does not toggle again')

  const shortUp = G.directUp(down.state, 1400, true)
  eq(shortUp.intent, null, 'a short F8 press does not stop on release')

  const longUp = G.directUp(down.state, 1000 + G.DIRECT_PTT_MS, true)
  eq(longUp.intent, 'ptt-end', 'holding F8 past 700ms then releasing stops')

  const already = G.directDown(G.idleGesture(), 1000, true)
  eq(already.state.startedListening, false, 'press while already listening is not "this press started it"')
  eq(G.directUp(already.state, 2000, true).intent, null, 'so a long hold does not steal an existing session')
}

console.log('\nwarm-start wiring')
{
  const read = (rel) => readFileSync(join(ROOT, rel), 'utf8')
  const sidecar = read('electron/stt-sidecar.ts')
  const main = read('electron/main.ts')
  const py = read('stt/stt_service.py')
  const hook = read('src/hooks/useDictation.ts')
  const types = read('shared/types.ts')

  ok(sidecar.includes('export function warmStart'), 'sidecar exports warmStart()')
  ok(sidecar.includes('export function scheduleWarmStart'), 'sidecar exports scheduleWarmStart()')
  ok(sidecar.includes('pendingCapture'), 'sidecar queues a capture that arrived before the mic was open')
  ok(/scheduleWarmStart\s*\(/.test(main), 'main actually calls scheduleWarmStart')
  ok(py.includes('engine warmed') || py.includes('engine.transcribe(np.zeros'), 'python warms the ONNX session after load')
  ok(py.includes('elif cmd == "release"') || py.includes('cmd == "release"'), 'python accepts a release command')
  ok(types.includes('sttWarmStart'), 'settings has sttWarmStart')
  ok(hook.includes('stt-gesture') || hook.includes('modifierHeld'), 'the dictation hook drives the gesture machine')
  ok(hook.includes('forge.stt.release') || hook.includes("stt.release"), 'agent PTT releases capture instead of killing the session')
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
