import { Terminal, type ITheme } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import type { PtyDataEvent, PtyExitEvent } from '@shared/types'
import { findRemoteSessionUrl } from '@shared/remote'
import { commandExe } from '@shared/agents'
import { SHARE_CAPTURE_DEFAULT_LINES } from '@shared/share'
import { advanceDraft, clampDraft } from './draft'
import { joinBufferRows, tidyCapture, type BufferRow } from './paneText'
import { earconTaskAttention, earconTaskDone } from './earcon'
import { getLiveSettings } from './livesettings'

/**
 * TerminalHost — the renderer-side owner of every xterm instance.
 *
 * Why a module-level singleton rather than React state: panes must survive
 * being unmounted. Switching project switches the whole terminal workspace,
 * but those shells keep running in the background and their scrollback must
 * still be there when you switch back. So the xterm instance and its DOM
 * wrapper live here, and React components merely *attach* a wrapper into their
 * container. A terminal is only destroyed when its pane is really closed.
 */

export type PaneStatus = 'idle' | 'starting' | 'live' | 'exited' | 'error'

export interface PaneRuntime {
  status: PaneStatus
  pid: number | null
  exitCode: number | null
  error: string | null
  /**
   * The claude.ai/code URL for this pane's Remote Control session, once Claude
   * has printed it. Null until then — and for every pane that is not a
   * remote-controlled Claude session.
   */
  remoteUrl: string | null
  /**
   * True while a phone has this pane open and is therefore the one deciding
   * its size. The pane still works normally at the desk — this is a fact worth
   * showing (the terminal is letterboxed at phone width, which otherwise reads
   * as a bug), not a lock.
   */
  phone: boolean
  /**
   * The same fact about a browser on Forge Web. Two flags rather than one
   * because both can be true at once and the pane says which — a terminal
   * drawn at somebody else's width is only reassuring if the label names the
   * screen it is being drawn for.
   */
  browser: boolean
}

export interface TerminalSpec {
  cwd: string
  bootstrapCommand: string
  fontSize: number
  fontFamily: string
  /** Profile accent — used for the cursor and selection wash. */
  accent: string
  /**
   * What this pane is, in words. Sent to the main process purely so the
   * bootstrap transforms can name things after it — today that is the Remote
   * Control session name Steve's phone shows.
   */
  projectName: string
  paneTitle: string
  /**
   * The pane's saved Claude session id. Passed straight through to the main
   * process, which decides whether it means "claim this id" or "resume it" —
   * see electron/bridge/claude-session.ts. Absent for a pane whose layout entry
   * somehow has none; the launch is then exactly what it always was.
   */
  sessionId?: string
  /**
   * `false` opts the pane out of Remote Control (see CreateSessionRequest).
   * The planner sets it: its plans are read out of the local transcript, which
   * a bridged session never writes.
   */
  remoteControl?: false
  /**
   * The project's GitHub remote, passed to the main process so the pane is
   * spawned with `FORGE_REPO_URL` set. Absent for a project that has no URL
   * recorded yet — the main process then asks git about the cwd itself.
   */
  repoUrl?: string
}

/**
 * How a terminal is currently being shown.
 *
 * `tab`  full size in a pane: the container drives the geometry, so the PTY is
 *        refitted whenever the container changes.
 * `peek` a mosaic tile: the terminal keeps the cols/rows it already had and the
 *        *view* is shrunk with a CSS transform instead. Nothing is refitted, so
 *        a full-screen TUI never reflows just because you glanced at it.
 */
type PaneMode = 'tab' | 'peek'

/** The pixel size a terminal was last laid out at while in `tab` mode. */
export interface PaneGeometry {
  width: number
  height: number
}

const IDLE_RUNTIME: PaneRuntime = {
  status: 'idle',
  pid: null,
  exitCode: null,
  error: null,
  remoteUrl: null,
  phone: false,
  browser: false
}

/**
 * How much of the previous chunk to re-scan for the Remote Control URL. PTY
 * output arrives in arbitrary slices, so the URL can straddle two of them; a
 * short overlap costs nothing and means we never miss it by one byte.
 */
const URL_SCAN_OVERLAP = 256

const ACTIVITY_THROTTLE_MS = 90

/**
 * What separates "a shell said something" from "an agent is working".
 *
 * A keystroke echo is one chunk and then silence. An agent thinking is a
 * spinner repainting ten times a second for as long as it takes. So busy is a
 * *run* of output, not a byte of it: ONSET is how long the run has to keep
 * going before it counts, GAP is how big a hole ends the run and starts a new
 * one, and QUIET is how long the silence must last before the pane goes back to
 * idle. The numbers are deliberately slow — this drives a light on the project
 * rail, and a light that flickers as you type is worse than no light.
 */
const BUSY_ONSET_MS = 600
const BUSY_GAP_MS = 400
const BUSY_QUIET_MS = 1200

/** "1. Yes", "❯ 2. No", "(3) Skip" — one option in a prompt's list of them. */
const CHOICE_LINE = /^[❯>▶●•*\s]*\(?\d+[.)]\s+\S/

/**
 * Drop the border a TUI draws around a prompt, so the text inside reads as
 * ordinary lines. A row that was nothing but border comes back empty and is
 * skipped by the caller.
 */
function stripBoxDrawing(line: string): string {
  return line.replace(/[─-╿▀-▟]/g, ' ').trim()
}

/**
 * How long the geometry must hold still before ConPTY is told about it.
 *
 * xterm itself is refitted on every observation — the picture has to track the
 * drag — but the *PTY* is not. Dragging a window edge fires the observer dozens
 * of times a second, and each resize makes ConPTY reflow its buffer while the
 * TUI inside is repainting its live region: the two interleave and the screen
 * comes out overlapped and duplicated. One resize, once the pointer stops.
 */
const RESIZE_SETTLE_MS = 200

/** Gap between the short size and the true one in the repaint jiggle. */
const REDRAW_JIGGLE_MS = 60

/**
 * Geometry handed to a pane that has never been laid out at full size — only
 * reachable by opening a project straight into the mosaic. Roughly the classic
 * 80×24 at our default type size, which is both a sane width for a shell's
 * first prompt and close enough to a real pane that the wall does not end up
 * visibly two-tier.
 */
export const DEFAULT_PANE_GEOMETRY: PaneGeometry = { width: 640, height: 400 }

/**
 * The terminal answering a question, as opposed to a person typing.
 *
 * A TUI probes its terminal as it starts — "what are you?", "where is the
 * cursor?", "what is palette slot 4?" — and xterm replies down the very same
 * `onData` channel a keystroke takes, because to the PTY they are both input.
 * They are not typing, though, and the typed-draft tracker must not count them:
 * "Take back typed" erases one backspace per character, and a draft holding
 * bytes Steve never pressed would fire backspaces at a prompt on their behalf.
 *
 * Told apart by their opening bytes rather than by parsing them. No key on any
 * keyboard sends a DCS, OSC, APC, PM or SOS string, and none sends a CSI ending
 * in one of the report finals below — the arrows, the function keys and
 * shift-tab all end in something else. So everything a keyboard can actually
 * produce, bracketed paste included, still goes to advanceDraft, which already
 * models it (see lib/draft.ts).
 *
 * Half of this is belt and braces: advanceDraft skips a CSI or SS3 whole, so
 * the Device Attributes reply never reached the draft anyway. The string forms
 * did — `\x1b]4;1;rgb:…\x1b\\` reads to that parser as an Alt+] chord followed
 * by a dozen printable characters — and they are the leak this closes.
 */
const REPORT_RESPONSE = /^(?:\x1b[P\]_^X]|\x1b\[[?>=<]?[0-9;]*(?:\$?[cnRty]|[IOMm]))/

