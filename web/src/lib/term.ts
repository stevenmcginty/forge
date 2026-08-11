import { Terminal, type ITheme } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'

/**
 * An xterm instance fed relayed PTY bytes.
 *
 * Decision 6 in docs/forge-web.md: the terminal widget is xterm.js on real PTY
 * bytes, because Claude Code is a full-screen TUI and a prettier "blocks of
 * output" view cannot render one.
 *
 * Deliberately *not* a copy of src/lib/terminals.ts. That file is 1,400 lines
 * because it owns the mosaic, pane peeking, remote-URL scanning, the desktop's
 * focus model and an IPC channel per pane — none of which exist here, where a
 * pane is a socket subscription. What is shared is the emulator and its palette,
 * which are the parts that have to be faithful, and the palette is shared by
 * being *read off the same design tokens* rather than written down twice.
 *
 * Closest in shape to mobile/src/lib/term.ts, which already solved the fiddly
 * parts of driving xterm against a relayed PTY. Two of them are carried over
 * verbatim in spirit:
 *
 *  1. **Never fit a container with no box.** A container mid-layout makes
 *     FitAddon compute a nonsense geometry and resize the real PTY to it.
 *  2. **A ResizeObserver is the retry for a fit that came too early.** The
 *     effect that mounts a terminal runs before flex has settled, and without
 *     something watching, the terminal stays at 80×24 while the PTY stays at
 *     whatever the desktop last set — output wrapped for a screen twice as wide
 *     as the one showing it.
 *
 * ## The cursor-position query, which is not optional
 *
 * `CSI 6 n` is a Device Status Report, and pwsh asks it constantly — hardest
 * right after a resize, because PSReadLine has to know where its line begins
 * before it can repaint. xterm answers it in microseconds *when a terminal is
 * attached*. With nothing on the end of the PTY, ConPTY waits out a timeout
 * instead: measured in scripts/web-smoke.mjs at **39 seconds** for one resize,
 * against 47ms once the question is answered. So a browser that renders a pane
 * must be a terminal, not a viewer — and xterm's own reply path (`onData`, which
 * carries the DSR response back) is what makes it one, provided the client
 * actually sends what `onData` produces. That is the whole reason `onData` here
 * is wired straight to `write` on the socket rather than filtered to keystrokes.
 */

export interface TermHost {
  term: Terminal
  /** Refit to the container and return the new geometry, or null if unchanged. */
  fit: () => { cols: number; rows: number } | null
  /** The geometry as it stands, whether or not the last fit changed it. */
  size: () => { cols: number; rows: number }
  write: (data: string) => void
  /** Wipe screen and scrollback — used before painting a replay buffer. */
  reset: () => void
  focus: () => void
  /**
   * Stop taking input, or start again, without rebuilding the terminal.
   *
   * A pane whose socket has dropped keeps the emulator it already has — see
   * `PaneView`, where tearing one down costs a detach, a re-attach and up to
   * MAX_REPLAY_BYTES — so "this is not live right now" has to be something a
   * running instance can be told. No effect on a host built `readOnly`, which
   * never wired `onData` in the first place.
   */
  setReadOnly: (readOnly: boolean) => void
  dispose: () => void
}

export interface TermOptions {
  fontSize: number
  fontFamily: string
  /** The pane's agent accent, which is what colours the cursor on the desktop. */
  accent: string
  /** Everything xterm produces: keystrokes, pastes, and DSR replies. See header. */
  onData: (data: string) => void
  onResize: (cols: number, rows: number) => void
  /** A read-only frozen transcript takes no input and shows no cursor. */
  readOnly?: boolean
}

/**
 * The palette, off the design tokens.
 *
 * The same token names src/lib/terminals.ts reads, and read the same way, so the
 * browser's terminals and the desktop's are the same colours by construction
 * rather than by somebody keeping two lists in step. Cached for the same reason
 * it is cached there: `getComputedStyle` is not free and the tokens only move
 * when the theme does.
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

/** Only reached if tokens.css failed to load at all. */
const TERM_FALLBACK = '#e8eaed'

/**
 * How long a container has to hold still before it is worth refitting.
 *
 * Read off the design tokens rather than named here, for the reason the palette
 * above is: the thing this number is *about* is timed by a token. Collapsing the
 * rail transitions `.app__left`'s width over `--dur-med` (see src/App.css), so
 * every pane's box moves for the whole of that transition, and a number invented
 * in this file would drift the moment somebody retimed the rail — and the
 * reduced-motion override, which sets the token to `0ms`, would never reach it
 * at all.
 */
let settleCache: number | null = null

/** Only reached if tokens.css failed to load. `--dur-med`'s own value. */
const SETTLE_FALLBACK = 180

function settleMs(): number {
  if (settleCache !== null) return settleCache
  const raw = getComputedStyle(document.documentElement).getPropertyValue('--dur-med').trim()
  const value = Number.parseFloat(raw)
  // Tokens are written in ms today; seconds are honoured anyway rather than
  // silently read as a thousandth of themselves if that ever changes.
  settleCache = Number.isFinite(value) ? (raw.endsWith('ms') ? value : value * 1000) : SETTLE_FALLBACK
  return settleCache
}

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
 * A complete 16-colour dark theme, every slot handed over explicitly.
 *
 * That is what lets a TUI which probes the terminal — Claude Code does — see a
 * dark background and pick its dark theme instead of defaulting to white. The
 * desktop's `baseTheme` says the same thing; this is the same decision reached
 * from the same tokens.
 */
