/**
 * The mini bar's global talk keys, judged head-less.
 *
 *   node scripts/global-keys-check.mjs
 *
 * Imports the *real* electron/global-keys.ts (with `electron` and its Forge
 * neighbours stubbed) and feeds fake uiohook events into its filter. The real
 * hook is never started and no key is ever pressed or injected:
 *
 *   - a talk key's press and release go to the host once each; the OS
 *     auto-repeat between them is dropped
 *   - any other key pressed while a talk key is held is a content-free otherKey
 *   - AltGr's fake Left Ctrl (same hook time as its Right Alt) is ignored, and
 *     does not eat the next real Left Ctrl
 *   - a real Left Ctrl still counts, after a short wait for a Right Alt
 *   - the summon chord (and only with its exact modifiers) summons
 *   - while a Forge window has focus, nothing goes
 *   - stopping the hook lets go of a held talk key
 */
import { registerHooks } from 'node:module'

const STUBS = {
  electron: 'export const BrowserWindow = { getFocusedWindow: () => null }',
  './hub-ipc': 'export const keymapOverride = () => null',
  './minibar-window': 'export const isMainMinimised = () => false; export const sendRemoteKey = () => {}; export const summon = () => {}',
  './store': 'export const getSettings = () => ({})',
  './tray': 'export const isQuitting = () => false'
}

registerHooks({
  resolve(spec, context, next) {
    if (Object.prototype.hasOwnProperty.call(STUBS, spec)) return { url: `forge-check:${spec}`, shortCircuit: true }
    if (spec.startsWith('@shared/')) {
      return next(new URL(`../shared/${spec.slice('@shared/'.length)}.ts`, import.meta.url).href, context)
    }
    return next(spec, context)
  },
  load(url, context, next) {
    if (url.startsWith('forge-check:')) {
      return { format: 'module', shortCircuit: true, source: STUBS[url.slice('forge-check:'.length)] }
    }
    if (url.endsWith('.ts')) return next(url, { ...context, format: 'module-typescript' })
    return next(url, context)
  }
})

const G = await import('../electron/global-keys.ts')