interface Entry {
  paneId: string
  term: Terminal
  fit: FitAddon
  wrapper: HTMLDivElement
  spec: TerminalSpec
  runtime: PaneRuntime
  container: HTMLElement | null
  mode: PaneMode
  /** Last full-size layout, remembered so a peek tile can scale against it. */
  geometry: PaneGeometry | null
  resizeObserver: ResizeObserver | null
  /** The size xterm has settled on but ConPTY has not been told about yet. */
  pendingResize: { cols: number; rows: number } | null
  resizeTimer: number | null
  /** The last size actually sent down the PTY, so a no-op never jiggles. */
  ptyDims: { cols: number; rows: number } | null
  /** Pending second half of a repaint jiggle — see resizePty. */
  jiggleTimer: number | null
  /**
   * A phone or a browser has this pane open, so that viewer owns the geometry —
   * see setPhoneWatched and setBrowserWatched. While true, nothing here refits
   * the terminal or resizes the PTY; the pane follows what the viewer asked for
   * instead, and when both are reading it, the smaller of the two.
   */
  viewerOwned: boolean
  /** Tail of the last output chunk, kept only until the RC URL is found. */
  scanTail: string
  /**
   * What has been typed into this pane since the last Enter — the draft the
   * program's line editor is holding. Reconstructed from the keystroke stream
   * (see trackTyped), so cursor-movement keys make it approximate; that is
   * fine, because its one consumer erases with backspaces, and a backspace at
   * an empty prompt is a no-op in every shell and agent we launch.
   */
  typed: string
  lastActivityNotify: number
  activityTimer: number | null
  /** True while this pane counts as working — see the BUSY_* constants. */
  busy: boolean
  /** True when settled output looks like a question or approval prompt. */
  attention: boolean
  /** When the current unbroken run of output began. */
  busyRunStart: number
  /** When the last chunk arrived, so a gap can be measured. */
  busyLastOutput: number
  busyTimer: number | null
  /** The WebGL renderer, when this terminal currently has one. */
  webgl: { dispose(): void } | null
  webglWanted: boolean
  webglLoading: boolean
  disposers: Array<() => void>
}

interface Listeners {
  runtime: Set<(r: PaneRuntime) => void>
  activity: Set<() => void>
}

/**
 * The palette comes off the design tokens rather than being written twice.
 * Read once (a getComputedStyle call is not free) and cached — the tokens only
 * move when the theme does, and `refreshTheme()` below is what tells us.
 */
let paletteCache: Record<string, string> | null = null

const TERM_TOKENS = [
  'bg',
  'fg',
  'cursor-accent',
  'selection',
  'black',
  'red',
  'green',
  'yellow',
  'blue',
  'magenta',
  'cyan',
  'white',
  'bright-black',
  'bright-red',
  'bright-green',
  'bright-yellow',
  'bright-blue',
  'bright-magenta',
  'bright-cyan',
  'bright-white'
] as const

/** Fallbacks only matter if tokens.css failed to load at all. */
const TERM_FALLBACK = '#e8eaed'

function palette(): Record<string, string> {
  if (paletteCache) return paletteCache
  const style = getComputedStyle(document.documentElement)
  const out: Record<string, string> = {}
  for (const token of TERM_TOKENS) {
    out[token] = style.getPropertyValue(`--term-${token}`).trim() || TERM_FALLBACK
  }
  paletteCache = out
  return out
}

/**
 * Per-pane text colour, set by the tab that owns the pane — see
 * `setForeground`. A module-level map rather than a field on the entry because
 * a colour can be chosen for a pane that has not been attached yet (a fresh
 * split in an already-coloured tab), and it has to be waiting when it is.
 */
const foregrounds = new Map<string, string>()

/**
 * A complete 16-colour dark theme. Handing xterm every slot explicitly is what
 * lets a TUI that probes the terminal (Claude Code does) see a dark background
 * and pick its dark theme, instead of defaulting to white.
 *
 * `foreground` overrides the theme's default text colour only. Output that
 * names its own ANSI colour still gets it — recolouring those sixteen slots as
 * well would not tint an agent's output, it would erase its syntax highlighting.
 */
function baseTheme(accent: string, foreground?: string): ITheme {
  const p = palette()
  return {
    background: p['bg']!,
    foreground: foreground ?? p['fg']!,
    cursor: accent,
    cursorAccent: p['cursor-accent']!,
    selectionBackground: p['selection']!,
    selectionForeground: undefined,
    black: p['black']!,
    red: p['red']!,
    green: p['green']!,
    yellow: p['yellow']!,
    blue: p['blue']!,
    magenta: p['magenta']!,
    cyan: p['cyan']!,
    white: p['white']!,
    brightBlack: p['bright-black']!,
    brightRed: p['bright-red']!,
    brightGreen: p['bright-green']!,
    brightYellow: p['bright-yellow']!,
    brightBlue: p['bright-blue']!,
    brightMagenta: p['bright-magenta']!,
    brightCyan: p['bright-cyan']!,
    brightWhite: p['bright-white']!
  }
}

/**
 * A watch list off the wire, as a map this host can ask questions of.
 *
 * The dimension guard is why this is a function rather than a `new Map`: main
 * reports what the PTY *is*, but a session that has just been created and never
 * resized, or one read by a client that sent nonsense, can still arrive as a
 * zero — and a terminal resized to zero columns is a pane that draws nothing at
 * all. A pane with an unusable size is treated as one nobody is reading, which
 * leaves the desk fitting it as normal.
 */
function asWatchMap(
  panes: Array<{ id: string; cols: number; rows: number }>
): Map<string, { cols: number; rows: number }> {
  const map = new Map<string, { cols: number; rows: number }>()
  for (const pane of panes) {
    if (pane.cols > 0 && pane.rows > 0) map.set(pane.id, { cols: pane.cols, rows: pane.rows })
  }
  return map
}

class TerminalHost {
  private entries = new Map<string, Entry>()
  private listeners = new Map<string, Listeners>()
  /**
   * "Something, somewhere, changed busy state." One set for the whole app
   * rather than one per pane: the flag only moves on a 600ms onset and a 1.2s
   * quiet, so the callers can afford to re-read whichever panes they care
   * about — and what a project rail row cares about changes every time a tab
   * is split.
   */
  private busyListeners = new Set<() => void>()
  private attentionListeners = new Set<() => void>()
  /**
   * Panes a phone is reading, and the size it is reading them at. Kept even
   * for panes with no entry yet, because the phone can ask for a tab that this
   * host is about to create — see `create`.
   */
  private phoneWatched = new Map<string, { cols: number; rows: number }>()
  /**
   * The same, for browsers on Forge Web. A second map rather than a second
   * source writing into the first: each viewer sends its whole list on every
   * change (an empty one is how it hands its panes back), so merging them on
   * arrival would mean a browser's silence looking exactly like a phone
   * leaving. `watchedSize` is where the two are read together.
   */
  private browserWatched = new Map<string, { cols: number; rows: number }>()
  private wired = false

  /* ----------------------------------------------------------- plumbing */

  private wire(): void {
    if (this.wired) return
    this.wired = true

    window.forge.pty.onData((e: PtyDataEvent) => {
      const entry = this.entries.get(e.id)
      if (!entry) return
      entry.term.write(e.data)
      if (entry.runtime.status === 'starting') this.setRuntime(entry, { status: 'live' })
      this.scanForRemoteUrl(entry, e.data)
      this.pulse(entry)
      this.markOutput(entry)
    })

    window.forge.pty.onExit((e: PtyExitEvent) => {
      const entry = this.entries.get(e.id)
      if (!entry) return
      entry.term.write(
        `\r\n\x1b[38;2;106;112;120m── session ended (exit ${e.exitCode}) ─ press Enter to relaunch\x1b[0m\r\n`
      )
      this.setRuntime(entry, { status: 'exited', exitCode: e.exitCode, pid: null })
      // A dead shell is not working, whatever it was doing a moment ago.
      this.clearBusy(entry)
      this.chimeOnExit(e.exitCode)
    })
  }

