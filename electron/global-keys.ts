import { BrowserWindow } from 'electron'
import type { RemoteKey } from '@shared/minibar'
import { keymapOverride } from './hub-ipc'
import { isMainMinimised, sendRemoteKey, summon } from './minibar-window'
import { getSettings } from './store'
import { isQuitting } from './tray'

/**
 * The global talk keys: the Dictate key, the Listen key and the summon key
 * from any app while Forge is minimised (docs/MINI-BAR.md 4.5, 5.5 b).
 *
 * A native low-level keyboard hook (`uiohook-napi`), on only while the main
 * window is minimised with the mini bar and `miniGlobalKeys` on. Zero global
 * hooking while Forge is up. Only these three keys, never anything else (D1):
 * a system-wide Ctrl+T would also act in the app Steve is using.
 *
 * The hook sees every keystroke on the machine, so the privacy rule is part of
 * this file's contract: it never reads characters, never logs a key event,
 * never buffers one, never swallows one (uiohook always calls CallNextHookEx),
 * and never injects one (no keyTap / keyToggle: they call SendInput). Every
 * other key is judged and forgotten on the spot; what crosses to the host is a
 * talk key's code, a content-free `otherKey`, or `summon`.
 *
 * The hook installs a mouse hook alongside the keyboard one (there is no
 * keyboard-only mode), so only `keydown`/`keyup` are listened to, never
 * `input`, which fires on every mouse move.
 *
 * The native module is loaded on the first start, not at import: a module
 * that failed to load must cost the global keys, never Forge's startup.
 */

/** One keyboard event, as uiohook hands it over: no characters, no scan code, no repeat flag. */
export interface HookKey {
  keycode: number
  /** Milliseconds since boot (KBDLLHOOKSTRUCT.time). */
  time: number
  ctrlKey: boolean
  altKey: boolean
  shiftKey: boolean
  metaKey: boolean
}

/*
 * uiohook keycodes (node_modules/uiohook-napi/dist/index.js `UiohookKey`;
 * Pause from libuiohook/include/uiohook.h VC_PAUSE). Written out here because
 * importing the package loads the native hook.
 */
const CTRL_LEFT = 0x001d
const ALT_RIGHT = 0x0e38

/** A talk key's uiohook keycode, by KeyboardEvent.code (src/lib/keymap.ts TALK_LABELS, plus F1–F24). */
const TALK_KEYCODES: Record<string, number> = {
  ControlLeft: CTRL_LEFT,
  ControlRight: 0x0e1d,
  ShiftLeft: 0x002a,
  ShiftRight: 0x0036,
  AltLeft: 0x0038,
  AltRight: ALT_RIGHT,
  MetaLeft: 0x0e5b,
  MetaRight: 0x0e5c,
  ScrollLock: 0x0046,
  Pause: 0x0e45,
  F1: 0x003b,
  F2: 0x003c,
  F3: 0x003d,
  F4: 0x003e,
  F5: 0x003f,
  F6: 0x0040,
  F7: 0x0041,
  F8: 0x0042,
  F9: 0x0043,
  F10: 0x0044,
  F11: 0x0057,
  F12: 0x0058,
  F13: 0x005b,
  F14: 0x005c,
  F15: 0x005d,
  F16: 0x0063,
  F17: 0x0064,
  F18: 0x0065,
  F19: 0x0066,
  F20: 0x0067,
  F21: 0x0068,
  F22: 0x0069,
  F23: 0x006a,
  F24: 0x006b
}

/** A talk key stored by its label ('Right Shift'), as src/lib/keymap.ts normaliseTalkKey also accepts. */
const TALK_LABELS: Record<string, string> = {
  'right ctrl': 'ControlRight',
  'left ctrl': 'ControlLeft',
  'right shift': 'ShiftRight',
  'left shift': 'ShiftLeft',
  'right alt': 'AltRight',
  'left alt': 'AltLeft',
  'right win': 'MetaRight',
  'left win': 'MetaLeft',
  'scroll lock': 'ScrollLock',
  pause: 'Pause'
}

