import { Terminal, type ITheme } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { SHARE_CAPTURE_MAX_LINES } from '@shared/share'
import { planPointerDelta, wheelDeltaPx, type ScrollCarry } from '@shared/touch-scroll'
import { joinBufferRows, tidyCapture, type BufferRow } from '@/lib/paneText'
import type { RichLine, Run } from '@/lib/rich'

/**
 * An xterm instance fed relayed PTY bytes.
 *
 * Decision 6 in docs/forge-web.md: the terminal widget is xterm.js on real PTY
 * bytes, because Claude Code is a full-screen TUI and a prettier "blocks of
 * output" view cannot *be* the emulator. A conversation feed can sit on top of
 * this capture (see web/src/lib/feed.ts); it cannot replace this file.
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
  write: (data: string, after?: () => void) => void
  /** Wipe screen and scrollback — used before painting a replay buffer. */
  reset: () => void
  /**
   * The screen as text, scrollback included. Used by the conversation feed so
   * the page can draw cards without being the TUI. Same join as a desktop
   * capture: wrapped rows become one line.
   */
  capture: () => string
  /**
   * The same screen with its colours kept — the conversation display's source.
   *
   * `capture()` throws every attribute away, which is why the feed reads as a
   * plain-text log of something that was drawn in six colours. This walks the
   * same buffer and the same joins, but cell by cell, grouping adjacent cells
   * that share a style into runs (see lib/rich.ts). Capped at
   * SHARE_CAPTURE_MAX_LINES like `capture()`, and bounded by that cap rather
   * than by the depth of the scrollback — see `captureRichTail`.
   */
  captureRich: () => RichLine[]
  /** `captureRich` with the cap chosen by the caller. Never above the shared cap. */
  captureRichTail: (maxLines: number) => RichLine[]
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
  /**
   * A wheel or a finger over an alt-screen TUI (Grok, OpenCode). Returns true
   * when the gesture was spent as PTY bytes — PageUp/PageDown or SGR wheel at
   * 1;1 — so the caller can preventDefault. False on the normal buffer: the
   * feed should native-scroll the captured scrollback, and xterm should keep
   * the physical wheel.
   */
  driveScroll: (deltaY: number, deltaMode?: number) => boolean
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

/* --------------------------------------------------- colour, cell by cell */

/**
 * The sixteen ANSI slots in the order a cell reports them, named as tokens.
 *
 * Same list `themeFor` hands xterm, in the order `CSI 3(0-7) m` / `CSI 9(0-7) m`
 * number them — so a cell that says "palette 4" and the blue xterm is painting
 * it in are the same `--term-blue`, by construction rather than by a second
 * list agreeing with the first.
 */
