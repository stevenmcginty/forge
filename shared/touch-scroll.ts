/**
 * Where a finger-drag or a wheel over a terminal should go.
 *
 * xterm scrolls its own viewport from a wheel, and a phone has none, so the
 * remote clients synthesise the gesture (`enableTouchScroll` in web/src/lib/term.ts
 * and mobile/src/lib/term.ts). The desktop used to leave the physical wheel to
 * xterm, which is why Grok's conversation never moved at the desk: on the
 * alternate screen with no mouse, xterm turns a wheel into a single arrow key,
 * and Grok's focused prompt eats those as caret motion. The same planner now
 * owns the wheel on every surface.
 *
 * The routing cannot be "always a wheel" or "always scrollLines":
 *
 *  - **Normal buffer, no mouse tracking.** The history is xterm's scrollback.
 *    `scrollLines` is the public API for that, and it is the only one that
 *    still works after xterm 6 — a constructed `WheelEvent` reports
 *    `wheelDeltaY: 0` in Chrome, so vscode's `ScrollableElement` moves nothing.
 *  - **A program that asked for the mouse.** Wheel reports, not a scrolled
 *    viewport. Claude Code is *not* in this bucket: it writes the normal
 *    buffer, so a finger drag is scrollback. Grok, OpenCode, Antigravity, vim
 *    and htop take the alternate screen and (usually) enable mouse tracking.
 *    Reports are written at the cell `wheelReportCell` picks — the top row,
 *    mid-width — so a TUI that hit-tests the composer along the bottom still
 *    treats the gesture as scrollback rather than as a nudge of the composer.
 *  - **Alternate screen, no mouse.** xterm would turn a wheel into arrow keys,
 *    which in Grok (prompt focused, the resting state) only move the caret.
 *    PageUp / PageDown scroll the conversation even then; Grok's own
 *    keyboard-shortcut doc says so. One page per `TUI_PAGE_ROWS` of travel,
 *    not one page per row — a slow drag used to fire PageUp on every row and
 *    the conversation leapt past what you were trying to read.
 */

export type TouchScrollPlan =
  | { kind: 'viewport'; lines: number }
  | { kind: 'data'; data: string }

/** Remainder of a pointer gesture, in CSS pixels. Shared across move/wheel events. */
export interface ScrollCarry {
  px: number
}

/**
 * The cell a synthesised wheel report claims to be over, 1-based.
 *
 * This used to be a flat `1;1`, and column 1 is why an OpenCode pane could not
 * be scrolled by a finger or by the wheel on any surface. OpenCode hit-tests
 * the report against its message list, and the list does not start at the left
 * edge of the grid: measured against opencode 1.18.21 in a PTY, wheel reports
 * at columns 1 and 2 produce *no output at all* — not a nudge of the composer,
 * simply nothing — while column 3 and inwards scroll the conversation. The
 * last column is the right-hand gutter and is dead in the same way.
 *
 * Mid-width is the column that cannot be a border however wide the gutter
 * grows. The *row* stays at the top, which the same measurements say is the
 * safe end: a 120x40 grid took the report at every row tried from 1 to 20 and
 * ignored every one from 36 down, but on a phone-shaped 45x24 grid the dead
 * zone starts at row 5, and on 60x16 at row 4 — the composer grows into the
 * middle of a short pane. Row 1 is inside the transcript at every size, which
 * is exactly the property the old `1;1` was reaching for.
 */
export function wheelReportCell(cols: number): { col: number; row: number } {
  const width = Number.isFinite(cols) && cols > 0 ? Math.floor(cols) : 1
  return { col: Math.max(1, Math.floor(width / 2)), row: 1 }
}

/** SGR mouse wheel: button 64 up, 65 down, 1-based cell. See `wheelReportCell`. */
function sgrWheel(up: boolean, count: number, cols: number): string {
  const button = up ? 64 : 65
  const { col, row } = wheelReportCell(cols)
  const one = `\x1b[<${button};${col};${row}M`
  return one.repeat(count)
}

/** How many rows of travel become one PageUp/PageDown on an alt-screen TUI. */
export const TUI_PAGE_ROWS = 8

/** Rows of pointer travel to accumulate before the planner fires. */
export function scrollUnitRows(altScreen: boolean, mouseTracking: boolean): number {
  return altScreen && !mouseTracking ? TUI_PAGE_ROWS : 1
}

/**
 * WheelEvent.deltaY in CSS pixels, whatever deltaMode the event arrived in.
 *
 * `0` is pixels (trackpads), `1` is lines (most mice), `2` is pages. The
 * planner thinks in pixels because a row's height is measured, not assumed.
 */
export function wheelDeltaPx(deltaY: number, deltaMode: number, rowHeight: number): number {
  if (deltaMode === 1) return deltaY * rowHeight
  if (deltaMode === 2) return deltaY * rowHeight * TUI_PAGE_ROWS
  return deltaY
}

/**
 * `cols` is the terminal's current width, which is what aims the wheel report
 * at a cell the TUI will accept — see `wheelReportCell`. It is required rather
 * than defaulted, because the one value a default could plausibly take is the
 * left gutter that this whole path used to fire into.
 */
export function planTouchScroll(
  lines: number,
  altScreen: boolean,
  mouseTracking: boolean,
  cols: number
): TouchScrollPlan {
  if (lines === 0) return { kind: 'viewport', lines: 0 }
  if (mouseTracking) {
    return { kind: 'data', data: sgrWheel(lines < 0, Math.abs(lines), cols) }
  }
  if (altScreen) {
    const pages = Math.floor(Math.abs(lines) / TUI_PAGE_ROWS)
    if (pages === 0) return { kind: 'viewport', lines: 0 }
    const key = lines < 0 ? '\x1b[5~' : '\x1b[6~'
    return { kind: 'data', data: key.repeat(pages) }
  }
  return { kind: 'viewport', lines }
}

/**
 * Turn a pixel delta (same sign as `WheelEvent.deltaY`) into a scroll plan,
 * holding the remainder so a slow drag or a smooth trackpad still adds up.
 *
 * Same sign convention as a physical wheel and as the finger handler: negative
 * reveals older output (PageUp / SGR 64 / `scrollLines` up).
 */
export function planPointerDelta(
  carry: ScrollCarry,
  deltaY: number,
  rowHeight: number,
  altScreen: boolean,
  mouseTracking: boolean,
  cols: number
): TouchScrollPlan {
  const height = rowHeight > 0 ? rowHeight : 1
  const unitRows = scrollUnitRows(altScreen, mouseTracking)
  const unit = height * unitRows
  carry.px += deltaY
  const steps = Math.trunc(carry.px / unit)
  if (steps === 0) return { kind: 'viewport', lines: 0 }
  carry.px -= steps * unit
  return planTouchScroll(steps * unitRows, altScreen, mouseTracking, cols)
}