  /**
   * The little "your task is over" blip. Two rules and no more: it only plays
   * when Forge is not the focused window (a chime is for the moment you were
   * looking at something else), and the direction carries the news — up for a
   * clean exit, down for anything that ended badly. Fires and forgets; the
   * earcon returns immediately and nothing here waits on it.
   */
  private chimeOnExit(exitCode: number): void {
    if (getLiveSettings()?.terminalExitChime === false) return
    if (document.hasFocus()) return
    if (exitCode === 0) earconTaskDone()
    else earconTaskAttention()
  }

  private listenersFor(paneId: string): Listeners {
    let l = this.listeners.get(paneId)
    if (!l) {
      l = { runtime: new Set(), activity: new Set() }
      this.listeners.set(paneId, l)
    }
    return l
  }

  private setRuntime(entry: Entry, patch: Partial<PaneRuntime>): void {
    entry.runtime = { ...entry.runtime, ...patch }
    const l = this.listeners.get(entry.paneId)
    if (l) for (const cb of l.runtime) cb(entry.runtime)
  }

  /**
   * Watch a pane's output for the URL Claude prints when Remote Control
   * connects, so the pane's phone popover can deep-link to *that* session.
   *
   * Reading the terminal is the whole trick: the id is not in the environment
   * Forge can see and there is no IPC for it, but Claude announces it on screen
   * — and Forge is the terminal. Nothing is written to the user's hooks or
   * settings, and the scan stops the moment it finds one.
   */
  private scanForRemoteUrl(entry: Entry, data: string): void {
    if (entry.runtime.remoteUrl) return
    const found = findRemoteSessionUrl(entry.scanTail + data)
    if (found) {
      entry.scanTail = ''
      this.setRuntime(entry, { remoteUrl: found })
      return
    }
    entry.scanTail = (entry.scanTail + data).slice(-URL_SCAN_OVERLAP)
  }

  private pulse(entry: Entry): void {
    const now = performance.now()
    const l = this.listeners.get(entry.paneId)
    if (!l || l.activity.size === 0) return
    if (now - entry.lastActivityNotify >= ACTIVITY_THROTTLE_MS) {
      entry.lastActivityNotify = now
      for (const cb of l.activity) cb()
      return
    }
    // Coalesce a burst into one trailing notification.
    if (entry.activityTimer !== null) return
    entry.activityTimer = window.setTimeout(() => {
      entry.activityTimer = null
      entry.lastActivityNotify = performance.now()
      const live = this.listeners.get(entry.paneId)
      if (live) for (const cb of live.activity) cb()
    }, ACTIVITY_THROTTLE_MS)
  }

  /* --------------------------------------------------------------- busy */

  /**
   * Fold one chunk of output into the pane's busy state.
   *
   * The run is extended while chunks keep arriving within BUSY_GAP_MS of each
   * other; once that run is BUSY_ONSET_MS old the pane is working. A single
   * timer, rearmed on every chunk, is what calls it idle again — so silence
   * ends the run without anything having to poll for it.
   */
  private markOutput(entry: Entry): void {
    const now = performance.now()
    if (now - entry.busyLastOutput > BUSY_GAP_MS) entry.busyRunStart = now
    entry.busyLastOutput = now

    if (entry.busyTimer !== null) clearTimeout(entry.busyTimer)
    entry.busyTimer = window.setTimeout(() => {
      entry.busyTimer = null
      this.settle(entry)
    }, BUSY_QUIET_MS)

    if (!entry.busy && now - entry.busyRunStart >= BUSY_ONSET_MS) this.setBusy(entry, true)
  }

  private setBusy(entry: Entry, busy: boolean): void {
    if (entry.busy === busy) return
    entry.busy = busy
    // Output means the agent is talking, not waiting; whatever it asked is stale.
    if (busy) this.setAttention(entry, false)
    for (const cb of this.busyListeners) cb()
  }

  /**
   * The pane has gone quiet: stop calling it busy, and decide whether the last
   * thing on screen is a question aimed at the user.
   *
   * This runs on *every* quiet timeout rather than only on a busy-to-idle edge.
   * A permission prompt is often printed in one short burst that never lasts
   * BUSY_ONSET_MS, so the pane was never marked busy — and an attention check
   * hung off the busy edge would never look at exactly the prompts that matter
   * most.
   */
  private settle(entry: Entry): void {
    this.setBusy(entry, false)
    this.setAttention(entry, entry.runtime.status !== 'exited' && this.looksLikeWaiting(entry))
  }

  /**
   * Conservative fallback for CLIs that do not expose a waiting-state event.
   *
   * Three shapes cover what agents actually leave on screen when they stop for
   * an answer: a line that ends in a question mark, a menu of numbered choices
   * (Claude Code's permission box, which draws its question inside a border and
   * then lists options, so the *last* line is never the question), and the
   * classic y/n prompt. Box-drawing characters are stripped first so a bordered
   * prompt reads the same as an unbordered one.
   */
  private looksLikeWaiting(entry: Entry): boolean {
    const buffer = entry.term.buffer.active
    const lines: string[] = []
    const start = Math.max(0, buffer.length - 30)
    for (let y = start; y < buffer.length; y++) {
      const text = stripBoxDrawing(buffer.getLine(y)?.translateToString(true) ?? '')
      if (text) lines.push(text)
    }
    const tail = lines.slice(-10)
    if (tail.length === 0) return false

    if (tail.some((line) => /[?？]\s*$/.test(line))) return true
    if (tail.filter((line) => CHOICE_LINE.test(line)).length >= 2) return true
    return tail.some((line) =>
      /\b(?:yes\/no|y\/n|allow|deny|approve|confirm|continue|proceed|overwrite)\b\s*[:?]?\s*$/i.test(
        line
      )
    )
  }

  private setAttention(entry: Entry, attention: boolean): void {
    if (entry.attention === attention) return
    entry.attention = attention
    for (const cb of this.attentionListeners) cb()
  }

  private clearBusy(entry: Entry): void {
    if (entry.busyTimer !== null) {
      clearTimeout(entry.busyTimer)
      entry.busyTimer = null
    }
    this.setBusy(entry, false)
    this.setAttention(entry, false)
  }

  /** True while this pane is sustainedly printing — an agent mid-thought. */
  isBusy(paneId: string): boolean {
    return this.entries.get(paneId)?.busy ?? false
  }

  anyBusy(paneIds: Iterable<string>): boolean {
    for (const id of paneIds) if (this.isBusy(id)) return true
    return false
  }

  subscribeBusy(cb: () => void): () => void {
    this.busyListeners.add(cb)
    return () => {
      this.busyListeners.delete(cb)
    }
  }

  subscribeAttention(cb: () => void): () => void {
    this.attentionListeners.add(cb)
    return () => this.attentionListeners.delete(cb)
  }

  isAttention(paneId: string): boolean {
    return this.entries.get(paneId)?.attention ?? false
  }

  anyAttention(paneIds: Iterable<string>): boolean {
    for (const id of paneIds) if (this.isAttention(id)) return true
    return false
  }

  /* ---------------------------------------------------------- lifecycle */

