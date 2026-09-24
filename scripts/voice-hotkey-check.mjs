/**
 * The two voice keys: Dictate (Right Alt) and Agent (Right Shift).
 *
 *   node scripts/voice-hotkey-check.mjs
 *
 * Drives the real wiring (attachTalkKey in src/lib/stt-gesture.ts) with fake
 * key events on a fake window, and the keymap rules that let a lone modifier
 * be a voice key and nothing else. A lone modifier counts only when it goes
 * down and up on its own: Shift+A, Shift+click and Left Shift never fire the
 * Right Shift key.
 */
import { readFileSync } from 'node:fs'
import { registerHooks } from 'node:module'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const SHARED = new URL('../shared', import.meta.url).href
const SRC = new URL('../src', import.meta.url).href

registerHooks({
  resolve(spec, context, next) {
    if (spec.startsWith('@shared/')) return next(`${SHARED}/${spec.slice('@shared/'.length)}.ts`, context)
    if (spec.startsWith('@/')) return next(`${SRC}/${spec.slice(2)}.ts`, context)
    if (spec.startsWith('.') && !/\.[a-z]+$/i.test(spec)) return next(`${spec}.ts`, context)
    return next(spec, context)
  },
  load(url, context, next) {
    if (url.endsWith('.ts')) return next(url, { ...context, format: 'module-typescript' })
    return next(url, context)
  }
})

// keymapRegistry persists through window.forgeHub; give it a fake one.
let saved = null
globalThis.window = {
  forgeHub: {
    canvas: {},
    callSigns: {},
    prompts: {},
    keymap: {
      get: async () => ({ version: 1, overrides: {} }),
      set: async (file) => {
        saved = file
        return file
      }
    }
  }
}

const G = await import('../src/lib/stt-gesture.ts')
const W = await import('../web/src/lib/talk-key.ts')
const km = await import('../src/lib/keymap.ts')
const { BUILTIN_COMMANDS, TALK_AGENT_ID, TALK_DICTATE_ID } = await import('../src/lib/shortcutCommands.ts')
const reg = await import('../src/lib/keymapRegistry.ts')

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
const eq = (a, b, label) => ok(JSON.stringify(a) === JSON.stringify(b), label, `got ${JSON.stringify(a)}, want ${JSON.stringify(b)}`)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
/** Wait for the hold timer to have fired (or give up after `ms`), rather than betting on timer order. */
const until = async (cond, ms = 3000) => {
  const end = Date.now() + ms
  while (!cond() && Date.now() < end) await sleep(20)
}

/* A fake window: listeners by type, and events that record preventDefault. */
function fakeWindow() {
  const map = new Map()
  return {
    addEventListener(type, fn) {
      if (!map.has(type)) map.set(type, new Set())
      map.get(type).add(fn)
    },
    removeEventListener(type, fn) {
      map.get(type)?.delete(fn)
    },
    fire(type, code = '', repeat = false, mods = {}) {
      const ev = {
        type,
        code,
        repeat,
        ctrlKey: code.startsWith('Control'),
        altKey: code.startsWith('Alt'),
        shiftKey: code.startsWith('Shift'),
        metaKey: code.startsWith('Meta'),
        ...mods,
        prevented: false,
        preventDefault() {
          this.prevented = true
        },
        stopPropagation() {}
      }
      for (const fn of [...(map.get(type) ?? [])]) fn(ev)
      return ev
    },
    count() {
      let n = 0
      for (const s of map.values()) n += s.size
      return n
    }
  }
}

/** Wire one key and record what it asks for. */
function wire(win, code, opts = {}) {
  const w = { log: [], listening: false, off: null }
  w.off = G.attachTalkKey(
    win,
    code,
    () => w.listening,
    (intent) => {
      w.log.push(intent)
      if (intent === 'toggle') w.listening = !w.listening
      else w.listening = intent === 'ptt-start'
    },
    opts.cancel ? () => w.log.push('cancel') : undefined
  )
  return w
}

