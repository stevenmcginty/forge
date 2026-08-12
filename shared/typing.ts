/**
 * Did a person type this, or did the terminal answer a question?
 *
 * Everything a terminal emulator sends back up a PTY arrives on one channel.
 * Keystrokes, pastes and dictated words go up it, and so do the *replies* a TUI
 * asked for: a program probes its terminal as it starts — "what are you?",
 * "where is the cursor?", "what is palette slot 4?" — and xterm answers down
 * the very same `onData` a keypress takes, because to the PTY they are both
 * input. Two things in Forge have to tell them apart, and both of them break in
 * a way nobody would trace back to here if they could not:
 *
 *  1. **The typed draft** (src/lib/terminals.ts). "Take back typed" erases one
 *     backspace per character, and a draft holding bytes nobody pressed would
 *     fire backspaces at a prompt on their behalf.
 *  2. **Who owns the grid** (electron/pty/grid-owner.ts). The width follows the
 *     typist, so a `write` is what hands a pane's geometry to a device — and a
 *     browser merely *watching* a busy pane sends a steady trickle of `CSI 6 n`
 *     answers. Counting those as typing would mean opening a tab in another
 *     town reshaped the pane in front of somebody, which is the exact failure
 *     the ownership rule exists to prevent.
 *
 * Told apart by their opening bytes rather than by parsing them. No key on any
 * keyboard sends a DCS, OSC, APC, PM or SOS string, and none sends a CSI ending
 * in one of the report finals below — the arrows, the function keys and
 * shift-tab all end in something else. So everything a keyboard can actually
 * produce, bracketed paste included, comes back `true`.
 *
 * Mouse reports are on the not-typing side by the same test (`CSI < … M`, which
 * the `[?>=<]?` prefix and the `M` final between them cover), and that is the
 * right answer for both callers: clicking a pane to focus it, or rolling the
 * wheel over a TUI, is looking at it rather than working in it.
 *
 * Deliberately dependency-free, like shared/session.ts: the main process gates
 * ownership with it, the renderer tracks its draft with it, and
 * scripts/web-smoke.mjs drives it head-less through the registry.
 */
const REPORT_RESPONSE = /^(?:\x1b[P\]_^X]|\x1b\[[?>=<]?[0-9;]*(?:\$?[cnRty]|[IOMm]))/

/** True when this chunk is something a person pressed, pasted or dictated. */
export function isTypedInput(data: string): boolean {
  if (!data) return false
  return !REPORT_RESPONSE.test(data)
}