/** A combo's key name (src/lib/keymap.ts keyName) as a uiohook keycode. Letters, digits and F-keys are added below. */
const COMBO_KEYCODES: Record<string, number> = {
  ',': 0x0033,
  '.': 0x0034,
  '/': 0x0035,
  '\\': 0x002b,
  '[': 0x001a,
  ']': 0x001b,
  ';': 0x0027,
  "'": 0x0028,
  '`': 0x0029,
  '-': 0x000c,
  '=': 0x000d,
  Left: 0xe04b,
  Right: 0xe04d,
  Up: 0xe048,
  Down: 0xe050,
  Esc: 0x0001,
  Space: 0x0039,
  Enter: 0x001c,
  Tab: 0x000f,
  Backspace: 0x000e,
  Delete: 0x0e53,
  Insert: 0x0e52,
  Home: 0x0e47,
  End: 0x0e4f,
  PageUp: 0x0e49,
  PageDown: 0x0e51,
  NumpadAdd: 0x004e,
  NumpadSubtract: 0x004a,
  NumpadEnter: 0x0e1c,
  A: 0x001e,
  B: 0x0030,
  C: 0x002e,
  D: 0x0020,
  E: 0x0012,
  F: 0x0021,
  G: 0x0022,
  H: 0x0023,
  I: 0x0017,
  J: 0x0024,
  K: 0x0025,
  L: 0x0026,
  M: 0x0032,
  N: 0x0031,
  O: 0x0018,
  P: 0x0019,
  Q: 0x0010,
  R: 0x0013,
  S: 0x001f,
  T: 0x0014,
  U: 0x0016,
  V: 0x002f,
  W: 0x0011,
  X: 0x002d,
  Y: 0x0015,
  Z: 0x002c,
  '0': 0x000b,
  '1': 0x0002,
  '2': 0x0003,
  '3': 0x0004,
  '4': 0x0005,
  '5': 0x0006,
  '6': 0x0007,
  '7': 0x0008,
  '8': 0x0009,
  '9': 0x000a,
  Numpad0: 0x0052,
  Numpad1: 0x004f,
  Numpad2: 0x0050,
  Numpad3: 0x0051,
  Numpad4: 0x004b,
  Numpad5: 0x004c,
  Numpad6: 0x004d,
  Numpad7: 0x0047,
  Numpad8: 0x0048,
  Numpad9: 0x0049
}
for (let n = 1; n <= 24; n++) COMBO_KEYCODES[`F${n}`] = TALK_KEYCODES[`F${n}`]!

/**
 * AltGr on a UK layout: Windows sends a fake Left Ctrl, then Right Alt, from
 * the same hardware event, so their hook times match to the millisecond. The
 * fake arrives as keycode 29, the same as a real Left Ctrl; this gap is the
 * only tell uiohook passes through.
 */
const ALTGR_GAP_MS = 10
/** How long a Left Ctrl press waits for its Right Alt before it counts as a real Left Ctrl. */
const ALTGR_WAIT_MS = 30

/** The commands whose keys this file reads (src/lib/shortcutCommands.ts). */
const TALK_AGENT_ID = 'voice.talk.agent'
const SUMMON_ID = 'voice.hubCard'

interface Chord {
  keycode: number
  ctrl: boolean
  alt: boolean
  shift: boolean
  meta: boolean
}

export interface KeyConfig {
  /** uiohook keycode → the talk key's KeyboardEvent.code. */
  talk: Map<number, string>
  summon: Chord[]
}

/** A stored talk key ('AltRight' or 'Right Alt') as its KeyboardEvent.code, or null. */
function talkCode(raw: string | undefined): string | null {
  const value = String(raw ?? '').trim()
  if (!value) return null
  if (TALK_KEYCODES[value] !== undefined) return value
  if (/^f\d{1,2}$/i.test(value) && TALK_KEYCODES[value.toUpperCase()] !== undefined) return value.toUpperCase()
  return TALK_LABELS[value.toLowerCase().replace(/\s+/g, ' ')] ?? null
}