console.log('\nAgent key (Right Shift): the gesture matcher')
{
  const win = fakeWindow()
  const agent = wire(win, 'ShiftRight', { cancel: true })

  const down = win.fire('keydown', 'ShiftRight')
  win.fire('keyup', 'ShiftRight')
  eq(agent.log, ['toggle'], 'a lone Right Shift tap fires (toggle)')
  ok(!down.prevented, 'the Right Shift keydown is not swallowed (the terminal still sees Shift)')

  agent.log.length = 0
  win.fire('keydown', 'ShiftRight')
  const a = win.fire('keydown', 'KeyA', false, { shiftKey: true })
  win.fire('keyup', 'KeyA')
  win.fire('keyup', 'ShiftRight')
  eq(agent.log, [], 'Shift+A does not fire')
  ok(!a.prevented, '…and the A keydown reaches the pane untouched, so it types a capital')

  win.fire('keydown', 'ShiftRight')
  win.fire('pointerdown')
  win.fire('keyup', 'ShiftRight')
  eq(agent.log, [], 'Right Shift held while clicking does not fire')

  win.fire('keydown', 'ShiftLeft')
  win.fire('keyup', 'ShiftLeft')
  eq(agent.log, [], 'Left Shift does not fire the Right Shift key')

  win.fire('keydown', 'ShiftRight', false, { ctrlKey: true })
  win.fire('keyup', 'ShiftRight', false, { ctrlKey: true })
  eq(agent.log, [], 'Right Shift pressed while Ctrl is already held (Ctrl+Shift) does not fire')

  win.fire('keydown', 'ShiftRight')
  win.fire('keydown', 'ShiftRight', true)
  win.fire('keyup', 'ShiftRight')
  eq(agent.log, ['toggle'], 'auto-repeat while tapping still fires once')

  agent.log.length = 0
  win.fire('keydown', 'ShiftRight')
  await until(() => agent.log.length > 0)
  eq(agent.log, ['ptt-start'], 'holding Right Shift starts listening (hold to talk)')
  win.fire('keyup', 'ShiftRight')
  eq(agent.log, ['ptt-start', 'ptt-end'], '…and letting go ends it (release sends)')

  agent.log.length = 0
  win.fire('keydown', 'ShiftRight')
  await until(() => agent.log.length > 0)
  win.fire('keydown', 'KeyA', false, { shiftKey: true })
  win.fire('keyup', 'KeyA', false, { shiftKey: true })
  win.fire('keyup', 'ShiftRight')
  eq(agent.log, ['ptt-start', 'cancel'], 'Shift held a beat too long before a capital: the hold is taken back, nothing more')

  agent.off()
  ok(win.count() === 0, 'unwiring removes every listener')
}

console.log('\nDictate key (Right Ctrl) beside the Agent key')
{
  const win = fakeWindow()
  const dictate = wire(win, 'ControlRight')
  const agent = wire(win, 'ShiftRight', { cancel: true })

  win.fire('keydown', 'ControlRight')
  win.fire('keyup', 'ControlRight')
  eq([dictate.log, agent.log], [['toggle'], []], 'a Right Ctrl tap is the Dictate key only')

  win.fire('keydown', 'ShiftRight')
  win.fire('keyup', 'ShiftRight')
  eq([dictate.log, agent.log], [['toggle'], ['toggle']], 'a Right Shift tap is the Agent key only')

  win.fire('keydown', 'ControlRight')
  win.fire('keydown', 'KeyC')
  win.fire('keyup', 'KeyC')
  win.fire('keyup', 'ControlRight')
  eq(dictate.log, ['toggle'], 'Ctrl+C never fires the Dictate key')

  win.fire('keydown', 'ControlRight')
  win.fire('keydown', 'ShiftRight', false, { ctrlKey: true })
  win.fire('keyup', 'ShiftRight', false, { ctrlKey: true })
  win.fire('keyup', 'ControlRight')
  eq([dictate.log, agent.log], [['toggle'], ['toggle']], 'Right Ctrl+Right Shift together fires neither')

  dictate.listening = false
  win.fire('keydown', 'ControlRight')
  await until(() => dictate.log.length > 1)
  win.fire('keydown', 'KeyC', false, { ctrlKey: true })
  win.fire('keyup', 'ControlRight')
  eq(dictate.log, ['toggle', 'ptt-start', 'ptt-end'], 'a Dictate hold that becomes Ctrl+C closes the mic it opened')

  dictate.off()
  agent.off()
}

