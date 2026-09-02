import { Terminal, type ITheme } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import type { PtyDataEvent, PtyExitEvent, PtyGeometryEvent } from '@shared/types'
import { findRemoteSessionUrl } from '@shared/remote'
import { findDevServerUrl } from '@shared/devserver'
import { isTypedInput } from '@shared/typing'
import { commandExe } from '@shared/agents'
import { planPointerDelta, wheelDeltaPx, type ScrollCarry } from '@shared/touch-scroll'
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
   * True while a phone has this pane open. It decides nothing about the pane's
   * size — only *typing* moves a grid, and this flag is set by watching — so it
   * is news rather than an explanation of what is on screen, and never a lock.
   */
  phone: boolean
  /**
   * The same fact about a browser on Forge Web. Two flags rather than one
   * because both can be true at once and the pane header has to be able to say
   * which.
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

/** One row, measured off the painted grid, falling back to the font. */
function terminalRowHeight(term: Terminal, fontSize: number): number {
  const rows = term.element?.querySelector('.xterm-rows') as HTMLElement | null
  const measured = rows && term.rows > 0 ? rows.clientHeight / term.rows : 0
  return measured > 1 ? measured : Math.max(1, fontSize * 1.2)
}

/**
 * True when this pane *is* a chat TUI, not a shell that happens to be running
 * one. vim and htop inside PowerShell still want xterm's native wheel (arrows
 * without mouse tracking, reports at the cursor with it). Grok and OpenCode
 * are the pane — their prompt eats arrows and hit-tests the composer.
 */
