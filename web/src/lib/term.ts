import { Terminal, type ITheme } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { planTouchScroll } from '@shared/touch-scroll'

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
 * ## Whose grid this is, which is sometimes this browser's
 *
 * A PTY has one grid and Forge Web is one viewer of it. **The grid belongs to
 * the device somebody last typed into the pane on**
 * (electron/pty/grid-owner.ts): type in this tab and its own fit lands on the
 * real PTY, so a big screen is a big terminal; type at the desk and the desk
 * takes it back, and this tab draws the desk's grid instead. Merely opening a
 * pane and reading it moves nothing anywhere, which is what makes it safe to
 * leave a browser watching a machine somebody else is working at.
 *
 * So this file does two things at once, and neither of them depends on knowing
 * the policy: it goes on fitting the container and reporting that geometry
 * through `onResize` — the wish, granted whenever this browser is the device
 * being typed on — and it draws whatever grid the desktop says the session
 * really has, shrinking the *font* until that grid fits the box it has.
 * `follow` is where the second half happens, and when the two agree, which is
 * the whole of the case where this browser is the one holding the pane, it does
 * nothing at all.
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
  /**
   * Refit to the container and return the browser's own geometry, or null if it
   * is unchanged. Note that this is the size this browser *would like* — what is
   * on screen afterwards is somebody else's grid whenever somebody else is the
   * one holding this pane. See `follow`.
   */
  fit: () => { cols: number; rows: number } | null
  /** The geometry this browser wants, whether or not the last fit changed it. */
  size: () => { cols: number; rows: number }
  /**
   * Draw the grid the desktop says this session actually has, or null to go
   * back to drawing this browser's own fit. See the geometry note in the header.
   */
  follow: (size: { cols: number; rows: number } | null) => void
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

/**
 * How small the font may go while shrinking a desktop grid into this box.
 *
 * There is a size below which a terminal stops being readable and starts being
 * a texture, and a pane rendered at 4px is not "still working" in any sense
 * that matters. At the floor the shrinking stops and the terminal overflows its
 * box, which `.pane__terminal` clips — see the note beside the pane wall in
 * styles.css for why the obvious `overflow: auto` there is worse than the
 * clipping. It takes a desk pane roughly twice this window's width to reach it.
 */