console.log('\nDictate key on Right Alt, UK (AltGr) layout')
{
  // The order and flags below are what Chromium reported for a real Right Alt
  // held on Windows with the UK layout (2026-09-24 probe): a fake Left Ctrl
  // goes down first, and repeats beside Right Alt for as long as it is held.
  const altGr = async (win, holdMs, { repeats = 0, extra, beforeUp } = {}) => {
    win.fire('keydown', 'ControlLeft', false, { ctrlKey: true })
    win.fire('keydown', 'AltRight', false, { ctrlKey: false, altKey: false })
    if (holdMs) await new Promise((r) => setTimeout(r, holdMs))
    for (let i = 0; i < repeats; i++) {
      win.fire('keydown', 'ControlLeft', true, { ctrlKey: false })
      win.fire('keydown', 'AltRight', true, { ctrlKey: false, altKey: false })
    }
    extra?.()
    beforeUp?.()
    win.fire('keyup', 'ControlLeft', false, { ctrlKey: false })
    win.fire('keyup', 'AltRight', false, { ctrlKey: false, altKey: false })
  }
  const win = fakeWindow()
  const dictate = wire(win, 'AltRight')

  await altGr(win, 0)
  eq(dictate.log, ['toggle'], 'a Right Alt tap toggles, the fake Left Ctrl ignored')
  dictate.log.length = 0
  dictate.listening = false

  let midHold = null
  await altGr(win, G.MODIFIER_TAP_MS + 80, { repeats: 5, beforeUp: () => (midHold = [...dictate.log]) })
  eq(midHold, ['ptt-start'], 'a Right Alt hold keeps the mic open through the fake Left Ctrl repeats')
  eq(dictate.log, ['ptt-start', 'ptt-end'], '…and closes it on release')
  dictate.log.length = 0

  await altGr(win, 0, {
    extra: () => {
      win.fire('keydown', 'Digit4', false, { ctrlKey: true, altKey: true })
      win.fire('keyup', 'Digit4', false, { ctrlKey: true, altKey: true })
    }
  })
  eq(dictate.log, [], 'AltGr+4 (the euro sign) types and never fires')
  const typed = win.fire('keydown', 'AltRight', false, { ctrlKey: false, altKey: false })
  win.fire('keyup', 'AltRight')
  ok(!typed.prevented, 'Right Alt is only read, never swallowed, so AltGr characters still type')
  dictate.log.length = 0
  dictate.listening = false

  win.fire('keydown', 'AltLeft')
  win.fire('keyup', 'AltLeft')
  eq(dictate.log, [], 'Left Alt is not Right Alt')
  dictate.off()
}