  /**
   * Attach pane `paneId` into `container` at full size, creating the terminal
   * (and its PTY session) on first call. Safe to call repeatedly.
   */
  attach(paneId: string, container: HTMLElement, spec: TerminalSpec): void {
    this.wire()
    let entry = this.entries.get(paneId)

    if (!entry) {
      entry = this.create(paneId, spec)
      this.entries.set(paneId, entry)
      container.appendChild(entry.wrapper)
      entry.container = container
      entry.mode = 'tab'
      entry.term.open(entry.wrapper)
      this.setWebgl(paneId, true)
      this.observe(entry, container)
      // Size against the real container before spawning, so the shell's very
      // first prompt is already the right width.
      this.fit(paneId)
      void this.start(entry)
      return
    }

    const existing = entry
    existing.mode = 'tab'
    const moved = existing.container !== container
    if (moved) {
      container.appendChild(existing.wrapper)
      existing.container = container
    }
    // Re-observe whenever there is no live observer, not only when the box
    // changed: a peek attach drops the observer (see attachPeek) without
    // clearing the container, so "same container" is not proof of "still
    // watched" — and a tab-mode pane that nothing watches never refits again.
    if (moved || !existing.resizeObserver) this.observe(existing, container)
    this.setWebgl(paneId, true)
    requestAnimationFrame(() => {
      this.fit(paneId)
      existing.term.refresh(0, existing.term.rows - 1)
    })
  }

  /**
   * Attach pane `paneId` into a fixed-size box for a mosaic tile.
   *
   * `container` must already be `geometry` pixels big: the terminal is laid out
   * at its natural size inside it and the *caller* shrinks the box with a CSS
   * transform. Nothing here observes the box or refits, so cols/rows — and
   * therefore any TUI drawing itself into them — are left completely alone.
   *
   * "Already" is literal, and it bites hardest on the first call: a pane being
   * created here is fitted against this box and its shell spawned at whatever
   * that measures. A container still sitting at 0×0 fails the fit's own sanity
   * check, spawns the agent at xterm's default 80×24, and the true size then
   * lands a frame later as a reflow straight through the agent's first paint.
   * MosaicTile writes the pixels before it attaches for exactly that reason.
   */
  attachPeek(paneId: string, container: HTMLElement, spec: TerminalSpec): void {
    this.wire()
    const existing = this.entries.get(paneId)

    if (!existing) {
      const entry = this.create(paneId, spec)
      this.entries.set(paneId, entry)
      container.appendChild(entry.wrapper)
      entry.container = container
      entry.mode = 'peek'
      entry.term.open(entry.wrapper)
      this.fit(paneId)
      void this.start(entry)
      return
    }

    existing.mode = 'peek'
    // A peek surface never resizes its terminal, so drop the observer that
    // would otherwise refit it the moment the tile is measured.
    existing.resizeObserver?.disconnect()
    existing.resizeObserver = null
    if (existing.container !== container) {
      container.appendChild(existing.wrapper)
      existing.container = container
    }
    // Re-parenting drops DOM focus; make xterm agree, so a peek tile can never
    // quietly swallow keystrokes.
    existing.term.blur()
    requestAnimationFrame(() => existing.term.refresh(0, existing.term.rows - 1))
  }

  /**
   * The size a mosaic tile should lay this terminal out at: whatever it last
   * measured at full size, or a sane default for one it has never shown.
   */
  geometryFor(paneId: string): PaneGeometry {
    return this.entries.get(paneId)?.geometry ?? DEFAULT_PANE_GEOMETRY
  }

  /** True while a full-screen TUI (vim, htop, an agent) owns the screen. */
  isAltBuffer(paneId: string): boolean {
    return this.entries.get(paneId)?.term.buffer.active.type === 'alternate'
  }

  /**
   * The last `lines` lines of a pane, as text. Null for a pane this window has no
   * terminal for.
   *
   * This is what "Capture pane" reads, and reading it *here* rather than from
   * main's replay buffer is the whole point. The replay buffer is a byte stream of
   * cursor-addressed redraws; every agent CLI is a full-screen TUI, so stripping
   * the escapes out of it yields half-overwritten rows in the order they were
   * painted. This object already parsed those exact bytes into a grid.
   *
   * Works for a pane in another tab or in the mosaic: `detach()` keeps the Entry
   * and its Terminal alive, and only `dispose()` removes them. For an agent the
   * active buffer *is* the alternate buffer, so what comes back is what is on
   * screen — which is what capture means. For a shell it is the tail of a
   * 20,000-line scrollback.
   *
   * `isWrapped` is the detail that matters: a soft-wrapped 300-character line is
   * three rows, and joining those with newlines would turn one sentence into
   * three. See src/lib/paneText.ts.
   */
  snapshotText(paneId: string, lines: number): string | null {
    const entry = this.entries.get(paneId)
    if (!entry) return null

    const buffer = entry.term.buffer.active
    const want = Number.isFinite(lines) && lines > 0 ? Math.floor(lines) : SHARE_CAPTURE_DEFAULT_LINES
    // Rows, not lines: a wrapped line is several rows, so over-reading here is
    // what makes `want` lines actually arrive after joinBufferRows has folded
    // them back together. tidyCapture applies the real limit.
    const rows: BufferRow[] = []
    const start = Math.max(0, buffer.length - want * 2)
    for (let y = start; y < buffer.length; y++) {
      const line = buffer.getLine(y)
      if (!line) continue
      rows.push({ text: line.translateToString(true), wrapped: line.isWrapped })
    }
    return tidyCapture(joinBufferRows(rows), want)
  }

  detach(paneId: string): void {
    const entry = this.entries.get(paneId)
    if (!entry) return
    entry.resizeObserver?.disconnect()
    entry.resizeObserver = null
    if (entry.wrapper.parentElement) entry.wrapper.parentElement.removeChild(entry.wrapper)
    entry.container = null
  }

