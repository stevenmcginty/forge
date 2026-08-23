import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { planPointerDelta, wheelDeltaPx, type ScrollCarry } from '@shared/touch-scroll'

/**
 * An xterm instance sized for a phone.
 *
 * Deliberately *not* a copy of src/lib/terminals.ts. That file is 865 lines
 * because it carries the mosaic, pane peeking, remote-URL scanning and the
 * desktop's focus model — none of which exist here. What is shared is the
 * emulator itself, which is the part that has to be faithful.
 *
 * ## The keyboard, which is the whole problem
 *
 * A terminal on a phone lives or dies by its keyboard, and Android's is not a
 * keyboard — it is an input method that *composes*. GBoard sends autocorrect
 * suggestions, swipe input arrives as whole words, and predictive text can
 * rewrite characters already sent. xterm's hidden textarea was written for
 * hardware keys.
 *
 * Two mitigations here, and a third in the UI:
 *
 *  1. Every autocorrect affordance is switched off on the helper textarea
 *     (`autocapitalize`, `autocorrect`, `autocomplete`, `spellcheck`). This is
 *     re-applied after `open()` because xterm creates that element itself.
 *  2. `inputmode` is left as text rather than forced, because forcing it to
 *     `none` hides the keyboard entirely on some Android versions — which is
 *     worse than composition.
 *  3. The UI offers a **compose row** (see PaneView): type a line into a real
 *     text field and send it whole. That is the escape hatch for the day GBoard
 *     wins, and it is the right answer for prompting an agent anyway, where you
 *     want to read a sentence back before it is sent.
 *
 * Canvas rendering, not WebGL: the WebGL addon is the desktop's default but
 * loses its context whenever Android backgrounds the app, and comes back blank.
 *
 * ## Whose grid this is, which is sometimes this phone's
 *
 * A PTY has one grid and a phone is one viewer of it. **The grid belongs to the
 * device somebody last typed into the pane on** (electron/pty/grid-owner.ts):
 * type here and this phone's own fit lands on the real PTY, native and readable;
 * type at the desk and the desk takes it back, and this phone draws the desk's
 * grid instead. Merely looking at a pane moves nothing anywhere.
 *
 * So this file does two things at once, and neither of them depends on knowing
 * the policy: it goes on fitting the container and reporting that geometry
 * through `onResize` — the wish, granted whenever this phone is the device being
 * typed on — and it draws whatever grid the desktop says the session really has,
 * shrinking the *font* until that grid fits the screen it has. `follow` is where
 * the second half happens, and when the two agree, which is the whole of the
 * case where this phone is the one holding the pane, it does nothing at all.
 */

export interface TermHost {
  term: Terminal
  /**
   * Refit to the container and return this phone's own geometry, or null if it
   * is unchanged. Note that this is the size this phone *would like* — what is
   * on screen afterwards is somebody else's grid whenever somebody else is the
   * one holding this pane. See `follow`.
   */
  fit: () => { cols: number; rows: number } | null
  /**
   * Draw the grid the desktop says this session actually has, or null to go
   * back to drawing this phone's own fit. See the geometry note in the header.
   */
  follow: (size: { cols: number; rows: number } | null) => void
  write: (data: string) => void
  /**
   * Wipe the screen and scrollback.
   *
   * Not the thing to reach for before painting a replay buffer — see `repaint`,
   * which is that, correctly ordered. This stays because a caller that owns the
   * whole of a terminal's life and simply wants it blank has no ordering
   * problem to solve.
   */
  reset: () => void
  /**
   * Wipe the screen and scrollback and paint a catch-up buffer over it, ordered
   * against everything already queued.
   *
   * Deliberately *not* a `reset()` the caller can pair with a `write()` of its
   * own, because those two are not on the same clock. `term.reset()` acts on the
   * buffer the instant it is called, while `write()` only ever *queues* — xterm
   * parses in 12ms slices off a timer (see `WriteBuffer`) — so a bare reset
   * before a write clears a screen the live bytes have not been painted onto
   * yet, and then lets that backlog paint *after* the wipe and *before* the
   * replay. Since the replay is the tail of the same stream, every byte in that
   * backlog is in the replay too, and the overlap lands on screen twice. That is
   * the reconnect that stacks a second copy of the scrollback under the first,
   * and a phone reconnects constantly.
   *
   * So the reset is sequenced through the same FIFO as the bytes it is meant to
   * come after. See the implementation for why an empty write is a legitimate
   * queue position.
   */
  repaint: (data: string) => void
  focus: () => void
  dispose: () => void
}

