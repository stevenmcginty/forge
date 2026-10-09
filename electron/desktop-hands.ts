import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { mkdirSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ScreenLookResult } from '@shared/screen'
import { HANDS_CSHARP } from './desktop-hands-csharp'

/**
 * Eyes and hands on Steve's own desktop: look at the screen, list the windows,
 * read any window's controls as a numbered list, then click, type and press
 * keys in it.
 *
 * ./desktop-control.ts already lets the voice agent launch, focus and type
 * into windows, but blind — it cannot click, and it cannot tell a text box
 * from a button. The mini bar is meant to be an on-screen assistant ("fill
 * out this form", "help me with this program"), and pane agents could not see
 * the screen at all. This module is what both use: the bridge's window_* and
 * screen_look tools (through electron/browser-panes/ipc.ts), the voice
 * agent's window_* tools, and `window.forge.screen.look()`.
 *
 * ## Why one long-lived PowerShell
 *
 * Reading a window means UI Automation, and acting on what was read means
 * keeping the *elements*, not just their names: "[4]" must be the real text
 * box from the last read, so a click or a type lands on it even if the page
 * moved a few pixels. So instead of desktop-control's one shell per call, one
 * hidden `powershell.exe` compiles a small C# helper (./desktop-hands-csharp.ts)
 * once and then answers JSON lines on stdin, holding the last read's elements
 * between calls. Still no native module and nothing new to package. It is
 * started on first use, restarted if it dies, and ends when Forge does (its
 * stdin closes, and `exit` kills it).
 *
 * ## Pixels
 *
 * Steve's laptop runs Windows scaling. The helper makes itself per-monitor DPI
 * aware before it touches anything, so window rectangles and the mouse are in
 * physical pixels — the same units as the picture main captures. A click by
 * x,y is in the last look's picture pixels and is scaled to the screen here.
 *
 * ## Safety shape
 *
 * Forge's own windows are never listed, read, clicked or typed into. Nothing
 * is brought forward by a read. Typing into a password box is refused in the
 * helper itself, whatever the caller asked. Asking Steve before a submit, a
 * purchase or a message is the tool descriptions' and persona's job; this
 * layer's is that nothing here does more than his own mouse and keyboard.
 *
 * ## Deliberately Electron-free
 *
 * voice-agent/host.ts imports this, and the headless smoke test loads the
 * host without Electron. The screen capture and Forge's own process ids are
 * handed in by ./desktop-hands-ipc.ts through `configureDesktopHands`.
 */

/* ------------------------------------------------------------------ deps */

export interface DesktopHandsDeps {
  /** Where screen looks are saved (`<data dir>\screen-looks`) and the helper script lives. */
  dataDir?: string
  /** A PNG of the primary display, capped 1920 wide. */
  capture?: () => Promise<{ png: Buffer; width: number; height: number } | null>
  /** Forge's own process ids (main, renderers…), whose windows are never Steve's. */
  ownPids?: () => number[]
}

/** The forge-bridge pipe ops answered here (bridge/desktop-tools.mjs), in main, without the renderer. */
export const DESKTOP_LINK_OPS = ['screen_look', 'window_list', 'window_read', 'window_click', 'window_type', 'window_key'] as const

let deps: DesktopHandsDeps = {}

export function configureDesktopHands(next: DesktopHandsDeps): void {
  deps = { ...deps, ...next }
}

export interface HandsReply {
  ok: boolean
  text: string
}

export interface HandsWindow {
  /** 1-based, front first, as the last list showed it. */
  number: number
  hwnd: number
  pid: number
  app: string
  title: string
  minimised: boolean
}

const LOOKS_KEPT = 20
const READ_CAP = 150
const ASK_TIMEOUT_MS = 25_000
const START_TIMEOUT_MS = 30_000

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function ownPids(): number[] {
  const pids = new Set<number>([process.pid])
  try {
    for (const pid of deps.ownPids?.() ?? []) if (Number.isInteger(pid) && pid > 0) pids.add(pid)
  } catch {
    /* main's pid alone still covers every BrowserWindow */
  }
  return [...pids]
}

/* ---------------------------------------------------------------- helper */

interface Pending {
  resolve: (value: unknown) => void
  reject: (err: Error) => void
  timer: NodeJS.Timeout
}