  private create(paneId: string, spec: TerminalSpec): Entry {
    const wrapper = document.createElement('div')
    wrapper.className = 'terminal-surface'
    wrapper.dataset['paneId'] = paneId

    const term = new Terminal({
      allowProposedApi: true,
      cursorBlink: true,
      cursorStyle: 'bar',
      // xterm's default for a terminal without keyboard focus is a hollow
      // block, which reads as "this pane is broken" rather than "this pane is
      // not listening" — and is the square Steve kept finding after clicking
      // away and back. A bar either way: focused it blinks, unfocused it sits
      // still, so the shape never changes and the blink carries the state.
      cursorInactiveStyle: 'bar',
      cursorWidth: 2,
      fontFamily: spec.fontFamily,
      fontSize: spec.fontSize,
      lineHeight: 1.24,
      letterSpacing: 0,
      drawBoldTextInBrightColors: true,
      minimumContrastRatio: 1.1,
      scrollback: 20000,
      smoothScrollDuration: 0,
      convertEol: false,
      macOptionIsMeta: false,
      windowsPty: { backend: 'conpty' },
      theme: baseTheme(spec.accent, foregrounds.get(paneId))
    })

    const fit = new FitAddon()
    term.loadAddon(fit)

    const entry: Entry = {
      paneId,
      term,
      fit,
      wrapper,
      spec,
      runtime: {
        ...IDLE_RUNTIME,
        phone: this.phoneWatched.has(paneId),
        browser: this.browserWatched.has(paneId)
      },
      container: null,
      mode: 'tab',
      geometry: null,
      resizeObserver: null,
      pendingResize: null,
      resizeTimer: null,
      ptyDims: null,
      jiggleTimer: null,
      // A pane can be created while a phone or a browser is already reading it —
      // that viewer asked for the tab, and the desktop is building it. It must
      // be born owned, or the very first fit takes the geometry straight back.
      viewerOwned: this.watchedSize(paneId) !== null,
      scanTail: '',
      typed: '',
      lastActivityNotify: 0,
      activityTimer: null,
      busy: false,
      attention: false,
      busyRunStart: 0,
      busyLastOutput: 0,
      busyTimer: null,
      webgl: null,
      webglWanted: false,
      webglLoading: false,
      disposers: []
    }

    const dataSub = term.onData((data) => {
      if (entry.runtime.status === 'exited') {
        // Enter in a dead pane relaunches it — matches the hint printed on exit.
        if (data === '\r' || data === '\n') void this.restart(paneId)
        return
      }
      this.setAttention(entry, false)
      // A reply xterm composed itself is still sent — the program asked for it —
      // but it is not part of what was typed. See REPORT_RESPONSE.
      if (!REPORT_RESPONSE.test(data)) entry.typed = advanceDraft(entry.typed, data)
      window.forge.pty.write(paneId, data)
    })
    entry.disposers.push(() => dataSub.dispose())

    // Not sent straight down: xterm resizes with the drag, ConPTY waits for it
    // to finish. See queuePtyResize.
    const resizeSub = term.onResize(({ cols, rows }) => {
      this.queuePtyResize(entry, cols, rows)
    })
    entry.disposers.push(() => resizeSub.dispose())

    /*
     * opencode (the DeepSeek V4 pane) is a full-screen TUI on the alternate
     * screen. Unlike Claude Code, which writes into the normal buffer so the
     * terminal's own scrollback scrolls under the wheel, it takes the alternate
     * screen — which keeps no scrollback — and enables every mouse tracking
     * mode (DECSET 1000/1002/1003 + SGR 1006, verified against 1.18.11), so
     * the wheel stops meaning "scroll the terminal" and is handed to the
     * program as a mouse report.
     *
     * There used to be a wheel→PgUp workaround here, written against an older
     * opencode that dropped those wheel reports on the floor. Since at least
     * 1.18.11 it scrolls its message viewport from them (a few lines per
     * notch, verified end-to-end through ConPTY), so the right thing is to
     * stay out of the way and let xterm deliver the reports the TUI asked
     * for — exactly what vim and htop already get. Intercepting here would
     * only re-break a program that has fixed itself.
     *
     * What opencode cannot get natively are the chords xterm reserves or
     * mangles — Shift+PageUp scrolls xterm's own (empty) scrollback, and
     * Ctrl+Home/End have no default TUI meaning. Those are re-aimed at
     * opencode's message navigation in handleKey below.
     */
    term.attachCustomKeyEventHandler((e) => this.handleKey(entry, e))

    // Answer "what colour are you?" — see answerColour.
    for (const code of [10, 11] as const) {
      const sub = term.parser.registerOscHandler(code, (data) => this.answerColour(paneId, code, data))
      entry.disposers.push(() => sub.dispose())
    }

    return entry
  }