export interface TermOptions {
  fontSize: number
  onData: (data: string) => void
  onResize: (cols: number, rows: number) => void
}

/**
 * How small the font may go while shrinking a desktop grid onto this screen.
 *
 * There is a size below which a terminal stops being readable and starts being
 * a texture, and a pane rendered at 4px is not "still working" in any sense
 * that matters. At the floor the shrinking stops and the terminal overflows its
 * holder, which `.term-holder` clips. A desk pane has to be roughly twice a
 * handset's width before it is reached.
 */
const MIN_FONT_PX = 7

/**
 * How long the holder has to hold still before it is worth refitting.
 *
 * The web client reads its equivalent off `--dur-med`, because there the thing
 * being waited out is a CSS transition and a number invented in that file would
 * drift the moment somebody retimed the rail. Here the thing being waited out is
 * Android's keyboard slide, which is the platform's animation and not one this
 * app times, so there is no token to read — and this is deliberately the same
 * number `onViewportSettled` has always debounced by, since the two are waiting
 * out the same event from opposite ends.
 */
const SETTLE_MS = 160

export function mountTerm(container: HTMLElement, options: TermOptions): TermHost {
  const term = new Terminal({
    fontSize: options.fontSize,
    fontFamily: "'Cascadia Mono', ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
    // Enough rows that the first paint is not a one-line window; fit() corrects
    // it as soon as the container has a size.
    cols: 80,
    rows: 24,
    cursorBlink: true,
    // A phone scrolls with a finger, so scrollback is cheap and welcome — but
    // the desktop only ever sends 192KB of catch-up, so more than this would be
    // memory nothing can fill.
    scrollback: 4000,
    allowProposedApi: true,
    // Same ConPTY as the desktop renderer. Without this, xterm's wrap
    // heuristics assume a POSIX pty and a TUI on Windows loses the first
    // column of a wrapped row — which is how the Grok wordmark reads as "rok".
    windowsPty: { backend: 'conpty' },
    theme: {
      background: '#0B0C0E',
      foreground: '#E8EAED',
      cursor: '#C6FF4A',
      selectionBackground: '#2A3A12'
    }
  })

  const fitAddon = new FitAddon()
  term.loadAddon(fitAddon)
  term.open(container)

  // xterm builds its helper textarea in open(), so these can only be set now.
  // Without them GBoard capitalises the first letter of every command and
  // autocorrects flags into words.
  const textarea = term.textarea
  if (textarea) {
    textarea.setAttribute('autocapitalize', 'off')
    textarea.setAttribute('autocorrect', 'off')
    textarea.setAttribute('autocomplete', 'off')
    textarea.setAttribute('spellcheck', 'false')
  }

  term.onData(options.onData)

  let lastCols = 0
  let lastRows = 0
  /** The grid this phone's own holder would hold at this phone's own font. */
  let natural: { cols: number; rows: number } | null = null
  /** The grid the desktop says this session actually has. Null while unknown. */
  let desired: { cols: number; rows: number } | null = null

  /**
   * Put the right grid on screen at the largest font it fits in.
   *
   * The session's real grid whenever this pane has been told one, and this phone's
   * own until then. When the two agree — which is the whole of the case where
   * this phone is the device being typed on and the wish below was granted —
   * the second branch finds nothing to change and costs a comparison.
   *
   * The scale comes out of the two grids rather than out of any measurement of
   * a character: `natural` is what this holder holds at `options.fontSize`, so
   * `natural.cols / desired.cols` is exactly the factor the type has to come
   * down by for `desired.cols` of them to fit the same width. Never *up*,
   * because a desk pane narrower than a handset is better letterboxed than
   * blown up past the size the rest of the app is set in.
   */
  const apply = (): void => {
    // Nobody has told this pane what the desktop's grid is, so this phone's own
    // is the only one there is — and the addon's own `fit` is what applies it,
    // rather than a hand-rolled resize that would be the same call minus
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
      // that step is measurably not free — the same omission on Forge Web left a
      // freshly mounted terminal blank after its replay was written. The
      // desktop's own `redraw` reaches for the same public refresh.
      term.refresh(0, term.rows - 1)
    } catch {
      /* xterm throws if measured mid-teardown — harmless */
    }
  }

  const fit = (): { cols: number; rows: number } | null => {
    // A container with no height — mid-layout, or while the keyboard animates —
    // makes FitAddon compute a nonsense geometry, and a nonsense geometry is
    // what the desktop would be asked for.
    if (container.clientWidth < 8 || container.clientHeight < 8) return null
    // Measured at this phone's own type size, whatever the terminal is
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

  const releaseTouch = enableTouchScroll(container, term, () => options.fontSize, options.onData)

  /**
   * Refit whenever the holder's own box changes — which is also the retry for a
   * fit that arrived too early.
   *
   * `fit()` above refuses to measure a container under 8px, and the first call
   * of a pane's life can easily land there: the effect that mounts the terminal
   * runs before the flex layout has settled, and the phone then had nothing
   * watching for the size it eventually got. The terminal stayed at xterm's
   * default 80×24 while the PTY stayed at whatever the *desktop* last set, so
   * output was wrapped for a screen twice as wide as the one showing it — the
   * "typing runs off the edge" bug. The observer fires as soon as the box is
   * real, so the early fit is never the last word.
   *
   * Kept alongside `onViewportSettled` in PaneView rather than replacing it: an
   * Android soft keyboard changes the *visual viewport* without necessarily
   * changing this element's layout box, and only one of the two sees each case.
   *
   * ## And the throttle, which is the other half of it
   *
   * A box does not change once when it changes. The soft keyboard *animates*
   * open, so the holder shrinks on every frame of that slide, and each frame
   * that lands on a new cols/rows is a `pty:resize` the shell answers with a
   * full TUI redraw — plus, on the desktop side, a jiggle pair per resize. An
   * unthrottled observer therefore turns one keyboard opening into a dozen
   * reflows of the thing you were trying to read. `onViewportSettled` has
   * debounced its own path since it was written; this one never did.
   *
   * Same shape as web/src/lib/term.ts, for the same reasons: every observation
   * in one animation frame is coalesced into a single callback, the first one
   * after a quiet spell is acted on immediately — a pane that has just mounted
   * must not sit at 80×24 for the length of an animation it is not part of —
   * and everything after that waits until the box has been still for
   * `SETTLE_MS`. An animation therefore costs two fits rather than one per
   * frame, and only the ones that actually changed the geometry send anything,
   * because `fit` returns null otherwise.
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
      }, SETTLE_MS)
    })
  })
  observer.observe(container)

  return {
    term,
    fit,
    follow: (size) => {
      const next = size && size.cols > 0 && size.rows > 0 ? { cols: size.cols, rows: size.rows } : null
      if (next?.cols === desired?.cols && next?.rows === desired?.rows) return
      desired = next
      apply()
    },
    write: (data) => term.write(data),
    reset: () => term.reset(),
    repaint: (data) => {
      // The empty write is the queue position, and it is a real one: xterm's
      // `WriteBuffer.write` has no short-circuit for zero-length data — it
      // pushes the chunk and its callback like any other — and `_innerWrite`
      // walks the buffer by index rather than shifting, so a chunk that parses
      // to nothing still fires its callback in turn. (`writeSync` *would* stop
      // on it, because that path shifts and an empty string is falsy; nothing
      // here calls it.) So this callback runs exactly where the caller meant
      // the wipe to happen: after every live byte that arrived before the
      // replay, and before the replay itself.
      term.write('', () => term.reset())
      term.write(data)
    },
    focus: () => term.focus(),
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
 * `scrollback: 4000` above is annotated "a phone scrolls with a finger", and
 * for a long time that was an assumption rather than a feature: the history was
 * being kept and there was no way to reach it. xterm scrolls its viewport from
 * wheel events and keyboard, neither of which a handset has, and its screen
 * layer sits over the scrollable div and swallows the touch — so the buffer was
 * real, retained, and unreachable. On a phone, where the window is ~20 rows,
 * that means you can only ever see the last screenful of what an agent said.
 *
 * Done here rather than by making `.xterm-viewport` natively scrollable,
 * because native scrolling moves the DOM viewport underneath a canvas that
 * xterm paints by row index — they desynchronise and you get a smear.
 *
 * ## Where the finger's movement is sent, which depends on what the pane is
 *
 * Routed by `planPointerDelta` in shared/touch-scroll.ts, the same decision the
 * web client and the desktop wheel use. A constructed `WheelEvent` is how this
 * used to talk to a TUI, and it is how Grok's conversation never moved. The
 * normal buffer goes through `scrollLines`; a TUI on the alternate screen gets
 * SGR wheel reports or PageUp/PageDown written down the PTY. Claude Code writes
 * the normal buffer, so it was never on this path and kept working.
 *
 * Two details that stop it fighting the rest of the app:
 *
 *  - **A threshold before it commits.** Under `DRAG_START_PX` the gesture is
 *    still a tap, so tap-to-focus keeps working and the keyboard still opens.
 *    Past it, the drag is a scroll and `preventDefault` keeps Android from
 *    also treating it as a page pan or a pull-to-refresh.
 *  - **Whole rows only.** The accumulator carries the remainder between moves
 *    rather than rounding each one, so a slow drag scrolls smoothly instead of
 *    quantising to nothing and feeling stuck.
 *
 * Multi-touch is ignored outright: two fingers is a zoom or a system gesture,
 * and interpreting it as a scroll is how a pinch scrolls the terminal to its
 * top.
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
  const carry: ScrollCarry = { px: 0 }

  /** The height of one row, measured rather than assumed. */
  const measureRow = (): number => {
    const rows = term.element?.querySelector('.xterm-rows') as HTMLElement | null
    const measured = rows && term.rows > 0 ? rows.clientHeight / term.rows : 0
    // Before the first paint there is nothing to measure; the font size is a
    // serviceable stand-in and only affects the first few pixels of a drag.
    return measured > 1 ? measured : Math.max(1, fontSize() * 1.2)
  }

  const applyDelta = (deltaY: number): void => {
    const alt = term.buffer.active.type === 'alternate'
    const mouse = term.modes.mouseTrackingMode !== 'none'
    const plan = planPointerDelta(carry, deltaY, measureRow(), alt, mouse, term.cols)
    if (plan.kind === 'viewport') {
      if (plan.lines !== 0) term.scrollLines(plan.lines)
      return
    }
    if (send) send(plan.data)
  }

  const onStart = (event: TouchEvent): void => {
    if (event.touches.length !== 1) {
      tracking = false
      scrolling = false
      return
    }
    tracking = true
    scrolling = false
    carry.px = 0
    startY = event.touches[0].clientY
    lastY = startY
  }

  const onMove = (event: TouchEvent): void => {
    if (!tracking || event.touches.length !== 1) return
    const y = event.touches[0].clientY

    if (!scrolling) {
      if (Math.abs(y - startY) < DRAG_START_PX) return
      scrolling = true
    }

    // Dragging down reveals older output, which is scrolling *up* the buffer —
    // a negative count, which is what both branches below want: a negative
    // wheel delta, same as a physical wheel, and a negative `scrollLines`.
    applyDelta(lastY - y)
    lastY = y
    event.preventDefault()
  }

  const onEnd = (): void => {
    tracking = false
    scrolling = false
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
    container.removeEventListener('touchstart', onStart)
    container.removeEventListener('touchmove', onMove)
    container.removeEventListener('touchend', onEnd)
    container.removeEventListener('touchcancel', onEnd)
  }
}