let child: ChildProcessWithoutNullStreams | null = null
let ready: Promise<void> | null = null
let nextId = 1
const pending = new Map<number, Pending>()
let stderrTail = ''

function helperScript(): string {
  const refs = 'UIAutomationClient, UIAutomationTypes, WindowsBase, System.Web.Extensions'
  return [
    "$ErrorActionPreference = 'Stop'",
    `Add-Type -AssemblyName ${refs}`,
    `Add-Type -ReferencedAssemblies ${refs} -TypeDefinition @'`,
    HANDS_CSHARP.trim(),
    "'@",
    '[ForgeHands]::Run()',
    ''
  ].join('\r\n')
}

function stopHelper(why: string): void {
  const c = child
  child = null
  ready = null
  for (const [id, p] of pending) {
    clearTimeout(p.timer)
    p.reject(new Error(why))
    pending.delete(id)
  }
  if (c && c.exitCode === null) {
    try {
      c.kill()
    } catch {
      /* already gone */
    }
  }
}

function startHelper(): Promise<void> {
  const dir = deps.dataDir ?? join(tmpdir(), 'forge-desktop-hands')
  mkdirSync(dir, { recursive: true })
  const script = join(dir, 'desktop-hands.ps1')
  // Rewritten on every start so it is never older than this build. The BOM
  // makes Windows PowerShell read it as UTF-8.
  writeFileSync(script, `﻿${helperScript()}`, 'utf8')
  const c = spawn(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-MTA', '-ExecutionPolicy', 'Bypass', '-File', script],
    { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] }
  )
  child = c
  stderrTail = ''
  let buffer = ''
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`the desktop helper did not start within ${START_TIMEOUT_MS / 1000}s`))
      if (child === c) stopHelper('the desktop helper did not start')
    }, START_TIMEOUT_MS)
    c.stdout.setEncoding('utf8')
    c.stderr.setEncoding('utf8')
    c.stderr.on('data', (chunk: string) => {
      stderrTail = (stderrTail + chunk).slice(-600)
    })
    c.stdout.on('data', (chunk: string) => {
      buffer += chunk
      let nl: number
      while ((nl = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, nl).trim()
        buffer = buffer.slice(nl + 1)
        if (!line) continue
        let msg: { ready?: boolean; id?: number; ok?: boolean; result?: unknown; error?: string }
        try {
          msg = JSON.parse(line)
        } catch {
          continue
        }
        if (msg.ready) {
          clearTimeout(timer)
          resolve()
          continue
        }
        const p = typeof msg.id === 'number' ? pending.get(msg.id) : undefined
        if (!p) continue
        pending.delete(msg.id as number)
        clearTimeout(p.timer)
        if (msg.ok) p.resolve(msg.result)
        else p.reject(new Error(String(msg.error ?? 'the desktop helper failed')))
      }
    })
    c.on('error', (err) => {
      clearTimeout(timer)
      reject(err)
      if (child === c) stopHelper(`the desktop helper failed: ${err.message}`)
    })
    c.on('exit', (code) => {
      clearTimeout(timer)
      const why = `the desktop helper stopped (exit ${code})${stderrTail.trim() ? `: ${stderrTail.trim().slice(-400)}` : ''}`
      reject(new Error(why))
      if (child === c) stopHelper(why)
    })
  })
}

async function ask<T>(op: string, args: Record<string, unknown> = {}, timeoutMs = ASK_TIMEOUT_MS): Promise<T> {
  if (process.platform !== 'win32') throw new Error('the desktop tools only work on Windows')
  if (!child || !ready) ready = startHelper()
  await ready
  const c = child
  if (!c) throw new Error('the desktop helper is not running')
  const id = nextId++
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id)
      reject(new Error(`the window did not answer within ${timeoutMs / 1000}s`))
      // A helper stuck inside one UI Automation call is no use for the next.
      if (child === c) stopHelper('the desktop helper was restarted after a stuck call')
    }, timeoutMs)
    pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer })
    c.stdin.write(`${JSON.stringify({ id, op, args })}\n`)
  })
}

/** Quit: end the helper. It would end anyway when its stdin closes. */
export function disposeDesktopHands(): void {
  stopHelper('Forge is closing')
}

process.once('exit', () => disposeDesktopHands())

/* ---------------------------------------------------------------- windows */

let lastList: HandsWindow[] = []
let lastRead: { hwnd: number; title: string; app: string } | null = null
let lastLook: { width: number; height: number } | null = null