/** "Ctrl+Shift+G" as a chord, or null when it has no key this hook knows. */
function parseChord(combo: string): Chord | null {
  const chord: Chord = { keycode: -1, ctrl: false, alt: false, shift: false, meta: false }
  for (const part of String(combo).split('+').map((p) => p.trim()).filter(Boolean)) {
    const lower = part.toLowerCase()
    if (lower === 'ctrl' || lower === 'control') chord.ctrl = true
    else if (lower === 'alt') chord.alt = true
    else if (lower === 'shift') chord.shift = true
    else if (lower === 'meta' || lower === 'win') chord.meta = true
    else {
      if (chord.keycode !== -1) return null
      const name = part.length === 1 ? part.toUpperCase() : part
      const code = COMBO_KEYCODES[name] ?? COMBO_KEYCODES[name.toUpperCase()]
      if (code === undefined) return null
      chord.keycode = code
    }
  }
  return chord.keycode === -1 ? null : chord
}

/** The keys to watch: the two talk keys and the summon key's combos. */
export function keyConfig(dictate: string | undefined, listen: string | undefined, summonKeys: string[]): KeyConfig {
  const talk = new Map<number, string>()
  for (const raw of [dictate, listen]) {
    const code = talkCode(raw)
    if (code) talk.set(TALK_KEYCODES[code]!, code)
  }
  const summon = summonKeys.map(parseChord).filter((c): c is Chord => !!c)
  return { talk, summon }
}

export interface KeyFilter {
  down(e: HookKey): void
  up(e: HookKey): void
  /** Let go of every talk key the host was told is down (the hook is stopping). */
  release(): void
}

/**
 * The hook's judgement, apart from the hook so it can be driven with fake
 * events (scripts/global-keys-check.mjs).
 *
 * - OS auto-repeat arrives as more keydowns with no keyup between: a key
 *   already down is dropped.
 * - A talk key's press and release go to the host as `talkKey` down/up; any
 *   other key going down while a talk key is held goes as `otherKey`.
 * - The summon key calls `summon`.
 * - While a Forge window has the keyboard, the mini bar's own listeners have
 *   these keys, so nothing goes from here. The one exception is the release of
 *   a talk key whose press did go from here: the bar never saw that press, and
 *   without the release the host would hold the key (and the mic) for ever.
 */
export function createKeyFilter(
  config: KeyConfig,
  deps: { focused: () => boolean; send: (key: RemoteKey) => void; summon: () => void }
): KeyFilter {
  /** Keycodes down right now, to tell a new press from an auto-repeat. */
  const held = new Set<number>()
  /** Talk keys whose press the host was told about. */
  const talking = new Set<string>()
  /** A Left Ctrl press waiting to see whether Right Alt follows (AltGr). */
  let pending: HookKey | null = null
  let pendingTimer: ReturnType<typeof setTimeout> | null = null
  /** The Left Ctrl now down is AltGr's fake. */
  let fakeCtrl = false

  const isSummon = (e: HookKey): boolean =>
    config.summon.some(
      (c) =>
        c.keycode === e.keycode &&
        c.ctrl === e.ctrlKey &&
        c.alt === e.altKey &&
        c.shift === e.shiftKey &&
        c.meta === e.metaKey
    )

  /** A new press (not a repeat, not AltGr's fake Ctrl). */
  const press = (e: HookKey): void => {
    if (deps.focused()) return
    const code = config.talk.get(e.keycode)
    if (code) {
      talking.add(code)
      deps.send({ t: 'talkKey', code, phase: 'down' })
      return
    }
    if (talking.size > 0) deps.send({ t: 'otherKey' })
    if (isSummon(e)) deps.summon()
  }

  const settle = (): void => {
    if (pendingTimer) clearTimeout(pendingTimer)
    pendingTimer = null
    const e = pending
    pending = null
    if (e) press(e)
  }

  return {
    down(e) {
      if (pending) {
        if (e.keycode === ALT_RIGHT && Math.abs(e.time - pending.time) <= ALTGR_GAP_MS) {
          // AltGr: the Ctrl stays in `held`, so its repeats are dropped too.
          if (pendingTimer) clearTimeout(pendingTimer)
          pendingTimer = null
          pending = null
          fakeCtrl = true
        } else settle()
      }
      if (held.has(e.keycode)) return
      held.add(e.keycode)
      if (e.keycode === CTRL_LEFT) {
        pending = e
        pendingTimer = setTimeout(settle, ALTGR_WAIT_MS)
        return
      }
      press(e)
    },

    up(e) {
      if (pending) settle()
      if (fakeCtrl && (e.keycode === CTRL_LEFT || e.keycode === ALT_RIGHT)) {
        // Either half coming up ends the AltGr press. Its order is not known,
        // and a fake Ctrl left in `held` would eat the next real Left Ctrl.
        fakeCtrl = false
        held.delete(CTRL_LEFT)
        if (e.keycode === CTRL_LEFT) return
      }
      if (!held.delete(e.keycode)) return
      const code = config.talk.get(e.keycode)
      if (!code || !talking.delete(code)) return
      deps.send({ t: 'talkKey', code, phase: 'up' })
    },

    release() {
      if (pendingTimer) clearTimeout(pendingTimer)
      pendingTimer = null
      pending = null
      fakeCtrl = false
      held.clear()
      for (const code of talking) deps.send({ t: 'talkKey', code, phase: 'up' })
      talking.clear()
    }
  }
}