/**
 * Watch the visual viewport and call back when it settles.
 *
 * The soft keyboard opening is the single most common resize in this app's
 * life, and on Android it animates — so a resize per frame during the slide
 * would mean a `pty:resize` per frame, and a shell reflowing its prompt a
 * dozen times. Debounced to the end of the animation instead.
 *
 * `visualViewport` rather than `window.resize`: with `adjustResize` the window
 * does change, but on some Android versions only the visual viewport does, and
 * listening to both is how a terminal ends up the wrong size in exactly one
 * configuration.
 */
export function onViewportSettled(run: () => void, delay = SETTLE_MS): () => void {
  let timer: number | null = null
  const schedule = (): void => {
    if (timer !== null) clearTimeout(timer)
    timer = window.setTimeout(run, delay)
  }

  const viewport = window.visualViewport
  viewport?.addEventListener('resize', schedule)
  viewport?.addEventListener('scroll', schedule)
  window.addEventListener('resize', schedule)
  window.addEventListener('orientationchange', schedule)

  return () => {
    if (timer !== null) clearTimeout(timer)
    viewport?.removeEventListener('resize', schedule)
    viewport?.removeEventListener('scroll', schedule)
    window.removeEventListener('resize', schedule)
    window.removeEventListener('orientationchange', schedule)
  }
}