/** Every titled window Steve can see, front first; Forge's own left out. */
export async function listWindows(): Promise<HandsWindow[]> {
  const rows = await ask<Array<Omit<HandsWindow, 'number'>>>('windows', { own: ownPids() })
  lastList = (Array.isArray(rows) ? rows : []).map((w, i) => ({
    number: i + 1,
    hwnd: Number(w.hwnd),
    pid: Number(w.pid),
    app: String(w.app ?? ''),
    title: String(w.title ?? ''),
    minimised: !!w.minimised
  }))
  return lastList
}

/** The top window that is not minimised — the app Steve was in. */
export async function frontWindow(): Promise<HandsWindow | null> {
  return (await listWindows()).find((w) => !w.minimised) ?? null
}

export function formatWindowList(list: HandsWindow[]): string {
  if (!list.length) return 'No windows are open apart from Forge.'
  return list.map((w) => `${w.number}. ${w.app} — ${w.title}${w.minimised ? ' (minimised)' : ''}`).join('\n')
}

/**
 * A window by what a caller said: a number from the last list, or words
 * matched against the title, then the app. Empty = `fallback`.
 */
async function resolveWindow(
  query: unknown,
  fallback: 'front' | 'last-read'
): Promise<{ hit: HandsWindow } | { error: string }> {
  const raw = typeof query === 'number' ? String(query) : typeof query === 'string' ? query.trim() : ''
  if (/^\d+$/.test(raw)) {
    const n = Number(raw)
    const list = lastList.length ? lastList : await listWindows()
    const hit = list.find((w) => w.number === n)
    if (!hit) return { error: `There is no window ${n} in the list. Call window_list again.` }
    // The list may be old; make sure that window still exists.
    const fresh = await listWindows()
    const still = fresh.find((w) => w.hwnd === hit.hwnd)
    return still ? { hit: still } : { error: `Window ${n} (${hit.title}) has closed. Call window_list again.` }
  }
  const list = await listWindows()
  if (raw) {
    const q = raw.toLowerCase()
    const hit = list.find((w) => w.title.toLowerCase().includes(q)) ?? list.find((w) => w.app.toLowerCase().includes(q))
    if (hit) return { hit }
    return { error: `No open window matches "${raw}". Open now:\n${formatWindowList(list.slice(0, 12))}` }
  }
  if (fallback === 'last-read' && lastRead) {
    const hit = list.find((w) => w.hwnd === lastRead?.hwnd)
    if (hit) return { hit }
  }
  const front = list.find((w) => !w.minimised)
  return front ? { hit: front } : { error: 'No window is open apart from Forge.' }
}

/* ------------------------------------------------------------------- look */