const MIN_FONT_PX = 7

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
    // Same ConPTY as the desktop renderer. Without this, xterm's wrap
    // heuristics assume a POSIX pty and a TUI on Windows loses the first
    // column of a wrapped row — which is how the Grok wordmark reads as "rok".
    windowsPty: { backend: 'conpty' },
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
  /** The grid this browser's own box would hold at this browser's own font. */
  let natural: { cols: number; rows: number } | null = null
  /** The grid the desktop says this session actually has. Null while unknown. */
  let desired: { cols: number; rows: number } | null = null

  /**
   * Put the right grid on screen at the largest font it fits in.
   *
   * The session's real grid whenever this pane has been told one, and this browser's
   * own until then. When the two agree — which is the whole of the case where
   * this browser is the device being typed on and the wish below was granted —
   * the second branch finds nothing to change and costs a comparison.
   *
   * The scale comes out of the two grids rather than out of any measurement of
   * a character: `natural` is what this box holds at `options.fontSize`, so
   * `natural.cols / desired.cols` is exactly the factor the type has to come
   * down by for `desired.cols` of them to fit the same width. Never *up*,
   * because a desk pane narrower than this window is better letterboxed than
   * blown up past the size the rest of the page is set in.
   */
  const apply = (): void => {
    // Nobody has told this pane what the desktop's grid is, so this browser's
    // own is the only one there is — and the addon's own `fit` is what applies
    // it, rather than a hand-rolled resize that would be the same call minus
    // whatever else it does on the way.
    if (!desired) {
      if (term.options.fontSize !== options.fontSize) term.options.fontSize = options.fontSize
      try {
        fitAddon.fit()
      } catch {
        /* xterm throws if measured mid-teardown — harmless */
      }
      return
    }
    if (desired.cols < 1 || desired.rows < 1) return
    const scale = natural ? Math.min(natural.cols / desired.cols, natural.rows / desired.rows) : 1
    const size = scale >= 1 ? options.fontSize : Math.max(MIN_FONT_PX, Math.floor(options.fontSize * scale))
    if (term.options.fontSize !== size) term.options.fontSize = size
    if (term.cols === desired.cols && term.rows === desired.rows) return
    try {
      term.resize(desired.cols, desired.rows)
      // A resize is not on its own a repaint, and this one is not the addon's:
      // `FitAddon.fit` wipes the rendered rows before it resizes, and skipping
      // that step is measurably not free — a freshly mounted terminal resized
      // this way and then written to came up blank in scripts/web-e2e.mjs. The
      // desktop's own `redraw` reaches for the same public refresh.
      term.refresh(0, term.rows - 1)
    } catch {
      /* xterm throws if measured mid-teardown — harmless */
    }
  }

  // The finger, which is the only pointer a phone has. See `enableTouchScroll`.
  // The size handed over is the one currently *drawn* rather than
  // `options.fontSize`, because `apply` above may be shrinking the desktop's
  // grid into this box — and a row is as tall as the type it is set in.
  const releaseTouch = enableTouchScroll(
    container,
    term,
    () => term.options.fontSize ?? options.fontSize,
    options.readOnly ? undefined : options.onData
  )

  const fit = (): { cols: number; rows: number } | null => {
    // A container with no box — mid-layout, or a tab that is not on screen —
    // makes FitAddon compute a nonsense geometry, and a nonsense geometry is
    // what the desktop would be asked for.
    if (container.clientWidth < 8 || container.clientHeight < 8) return null
    // Measured at this browser's own type size, whatever the terminal is
    // currently drawn at: the wish is "the grid I would choose", not "the grid
    // I would choose if I stayed squinting at the desktop's". xterm remeasures
    // its cell synchronously when the option is set, so what `proposeDimensions`
    // reads a line later is already the new one — and `propose` rather than
    // `fit`, because measuring the box and deciding what goes on screen are two
    // different questions here. `apply` answers the second one.
    if (term.options.fontSize !== options.fontSize) term.options.fontSize = options.fontSize
    let proposed
    try {
      proposed = fitAddon.proposeDimensions()
    } catch {
      // Measured mid-teardown, or before the renderer exists. The observer
      // below is the retry, exactly as it is for a container with no box.
      return null
    }
    if (!proposed || !Number.isFinite(proposed.cols) || !Number.isFinite(proposed.rows)) return null
    natural = { cols: proposed.cols, rows: proposed.rows }
    apply()
    if (natural.cols === lastCols && natural.rows === lastRows) return null
    lastCols = natural.cols
    lastRows = natural.rows
    options.onResize(natural.cols, natural.rows)
    return { cols: natural.cols, rows: natural.rows }
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
    // The wish, not what is on screen: this is what `attach` carries, and an
    // attach that carried the desktop's own grid back to it would be a browser
    // that could never say what it wants once it had been told once.
    size: () => natural ?? { cols: term.cols, rows: term.rows },
    follow: (size) => {
      const next = size && size.cols > 0 && size.rows > 0 ? { cols: size.cols, rows: size.rows } : null
      if (next?.cols === desired?.cols && next?.rows === desired?.rows) return
      desired = next
      apply()
    },
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
      releaseTouch()
      term.dispose()
    }
  }
}