console.log('\nForge Web deck: D on Right Alt, UK (AltGr) layout (web/src/lib/talk-key.ts)')
{
  // The same Chromium sequence as above, through the browser's copy of the wiring.
  const altGr = async (win, holdMs, { repeats = 0, extra } = {}) => {
    win.fire('keydown', 'ControlLeft', false, { ctrlKey: true })
    win.fire('keydown', 'AltRight', false, { ctrlKey: false, altKey: false })
    if (holdMs) await sleep(holdMs)
    for (let i = 0; i < repeats; i++) {
      win.fire('keydown', 'ControlLeft', true, { ctrlKey: false })
      win.fire('keydown', 'AltRight', true, { ctrlKey: false, altKey: false })
    }
    extra?.()
    win.fire('keyup', 'ControlLeft', false, { ctrlKey: false })
    win.fire('keyup', 'AltRight', false, { ctrlKey: false, altKey: false })
  }
  let suspended = false
  const win = fakeWindow()
  const d = { log: [], listening: false }
  const off = W.attachTalkKey(
    win,
    'AltRight',
    () => d.listening,
    (intent) => {
      d.log.push(intent)
      if (intent === 'toggle') d.listening = !d.listening
      else d.listening = intent === 'ptt-start'
    },
    { cancel: () => d.log.push('cancel'), suspended: () => suspended }
  )
  const reset = () => {
    d.log.length = 0
    d.listening = false
  }

  await altGr(win, 0)
  eq(d.log, ['toggle'], 'a Right Alt tap toggles D, the fake Left Ctrl ignored')
  reset()

  let midHold = null
  await altGr(win, W.MODIFIER_TAP_MS + 80, { repeats: 5, extra: () => (midHold = [...d.log]) })
  eq(midHold, ['ptt-start'], 'a Right Alt hold keeps D listening through the fake Left Ctrl repeats')
  eq(d.log, ['ptt-start', 'ptt-end'], '…and stops and sends on release')
  reset()

  await altGr(win, 0, {
    extra: () => {
      win.fire('keydown', 'Digit4', false, { ctrlKey: true, altKey: true })
      win.fire('keyup', 'Digit4', false, { ctrlKey: true, altKey: true })
    }
  })
  eq(d.log, [], 'AltGr+4 (the euro sign) types and never fires D')
  const typed = win.fire('keydown', 'AltRight', false, { ctrlKey: false, altKey: false })
  win.fire('keyup', 'AltRight')
  ok(!typed.prevented, 'Right Alt is only read, never swallowed')
  reset()

  suspended = true
  await altGr(win, 0)
  eq(d.log, [], 'nothing fires while a field is recording a key')
  suspended = false

  win.fire('compositionstart')
  await altGr(win, 0)
  eq(d.log, [], 'nothing fires while an IME composition runs')
  win.fire('compositionend')
  win.fire('keydown', 'AltRight', false, { isComposing: true })
  win.fire('keyup', 'AltRight')
  eq(d.log, [], '…or while the key event itself is composing')
  await altGr(win, 0)
  eq(d.log, ['toggle'], 'and fires again once the composition ends')
  reset()
  off()

  // The recorder: Right Alt records as Right Alt, not as "Left Ctrl + another key".
  const ev = (code, mods = {}) => ({ code, repeat: false, ctrlKey: false, altKey: false, shiftKey: false, metaKey: false, ...mods })
  let s = W.recordKeyDown(null, ev('ControlLeft', { ctrlKey: true }))
  s = W.recordKeyDown(s.held, ev('AltRight'))
  const upCtrl = W.recordKeyUp(s.held, 'ControlLeft')
  ok(upCtrl.ignored === true, 'the recorder ignores AltGr\'s fake Left Ctrl coming up')
  const upAlt = W.recordKeyUp(upCtrl.held, 'AltRight')
  eq(upAlt.key, 'AltRight', 'the recorder records Right Alt on a UK layout')
  s = W.recordKeyDown(null, ev('ShiftLeft', { shiftKey: true }))
  s = W.recordKeyDown(s.held, ev('KeyA', { shiftKey: true }))
  ok(s.refused === true && W.recordKeyUp(s.held, 'ShiftLeft').key === undefined, 'Shift+A records nothing')
  eq(W.recordKeyDown(null, ev('F8')).key, 'F8', 'F8 records at once')
}

console.log('\ndirect key (F8)')
{
  const win = fakeWindow()
  const f8 = wire(win, 'F8')
  const ev = win.fire('keydown', 'F8')
  win.fire('keyup', 'F8')
  eq(f8.log, ['toggle'], 'F8 toggles on press')
  ok(ev.prevented, 'F8 is taken (it is not a typing key)')
  f8.off()
}

