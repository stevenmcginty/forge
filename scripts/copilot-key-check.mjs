/**
 * The Copilot key (F24) as a Listen tap, judged head-less.
 *
 *   node scripts/copilot-key-check.mjs
 *
 * Imports the *real* electron/copilot-key.ts with `electron` stubbed: the
 * stub's globalShortcut keeps the F24 callback, and the check calls it on a
 * fake clock. No hotkey is registered, no key is pressed, no microphone opens:
 *
 *   - the repeat gate: a first press passes, a press inside the gap is
 *     dropped, a press after it passes, a steady repeat stream passes once
 *   - start registers F24 once; a press sends one voice:listenToggle to the
 *     host and nothing else; a held key's repeats send nothing more
 *   - no host, or a destroyed one: the press is dropped without a throw
 *   - F24 taken by another app (register false or a throw): one warning, no throw
 *   - dispose lets F24 go
 */
import { registerHooks } from 'node:module'

// One stub module for every copy: it hands each call to the current rig's fake.
const ELECTRON_STUB = `export const globalShortcut = {
  register: (...a) => globalThis.__copilotShortcut.register(...a),
  unregister: (...a) => globalThis.__copilotShortcut.unregister(...a)
}`

registerHooks({
  resolve(spec, context, next) {
    if (spec === 'electron') return { url: 'forge-check:electron', shortCircuit: true }
    if (spec.startsWith('@shared/')) {
      return next(new URL(`../shared/${spec.slice('@shared/'.length)}.ts`, import.meta.url).href, context)
    }
    // shared/ipc.ts's own './foreman', './brain': extensionless, as Vite writes them.
    if (spec.startsWith('./') && !/\.[cm]?[jt]s$/.test(spec) && context.parentURL?.includes('/shared/')) {
      return next(`${spec}.ts`, context)
    }
    return next(spec, context)
  },
  load(url, context, next) {
    if (url === 'forge-check:electron') return { format: 'module', shortCircuit: true, source: ELECTRON_STUB }
    if (url.startsWith('file:') && new URL(url).pathname.endsWith('.ts')) {
      return next(url, { ...context, format: 'module-typescript' })
    }
    return next(url, context)
  }
})

const { IPC } = await import('../shared/ipc.ts')

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

/** A fresh copy of the module (its registered/warned state is per module), over a fake globalShortcut. */
let copies = 0
async function rig({ register = () => true } = {}) {
  const shortcut = {
    keys: new Map(),
    registers: [],
    unregisters: [],
    register(accel, cb) {
      this.registers.push(accel)
      const r = register(accel)
      if (r) this.keys.set(accel, cb)
      return r
    },
    unregister(accel) {
      this.unregisters.push(accel)
      this.keys.delete(accel)
    }
  }
  globalThis.__copilotShortcut = shortcut
  const C = await import(`../electron/copilot-key.ts?copy=${++copies}`)
  const sent = []
  const host = {
    destroyed: false,
    isDestroyed() {
      return this.destroyed
    },
    webContents: { send: (...args) => sent.push(args) }
  }
  const clock = { t: 10_000 }
  const warnings = []
  const press = () => {
    const cb = shortcut.keys.get(C.LISTEN_ACCELERATOR)
    if (cb) cb()
  }
  return { C, shortcut, sent, host, clock, warnings, press }
}

/** console.warn, captured for the length of `fn`. */
async function capturingWarn(into, fn) {
  const real = console.warn
  console.warn = (...args) => into.push(args.map(String).join(' '))
  try {
    await fn()
  } finally {
    console.warn = real
  }
}