/* ------------------------------------------------------------------ hook */

type Hook = {
  on(event: 'keydown' | 'keyup', listener: (e: HookKey) => void): unknown
  off(event: 'keydown' | 'keyup', listener: (e: HookKey) => void): unknown
  start(): void
  stop(): void
}

let hook: Hook | null = null
let filter: KeyFilter | null = null
/** The hook is loading; `wanted` decides whether it starts once loaded. */
let loading = false
/** The native module failed to load once: it will not load later either. */
let unavailable = false
let wanted = false

const onDown = (e: HookKey): void => filter?.down(e)
const onUp = (e: HookKey): void => filter?.up(e)

function currentConfig(): KeyConfig {
  const settings = getSettings()
  const listen = keymapOverride(TALK_AGENT_ID)
  const summonKeys = keymapOverride(SUMMON_ID) ?? ['Ctrl+Shift+G']
  return keyConfig(settings.sttHotkey, listen ? listen[0] : 'ShiftRight', summonKeys)
}

async function start(): Promise<void> {
  if (filter || loading || unavailable) return
  if (!hook) {
    loading = true
    try {
      // A CommonJS package: its exports are named, or under `default`, depending on who loads it.
      const mod = (await import('uiohook-napi')) as unknown as { uIOhook?: Hook; default?: { uIOhook?: Hook } }
      const found = mod.uIOhook ?? mod.default?.uIOhook
      if (!found) throw new Error('uiohook-napi has no uIOhook export')
      hook = found
    } catch (err) {
      unavailable = true
      console.error('[global-keys] the key hook could not load; the talk keys work only in the mini bar', err)
      return
    } finally {
      loading = false
    }
  }
  // Restored (or turned off) while the module loaded.
  if (!wanted || filter) return
  filter = createKeyFilter(currentConfig(), {
    focused: () => BrowserWindow.getFocusedWindow() !== null,
    send: sendRemoteKey,
    summon: () => {
      summon()
      sendRemoteKey({ t: 'summon' })
    }
  })
  hook.on('keydown', onDown)
  hook.on('keyup', onUp)
  try {
    hook.start()
  } catch (err) {
    stop()
    console.error('[global-keys] the key hook could not start', err)
  }
}

function stop(): void {
  if (!filter || !hook) return
  const was = filter
  filter = null
  hook.off('keydown', onDown)
  hook.off('keyup', onUp)
  try {
    hook.stop()
  } finally {
    was.release()
  }
}

/**
 * On while the main window is minimised with the mini bar and `miniGlobalKeys`
 * on, and not quitting; off otherwise. Call on minimise, on the way back, and
 * when either setting changes. The keys are read at each start: they can only
 * be rebound in Settings, which needs the main window up.
 */
export function syncGlobalKeys(): void {
  const settings = getSettings()
  wanted = !isQuitting() && isMainMinimised() && settings.miniBar && settings.miniGlobalKeys
  if (wanted) void start()
  else stop()
}

/** Stop the hook for good (before-quit). */
export function disposeGlobalKeys(): void {
  wanted = false
  stop()
}