function isChatAgentCommand(command: string): boolean {
  const exe = commandExe(command)
  if (!exe) return false
  switch (exe) {
    case 'pwsh':
    case 'powershell':
    case 'cmd':
    case 'bash':
    case 'zsh':
    case 'fish':
    case 'sh':
      return false
    default:
      return true
  }
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

/**
 * How long a pane must have been busy before going quiet counts as "done".
 *
 * The `done` half of what is forwarded to Forge Web exists for one moment: a
 * long job finished while nobody was at the desk. A shell echoing a directory
 * listing also goes from busy to idle, and a phone that buzzed for that would
 * be a phone somebody turns notifications off on. Well above BUSY_ONSET_MS,
 * because the two measure different things — that one is "is this an agent",
 * this one is "was that worth walking back for".
 */
const DONE_MIN_BUSY_MS = 8000

/** The longest question line handed to a browser or a push. See `promptFor`. */
const PROMPT_MAX_CHARS = 200

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
 * How small the font may go while shrinking somebody else's grid into a pane.
 *
 * The same floor, for the same reason, as `MIN_FONT_PX` in web/src/lib/term.ts
 * and mobile/src/lib/term.ts — those two have always had to draw this desk's
 * grid, and now that the width follows the typist this desk has to draw theirs.
 * Below about this size a terminal stops being readable and starts being a
 * texture. At the floor the shrinking stops and the terminal overflows its box,
 * which `.pane__terminal` clips.
 */
const MIN_FONT_PX = 7

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
  /**
   * The grid this pane's box would hold at this pane's own font — the size the
   * desk *wishes* for, whether or not it is the one on screen.
   */
  natural: { cols: number; rows: number } | null
  /**
   * The grid the PTY really has while somebody else is holding it, or null when
   * this desk is free to choose. See `setGeometry` and `applyGrid`.
   */
  desired: { cols: number; rows: number } | null
  /** Pending second half of a repaint jiggle — see resizePty. */
  jiggleTimer: number | null
  /** Tail of the last output chunk, kept only until the RC URL is found. */
  scanTail: string
  /**
   * The same overlap for the dev-server scan, kept for the pane's whole life:
   * unlike the Remote Control URL there is no "found it, stop looking" — a
   * server can be restarted onto a different port at any moment, and the newest
   * URL is the one that is true.
   */
  devScanTail: string
  /** The last dev-server URL announced for this pane, so a repeat is silent. */
  devUrl: string | null
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
  /**
   * The question line pulled out of the settled screen when `attention` went
   * on, so a client with none of this pane's bytes can be told what it is being
   * asked. Empty whenever `attention` is false.
   */
  attentionPrompt: string
  /** When this pane last became busy, so a settle can measure the stretch. */
  busySince: number
  /** When the current unbroken run of output began. */
  busyRunStart: number
  /** When the last chunk arrived, so a gap can be measured. */
  busyLastOutput: number
  busyTimer: number | null
  /** Bytes printed since this shell was spawned — see `readiness`. */
  outputBytes: number
  /** The WebGL renderer, when this terminal currently has one. */
  webgl: { dispose(): void } | null
  webglWanted: boolean
  webglLoading: boolean
  disposers: Array<() => void>
  /** Remainder of a TUI wheel/finger gesture. Shared with the cards view. */
  wheelCarry: ScrollCarry
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
   * Panes a phone is reading. A set, not a map, because no geometry comes with
   * them: a viewer that is only reading changes nothing about a pane, and the
   * list is here so a pane can say it is being read and for nothing else.
   */
  private phoneWatched = new Set<string>()
  /** The same, for a browser on Forge Web. Two lists because each is complete
   * in itself: every viewer sends its whole set on every change, so merging
   * them on arrival would make a browser's silence look like a phone leaving. */
  private browserWatched = new Set<string>()
  /**
   * Who wants to hear about a dev server appearing in a pane. A plain set of
   * callbacks rather than anything React-shaped, for the same reason the rest of
   * this file is: panes outlive every component that ever showed them.
   */
  private devUrlListeners = new Set<(cwd: string, url: string) => void>()
  private wired = false

  /* ----------------------------------------------------------- plumbing */

  private wire(): void {
    if (this.wired) return
    this.wired = true

    window.forge.pty.onData((e: PtyDataEvent) => {
      const entry = this.entries.get(e.id)
      if (!entry) return
      entry.term.write(e.data)
      entry.outputBytes += e.data.length
      if (entry.runtime.status === 'starting') this.setRuntime(entry, { status: 'live' })
      this.scanForRemoteUrl(entry, e.data)
      this.scanForDevUrl(entry, e.data)
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

    // The other half of the geometry conversation. The desk's `fit` says what it
    // would like; this says what the pane actually is, and who chose it.
    window.forge.pty.onGeometry((e: PtyGeometryEvent) => {
      this.setGeometry(e.id, e.deskOwns ? null : { cols: e.cols, rows: e.rows })
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

  /**
   * Watch a pane's output for the local URL a dev server prints when it comes
   * up, so the Devices preview can show the site this project is building
   * rather than only Forge's own app.
   *
   * Same telescope as the Remote Control scan above and the same overlap, with
   * one difference that matters: this one never stops. `npm run dev` restarted
   * onto a free port, a second server started beside the first, a framework
   * that moves — the newest URL a pane has printed is the answer, so the tail is
   * kept for the pane's whole life and only a *change* is news.
   *
   * The cwd, not the pane id, is what goes out: a pane's cwd is its project's
   * path, and the preview is a per-project thing that does not care which of the
   * project's terminals happened to be the one running the server.
   */
  private scanForDevUrl(entry: Entry, data: string): void {
    const text = entry.devScanTail + data
    entry.devScanTail = text.slice(-URL_SCAN_OVERLAP)
    const found = findDevServerUrl(text)
    if (!found || found === entry.devUrl) return
    entry.devUrl = found
    for (const cb of this.devUrlListeners) cb(entry.spec.cwd, found)
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
    if (busy) {
      entry.busySince = performance.now()
      // Output means the agent is talking, not waiting; whatever it asked is stale.
      this.setAttention(entry, false)
    }
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
    // Read before `setBusy` clears it: the interesting question is how long the
    // stretch that just ended lasted, and after the call there is no stretch.
    const stretch = entry.busy ? performance.now() - entry.busySince : 0
    const alive = entry.runtime.status !== 'exited'
    this.setBusy(entry, false)
    this.setAttention(entry, alive && this.looksLikeWaiting(entry))
    // A long job that went quiet with nothing to ask. Announced only from here,
    // after the attention check, because "finished" and "waiting for you" are
    // the same edge seen twice and only one of them is this one — a pane that
    // settled on a question is asking, not done.
    if (alive && !entry.attention && stretch >= DONE_MIN_BUSY_MS) this.tellWeb(entry, 'done', '')
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
  /**
   * The last few non-empty lines on screen, de-bordered — the evidence both
   * `looksLikeWaiting` and `promptFor` reason about.
   *
   * One function rather than two copies, because the two must agree: a prompt
   * pulled from a different window than the one that decided a pane is waiting
   * would be a notification quoting a line that had nothing to do with the
   * badge beside it.
   */
  private settledTail(entry: Entry): string[] {
    const buffer = entry.term.buffer.active
    const lines: string[] = []
    const start = Math.max(0, buffer.length - 30)
    for (let y = start; y < buffer.length; y++) {
      const text = stripBoxDrawing(buffer.getLine(y)?.translateToString(true) ?? '')
      if (text) lines.push(text)
    }
    return lines.slice(-10)
  }

  private looksLikeWaiting(entry: Entry): boolean {
    const tail = this.settledTail(entry)
    if (tail.length === 0) return false

    if (tail.some((line) => /[?？]\s*$/.test(line))) return true
    if (tail.filter((line) => CHOICE_LINE.test(line)).length >= 2) return true
    return tail.some((line) =>
      /\b(?:yes\/no|y\/n|allow|deny|approve|confirm|continue|proceed|overwrite)\b\s*[:?]?\s*$/i.test(
        line
      )
    )
  }

  /**
   * The one line worth quoting off a screen that has settled on a question.
   *
   * Three shapes, in the order they are trusted, and they mirror
   * `looksLikeWaiting`'s three: a line ending in a question mark is the
   * question; a menu of numbered options has its question written *above* the
   * list, so the last line before the first option is taken instead; and
   * anything else falls back to the last line there is, which for a y/n prompt
   * is the prompt itself.
   *
   * A courtesy and not a contract — the pane is the real answer to "what is it
   * asking", and this is what a phone can fit on a lock screen.
   */
  private promptFor(entry: Entry): string {
    const tail = this.settledTail(entry)
    if (tail.length === 0) return ''

    const asked = [...tail].reverse().find((line) => /[?？]\s*$/.test(line))
    if (asked) return asked.trim().slice(0, PROMPT_MAX_CHARS)

    const firstChoice = tail.findIndex((line) => CHOICE_LINE.test(line))
    if (firstChoice > 0) {
      const above = [...tail.slice(0, firstChoice)].reverse().find((line) => !CHOICE_LINE.test(line))
      if (above) return above.trim().slice(0, PROMPT_MAX_CHARS)
    }

    return (tail[tail.length - 1] ?? '').trim().slice(0, PROMPT_MAX_CHARS)
  }

  private setAttention(entry: Entry, attention: boolean): void {
    if (entry.attention === attention) return
    entry.attention = attention
    // Read while the screen still shows what caused it: by the time anything
    // downstream asks, the agent may have printed over the question.
    entry.attentionPrompt = attention ? this.promptFor(entry) : ''
    this.tellWeb(entry, attention ? 'asking' : 'idle', entry.attentionPrompt)
    for (const cb of this.attentionListeners) cb()
  }

  /**
   * Hand one attention transition to the main process, which owns the browsers.
   *
   * Guarded rather than assumed: this class is also the thing a headless check
   * loads, and a bridge without `web` on it is not a reason for a pane to stop
   * working. On the desktop the call is always there. Nothing is awaited —
   * whether any browser is connected, and whether the news is worth a push, are
   * both questions for the far side.
   */
  private tellWeb(entry: Entry, state: 'asking' | 'done' | 'idle', prompt: string): void {
    window.forge?.web?.attention?.(entry.paneId, state, prompt)
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

  /**
   * What this pane is asking, when it is asking anything. Empty otherwise —
   * including for a pane that has never existed, which is the same answer and
   * for the same reason `isAttention` gives `false`.
   */
  attentionPrompt(paneId: string): string {
    return this.entries.get(paneId)?.attentionPrompt ?? ''
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
   * A wheel or a finger over an alt-screen agent TUI. Writes PageUp/PageDown
   * or an SGR wheel at `wheelReportCell`. Returns true when the TUI took the
   * gesture so the caller can preventDefault. False on Claude Code's normal
   * buffer, which keeps xterm's own scrollback.
   */
  driveScroll(paneId: string, deltaY: number, deltaMode = 0): boolean {
    const entry = this.entries.get(paneId)
    if (!entry || !isChatAgentCommand(entry.spec.bootstrapCommand)) return false
    const { term } = entry
    const alt = term.buffer.active.type === 'alternate'
    const mouse = term.modes?.mouseTrackingMode != null && term.modes.mouseTrackingMode !== 'none'
    if (!alt && !mouse) {
      entry.wheelCarry.px = 0
      return false
    }
    const height = terminalRowHeight(term, entry.spec.fontSize)
    const plan = planPointerDelta(
      entry.wheelCarry,
      wheelDeltaPx(deltaY, deltaMode, height),
      height,
      alt,
      mouse,
      term.cols
    )
    if (plan.kind === 'data') window.forge.pty.write(paneId, plan.data)
    return true
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
      natural: null,
      desired: null,
      jiggleTimer: null,
      scanTail: '',
      devScanTail: '',
      devUrl: null,
      typed: '',
      lastActivityNotify: 0,
      activityTimer: null,
      busy: false,
      attention: false,
      attentionPrompt: '',
      busySince: 0,
      busyRunStart: 0,
      busyLastOutput: 0,
      busyTimer: null,
      outputBytes: 0,
      webgl: null,
      webglWanted: false,
      webglLoading: false,
      disposers: [],
      wheelCarry: { px: 0 }
    }

    const dataSub = term.onData((data) => {
      if (entry.runtime.status === 'exited') {
        // Enter in a dead pane relaunches it — matches the hint printed on exit.
        if (data === '\r' || data === '\n') void this.restart(paneId)
        return
      }
      this.setAttention(entry, false)
      // A reply xterm composed itself is still sent — the program asked for it —
      // but it is not part of what was typed. See shared/typing.ts, which the
      // main process consults on this same stream to decide whether the person
      // at this desk has just taken the pane's grid back.
      if (isTypedInput(data)) entry.typed = advanceDraft(entry.typed, data)
      window.forge.pty.write(paneId, data)
    })
    entry.disposers.push(() => dataSub.dispose())

    /*
     * Deliberately no `term.onResize` subscription. It used to be how a settled
     * fit reached ConPTY, and it cannot be any more: `applyGrid` resizes this
     * terminal to somebody *else's* grid while they hold the pane, and a
     * subscription would read that back as this desk's wish and ask for it — so
     * the desk would ask for the phone's width and never get its own back. `fit`
     * measures and reports instead, which is also what the remote clients do
     * (see `fit` in web/src/lib/term.ts).
     */

    /*
     * Alternate-screen TUIs (Grok, OpenCode, Antigravity, vim) have no xterm
     * scrollback. Left alone, xterm would turn a wheel into one arrow key
     * (Grok's focused prompt eats those as caret motion) or into an SGR
     * report at the cursor, which sits in OpenCode's composer along the
     * bottom.
     *
     * The same planner the phone and the browser already use writes PageUp
     * or an SGR wheel aimed at the top row instead — mid-width, because
     * OpenCode drops a report on the left gutter entirely, which is what
     * kept this pane frozen at the desk as well as on a phone. See
     * `wheelReportCell` in shared/touch-scroll.ts. Claude Code writes the
     * normal buffer, so the handler returns true and xterm keeps the wheel.
     *
     * What opencode still cannot get natively are the chords xterm reserves
     * or mangles — Shift+PageUp scrolls xterm's own (empty) scrollback, and
     * Ctrl+Home/End have no default TUI meaning. Those are re-aimed at
     * opencode's message navigation in handleKey below.
     */
    try {
      term.attachCustomWheelEventHandler((ev) => {
        try {
          if (ev.ctrlKey || ev.shiftKey) return true
          if (!isChatAgentCommand(spec.bootstrapCommand)) return true
          const consumed = this.driveScroll(paneId, ev.deltaY, ev.deltaMode)
          if (!consumed) return true
          ev.preventDefault()
          return false
        } catch {
          return true
        }
      })
    } catch {
      /* xterm without a wheel hook — leave the physical wheel to it */
    }
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
   * Remember the size this pane's box just measured at, and wish for it once the
   * geometry has held still for RESIZE_SETTLE_MS.
   *
   * The pending size is held on the entry rather than captured in the timer
   * because the last observation of a drag is often a repeat of an earlier one,
   * and the flush has to send the dimensions the box ended up at, not the ones
   * the timer was armed with. `ptyDims` is what makes a repeat cost nothing.
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
    // Nothing to jiggle *into* on a pane with no program in it, a two-row
    // terminal has no row to spare, and a pane somebody else is holding is a
    // pane where this is only a wish — jiggling a wish is two messages that
    // change nothing, and the repaint belongs to whoever's resize lands.
    if (entry.runtime.status !== 'live' || rows < 3 || entry.desired) {
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
    // A relaunched shell may serve somewhere else entirely, so the pane forgets
    // where it last did. Re-announcing the same URL costs nothing — the state it
    // reaches is already holding it.
    entry.devScanTail = ''
    entry.devUrl = null
    // A fresh shell holds no draft, whatever the old one was mid-typing.
    entry.typed = ''
    // The size we are about to spawn at *is* the PTY's size, recorded before
    // the await so the fit that queued this one flushes as a no-op rather than
    // resizing a shell that is already right.
    entry.ptyDims = { cols: entry.term.cols, rows: entry.term.rows }
    this.setRuntime(entry, { status: 'starting', error: null, exitCode: null, remoteUrl: null })
    entry.outputBytes = 0
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

  /**
   * Measure the pane's box, put the right grid on screen, and say what this desk
   * would like.
   *
   * "What this desk would like" is a *wish* now, not an instruction: the width
   * follows the typist (electron/pty/grid-owner.ts), so this only reaches the
   * real PTY when nobody else is holding this pane. Merely laying out a window
   * must not drag a grid away from the phone somebody is working on — and the
   * wish is sent unconditionally anyway, because it is what lands the instant
   * somebody types here.
   */
  fit(paneId: string): void {
    const entry = this.entries.get(paneId)
    if (!entry || !entry.container) return
    const { clientWidth, clientHeight } = entry.container
    if (clientWidth < 8 || clientHeight < 8) return
    // Only a full-size layout is worth remembering — a peek tile's box is
    // itself derived from this number.
    if (entry.mode === 'tab') entry.geometry = { width: clientWidth, height: clientHeight }
    // Measured at this pane's *own* type size whatever it is currently drawn at:
    // the wish is "the grid I would choose", not "the grid I would choose if I
    // stayed squinting at somebody else's". xterm remeasures its cell
    // synchronously when the option is set. `proposeDimensions` rather than
    // `fit`, because measuring the box and deciding what goes on screen are two
    // different questions here; `applyGrid` answers the second.
    if (entry.term.options.fontSize !== entry.spec.fontSize) entry.term.options.fontSize = entry.spec.fontSize
    let proposed
    try {
      proposed = entry.fit.proposeDimensions()
    } catch {
      /* xterm throws if measured mid-teardown — harmless */
      return
    }
    if (!proposed || !Number.isFinite(proposed.cols) || !Number.isFinite(proposed.rows)) return
    entry.natural = { cols: proposed.cols, rows: proposed.rows }
    this.applyGrid(entry)
    this.queuePtyResize(entry, proposed.cols, proposed.rows)
  }

  /**
   * Put the right grid on screen at the largest font it fits in.
   *
   * Somebody else's grid whenever this pane has been told one, and this desk's
   * own until then — which is the ordinary case and costs a comparison. The
   * scale comes out of the two grids rather than out of any measurement of a
   * character: `natural` is what this box holds at `spec.fontSize`, so
   * `natural.cols / desired.cols` is exactly the factor the type has to come
   * down by for `desired.cols` of them to fit the same width. Never *up*,
   * because a remote pane narrower than this one is better letterboxed than
   * blown up past the size the rest of the app is set in.
   *
   * The port of `apply` in web/src/lib/term.ts, including the lesson recorded
   * there: a resize is not on its own a repaint. `FitAddon.fit` wipes the
   * rendered rows before it resizes and skipping that step is measurably not
   * free, so the explicit `refresh` below is doing that job by hand.
   */
  private applyGrid(entry: Entry): void {
    const { term, spec, desired, natural } = entry
    if (!desired) {
      if (term.options.fontSize !== spec.fontSize) term.options.fontSize = spec.fontSize
      try {
        entry.fit.fit()
      } catch {
        /* xterm throws if measured mid-teardown — harmless */
      }
      return
    }
    if (desired.cols < 1 || desired.rows < 1) return
    const scale = natural ? Math.min(natural.cols / desired.cols, natural.rows / desired.rows) : 1
    const size = scale >= 1 ? spec.fontSize : Math.max(MIN_FONT_PX, Math.floor(spec.fontSize * scale))
    if (term.options.fontSize !== size) term.options.fontSize = size
    if (term.cols === desired.cols && term.rows === desired.rows) return
    try {
      term.resize(desired.cols, desired.rows)
      term.refresh(0, term.rows - 1)
    } catch {
      /* xterm throws if measured mid-teardown — harmless */
    }
  }

  /**
   * A pane's real grid, and whether this desk is the one choosing it —
   * `IPC.ptyGeometry`, from electron/pty-host.ts.
   *
   * `null` means the desk is free again: nobody remote holds this pane, so it
   * goes back to its own fit at its own type size. That is a `fit` rather than
   * an `applyGrid`, because coming back means *asking for* the desk's grid as
   * well as drawing it — the PTY is still at whoever-it-was's size until this
   * desk wishes for its own, and `ptyDims` is cleared first so the wish is not
   * mistaken for the no-op it would otherwise look like.
   */
  setGeometry(paneId: string, size: { cols: number; rows: number } | null): void {
    const entry = this.entries.get(paneId)
    if (!entry) return
    const next = size && size.cols > 0 && size.rows > 0 ? { cols: size.cols, rows: size.rows } : null
    if (next?.cols === entry.desired?.cols && next?.rows === entry.desired?.rows) return
    entry.desired = next
    entry.ptyDims = null
    if (next) this.applyGrid(entry)
    else this.fit(paneId)
  }

  fitAll(): void {
    for (const id of this.entries.keys()) this.fit(id)
  }

  /**
   * Which panes a phone is reading — `mobileWatched`, from
   * electron/mobile-host.ts.
   *
   * A label and nothing more, which is the whole point of it being separate from
   * `setGeometry`. Reading a pane from a phone changes nothing here; *typing*
   * into one does, and that arrives on `IPC.ptyGeometry` instead. Keeping the
   * two messages apart is what stops a device that is merely being glanced at
   * from reshaping the work in front of somebody.
   */
  setPhoneWatched(ids: string[]): void {
    this.phoneWatched = new Set(ids)
    this.applyWatched()
  }

  /** The same for a browser on Forge Web — `webWatched`, from
   * electron/web-host.ts, under the same rule and for the same reason. */
  setBrowserWatched(ids: string[]): void {
    this.browserWatched = new Set(ids)
    this.applyWatched()
  }

  /**
   * Say which panes are being read from away.
   *
   * The whole of it: a pane on either list gets `runtime.phone` or
   * `runtime.browser`, which is a chip on the pane header, and no geometry
   * decision hangs on it either way.
   */
  private applyWatched(): void {
    for (const [paneId, entry] of this.entries) {
      const phone = this.phoneWatched.has(paneId)
      const browser = this.browserWatched.has(paneId)
      // Only when one of them has actually moved. `setRuntime` tells every
      // listener on the pane whatever the patch says, and these lists are
      // re-sent whenever a viewer opens or closes a pane — a phone walking a
      // list of them is a stream of messages, and a stream of them would be a
      // stream of re-renders.
      if (entry.runtime.phone !== phone || entry.runtime.browser !== browser) {
        this.setRuntime(entry, { phone, browser })
      }
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
    // The renderer's own copy first, in case the corruption is only on screen.
    entry.term.refresh(0, rows - 1)
    // A pane somebody else is holding is one this desk may not move, and the
    // grid on screen is theirs — sending it back as *this* desk's wish would
    // mean sitting down and typing landed on their width rather than on the one
    // this box measured. Repainting locally is the whole of what can be done
    // here, and it is also the half that fixes a mess that is only on screen.
    if (entry.desired) return
    entry.ptyDims = { cols, rows }
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
   * How much this pane has said since it was spawned, and how long ago it last
   * spoke — the two numbers a caller needs to tell "the agent is up and waiting"
   * from "the shell is up and the agent is still loading".
   *
   * `live` alone cannot tell them apart: conpty reports the shell running, the
   * bootstrap command is echoed, and then node spends a second or three loading
   * the agent in silence. A brief pasted into that silence lands at the
   * PowerShell prompt, and a PowerShell prompt runs it. An agent, by contrast,
   * announces itself with a banner of a few kilobytes and then waits — so a
   * pane that has printed plenty and then gone quiet is one you can paste into.
   */
  readiness(paneId: string): { outputBytes: number; quietForMs: number } {
    const entry = this.entries.get(paneId)
    if (!entry) return { outputBytes: 0, quietForMs: 0 }
    return {
      outputBytes: entry.outputBytes,
      quietForMs: entry.busyLastOutput > 0 ? performance.now() - entry.busyLastOutput : 0
    }
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

  /**
   * Hear about the local dev server any pane announces, as `(cwd, url)`.
   *
   * One list for the whole app rather than one per pane: the caller is the app
   * state, which turns a cwd into a project and remembers the URL there, and it
   * cares about every project's terminals at once — including the ones whose
   * shells are still running in a workspace nobody is currently looking at.
   */
  onDevUrl(cb: (cwd: string, url: string) => void): () => void {
    this.devUrlListeners.add(cb)
    return () => {
      this.devUrlListeners.delete(cb)
    }
  }

  /**
   * The PTY pids of every live pane rooted at this folder.
   *
   * For the ownership check behind the Devices preview: a dev server started
   * from one of a project's panes is a descendant of that pane's shell, however
   * many wrappers `npm run dev` puts in between, so these pids are the roots the
   * check walks up to. Keyed on cwd for the same reason `onDevUrl` reports one:
   * a pane's cwd is its project, and which particular terminal ran the server is
   * nobody's business here.
   *
   * Exited panes contribute nothing — their runtime pid is nulled on exit — and
   * an empty list is a perfectly ordinary answer, meaning the server (if there
   * is one) was started somewhere else.
   */
  pidsForCwd(cwd: string): number[] {
    if (!cwd) return []
    const pids: number[] = []
    for (const entry of this.entries.values()) {
      if (entry.spec.cwd !== cwd) continue
      const pid = entry.runtime.pid
      if (typeof pid === 'number' && pid > 0) pids.push(pid)
    }
    return pids
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
