/**
 * Where a finger-drag over a terminal should go.
 *
 * xterm scrolls its own viewport from a wheel, and a phone has none, so both
 * remote clients synthesise the gesture (`enableTouchScroll` in web/src/lib/term.ts
 * and mobile/src/lib/term.ts). The routing cannot be "always a wheel" or
 * "always scrollLines":
 *
 *  - **Normal buffer, no mouse tracking.** The history is xterm's scrollback.
 *    `scrollLines` is the public API for that, and it is the only one that
 *    still works after xterm 6 — a constructed `WheelEvent` reports
 *    `wheelDeltaY: 0` in Chrome, so vscode's `ScrollableElement` moves nothing.
 *  - **A program that asked for the mouse.** Wheel reports, not a scrolled
 *    viewport. Claude Code is *not* in this bucket: it writes the normal
 *    buffer, so a finger drag is scrollback. Grok, Antigravity, vim and htop
 *    take the alternate screen and (usually) enable mouse tracking. A
 *    synthetic wheel dispatched at the DOM often never becomes a report —
 *    `getMouseReportCoords` returns nothing off a constructed event, and
 *    `consumeWheelEvent` returns 0 when cell metrics are missing — so the
 *    bytes are written directly, SGR wheel, one report per row of travel.
 *  - **Alternate screen, no mouse.** xterm would turn a wheel into arrow keys,
 *    which in Grok (prompt focused, the resting state) only move the caret.
 *    PageUp / PageDown scroll the conversation even then; Grok's own
 *    keyboard-shortcut doc says so. One page per ~half a screen of finger
 *    travel, not one page per row.
 */

export type TouchScrollPlan =
  | { kind: 'viewport'; lines: number }
  | { kind: 'data'; data: string }

/**
 * SGR mouse wheel: button 64 up, 65 down, 1-based cell. Written at column 1
 * row 1 so a TUI that hit-tests the prompt along the bottom still treats the
 * gesture as scrollback rather than as a nudge of the composer.
 */
function sgrWheel(up: boolean, count: number): string {
  const button = up ? 64 : 65
  const one = `\x1b[<${button};1;1M`
  return one.repeat(count)
}

/** How many rows of finger travel become one PageUp/PageDown. */
const PAGE_ROWS = 8

export function planTouchScroll(
  lines: number,
  altScreen: boolean,
  mouseTracking: boolean
): TouchScrollPlan {
  if (lines === 0) return { kind: 'viewport', lines: 0 }
  if (mouseTracking) {
    return { kind: 'data', data: sgrWheel(lines < 0, Math.abs(lines)) }
  }
  if (altScreen) {
    const pages = Math.max(1, Math.round(Math.abs(lines) / PAGE_ROWS))
    const key = lines < 0 ? '\x1b[5~' : '\x1b[6~'
    return { kind: 'data', data: key.repeat(pages) }
  }
  return { kind: 'viewport', lines }
}