let pass = 0
let fail = 0
const ok = (cond, label, detail = '') => {
  if (cond) {
    pass++
    console.log(`  ok   ${label}`)
  } else {
    fail++
    console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`)
  }
}
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)
const wait = (ms) => new Promise((r) => setTimeout(r, ms))

// uiohook keycodes (node_modules/uiohook-napi/dist/index.js UiohookKey).
const K = { CtrlLeft: 0x1d, ShiftLeft: 0x2a, ShiftRight: 0x36, AltRight: 0xe38, G: 0x22, A: 0x1e, F9: 0x43 }

/** A filter with Dictate = Right Alt, Listen = Right Shift, summon = Ctrl+Shift+G, and what it sent. */
function rig(dictate = 'AltRight', listen = 'ShiftRight', summon = ['Ctrl+Shift+G']) {
  const sent = []
  let summons = 0
  const state = { focused: false }
  const filter = G.createKeyFilter(G.keyConfig(dictate, listen, summon), {
    focused: () => state.focused,
    send: (k) => sent.push(k),
    summon: () => summons++
  })
  let clock = 1000
  const ev = (keycode, mods = {}, dt = 40) => {
    clock += dt
    return { keycode, time: clock, ctrlKey: false, altKey: false, shiftKey: false, metaKey: false, ...mods }
  }
  return {
    sent,
    state,
    summons: () => summons,
    down: (code, mods, dt) => filter.down(ev(code, mods, dt)),
    up: (code, mods, dt) => filter.up(ev(code, mods, dt)),
    release: () => filter.release()
  }
}

console.log('talk keys')
{
  const r = rig()
  r.down(K.ShiftRight, { shiftKey: true })
  r.down(K.ShiftRight, { shiftKey: true }) // OS auto-repeat
  r.down(K.ShiftRight, { shiftKey: true })
  r.up(K.ShiftRight)
  ok(
    same(r.sent, [
      { t: 'talkKey', code: 'ShiftRight', phase: 'down' },
      { t: 'talkKey', code: 'ShiftRight', phase: 'up' }
    ]),
    'Listen key: one down, one up, repeats dropped',
    JSON.stringify(r.sent)
  )
  r.sent.length = 0
  r.down(K.A)
  r.up(K.A)
  r.down(K.ShiftLeft, { shiftKey: true })
  r.up(K.ShiftLeft)
  ok(r.sent.length === 0, 'an ordinary key with no talk key held sends nothing', JSON.stringify(r.sent))
}
{
  const r = rig('F9', 'Right Shift')
  r.down(K.F9)
  r.up(K.F9)
  r.down(K.ShiftRight, { shiftKey: true })
  r.up(K.ShiftRight)
  ok(
    same(
      r.sent.map((k) => k.code),
      ['F9', 'F9', 'ShiftRight', 'ShiftRight']
    ),
    'an F-key talk key and a talk key stored by its label',
    JSON.stringify(r.sent)
  )
}

console.log('otherKey')
{
  const r = rig()
  r.down(K.ShiftRight, { shiftKey: true })
  r.down(K.A, { shiftKey: true })
  r.down(K.A, { shiftKey: true }) // repeat: not a new key
  r.up(K.A, { shiftKey: true })
  r.up(K.ShiftRight)
  ok(
    same(r.sent, [
      { t: 'talkKey', code: 'ShiftRight', phase: 'down' },
      { t: 'otherKey' },
      { t: 'talkKey', code: 'ShiftRight', phase: 'up' }
    ]),
    'a key pressed during a hold is one content-free otherKey',
    JSON.stringify(r.sent)
  )
  ok(!JSON.stringify(r.sent).includes(String(K.A)), 'no key identity reaches the host')
}

console.log('AltGr')
{
  const r = rig('AltRight', 'ShiftRight')
  // UK AltGr: fake Left Ctrl then Right Alt, same hook time; both repeat while held.
  r.down(K.CtrlLeft, { ctrlKey: true })
  r.down(K.AltRight, { ctrlKey: true, altKey: true }, 0)
  r.down(K.CtrlLeft, { ctrlKey: true, altKey: true })
  r.down(K.AltRight, { ctrlKey: true, altKey: true }, 0)
  r.up(K.CtrlLeft, { altKey: true })
  r.up(K.AltRight)
  ok(
    same(r.sent, [
      { t: 'talkKey', code: 'AltRight', phase: 'down' },
      { t: 'talkKey', code: 'AltRight', phase: 'up' }
    ]),
    'Dictate on Right Alt (AltGr): one down, one up, the fake Ctrl unseen',
    JSON.stringify(r.sent)
  )
}
{
  // Left Ctrl as a talk key: AltGr's fake must not fire it, a real one must.
  const r = rig('ControlLeft', 'ShiftRight')
  r.down(K.CtrlLeft, { ctrlKey: true })
  r.down(K.AltRight, { ctrlKey: true, altKey: true }, 0)
  r.up(K.AltRight, { ctrlKey: true })
  r.up(K.CtrlLeft)
  await wait(60)
  ok(r.sent.length === 0, 'AltGr does not fire a Left Ctrl talk key', JSON.stringify(r.sent))
  // Release order the other way round, then a real Left Ctrl press.
  r.down(K.CtrlLeft, { ctrlKey: true })
  r.down(K.AltRight, { ctrlKey: true, altKey: true }, 0)
  r.up(K.CtrlLeft, { altKey: true })
  r.up(K.AltRight)
  r.down(K.CtrlLeft, { ctrlKey: true }, 500)
  await wait(60) // no Right Alt follows: a real Left Ctrl
  ok(
    same(r.sent, [{ t: 'talkKey', code: 'ControlLeft', phase: 'down' }]),
    'a real Left Ctrl counts after the wait, and the fake did not eat it',
    JSON.stringify(r.sent)
  )
  r.up(K.CtrlLeft)
  ok(same(r.sent.at(-1), { t: 'talkKey', code: 'ControlLeft', phase: 'up' }), 'and its release goes')
}
{
  const r = rig('ControlLeft', 'ShiftRight')
  r.down(K.CtrlLeft, { ctrlKey: true })
  r.up(K.CtrlLeft) // a tap quicker than the wait settles at once
  ok(
    same(r.sent, [
      { t: 'talkKey', code: 'ControlLeft', phase: 'down' },
      { t: 'talkKey', code: 'ControlLeft', phase: 'up' }
    ]),
    'a quick real Left Ctrl tap: down then up, in order',
    JSON.stringify(r.sent)
  )
}

console.log('summon')
{
  const r = rig()
  r.down(K.CtrlLeft, { ctrlKey: true })
  r.down(K.ShiftLeft, { ctrlKey: true, shiftKey: true })
  r.down(K.G, { ctrlKey: true, shiftKey: true })
  r.down(K.G, { ctrlKey: true, shiftKey: true }) // repeat
  ok(r.summons() === 1, 'Ctrl+Shift+G summons once', `summons=${r.summons()}`)
  ok(r.sent.length === 0, 'and sends no talk key', JSON.stringify(r.sent))
  r.up(K.G)
  r.up(K.ShiftLeft)
  r.up(K.CtrlLeft)
  r.down(K.G, { ctrlKey: true })
  r.up(K.G)
  r.down(K.G, { ctrlKey: true, shiftKey: true, altKey: true })
  r.up(K.G)
  r.down(K.G)
  r.up(K.G)
  ok(r.summons() === 1, 'Ctrl+G, Ctrl+Alt+Shift+G and a bare G do not', `summons=${r.summons()}`)
}
{
  const r = rig('AltRight', 'ShiftRight', ['Ctrl+Alt+K'])
  r.down(K.G, { ctrlKey: true, shiftKey: true })
  r.down(0x25, { ctrlKey: true, altKey: true })
  ok(r.summons() === 1, 'a rebound summon key is the one that counts', `summons=${r.summons()}`)
}

console.log('focused')
{
  const r = rig()
  r.state.focused = true
  r.down(K.ShiftRight, { shiftKey: true })
  r.down(K.A, { shiftKey: true })
  r.up(K.A)
  r.up(K.ShiftRight)
  r.down(K.G, { ctrlKey: true, shiftKey: true })
  r.up(K.G)
  r.down(K.AltRight, { altKey: true })
  r.up(K.AltRight)
  ok(r.sent.length === 0 && r.summons() === 0, 'nothing goes while a Forge window is focused', JSON.stringify(r.sent))
  r.state.focused = false
  r.down(K.ShiftRight, { shiftKey: true })
  ok(same(r.sent, [{ t: 'talkKey', code: 'ShiftRight', phase: 'down' }]), 'and keys go again once it is not')
  r.state.focused = true
  r.down(K.A)
  r.up(K.ShiftRight)
  ok(
    same(r.sent, [
      { t: 'talkKey', code: 'ShiftRight', phase: 'down' },
      { t: 'talkKey', code: 'ShiftRight', phase: 'up' }
    ]),
    'a hold that started outside still ends at the host (no stuck key)',
    JSON.stringify(r.sent)
  )
}

console.log('stop')
{
  const r = rig()
  r.down(K.AltRight, { altKey: true })
  r.release()
  r.up(K.AltRight)
  ok(
    same(r.sent, [
      { t: 'talkKey', code: 'AltRight', phase: 'down' },
      { t: 'talkKey', code: 'AltRight', phase: 'up' }
    ]),
    'stopping the hook lets go of a held talk key, once',
    JSON.stringify(r.sent)
  )
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