  /**
   * OSC 10/11 colour queries. A program asks "what is your foreground /
   * background?" and a real terminal answers; xterm.js does not, so a TUI that
   * probes this way (Claude Code among them) gets silence, assumes a light
   * terminal, and renders itself white-on-white. We answer for it, in the
   * standard 16-bit-per-channel form, straight back down the PTY.
   */
  private answerColour(paneId: string, code: 10 | 11, data: string): boolean {
    if (data.trim() !== '?') return false
    // A pane wearing a text colour answers with *that* — the honest reply, and
    // the one that keeps a probing TUI's own palette in step with the tab.
    const hex = code === 10 ? (foregrounds.get(paneId) ?? palette()['fg'] ?? '') : (palette()['bg'] ?? '')
    const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex.trim())
    if (!m) return false
    const [, r, g, b] = m
    window.forge.pty.write(paneId, `\x1b]${code};rgb:${r}${r}/${g}${g}/${b}${b}\x1b\\`)
    return true
  }

  /**
   * True while this pane is opencode with its full-screen TUI up — the state
   * in which the terminal has no scrollback of its own and scrolling means
   * driving opencode's message viewport. See the long note in `create`.
   */
  private isOpencodeTui(entry: Entry): boolean {
    return (
      commandExe(entry.spec.bootstrapCommand) === 'opencode' &&
      entry.term.buffer.active.type === 'alternate'
    )
  }

  /**
   * Windows-terminal clipboard conventions, intercepted per pane so a key only
   * stops reaching the shell when we actually handled it.
   *
   *   Ctrl+C          copies when there is a selection, otherwise falls through
   *                   as ^C so it still interrupts a running command
   *   Ctrl+V          pastes (bracketed-paste safe, via term.paste)
   *   Ctrl+Shift+C/V  the same, unconditionally — the classic aliases
   *
   * Plus, for an opencode pane on the alternate screen only, the scroll chords
   * the TUI cannot receive natively, re-aimed at its message navigation
   * (keybind defaults verified against opencode 1.18.11):
   *
   *   Shift+PageUp/PageDown  a page — xterm would aim these at its own
   *                          scrollback, which the alternate screen does not
   *                          have, so they are sent as the plain page keys
   *                          opencode binds to messages_page_up/down
   *   Ctrl+Home / Ctrl+End   first / last message, via the plain Home/End
   *                          opencode binds to messages_first/messages_last
   *
   * Returning false stops xterm sending the key to the PTY; preventDefault is
   * also needed, because Chromium would otherwise run its own paste command on
   * the textarea and we would paste twice.
   */
  private handleKey(entry: Entry, e: KeyboardEvent): boolean {
    if (e.type !== 'keydown' || e.metaKey) return true
    const { paneId, term } = entry

    if (this.isOpencodeTui(entry) && !e.altKey) {
      if (e.shiftKey && !e.ctrlKey && (e.key === 'PageUp' || e.key === 'PageDown')) {
        e.preventDefault()
        window.forge.pty.write(paneId, e.key === 'PageUp' ? '\x1b[5~' : '\x1b[6~')
        return false
      }
      if (e.ctrlKey && !e.shiftKey && (e.key === 'Home' || e.key === 'End')) {
        e.preventDefault()
        window.forge.pty.write(paneId, e.key === 'Home' ? '\x1b[H' : '\x1b[F')
        return false
      }
    }

    if (!e.ctrlKey || e.altKey) return true
    const key = e.key.toLowerCase()

    if (key === 'v') {
      e.preventDefault()
      void this.pasteFromClipboard(paneId)
      return false
    }

    if (key === 'c') {
      if (term.hasSelection()) {
        e.preventDefault()
        this.copySelectionToClipboard(paneId)
        return false
      }
      // Nothing selected: Ctrl+C is a break, Ctrl+Shift+C is simply a no-op.
      if (e.shiftKey) {
        e.preventDefault()
        return false
      }
      return true
    }

    return true
  }

  /**
   * Choose this terminal's renderer.
   *
   * WebGL is the fast one, but a browser only hands out a dozen or so live
   * contexts per process — 16 panes all asking at once and the oldest get
   * killed off. So it is a *request*, granted to whatever is being looked at
   * full size and taken back from mosaic tiles, which fall back to the DOM
   * renderer. That is also the better renderer for a tile: DOM rows are real
   * text, so a CSS transform re-renders them crisply at any scale, where a
   * shrunken canvas is just resampled mush.
   */
  setWebgl(paneId: string, want: boolean): void {
    const entry = this.entries.get(paneId)
    if (!entry || entry.webglWanted === want) return
    entry.webglWanted = want
    if (want) void this.loadWebgl(entry)
    else this.unloadWebgl(entry)
  }

  private async loadWebgl(entry: Entry): Promise<void> {
    if (entry.webgl || entry.webglLoading) return
    entry.webglLoading = true
    try {
      const { WebglAddon } = await import('@xterm/addon-webgl')
      // The import is async: the pane may have been closed, or demoted to a
      // mosaic tile, while it was in flight.
      if (!entry.webglWanted || this.entries.get(entry.paneId) !== entry) return
      const addon = new WebglAddon()
      addon.onContextLoss(() => {
        // The browser reclaimed our context. Drop to the DOM renderer rather
        // than fight for it back.
        if (entry.webgl === addon) entry.webgl = null
        entry.webglWanted = false
        addon.dispose()
      })
      entry.term.loadAddon(addon)
      entry.webgl = addon
    } catch (err) {
      // The DOM renderer is a perfectly good fallback; just say so once.
      console.warn('[forge] WebGL renderer unavailable, using DOM renderer', err)
    } finally {
      entry.webglLoading = false
    }
  }

  /** Disposing the addon is what reverts xterm to its DOM renderer. */
  private unloadWebgl(entry: Entry): void {
    const addon = entry.webgl
    entry.webgl = null
    if (!addon) return
    try {
      addon.dispose()
    } catch {
      /* already gone */
    }
  }

  private observe(entry: Entry, container: HTMLElement): void {
    entry.resizeObserver?.disconnect()
    const ro = new ResizeObserver(() => this.fit(entry.paneId))
    ro.observe(container)
    entry.resizeObserver = ro
  }

  /* --------------------------------------------------------------- resize */

  /**
   * Remember the size xterm just took, and tell ConPTY about it once the
   * geometry has held still for RESIZE_SETTLE_MS.
   *
   * The pending size is held on the entry rather than captured in the timer
   * because `onResize` only fires when cols/rows actually *change*: the last
   * observation of a drag is often a repeat, and the flush has to send the
   * dimensions the terminal ended up at, not the ones the timer was armed with.
   */
  private queuePtyResize(entry: Entry, cols: number, rows: number): void {
    entry.pendingResize = { cols, rows }
    if (entry.resizeTimer !== null) clearTimeout(entry.resizeTimer)
    entry.resizeTimer = window.setTimeout(() => {
      entry.resizeTimer = null
      const next = entry.pendingResize
      entry.pendingResize = null
      if (!next) return
      const prev = entry.ptyDims
      // Nothing moved in the end (a drag that came back to where it started, or
      // a fit that only confirmed the size we spawned at) — leave the TUI alone.
      if (prev && prev.cols === next.cols && prev.rows === next.rows) return
      entry.ptyDims = next
      this.resizePty(entry, next.cols, next.rows)
    }, RESIZE_SETTLE_MS)
  }

  /**
   * Hand a settled size to ConPTY, in two steps, so whatever is drawing in the
   * pane repaints from scratch at it.
   *
   * A TUI that keeps a live region on screen — Ink, so Claude Code — only
   * rewrites the rows it believes changed, and ConPTY's buffer reflow during a
   * resize leaves fragments of the previous frame behind. Nothing clears them,
   * so the mess persists until the program next redraws everything. There is no
   * "please repaint" sequence a program is obliged to honour, but a *size
   * change* is an event every TUI redraws for. So: one row short, then the true
   * size a beat later. The pane lands on exactly the geometry it asked for,
   * having repainted at it.
   */
  private resizePty(entry: Entry, cols: number, rows: number): void {
    if (entry.jiggleTimer !== null) {
      clearTimeout(entry.jiggleTimer)
      entry.jiggleTimer = null
    }
    // Nothing to jiggle *into* on a pane with no program in it, and a two-row
    // terminal has no row to spare.
    if (entry.runtime.status !== 'live' || rows < 3) {
      window.forge.pty.resize(entry.paneId, cols, rows)
      return
    }
    window.forge.pty.resize(entry.paneId, cols, rows - 1)
    entry.jiggleTimer = window.setTimeout(() => {
      entry.jiggleTimer = null
      window.forge.pty.resize(entry.paneId, cols, rows)
    }, REDRAW_JIGGLE_MS)
  }

  /**
   * Name the pane on its own first line, before the shell says anything.
   *
   * Restoring a workspace used to give you several tabs that were, for as long
   * as the agent took to boot, visually identical: the same prompt at the same
   * cwd, then the same launch line, whose only unique part is a session uuid
   * buried mid-line ahead of a long `--mcp-config` path that wraps. Three
   * restored tabs and a brand-new one all read the same, and only diverged once
   * each agent had painted — which reads as the tabs being broken and then
   * quietly fixing themselves.
   *
   * They were never wrong; there was simply nothing on screen that belonged to
   * *this* pane. So the pane introduces itself. Written to xterm rather than
   * down the PTY: it is a label, not input, so it can never reach the shell or
   * a program's stdin. An agent that takes the alternate buffer covers it a
   * moment later, which is exactly when it has stopped being needed.
   */
  private writeBootHeader(entry: Entry): void {
    const name = entry.spec.paneTitle.trim()
    if (!name) return
    const colour = foregrounds.get(entry.paneId) ?? entry.spec.accent
    const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(colour.trim())
    const rgb = m ? `38;2;${parseInt(m[1]!, 16)};${parseInt(m[2]!, 16)};${parseInt(m[3]!, 16)}` : '2'
    entry.term.write(`\x1b[${rgb}m── ${name}\x1b[0m\r\n`)
  }

  private async start(entry: Entry): Promise<void> {
    // A relaunch gets a new Remote Control id, so the old URL must not survive
    // it. The *conversation* does: the pane keeps its session id, so restarting
    // a pane picks its Claude back up rather than starting over.
    entry.scanTail = ''
    // A fresh shell holds no draft, whatever the old one was mid-typing.
    entry.typed = ''
    // The size we are about to spawn at *is* the PTY's size, recorded before
    // the await so the fit that queued this one flushes as a no-op rather than
    // resizing a shell that is already right.
    entry.ptyDims = { cols: entry.term.cols, rows: entry.term.rows }
    this.setRuntime(entry, { status: 'starting', error: null, exitCode: null, remoteUrl: null })
    this.writeBootHeader(entry)
    const result = await window.forge.pty.create({
      id: entry.paneId,
      cwd: entry.spec.cwd,
      cols: entry.term.cols,
      rows: entry.term.rows,
      bootstrapCommand: entry.spec.bootstrapCommand,
      projectName: entry.spec.projectName,
      paneTitle: entry.spec.paneTitle,
      ...(entry.spec.sessionId ? { sessionId: entry.spec.sessionId } : {}),
      ...(entry.spec.repoUrl ? { repoUrl: entry.spec.repoUrl } : {}),
      ...(entry.spec.remoteControl === false ? { remoteControl: false as const } : {})
    })
    if (result.ok) {
      this.setRuntime(entry, { status: 'live', pid: result.pid })
    } else {
      entry.term.write(`\r\n\x1b[38;2;255;92;72m✕ ${result.error}\x1b[0m\r\n`)
      this.setRuntime(entry, { status: 'error', error: result.error })
    }
  }

  /**
   * Kill the shell (if any) and launch a fresh one in the same pane.
   *
   * Fresh *shell*, same conversation: the pane keeps its session id, so a
   * restarted Claude resumes rather than starting over. A genuinely new session
   * is a new pane — that is what mints a new id (see makeLeaf).
   */
  async restart(paneId: string): Promise<void> {
    const entry = this.entries.get(paneId)
    if (!entry) return
    if (entry.runtime.status === 'live' || entry.runtime.status === 'starting') {
      await window.forge.pty.kill(paneId)
    }
    entry.term.reset()
    await this.start(entry)
    entry.term.focus()
  }

  /** Tear the pane down for good: kill the shell, dispose the terminal. */
  dispose(paneId: string): void {
    const entry = this.entries.get(paneId)
    this.entries.delete(paneId)
    this.listeners.delete(paneId)
    foregrounds.delete(paneId)
    if (!entry) {
      // Never created (e.g. a restored pane that was closed before being
      // viewed) — still make sure no orphan session lingers.
      void window.forge.pty.kill(paneId)
      return
    }
    if (entry.activityTimer !== null) clearTimeout(entry.activityTimer)
    // Off the map already, so nobody can read this pane's flag again — but the
    // rail is still showing the ring it turned on, and must be told.
    this.clearBusy(entry)
    if (entry.resizeTimer !== null) clearTimeout(entry.resizeTimer)
    if (entry.jiggleTimer !== null) clearTimeout(entry.jiggleTimer)
    entry.resizeObserver?.disconnect()
    entry.webglWanted = false
    this.unloadWebgl(entry)
    for (const d of entry.disposers) {
      try {
        d()
      } catch {
        /* ignore */
      }
    }
    void window.forge.pty.kill(paneId)
    entry.wrapper.remove()
    entry.term.dispose()
  }

  disposeAll(ids: Iterable<string>): void {
    for (const id of ids) this.dispose(id)
  }

  /* ------------------------------------------------------------ actions */

  fit(paneId: string): void {
    const entry = this.entries.get(paneId)
    if (!entry || !entry.container) return
    // A phone or a browser is reading this pane, so that viewer's geometry is
    // the pane's geometry until it stops — see setPhoneWatched. The observer
    // still fires (the box is still moving, and `geometry` below would be worth
    // having); it simply must not become a resize.
    if (entry.viewerOwned) return
    const { clientWidth, clientHeight } = entry.container
    if (clientWidth < 8 || clientHeight < 8) return
    // Only a full-size layout is worth remembering — a peek tile's box is
    // itself derived from this number.
    if (entry.mode === 'tab') entry.geometry = { width: clientWidth, height: clientHeight }
    try {
      entry.fit.fit()
    } catch {
      /* xterm throws if measured mid-teardown — harmless */
    }
  }

  fitAll(): void {
    for (const id of this.entries.keys()) this.fit(id)
  }

  /**
   * Hand the panes a phone is reading over to it, and take back the ones it
   * has let go. `mobileWatched`, from electron/mobile-host.ts.
   *
   * The problem this solves is that a PTY has one geometry and a link gives it
   * a second viewer. Both ends used to fit it to their own box, and since the
   * desktop refits on any layout change — a window resize, a split, the boot
   * `fitAll` — the desktop kept winning: a pane being read on a phone would
   * have its width dragged back to the desk's without anything on the phone
   * knowing, and every line after that arrived wrapped for a screen three
   * times wider than the one showing it.
   *
   * So there is an owner, and `applyWatched` below is where it is decided.
   */
  setPhoneWatched(panes: Array<{ id: string; cols: number; rows: number }>): void {
    this.phoneWatched = asWatchMap(panes)
    this.applyWatched()
  }

  /**
   * The same, for a browser on Forge Web — `webWatched`, from
   * electron/web-host.ts.
   *
   * A second entry point rather than a second caller of `setPhoneWatched`
   * because each list is complete in itself: a phone that has closed every pane
   * says so by sending an empty one, and were the two writing into a single map
   * that message would also hand back the panes a browser is still reading.
   * Which is the bug that made this necessary — the desktop and a browser tab
   * open side by side, each repairing its own render by corrupting the other's.
   */
  setBrowserWatched(panes: Array<{ id: string; cols: number; rows: number }>): void {
    this.browserWatched = asWatchMap(panes)
    this.applyWatched()
  }

  /**
   * What size a pane is being read at away from this desk, or null when nobody
   * is reading it.
   *
   * With both viewers on one pane the answer is the smaller of each dimension
   * *independently*, and independently is the load-bearing word: a phone held
   * upright is narrow and long, a browser window is wide and shallow, and
   * taking either viewer's pair wholesale overflows the other in the dimension
   * it was not chosen for. Neither screen can draw more than it has room for,
   * so both are given the intersection — which is smaller than one of them
   * asked for and readable on both, and that is the trade this whole
   * arrangement exists to make.
   */
  private watchedSize(paneId: string): { cols: number; rows: number } | null {
    const phone = this.phoneWatched.get(paneId)
    const browser = this.browserWatched.get(paneId)
    if (!phone) return browser ?? null
    if (!browser) return phone
    return { cols: Math.min(phone.cols, browser.cols), rows: Math.min(phone.rows, browser.rows) }
  }

  /**
   * Give every pane to whoever is reading it now, and take back the rest.
   *
   * While a pane has a viewer:
   *
   *  - `fit` is a no-op for it, so nothing here resizes the PTY, and
   *  - the desktop's own terminal is resized to the *viewer's* cols/rows, which
   *    letterboxes it inside the pane — the same screen, at the size it is
   *    actually being drawn at, rather than a lie the width of the window.
   *
   * `ptyDims` is set before `term.resize` on purpose: xterm answers a resize
   * with `onResize`, which queues a PTY resize, and the settle check compares
   * against `ptyDims`. Recording the size first is what makes adoption
   * *following* the PTY rather than arguing with it.
   *
   * Dropping off both lists refits against the real container, which sends the
   * desktop's geometry back down with the usual repaint jiggle.
   */
  private applyWatched(): void {
    for (const [paneId, entry] of this.entries) {
      const phone = this.phoneWatched.has(paneId)
      const browser = this.browserWatched.has(paneId)
      // Only when one of them has actually moved. `setRuntime` tells every
      // listener on the pane whatever the patch says, and these lists are
      // re-sent on every resize a viewer makes — a browser window being dragged
      // is a stream of them, and a stream of them is a stream of re-renders.
      if (entry.runtime.phone !== phone || entry.runtime.browser !== browser) {
        this.setRuntime(entry, { phone, browser })
      }
      const watched = this.watchedSize(paneId)
      if (watched) {
        entry.viewerOwned = true
        if (entry.term.cols !== watched.cols || entry.term.rows !== watched.rows) {
          entry.ptyDims = { cols: watched.cols, rows: watched.rows }
          try {
            entry.term.resize(watched.cols, watched.rows)
          } catch {
            /* xterm throws if measured mid-teardown — harmless */
          }
        }
        continue
      }
      if (!entry.viewerOwned) continue
      entry.viewerOwned = false
      this.fit(paneId)
    }
  }

  /**
   * Rescue a pane whose screen is already a mess.
   *
   * Same trick a settled resize uses (see resizePty), at the size the pane
   * already has, so nothing reflows — the program simply redraws everything.
   * Scrollback is deliberately left alone: the garbled lines above the live
   * region are history, and history is not ours to delete.
   */
  redraw(paneId: string): void {
    const entry = this.entries.get(paneId)
    if (!entry) return
    const { cols, rows } = entry.term
    entry.ptyDims = { cols, rows }
    // The renderer's own copy first, in case the corruption is only on screen.
    entry.term.refresh(0, rows - 1)
    this.resizePty(entry, cols, rows)
  }

  focus(paneId: string): void {
    this.entries.get(paneId)?.term.focus()
  }

  /**
   * Drop a pane's keyboard focus. A mosaic tile that stops being interactive
   * must give the caret back, or it keeps eating keystrokes that now belong to
   * the wall again.
   */
  blur(paneId: string): void {
    this.entries.get(paneId)?.term.blur()
  }

  clear(paneId: string): void {
    this.entries.get(paneId)?.term.clear()
  }

  hasSelection(paneId: string): boolean {
    return this.entries.get(paneId)?.term.hasSelection() ?? false
  }

  copySelection(paneId: string): string | null {
    const term = this.entries.get(paneId)?.term
    if (!term || !term.hasSelection()) return null
    return term.getSelection()
  }

  /**
   * Copy the selection and drop it, the way Windows Terminal does — leaving it
   * highlighted after Ctrl+C makes the next Ctrl+C look like it did nothing.
   */
  copySelectionToClipboard(paneId: string): boolean {
    const entry = this.entries.get(paneId)
    if (!entry || !entry.term.hasSelection()) return false
    const text = entry.term.getSelection()
    if (!text) return false
    void window.forge.clipboard.writeText(text)
    entry.term.clearSelection()
    return true
  }

  async pasteFromClipboard(paneId: string): Promise<boolean> {
    const entry = this.entries.get(paneId)
    if (!entry) return false
    const text = await window.forge.clipboard.readText()
    if (!text) return false
    entry.term.paste(text)
    entry.term.scrollToBottom()
    return true
  }

  selectAll(paneId: string): void {
    this.entries.get(paneId)?.term.selectAll()
  }

  paste(paneId: string, text: string): void {
    const entry = this.entries.get(paneId)
    if (!entry) return
    entry.term.paste(text)
    entry.term.scrollToBottom()
  }

  /** The draft takeBack would remove — read by the pane menu to label itself. */
  typedDraft(paneId: string): string {
    return this.entries.get(paneId)?.typed ?? ''
  }

  /**
   * Erase the draft typed into this pane and hand it back.
   *
   * The wrong-terminal rescue: a long prompt composed at the wrong pane is
   * removed here with one backspace per character — the only deletion every
   * shell and agent line editor understands — and returned, so the caller can
   * put it on the clipboard or re-aim it at the pane it was meant for. Null
   * when there is nothing to take back. Overshoot is harmless (a backspace at
   * an empty prompt is a no-op everywhere we launch); undershoot only happens
   * after caret gymnastics the tracker deliberately does not model.
   */
  takeBack(paneId: string): string | null {
    const entry = this.entries.get(paneId)
    if (!entry || entry.runtime.status === 'exited') return null
    const text = entry.typed
    if (!text) return null
    entry.typed = ''
    window.forge.pty.write(paneId, '\x7f'.repeat(Array.from(text).length))
    entry.term.scrollToBottom()
    return text
  }

  /**
   * Dictation insertion. Sends text to the shell as though it had been typed —
   * and deliberately never a carriage return: Steve reads what landed and
   * presses Enter himself, so a misheard word is never a submitted command.
   * (term.paste() is no good here: xterm folds newlines into \r, which submits.)
   *
   * Returns false when the pane has no live terminal, so the caller can fall
   * back to the clipboard instead of silently swallowing the words.
   */
  type(paneId: string, text: string): boolean {
    const entry = this.entries.get(paneId)
    if (!entry || entry.runtime.status === 'exited') return false
    const flat = text.replace(/[\r\n]+/g, ' ')
    // Dictated words are typing too: they belong to the draft takeBack removes.
    entry.typed = clampDraft(entry.typed + flat)
    window.forge.pty.write(paneId, flat)
    return true
  }

  /**
   * Press Enter in a pane, on the user's behalf.
   *
   * Split out from `type()` rather than folded into it because the two carry
   * completely different risk: typing is always safe, submitting is not. The
   * only caller is the voice agent's auto-relay, which is off by default, only
   * ever fires at a coding agent (never a bare shell) and only after a grace
   * beat the user can interrupt. Keeping the carriage return in its own method
   * means "who can submit for me?" is one search away.
   */
  submit(paneId: string): boolean {
    const entry = this.entries.get(paneId)
    if (!entry || entry.runtime.status === 'exited') return false
    entry.typed = '' // The Enter below sends the draft on its way.
    window.forge.pty.write(paneId, '\r')
    entry.term.scrollToBottom()
    return true
  }

  has(paneId: string): boolean {
    return this.entries.has(paneId)
  }

  /**
   * The naming context this pane was actually created with. Renaming a pane
   * afterwards does not rename its Remote Control session — Claude was told the
   * name once, at launch — so the phone popover reads it from here rather than
   * recomputing it from the current title and lying about what to look for.
   */
  launchedAs(paneId: string): { projectName: string; paneTitle: string } | null {
    const entry = this.entries.get(paneId)
    if (!entry) return null
    return { projectName: entry.spec.projectName, paneTitle: entry.spec.paneTitle }
  }

  scrollToBottom(paneId: string): void {
    this.entries.get(paneId)?.term.scrollToBottom()
  }

  runtime(paneId: string): PaneRuntime {
    return this.entries.get(paneId)?.runtime ?? IDLE_RUNTIME
  }

  /**
   * Re-read the terminal tokens and repaint every live terminal.
   *
   * Switching theme has to reach the terminals or the app ends up light with
   * four black holes in it. The palette is cached at create time for speed, so
   * the cache is dropped first; each terminal then gets a fresh ITheme built
   * against its own accent, and a forced refresh, because xterm only repaints
   * the rows it thinks changed and a colour swap changes none of them.
   *
   * Call *after* the new tokens are on the document — this reads computed
   * style, so it sees whatever is there at the moment it runs.
   */
  refreshTheme(): void {
    paletteCache = null
    for (const entry of this.entries.values()) {
      entry.term.options.theme = baseTheme(entry.spec.accent, foregrounds.get(entry.paneId))
      entry.term.refresh(0, entry.term.rows - 1)
    }
  }

  applyTypography(fontSize: number, fontFamily: string): void {
    for (const entry of this.entries.values()) {
      entry.spec = { ...entry.spec, fontSize, fontFamily }
      entry.term.options.fontSize = fontSize
      entry.term.options.fontFamily = fontFamily
      this.fit(entry.paneId)
    }
  }

  /** Keep a live pane's spec in sync when its profile/accent is edited. */
  updateAccent(paneId: string, accent: string): void {
    const entry = this.entries.get(paneId)
    if (!entry || entry.spec.accent === accent) return
    entry.spec = { ...entry.spec, accent }
    entry.term.options.theme = baseTheme(accent, foregrounds.get(paneId))
  }

  /**
   * Paint a pane's default text colour, or `null` to hand it back to the theme.
   *
   * Remembered whether or not the pane is attached, because tab colours are
   * applied for every pane in the project at once (see TerminalGrid) and half
   * of those are, at any moment, tabs you are not looking at.
   */
  setForeground(paneId: string, color: string | null): void {
    const current = foregrounds.get(paneId) ?? null
    if (current === color) return
    if (color) foregrounds.set(paneId, color)
    else foregrounds.delete(paneId)
    const entry = this.entries.get(paneId)
    if (!entry) return
    entry.term.options.theme = baseTheme(entry.spec.accent, color ?? undefined)
    // xterm only repaints rows it believes changed, and a colour swap changes
    // none of them — same reason refreshTheme forces it.
    entry.term.refresh(0, entry.term.rows - 1)
  }

  /* ------------------------------------------------------ subscriptions */

  subscribeRuntime(paneId: string, cb: (r: PaneRuntime) => void): () => void {
    const l = this.listenersFor(paneId)
    l.runtime.add(cb)
    return () => {
      l.runtime.delete(cb)
    }
  }

  subscribeActivity(paneId: string, cb: () => void): () => void {
    const l = this.listenersFor(paneId)
    l.activity.add(cb)
    return () => {
      l.activity.delete(cb)
    }
  }

  liveCount(): number {
    let n = 0
    for (const e of this.entries.values()) {
      if (e.runtime.status === 'live' || e.runtime.status === 'starting') n++
    }
    return n
  }
}

export const terminalHost = new TerminalHost()