function themeFor(accent: string): ITheme {
  const p = palette()
  return {
    background: p['bg']!,
    foreground: p['fg']!,
    cursor: accent,
    cursorAccent: p['cursor-accent']!,
    selectionBackground: p['selection']!,
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

export function mountTerm(container: HTMLElement, options: TermOptions): TermHost {
  const term = new Terminal({
    fontSize: options.fontSize,
    fontFamily: options.fontFamily,
    // Enough rows that the first paint is not a one-line window; fit() corrects
    // it as soon as the container has a size.
    cols: 80,
    rows: 24,
    cursorBlink: !options.readOnly,
    disableStdin: options.readOnly === true,
    // MAX_REPLAY_BYTES is 192KB of catch-up, so more scrollback than this is
    // memory nothing can fill. The desktop keeps 20,000 because it owns the
    // session for its whole life; a browser only ever sees the tail.
    scrollback: 5000,
    allowProposedApi: true,
    theme: themeFor(options.accent)
  })

  const fitAddon = new FitAddon()
  term.loadAddon(fitAddon)
  term.open(container)

  // Canvas rendering, not WebGL. The desktop loads the WebGL addon because it is
  // one long-lived window; a browser tab loses its WebGL context whenever the
  // tab is backgrounded on a machine under memory pressure and comes back blank,
  // which is exactly what mobile/src/lib/term.ts found on Android.

  if (!options.readOnly) term.onData(options.onData)

  let lastCols = 0
  let lastRows = 0

  const fit = (): { cols: number; rows: number } | null => {
    // A container with no box — mid-layout, or a tab that is not on screen —
    // makes FitAddon compute a nonsense geometry and resize the real PTY to it.
    if (container.clientWidth < 8 || container.clientHeight < 8) return null
    try {
      fitAddon.fit()
    } catch {
      return null
    }
    if (term.cols === lastCols && term.rows === lastRows) return null
    lastCols = term.cols
    lastRows = term.rows
    options.onResize(term.cols, term.rows)
    return { cols: term.cols, rows: term.rows }
  }

  /*
   * The retry for a fit that arrived before the flex layout had settled (see the
   * note in the header) — and the throttle that keeps it from being a flood.
   *
   * A box does not change once when it changes: `.app__left` animates its width
   * over `--dur-med`, so collapsing the rail moves every pane's container on
   * every frame of that transition, and each frame that lands on a new cols/rows
   * is a `resize` frame the desktop counts against MAX_INPUT_PER_SECOND — 120,
   * shared by every frame this browser sends. Four panes riding one animation,
   * or a window being dragged, can pass it, and the refusal comes back as "slow
   * down", which is a nonsense sentence about a window somebody resized.
   *
   * So: every observation in one animation frame is coalesced into a single
   * callback, the first one after a quiet spell is acted on immediately — a pane
   * that has just mounted must not sit at 80×24 for the length of an animation
   * it is not part of — and everything after that waits until the box has been
   * still for `--dur-med`. An animation therefore costs two fits rather than
   * one per frame, and only the ones that actually changed the geometry send
   * anything, because `fit` returns null otherwise.
   */
  let frame = 0
  let settling = 0
  const observer = new ResizeObserver(() => {
    if (frame) return
    frame = requestAnimationFrame(() => {
      frame = 0
      if (settling) clearTimeout(settling)
      else fit()
      settling = window.setTimeout(() => {
        settling = 0
        fit()
      }, settleMs())
    })
  })
  observer.observe(container)

  return {
    term,
    fit,
    size: () => ({ cols: term.cols, rows: term.rows }),
    write: (data) => term.write(data),
    reset: () => term.reset(),
    focus: () => term.focus(),
    setReadOnly: (readOnly) => {
      // A host built read-only never wired `onData`, so letting it take input
      // again would put keystrokes somewhere there is nothing to receive them.
      if (options.readOnly) return
      // `disableStdin` is read live by xterm's core service, and it also marks
      // the textarea read-only, so the caret stops taking keys rather than
      // taking them into a socket that is not there. The blink goes with it,
      // because a blinking cursor is the one part of a terminal that claims to
      // be waiting for you. Note that it gates xterm's *replies* as well as its
      // keystrokes — including the `CSI 6 n` answer this file's header is about
      // — which is why the caller switches it back the moment the link is live
      // and not a beat later.
      term.options.disableStdin = readOnly
      term.options.cursorBlink = !readOnly
    },
    dispose: () => {
      if (frame) cancelAnimationFrame(frame)
      if (settling) clearTimeout(settling)
      observer.disconnect()
      term.dispose()
    }
  }
}

/*
 * There is deliberately no window-level "refit everything" helper here, unlike
 * mobile's `onViewportSettled`. A phone needs one because Android's soft
 * keyboard changes the *visual viewport* without necessarily changing any
 * element's layout box, so the ResizeObserver sees nothing. A desktop browser
 * has no such case: every window resize changes the pane containers' boxes, the
 * observer above fires, and a second path would only send a duplicate `resize`
 * per pane per drag.
 */