/**
 * Drag the scrollback with a finger.
 *
 * Ported from mobile/src/lib/term.ts, whose comment there explains the shape at
 * length; the short version is that xterm scrolls its viewport from wheel events
 * and from the keyboard, and a phone has neither. `scrollback: 5000` above was
 * therefore history that was kept and could not be reached: on a handset the
 * window is around twenty rows, so what an agent said thirty lines ago was gone
 * for good. The desktop's wheel works, which is exactly why this went unnoticed
 * — the client is the same client in both browsers and only one of them has a
 * wheel.
 *
 * ## Where the finger's movement is sent, which depends on what the pane is
 *
 * Routed by `planTouchScroll` in shared/touch-scroll.ts, which is the whole of
 * the decision: a constructed `WheelEvent` is how this used to talk to a TUI,
 * and it is how Grok's conversation never moved. xterm 6's viewport reads
 * `wheelDeltaY` (always 0 on a constructed event) so the normal buffer has to
 * go through `scrollLines`; a TUI on the alternate screen wants SGR wheel
 * reports or PageUp/PageDown written down the PTY, not arrows — Grok's prompt
 * eats those. Claude Code writes the normal buffer, so it was never on this
 * path and kept working.
 *
 * ## And the rest, which is mobile's design unchanged
 *
 * **A threshold before it commits.** Under `DRAG_START_PX` the gesture is still
 * a tap, so tap-to-focus keeps working and the keyboard still opens. Past it the
 * drag is a scroll, and `preventDefault` keeps the browser from also treating it
 * as a page pan or a pull-to-refresh — the other half of which is the
 * `touch-action` on `.pane__terminal` in styles.css.
 *
 * The accumulator carries the remainder between moves rather than rounding each
 * one, so a slow drag scrolls smoothly instead of quantising to nothing. Rows
 * are measured rather than assumed because this client draws the desktop's grid
 * at a shrunken font (see `follow`), so a row here is not `fontSize` tall.
 *
 * Multi-touch is ignored outright: two fingers is a zoom or a system gesture,
 * and reading it as a scroll is how a pinch scrolls a terminal to its top.
 */
function enableTouchScroll(
  container: HTMLElement,
  term: Terminal,
  fontSize: () => number,
  send?: (data: string) => void
): () => void {
  const DRAG_START_PX = 8

  let tracking = false
  let scrolling = false
  let lastY = 0
  let startY = 0
  let carry = 0

  /** The height of one row, measured rather than assumed. */
  const rowHeight = (): number => {
    const rows = term.element?.querySelector('.xterm-rows') as HTMLElement | null
    const measured = rows && term.rows > 0 ? rows.clientHeight / term.rows : 0
    // Before the first paint there is nothing to measure; the font size is a
    // serviceable stand-in and only affects the first few pixels of a drag.
    return measured > 1 ? measured : Math.max(1, fontSize() * 1.2)
  }

  const onStart = (event: TouchEvent): void => {
    if (event.touches.length !== 1) {
      tracking = false
      scrolling = false
      return
    }
    tracking = true
    scrolling = false
    carry = 0
    startY = event.touches[0]!.clientY
    lastY = startY
  }

  const onMove = (event: TouchEvent): void => {
    if (!tracking || event.touches.length !== 1) return
    const y = event.touches[0]!.clientY

    if (!scrolling) {
      if (Math.abs(y - startY) < DRAG_START_PX) return
      scrolling = true
    }

    // Dragging down reveals older output, which is scrolling *up* the buffer —
    // a negative count, which is what both branches below want: a negative wheel
    // delta, same as a physical wheel, and a negative `scrollLines`.
    carry += lastY - y
    lastY = y

    const height = rowHeight()
    const lines = Math.trunc(carry / height)
    if (lines !== 0) {
      carry -= lines * height
      const plan = planTouchScroll(
        lines,
        term.buffer.active.type === 'alternate',
        term.modes.mouseTrackingMode !== 'none'
      )
      if (plan.kind === 'viewport') {
        term.scrollLines(plan.lines)
      } else if (send) {
        send(plan.data)
      }
    }
    event.preventDefault()
  }

  const onEnd = (): void => {
    tracking = false
    scrolling = false
  }

  // `passive: false` on move, because preventDefault is the whole point once a
  // drag has been claimed; the others stay passive so they cost nothing.
  container.addEventListener('touchstart', onStart, { passive: true })
  container.addEventListener('touchmove', onMove, { passive: false })
  container.addEventListener('touchend', onEnd, { passive: true })
  container.addEventListener('touchcancel', onEnd, { passive: true })

  return () => {
    container.removeEventListener('touchstart', onStart)
    container.removeEventListener('touchmove', onMove)
    container.removeEventListener('touchend', onEnd)
    container.removeEventListener('touchcancel', onEnd)
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
