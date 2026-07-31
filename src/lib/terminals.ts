import { Terminal, type ITheme } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import type { PtyDataEvent, PtyExitEvent } from '@shared/types'
import { findRemoteSessionUrl } from '@shared/remote'

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

const IDLE_RUNTIME: PaneRuntime = { status: 'idle', pid: null, exitCode: null, error: null, remoteUrl: null }

/**
 * How much of the previous chunk to re-scan for the Remote Control URL. PTY
 * output arrives in arbitrary slices, so the URL can straddle two of them; a
 * short overlap costs nothing and means we never miss it by one byte.
 */
const URL_SCAN_OVERLAP = 256

const ACTIVITY_THROTTLE_MS = 90

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
  /** Tail of the last output chunk, kept only until the RC URL is found. */
  scanTail: string
  lastActivityNotify: number
  activityTimer: number | null
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

class TerminalHost {
  private entries = new Map<string, Entry>()
  private listeners = new Map<string, Listeners>()
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
    })

    window.forge.pty.onExit((e: PtyExitEvent) => {
      const entry = this.entries.get(e.id)
      if (!entry) return
      entry.term.write(
        `\r\n\x1b[38;2;106;112;120m── session ended (exit ${e.exitCode}) ─ press Enter to relaunch\x1b[0m\r\n`
      )
      this.setRuntime(entry, { status: 'exited', exitCode: e.exitCode, pid: null })
    })
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
      runtime: { ...IDLE_RUNTIME },
      container: null,
      mode: 'tab',
      geometry: null,
      resizeObserver: null,
      pendingResize: null,
      resizeTimer: null,
      ptyDims: null,
      jiggleTimer: null,
      scanTail: '',
      lastActivityNotify: 0,
      activityTimer: null,
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
      window.forge.pty.write(paneId, data)
    })
    entry.disposers.push(() => dataSub.dispose())

    // Not sent straight down: xterm resizes with the drag, ConPTY waits for it
    // to finish. See queuePtyResize.
    const resizeSub = term.onResize(({ cols, rows }) => {
      this.queuePtyResize(entry, cols, rows)
    })
    entry.disposers.push(() => resizeSub.dispose())

    term.attachCustomKeyEventHandler((e) => this.handleKey(paneId, term, e))

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
   * Windows-terminal clipboard conventions, intercepted per pane so a key only
   * stops reaching the shell when we actually handled it.
   *
   *   Ctrl+C          copies when there is a selection, otherwise falls through
   *                   as ^C so it still interrupts a running command
   *   Ctrl+V          pastes (bracketed-paste safe, via term.paste)
   *   Ctrl+Shift+C/V  the same, unconditionally — the classic aliases
   *
   * Returning false stops xterm sending the key to the PTY; preventDefault is
   * also needed, because Chromium would otherwise run its own paste command on
   * the textarea and we would paste twice.
   */
  private handleKey(paneId: string, term: Terminal, e: KeyboardEvent): boolean {
    if (e.type !== 'keydown' || !e.ctrlKey || e.altKey || e.metaKey) return true
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
      ...(entry.spec.sessionId ? { sessionId: entry.spec.sessionId } : {})
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
    window.forge.pty.write(paneId, text.replace(/[\r\n]+/g, ' '))
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