function stamp(d = new Date()): string {
  const p = (n: number, w = 2): string => String(n).padStart(w, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}-${p(d.getMilliseconds(), 3)}`
}

function pruneLooks(dir: string): void {
  try {
    const looks = readdirSync(dir)
      .filter((f) => /^look-.*\.png$/i.test(f))
      .sort()
      .reverse()
    for (const old of looks.slice(LOOKS_KEPT)) unlinkSync(join(dir, old))
  } catch {
    /* an old look left behind is harmless */
  }
}

/** Width and height from a PNG's IHDR, or null when it is not a PNG. */
export function pngSize(png: Buffer): { width: number; height: number } | null {
  if (png.length < 24 || png.readUInt32BE(0) !== 0x89504e47) return null
  return { width: png.readUInt32BE(16), height: png.readUInt32BE(20) }
}

/**
 * A picture somebody else took of the whole primary display (the voice
 * agent's take_screenshot): its size is what a later click by x,y is in.
 */
export function noteLook(width: number, height: number): void {
  if (width > 0 && height > 0) lastLook = { width, height }
}

/** Photograph the primary display to a file and say which app is in front. */
export async function look(): Promise<ScreenLookResult> {
  if (!deps.capture) return { ok: false, error: 'Screen capture is not available here.' }
  let shot: { png: Buffer; width: number; height: number } | null
  try {
    shot = await deps.capture()
  } catch (err) {
    return { ok: false, error: `The screen could not be captured: ${errText(err)}` }
  }
  if (!shot) return { ok: false, error: 'The screen could not be captured.' }
  const dir = join(deps.dataDir ?? join(tmpdir(), 'forge-desktop-hands'), 'screen-looks')
  const path = join(dir, `look-${stamp()}.png`)
  try {
    mkdirSync(dir, { recursive: true })
    writeFileSync(path, shot.png)
  } catch (err) {
    return { ok: false, error: `The screen look could not be saved: ${errText(err)}` }
  }
  pruneLooks(dir)
  noteLook(shot.width, shot.height)
  let front: { app: string; title: string } | null = null
  try {
    const w = await frontWindow()
    if (w) front = { app: w.app, title: w.title }
  } catch {
    /* the picture is still the answer */
  }
  return { ok: true, path, width: shot.width, height: shot.height, front }
}

/* ------------------------------------------------------------------- read */

interface ReadItem {
  n: number
  type: string
  name: string
  value: string | null
  flags: string[]
}

function quote(s: string, max = 80): string {
  const one = s.replace(/\s+/g, ' ').trim()
  return `"${one.length > max ? `${one.slice(0, max)}…` : one}"`
}

/** A window's controls as a numbered list. Brings nothing forward. */
export async function readWindow(args: { window?: unknown } = {}): Promise<HandsReply> {
  try {
    const target = await resolveWindow(args.window, 'front')
    if ('error' in target) return { ok: false, text: target.error }
    const w = target.hit
    const res = await ask<{ title: string; app: string; minimised: boolean; items: ReadItem[]; total: number }>('read', {
      hwnd: w.hwnd,
      max: READ_CAP
    })
    lastRead = { hwnd: w.hwnd, title: res.title || w.title, app: res.app || w.app }
    const items = Array.isArray(res.items) ? res.items : []
    const head = `${lastRead.app} — ${quote(lastRead.title, 120)}${res.minimised ? ' (minimised: restore it, or little shows)' : ''}`
    if (!items.length) {
      return {
        ok: true,
        text: `${head}\nNothing on screen in it can be clicked or typed into. For a browser page, read it again in a moment; otherwise call screen_look and look at the picture.`
      }
    }
    const lines = items.map((it) => {
      const value = it.value ? ` = ${quote(it.value, 60)}` : ''
      const flags = it.flags?.length ? ` (${it.flags.join(', ')})` : ''
      return `[${it.n}] ${it.type}${it.name ? ` ${quote(it.name)}` : ''}${value}${flags}`
    })
    const more = res.total > items.length ? `\n…and ${res.total - items.length} more not listed.` : ''
    return {
      ok: true,
      text: `${head}\n${lines.join('\n')}${more}\nThese numbers last until the window changes; read again after every click or form step.`
    }
  } catch (err) {
    return { ok: false, text: `Could not read that window: ${errText(err)}` }
  }
}

/* ------------------------------------------------------------------ hands */

function refOf(value: unknown): number {
  const n = typeof value === 'number' ? value : typeof value === 'string' && /^\s*\d+\s*$/.test(value) ? Number(value) : NaN
  return Number.isInteger(n) && n > 0 ? n : 0
}

/** Click a numbered control from the last read, or a point in the last look's picture. */
export async function click(args: { ref?: unknown; x?: unknown; y?: unknown }): Promise<HandsReply> {
  try {
    const ref = refOf(args.ref)
    if (ref) return { ok: true, text: await ask<string>('click_ref', { ref }) }
    const x = Number(args.x)
    const y = Number(args.y)
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      return { ok: false, text: 'Nothing was clicked: give ref (a number from window_read), or x and y from the last screen look.' }
    }
    if (!lastLook) return { ok: false, text: 'Nothing was clicked: take a screen look first, then give x and y in that picture.' }
    if (x < 0 || y < 0 || x >= lastLook.width || y >= lastLook.height) {
      return { ok: false, text: `Nothing was clicked: ${x},${y} is outside the last look, which is ${lastLook.width}×${lastLook.height}.` }
    }
    const screen = await ask<{ width: number; height: number }>('screen')
    const sx = Math.round((x * screen.width) / lastLook.width)
    const sy = Math.round((y * screen.height) / lastLook.height)
    return { ok: true, text: await ask<string>('click_xy', { x: sx, y: sy, own: ownPids() }) }
  } catch (err) {
    return { ok: false, text: `Nothing was clicked: ${errText(err)}` }
  }
}

/** Type into a numbered control (its value is replaced), or where the cursor is in the last-read or front window. */
export async function type(args: { ref?: unknown; text?: unknown; enter?: unknown }): Promise<HandsReply> {
  try {
    const text = typeof args.text === 'string' ? args.text : ''
    const enter = args.enter === true
    if (!text && !enter) return { ok: false, text: 'Nothing was typed: give text, or enter: true.' }
    const ref = refOf(args.ref)
    let hwnd = 0
    if (!ref) {
      const target = await resolveWindow(undefined, 'last-read')
      if ('error' in target) return { ok: false, text: target.error }
      hwnd = target.hit.hwnd
    }
    const said = await ask<string>('type', { ref, hwnd, text, enter })
    return { ok: !/password box|refused|would not|gone/i.test(said), text: said }
  } catch (err) {
    return { ok: false, text: `Nothing was typed: ${errText(err)}` }
  }
}

const NAMED_KEYS: Record<string, number> = {
  tab: 0x09,
  enter: 0x0d,
  return: 0x0d,
  escape: 0x1b,
  esc: 0x1b,
  space: 0x20,
  backspace: 0x08,
  delete: 0x2e,
  del: 0x2e,
  insert: 0x2d,
  home: 0x24,
  end: 0x23,
  pageup: 0x21,
  pgup: 0x21,
  pagedown: 0x22,
  pgdn: 0x22,
  left: 0x25,
  arrowleft: 0x25,
  up: 0x26,
  arrowup: 0x26,
  right: 0x27,
  arrowright: 0x27,
  down: 0x28,
  arrowdown: 0x28
}

export interface KeyChord {
  vk: number
  ctrl: boolean
  shift: boolean
  alt: boolean
}

/**
 * "Tab Tab Enter", "Ctrl+A", "Shift+Tab, Enter" → key chords. Ctrl, Shift and
 * Alt only — no Windows key, so nothing here can lock the PC or open Run.
 */
export function parseKeys(keys: string): { chords: KeyChord[] } | { error: string } {
  const tokens = keys.split(/[\s,]+/).filter(Boolean)
  if (!tokens.length) return { error: 'No keys were given.' }
  if (tokens.length > 30) return { error: 'That is more than 30 keys; send them in smaller steps.' }
  const chords: KeyChord[] = []
  for (const token of tokens) {
    const parts = token.split('+').map((p) => p.trim().toLowerCase())
    const name = parts.pop() ?? ''
    const chord: KeyChord = { vk: 0, ctrl: false, shift: false, alt: false }
    for (const mod of parts) {
      if (mod === 'ctrl' || mod === 'control') chord.ctrl = true
      else if (mod === 'shift') chord.shift = true
      else if (mod === 'alt') chord.alt = true
      else return { error: `"${mod}" in "${token}" is not a key this can hold. Use Ctrl, Shift or Alt.` }
    }
    if (/^[a-z]$/.test(name)) chord.vk = name.toUpperCase().charCodeAt(0)
    else if (/^[0-9]$/.test(name)) chord.vk = name.charCodeAt(0)
    else if (/^f([1-9]|1[0-2])$/.test(name)) chord.vk = 0x6f + Number(name.slice(1))
    else if (NAMED_KEYS[name] !== undefined) chord.vk = NAMED_KEYS[name] as number
    else return { error: `"${token}" is not a key this knows. Use Tab, Enter, Escape, Space, Backspace, Delete, Home, End, PageUp, PageDown, arrows (Up, Down, Left, Right), F1–F12, letters and digits, with Ctrl+, Shift+ or Alt+.` }
    chords.push(chord)
  }
  return { chords }
}

/** Press keys in a named window, or the last-read or front one. */
export async function key(args: { keys?: unknown; window?: unknown }): Promise<HandsReply> {
  try {
    const parsed = parseKeys(typeof args.keys === 'string' ? args.keys : '')
    if ('error' in parsed) return { ok: false, text: `No keys were pressed: ${parsed.error}` }
    const target = await resolveWindow(args.window, 'last-read')
    if ('error' in target) return { ok: false, text: target.error }
    const said = await ask<string>('keys', { hwnd: target.hit.hwnd, keys: parsed.chords })
    return { ok: !/refused|would not/i.test(said), text: said }
  } catch (err) {
    return { ok: false, text: `No keys were pressed: ${errText(err)}` }
  }
}