console.log('\nkeymap: voice keys accept a lone modifier, nothing else does')
{
  const base = km.resolveKeymap(BUILTIN_COMMANDS, {})
  ok(base.conflicts.length === 0 && base.rejected.length === 0, 'built-ins resolve clean with both voice keys', JSON.stringify([base.conflicts, base.rejected]))
  eq(base.keysFor[TALK_DICTATE_ID], ['AltRight'], 'Dictate key defaults to Right Alt')
  eq(base.keysFor[TALK_AGENT_ID], ['ShiftRight'], 'Agent key defaults to Right Shift')
  eq(km.formatCombo('ShiftRight'), 'Right Shift', 'shown as "Right Shift"')
  eq(km.formatCombo('Ctrl+Shift+G'), 'Ctrl+Shift+G', 'ordinary combos display as before')

  const left = km.setBinding(BUILTIN_COMMANDS, {}, TALK_AGENT_ID, ['ShiftLeft'])
  ok(left.ok && left.overrides[TALK_AGENT_ID][0] === 'ShiftLeft', 'the Agent key can be moved to Left Shift', JSON.stringify(left))
  const byLabel = km.setBinding(BUILTIN_COMMANDS, {}, TALK_AGENT_ID, ['Left Alt'])
  ok(byLabel.ok && byLabel.overrides[TALK_AGENT_ID][0] === 'AltLeft', 'a label ("Left Alt") is stored as its code', JSON.stringify(byLabel))
  for (const bad of ['Shift+A', 'A', 'Ctrl+Shift+G']) {
    ok(!km.setBinding(BUILTIN_COMMANDS, {}, TALK_AGENT_ID, [bad]).ok, `a voice key refuses ${bad}`)
  }
  const clash = km.setBinding(BUILTIN_COMMANDS, {}, TALK_AGENT_ID, ['AltRight'])
  ok(!clash.ok && clash.conflictsWith?.includes(TALK_DICTATE_ID), 'Agent on Right Alt clashes with the Dictate key', JSON.stringify(clash))

  const loner = km.setBinding(BUILTIN_COMMANDS, {}, 'view.toggle', ['ShiftRight'])
  ok(!loner.ok && /only works for the Dictate and Agent/.test(loner.error), 'an ordinary command refuses Right Shift, with the reason', JSON.stringify(loner))
  const tainted = km.resolveKeymap(BUILTIN_COMMANDS, { 'tab.new': ['ShiftRight'] })
  ok(tainted.rejected.some((r) => r.commandId === 'tab.new' && /only works for/.test(r.reason)) && tainted.bindings.get('ShiftRight') === TALK_AGENT_ID, 'a hand-edited lone modifier on an ordinary command is rejected', JSON.stringify(tainted.rejected))
  ok(km.comboFromEvent({ code: 'ShiftRight', ctrlKey: false, altKey: false, shiftKey: true, metaKey: false }) === null, 'useShortcuts still never sees a lone modifier as a combo')
  for (const legacy of ['ControlRight', 'ControlLeft', 'AltRight', 'ShiftRight', 'ScrollLock', 'Pause', 'F8']) {
    ok(km.normaliseTalkKey(legacy) === legacy, `a stored sttHotkey of ${legacy} still reads`)
  }
}

console.log('\nkeymap registry: where each voice key is stored')
{
  await reg.loadKeymapOverrides()
  let written = null
  const unbind = reg.bindCommandKeys(TALK_DICTATE_ID, ['ControlRight'], (keys) => {
    written = keys
  })
  ok(reg.commandForCombo('F8') === null, 'no command fires on F8 by default')
  const agentOnF9 = reg.setCommandKeys(TALK_AGENT_ID, ['F9'])
  ok(agentOnF9.ok && reg.commandForCombo('F9') === null, 'a voice key on F9 is never fired by useShortcuts (the gesture engine owns it)')
  eq(reg.keyForCommand(TALK_AGENT_ID), 'F9', 'the Agent key reads back from the registry')
  eq(saved?.overrides?.[TALK_AGENT_ID], ['F9'], 'the Agent key is saved in keymap.json')

  const dict = reg.setCommandKeys(TALK_DICTATE_ID, ['ShiftLeft'])
  ok(dict.ok, 'the Dictate key rebinds through the registry', JSON.stringify(dict))
  eq(written, ['ShiftLeft'], '…and the new key is written back to settings.sttHotkey')
  ok(!(TALK_DICTATE_ID in (saved?.overrides ?? {})), '…not into keymap.json')
  const view = reg.getKeymapView().commands.find((c) => c.id === TALK_DICTATE_ID)
  ok(view?.customised === true && view.keys[0] === 'ShiftLeft', 'the settings view shows the Dictate key as changed')

  reg.resetCommandKeys(TALK_DICTATE_ID)
  eq(written, ['AltRight'], 'Reset puts the Dictate key back to Right Alt')
  reg.resetCommandKeys(TALK_AGENT_ID)
  eq(reg.keyForCommand(TALK_AGENT_ID), 'ShiftRight', 'Reset puts the Agent key back to Right Shift')
  unbind()
}

console.log('\nwiring')
{
  const hook = readFileSync(join(ROOT, 'src/hooks/useDictation.ts'), 'utf8')
  ok(/attachTalkKey\(window, hotkey/.test(hook) && /attachTalkKey\(window, agentKey/.test(hook), 'both keys are wired on window, the same capture path')
  ok(hook.includes('agentVoiceAlways()'), 'the Agent key uses the registered agent route whatever the bar mode')
  ok(!/setBarMode/.test(hook), 'the Agent key never flips the Dictate ⇄ Agent switch')
  ok(/dictateAutoSend/.test(hook) && /terminalHost\.submit/.test(hook), 'Dictate mode presses Enter only when dictateAutoSend is on')
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
