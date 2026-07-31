import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'

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
 */

export interface TermHost {
  term: Terminal
  /** Refit to the container and return the new geometry, or null if unchanged. */
  fit: () => { cols: number; rows: number } | null
  write: (data: string) => void
  /** Wipe the screen and scrollback — used before painting a replay buffer. */
  reset: () => void
  focus: () => void
  dispose: () => void
}

export interface TermOptions {
  fontSize: number
  onData: (data: string) => void
  onResize: (cols: number, rows: number) => void
}

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

  const fit = (): { cols: number; rows: number } | null => {
    // A container with no height — mid-layout, or while the keyboard animates —
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

  return {
    term,
    fit,
    write: (data) => term.write(data),
    reset: () => term.reset(),
    focus: () => term.focus(),
    dispose: () => {
      term.dispose()
    }
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
export function onViewportSettled(run: () => void, delay = 160): () => void {
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