// ---- the repeat gate, pure ---------------------------------------------------
{
  const { C } = await rig()
  ok(C.LISTEN_ACCELERATOR === 'F24', 'the key is F24')
  ok(C.REPEAT_GAP_MS > 500, 'the gap outlasts Windows\' default 500 ms repeat delay', String(C.REPEAT_GAP_MS))

  const gate = C.createRepeatGate(400)
  ok(gate(1000) === true, 'a single press passes')
  ok(gate(1300) === false, 'a press inside the gap is dropped')
  ok(gate(1300 + 400) === true, 'a press a whole gap after the last one passes')

  const held = C.createRepeatGate(400)
  const fired = [0, 380, 413, 446, 479, 512, 545, 578, 611].map((t) => held(t))
  ok(same(fired, [true, false, false, false, false, false, false, false, false]), 'a steady repeat stream passes once', JSON.stringify(fired))
  ok(held(611 + 399) === false && held(611 + 399 + 400) === true, 'the gap runs from the last press, dropped or not')

  const first = C.createRepeatGate()
  ok(first(0) === true, 'the very first press passes, even at time 0')
}

// ---- routing: F24 → one voice:listenToggle to the host ------------------------
{
  const { C, shortcut, sent, host, clock, press } = await rig()
  ok(IPC.voiceListenToggle === 'voice:listenToggle', 'the channel is voice:listenToggle')
  C.startCopilotKey(() => host, () => clock.t)
  C.startCopilotKey(() => host, () => clock.t)
  ok(same(shortcut.registers, ['F24']), 'start registers F24, once', JSON.stringify(shortcut.registers))

  press()
  ok(same(sent, [[IPC.voiceListenToggle]]), 'a press sends one listen toggle, no payload', JSON.stringify(sent))

  // Held: the OS repeat after ~500 ms, then every ~33 ms.
  for (const dt of [500, 33, 33, 33, 33]) {
    clock.t += dt
    press()
  }
  ok(sent.length === 1, 'a held key\'s repeats send nothing more', String(sent.length))

  clock.t += C.REPEAT_GAP_MS
  press()
  ok(sent.length === 2, 'a fresh press after the gap toggles again', String(sent.length))

  C.disposeCopilotKey()
  ok(same(shortcut.unregisters, ['F24']) && !shortcut.keys.has('F24'), 'dispose lets F24 go')
  C.disposeCopilotKey()
  ok(shortcut.unregisters.length === 1, 'a second dispose is a no-op')
}

// ---- no host -----------------------------------------------------------------
{
  const { C, sent, host, clock, press } = await rig()
  let current = null
  C.startCopilotKey(() => current, () => clock.t)
  let threw = null
  try {
    press()
    current = host
    host.destroyed = true
    clock.t += C.REPEAT_GAP_MS
    press()
  } catch (err) {
    threw = err
  }
  ok(!threw && sent.length === 0, 'no host, or a destroyed one: the press is dropped quietly', String(threw ?? sent.length))
  host.destroyed = false
  clock.t += C.REPEAT_GAP_MS
  press()
  ok(sent.length === 1, 'the host is read at each press, so a new window gets the next one', String(sent.length))
  C.disposeCopilotKey()
}

// ---- F24 taken ---------------------------------------------------------------
{
  const { C, shortcut, host, warnings } = await rig({ register: () => false })
  let threw = null
  await capturingWarn(warnings, () => {
    try {
      C.startCopilotKey(() => host)
      C.startCopilotKey(() => host)
    } catch (err) {
      threw = err
    }
  })
  ok(!threw, 'register false: no throw')
  ok(warnings.length === 1 && /F24/.test(warnings[0]), 'register false: one warning, once', JSON.stringify(warnings))
  C.disposeCopilotKey()
  ok(shortcut.unregisters.length === 0, 'nothing registered, nothing to let go')
}
{
  const { C, host, warnings } = await rig({
    register: () => {
      throw new Error('Failed to parse accelerator')
    }
  })
  let threw = null
  await capturingWarn(warnings, () => {
    try {
      C.startCopilotKey(() => host)
      C.startCopilotKey(() => host)
    } catch (err) {
      threw = err
    }
  })
  ok(!threw, 'register throws: no throw out of start')
  ok(warnings.length === 1, 'register throws: one warning, once', JSON.stringify(warnings))
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