const ANSI_TOKENS = [
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

/**
 * A palette index as a CSS colour.
 *
 * 0–15 are the theme's own; 16–231 are the 6×6×6 cube xterm defines, whose
 * levels are 0 then 55+40n; 232–255 are the 24-step greyscale ramp. The cube
 * and the ramp are fixed by the protocol rather than by a theme, so they are
 * computed rather than tokenised.
 */
function paletteColor(index: number): string | undefined {
  if (!Number.isFinite(index) || index < 0) return undefined
  if (index < 16) return palette()[ANSI_TOKENS[index]!]
  if (index < 232) {
    const i = index - 16
    const level = (n: number): number => (n === 0 ? 0 : 55 + n * 40)
    return `rgb(${level(Math.floor(i / 36) % 6)}, ${level(Math.floor(i / 6) % 6)}, ${level(i % 6)})`
  }
  if (index < 256) {
    const v = 8 + (index - 232) * 10
    return `rgb(${v}, ${v}, ${v})`
  }
  return undefined
}

/** `0xRRGGBB`, as xterm reports a true-colour cell, to CSS. */
function rgbColor(value: number): string {
  return `rgb(${(value >> 16) & 0xff}, ${(value >> 8) & 0xff}, ${value & 0xff})`
}

/** Cell attribute flags, packed so a run boundary is one integer comparison. */
const BOLD = 1
const DIM = 2
const ITALIC = 4
const UNDERLINE = 8
const STRIKE = 16
const INVERSE = 32

/**
 * xterm's cell and line views, taken off the `Terminal` type rather than
 * imported: the public typings declare them inside the module without an
 * `export`, so this is the supported way to name them.
 */
type BufferCell = ReturnType<Terminal['buffer']['active']['getNullCell']>
type BufferLine = NonNullable<ReturnType<Terminal['buffer']['active']['getLine']>>

/** One row of cells, as the pieces a logical line is built from. */
interface RichRow {
  runs: Run[]
  text: string
  wrapped: boolean
}

/**
 * Turn one buffer row into styled runs.
 *
 * Trailing blanks go, the same way `line.translateToString(true)` drops them
 * for `capture()`, so the two produce the same text for the same row. Width-0
 * cells are the second half of a wide glyph and are skipped — the glyph itself
 * already carries both columns.
 */
function rowRich(line: BufferLine, cell: BufferCell): RichRow {
  const width = line.length

  // The last column that is not blank. Found first so the run builder never has
  // to unpick a trailing run it should not have started.
  let last = -1
  for (let x = width - 1; x >= 0; x--) {
    if (!line.getCell(x, cell)) continue
    const chars = cell.getChars()
    if (chars !== '' && chars.trim() !== '') {
      last = x
      break
    }
  }
  if (last < 0) return { runs: [], text: '', wrapped: line.isWrapped }

  const runs: Run[] = []
  let text = ''
  let buf = ''
  // The attributes the open run was started with. -1 is "no run open yet".
  let fgMode = -1
  let fgColor = -1
  let bgMode = -1
  let bgColor = -1
  let flags = -1

  const close = (): void => {
    if (!buf) return
    const inverse = (flags & INVERSE) !== 0
    let fg = fgMode === 0 ? undefined : fgMode === 1 ? paletteColor(fgColor) : rgbColor(fgColor)
    let bg = bgMode === 0 ? undefined : bgMode === 1 ? paletteColor(bgColor) : rgbColor(bgColor)
    if (inverse) {
      const p = palette()
      const swapped = { fg: bg ?? p['bg'], bg: fg ?? p['fg'] }
      fg = swapped.fg
      bg = swapped.bg
    }
    const run: Run = { text: buf }
    if (fg) run.fg = fg
    if (bg) run.bg = bg
    if (flags & BOLD) run.bold = true
    if (flags & DIM) run.dim = true
    if (flags & ITALIC) run.italic = true
    if (flags & UNDERLINE) run.underline = true
    if (flags & STRIKE) run.strike = true
    runs.push(run)
    buf = ''
  }

  for (let x = 0; x <= last; x++) {
    if (!line.getCell(x, cell)) continue
    if (cell.getWidth() === 0) continue
    // An empty cell is a space that was never written to, not a missing one.
    const chars = cell.getChars() || ' '
    // The colour *mode* rather than the resolved CSS: comparing five integers
    // is what keeps this cheap enough to run on every frame of streaming
    // output, and the CSS is only computed once per run, in `close`.
    const nextFgMode = cell.isFgDefault() ? 0 : cell.isFgPalette() ? 1 : 2
    const nextBgMode = cell.isBgDefault() ? 0 : cell.isBgPalette() ? 1 : 2
    const nextFg = nextFgMode === 0 ? -1 : cell.getFgColor()
    const nextBg = nextBgMode === 0 ? -1 : cell.getBgColor()
    const nextFlags =
      (cell.isBold() ? BOLD : 0) |
      (cell.isDim() ? DIM : 0) |
      (cell.isItalic() ? ITALIC : 0) |
      (cell.isUnderline() ? UNDERLINE : 0) |
      (cell.isStrikethrough() ? STRIKE : 0) |
      (cell.isInverse() ? INVERSE : 0)

    if (nextFgMode !== fgMode || nextFg !== fgColor || nextBgMode !== bgMode || nextBg !== bgColor || nextFlags !== flags) {
      close()
      fgMode = nextFgMode
      fgColor = nextFg
      bgMode = nextBgMode
      bgColor = nextBg
      flags = nextFlags
    }
    buf += chars
    text += chars
  }
  close()
  return { runs, text, wrapped: line.isWrapped }
}

/** The rows of one logical line, top-first, as a single `RichLine`. */
function joinRichRows(rows: RichRow[]): RichLine {
  if (rows.length === 1) return { runs: rows[0]!.runs, text: rows[0]!.text }
  const runs: Run[] = []
  let text = ''
  for (const row of rows) {
    for (const run of row.runs) runs.push(run)
    text += row.text
  }
  return { runs, text }
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

  // xterm builds its helper textarea in open(), so these can only be set now.
  // On a phone this page is typed into through Gboard, which is not a keyboard
  // but an input method that *composes*: with autocorrect and prediction on,
  // a word arrives once from the composition and once more from the input
  // event, and the box shows it twice. Same four switches as
  // mobile/src/lib/term.ts, for the same reason.
  const textarea = term.textarea
  if (textarea) {
    textarea.setAttribute('autocapitalize', 'off')
    textarea.setAttribute('autocorrect', 'off')
    textarea.setAttribute('autocomplete', 'off')
    textarea.setAttribute('spellcheck', 'false')
  }

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

  // The finger, which is the only pointer a phone has, and the wheel on a
  // desktop browser. See `enableTouchScroll`. The size handed over is the one
  // currently *drawn* rather than `options.fontSize`, because `apply` above may
  // be shrinking the desktop's grid into this box — and a row is as tall as
  // the type it is set in.
  const scrollCarry: ScrollCarry = { px: 0 }
  const rowHeightOf = (): number => rowHeight(term, term.options.fontSize ?? options.fontSize)
  const releaseTouch = enableTouchScroll(
    container,
    term,
    rowHeightOf,
    scrollCarry,
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

  /**
   * The styled tail of the buffer, oldest line first.
   *
   * ## Backwards, which is the whole of the performance story
   *
   * The feed re-reads this on every frame of streaming output, and the
   * scrollback is 5,000 lines. Building all 5,000 to keep the last 400 is
   * 400,000 cell reads thrown away per parse, which on a phone is the
   * difference between a feed that scrolls and one that stutters — so the walk
   * starts at the bottom and stops as soon as it has `cap` logical lines. The
   * cost is therefore bounded by the *cap*, not by the depth of the scrollback:
   * a 5,000-line buffer and a 50-line one cost the same.
   *
   * That bound is deliberately preferred over caching rows by buffer index.
   * xterm's scrollback keeps its *content* stable but not its indices — once
   * the buffer is full, every new line shifts every index by one and nothing
   * public says by how much — so an index-keyed cache would need a fingerprint
   * per row to be safe, and taking that fingerprint costs the pass it was meant
   * to avoid. A stale-cache bug here draws somebody's last answer twice; this
   * cannot.
   *
   * The blank-line tidy is `tidyCapture`'s, reached from the other end: no
   * trailing blanks, no leading blanks, and never two blank lines in a row, so
   * the sixty empty rows under a TUI's composer do not become sixty cards.
   */
  const captureRichTail = (maxLines: number): RichLine[] => {
    const buffer = term.buffer.active
    const cap =
      Number.isFinite(maxLines) && maxLines > 0
        ? Math.min(Math.floor(maxLines), SHARE_CAPTURE_MAX_LINES)
        : SHARE_CAPTURE_MAX_LINES
    // One reusable cell object, as xterm's own docs ask for: a fresh one per
    // cell is the allocation this walk exists to avoid.
    const cell = buffer.getNullCell()
    /** Logical lines, bottom-first. Reversed before it is handed back. */
    const out: RichLine[] = []
    /** The rows of the logical line being assembled, bottom-first. */
    let rows: RichRow[] = []

    for (let y = buffer.length - 1; y >= 0 && out.length < cap; y--) {
      const line = buffer.getLine(y)
      if (!line) continue
      rows.push(rowRich(line, cell))
      // A wrapped row continues the row above it, so the line is not complete
      // until an unwrapped one arrives. A wrapped row at index 0 has nothing
      // above it to continue — `joinBufferRows` starts a line there too.
      if (line.isWrapped && y > 0) continue
      rows.reverse()
      const joined = joinRichRows(rows)
      rows = []
      if (!joined.text.trim()) {
        if (out.length === 0) continue
        if (!out[out.length - 1]!.text.trim()) continue
      }
      out.push(joined)
    }

    out.reverse()
    while (out.length > 0 && !out[0]!.text.trim()) out.shift()
    return out
  }

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
    write: (data, after) => {
      if (after) term.write(data, after)
      else term.write(data)
    },
    reset: () => term.reset(),
    capture: () => {
      const buffer = term.buffer.active
      const rows: BufferRow[] = []
      for (let y = 0; y < buffer.length; y++) {
        const line = buffer.getLine(y)
        if (!line) continue
        rows.push({ text: line.translateToString(true), wrapped: line.isWrapped })
      }
      return tidyCapture(joinBufferRows(rows), SHARE_CAPTURE_MAX_LINES)
    },
    captureRich: () => captureRichTail(SHARE_CAPTURE_MAX_LINES),
    captureRichTail,
    focus: () => term.focus(),
    driveScroll: (deltaY, deltaMode = 0) => {
      if (options.readOnly) return false
      const alt = term.buffer.active.type === 'alternate'
      const mouse = term.modes.mouseTrackingMode !== 'none'
      if (!alt && !mouse) {
        scrollCarry.px = 0
        return false
      }
      const height = rowHeightOf()
      const plan = planPointerDelta(
        scrollCarry,
        wheelDeltaPx(deltaY, deltaMode, height),
        height,
        alt,
        mouse
      )
      if (plan.kind === 'data') options.onData(plan.data)
      return true
    },
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

/** The height of one row, measured rather than assumed. */
function rowHeight(term: Terminal, fontSize: number): number {
  const rows = term.element?.querySelector('.xterm-rows') as HTMLElement | null
  const measured = rows && term.rows > 0 ? rows.clientHeight / term.rows : 0
  // Before the first paint there is nothing to measure; the font size is a
  // serviceable stand-in and only affects the first few pixels of a drag.
  return measured > 1 ? measured : Math.max(1, fontSize * 1.2)
}

/**
 * Drag the scrollback with a finger, and page a TUI with the wheel.
 *
 * Ported from mobile/src/lib/term.ts, whose comment there explains the shape at
 * length; the short version is that xterm scrolls its viewport from wheel events
 * and from the keyboard, and a phone has neither. `scrollback: 5000` above was
 * therefore history that was kept and could not be reached: on a handset the
 * window is around twenty rows, so what an agent said thirty lines ago was gone
 * for good.
 *
 * The desktop browser *has* a wheel, but leaving it to xterm is how Grok's
 * conversation never moved: on the alternate screen xterm turns a notch into
 * one arrow key, and Grok's focused prompt eats those. `attachCustomWheelEventHandler`
 * intercepts before that conversion; `planPointerDelta` then writes PageUp or
 * an SGR report at 1;1. Claude Code writes the normal buffer, so the handler
 * returns true and xterm keeps the wheel.
 *
 * ## Where the finger's movement is sent, which depends on what the pane is
 *
 * Routed by `planPointerDelta` in shared/touch-scroll.ts. A slow drag used to
 * call the planner once per row, and on Grok each call was a PageUp — the
 * conversation leapt. Remainder is held until a whole page (or a whole row of
 * SGR) has been travelled.
 *
 * ## And the rest, which is mobile's design unchanged
 *
 * **A threshold before it commits.** Under `DRAG_START_PX` the gesture is still
 * a tap, so tap-to-focus keeps working and the keyboard still opens. Past it the
 * drag is a scroll, and `preventDefault` keeps the browser from also treating it
 * as a page pan or a pull-to-refresh — the other half of which is the
 * `touch-action` on `.pane__terminal` in styles.css.
 *
 * **A fling when the finger lifts.** Native overflow has inertia; `scrollLines`
 * does not. The last velocity is decayed on animation frames so a flick keeps
 * moving. Only on the normal buffer — flinging PageUp at Grok would type.
 *
 * Multi-touch is ignored outright: two fingers is a zoom or a system gesture,
 * and reading it as a scroll is how a pinch scrolls a terminal to its top.
 */
function enableTouchScroll(
  container: HTMLElement,
  term: Terminal,
  measureRow: () => number,
  carry: ScrollCarry,
  send?: (data: string) => void
): () => void {
  const DRAG_START_PX = 8
  const DECAY = 0.94
  const MIN_FLING = 0.35

  let tracking = false
  let scrolling = false
  let lastY = 0
  let startY = 0
  let lastT = 0
  let velocity = 0
  let inertia = 0

  const stopInertia = (): void => {
    if (inertia) cancelAnimationFrame(inertia)
    inertia = 0
  }

  const applyDelta = (deltaY: number): 'viewport' | 'data' | null => {
    const alt = term.buffer.active.type === 'alternate'
    const mouse = term.modes.mouseTrackingMode !== 'none'
    const plan = planPointerDelta(carry, deltaY, measureRow(), alt, mouse)
    if (plan.kind === 'viewport') {
      if (plan.lines === 0) return null
      term.scrollLines(plan.lines)
      return 'viewport'
    }
    if (send) send(plan.data)
    return 'data'
  }

  const onStart = (event: TouchEvent): void => {
    if (event.touches.length !== 1) {
      tracking = false
      scrolling = false
      return
    }
    stopInertia()
    tracking = true
    scrolling = false
    carry.px = 0
    velocity = 0
    startY = event.touches[0]!.clientY
    lastY = startY
    lastT = performance.now()
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
    const now = performance.now()
    const dy = lastY - y
    const dt = Math.max(8, now - lastT)
    velocity = dy / dt
    lastT = now
    lastY = y
    applyDelta(dy)
    event.preventDefault()
  }

  const onEnd = (): void => {
    const fling = scrolling && velocity
    tracking = false
    scrolling = false
    // Inertia only for the normal buffer. Flinging PageUp at Grok or a
    // mouse-tracked TUI would type keys the person did not press.
    if (
      !fling ||
      Math.abs(velocity) < MIN_FLING ||
      term.buffer.active.type === 'alternate' ||
      term.modes.mouseTrackingMode !== 'none'
    ) {
      velocity = 0
      return
    }
    let v = velocity * 16
    const tick = (): void => {
      applyDelta(v)
      v *= DECAY
      if (Math.abs(v) < 0.5) {
        inertia = 0
        return
      }
      inertia = requestAnimationFrame(tick)
    }
    inertia = requestAnimationFrame(tick)
  }

  term.attachCustomWheelEventHandler((ev) => {
    if (ev.ctrlKey || ev.shiftKey) return true
    const alt = term.buffer.active.type === 'alternate'
    const mouse = term.modes.mouseTrackingMode !== 'none'
    if (!alt && !mouse) {
      carry.px = 0
      return true
    }
    ev.preventDefault()
    applyDelta(wheelDeltaPx(ev.deltaY, ev.deltaMode, measureRow()))
    return false
  })

  // `passive: false` on move, because preventDefault is the whole point once a
  // drag has been claimed; the others stay passive so they cost nothing.
  container.addEventListener('touchstart', onStart, { passive: true })
  container.addEventListener('touchmove', onMove, { passive: false })
  container.addEventListener('touchend', onEnd, { passive: true })
  container.addEventListener('touchcancel', onEnd, { passive: true })

  return () => {
    stopInertia()
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
