/**
 * Terminal output as *text*, for the one caller that wants the words rather
 * than the picture.
 *
 * Distinct from electron/pty/replay.ts, which removes only the sequences a
 * repaint must not answer — that file is protecting a live PTY from a terminal
 * that talks back, and it leaves everything else alone because a replay still
 * has to draw. This file removes all of it, because its output goes into a
 * markdown file that a language model will read.
 *
 * Used by the SHARE section's "Capture pane" fallback: the normal route reads
 * xterm's own parsed grid (src/lib/paneText.ts), and only a pane that has never
 * been opened in this renderer falls back to stripping the main process's raw
 * replay bytes. That path is honestly rough — a full-screen TUI's byte stream is
 * cursor-addressed redraws, so stripping the escapes leaves rows in the order
 * they were painted rather than the order they appear — and the rail says so
 * where the choice is offered. This module's job is only to make sure the result
 * is text, never to pretend it is a screenshot.
 *
 * Pure, no Node and no DOM, so scripts/share-check.mjs can hold it to the cases
 * below without a terminal in sight.
 */

/**
 * Sequences that carry a *string* payload, and so must go before CSI: their
 * payloads can contain bytes that look exactly like a CSI final byte, and a CSI
 * pass run first would cut one of them in half and leave the rest as text.
 *
 *   OSC  ESC ]   window titles, colour queries, hyperlinks
 *   DCS  ESC P   device control strings, e.g. Sixel, terminfo replies
 *   SOS  ESC X
 *   PM   ESC ^
 *   APC  ESC _   used by some TUIs for private messages
 *
 * All five end at ST (`ESC \`) — and OSC in practice often ends at BEL instead,
 * which xterm has always accepted and which every shell prompt in the world
 * relies on.
 */
const STRING_SEQUENCES: RegExp[] = [
  /\x1b\][\s\S]*?(?:\x07|\x1b\\)/g,
  /\x1b[PX^_][\s\S]*?(?:\x07|\x1b\\)/g
]

/** CSI, 7-bit and 8-bit: parameters, intermediates, then one final byte. */
const CSI = /\x1b\[[\x30-\x3f]*[\x20-\x2f]*[\x40-\x7e]/g
const CSI_8BIT = /\x9b[\x30-\x3f]*[\x20-\x2f]*[\x40-\x7e]/g

/** Charset designation (`ESC ( B`) and the two-character escapes. */
const CHARSET = /\x1b[()*+\-./][\x20-\x7e]/g
const KEYPAD = /\x1b[=>]/g
const TWO_CHAR = /\x1b[@-Z\\-_]/g

/** Anything left that started an escape we do not know. */
const LONE_ESCAPE = /\x1b/g

/** C1 controls, none of which is ever a printable character. */
const C1 = /[\x80-\x9f]/g

/** C0 controls, except the two that carry meaning in a text file. */
const C0 = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g

/**
 * Strip every escape sequence and control character, keeping newlines and tabs.
 *
 * Carriage returns are applied rather than removed: a progress line that redrew
 * itself twenty times is one line ending in the last thing it said, which is
 * what `foo\rbar` means and what makes a captured `npm install` readable.
 *
 * Text with no escapes in it comes back identical — asserted by
 * scripts/share-check.mjs with `===`, because a "cleaner" that rewrites innocent
 * text is a cleaner nobody can reason about.
 */
export function stripAnsi(text: string): string {
  let out = String(text ?? '')
  for (const pattern of STRING_SEQUENCES) out = out.replace(pattern, '')
  out = out.replace(CSI, '')
  out = out.replace(CSI_8BIT, '')
  out = out.replace(CHARSET, '')
  out = out.replace(KEYPAD, '')
  out = out.replace(TWO_CHAR, '')
  out = out.replace(LONE_ESCAPE, '')
  out = out.replace(C1, '')
  out = out
    .split('\n')
    .map((line) => {
      if (!line.includes('\r')) return line
      // The last segment wins, which is what a carriage return does. An empty
      // last segment (a line ending in \r) leaves the segment before it.
      const parts = line.split('\r').filter((p, i, all) => p.length > 0 || i === all.length - 1)
      return parts[parts.length - 1] ?? ''
    })
    .join('\n')
  return out.replace(C0, '')
}

/**
 * The last `n` lines. A trailing newline does not count as an extra empty line,
 * because every terminal ends its output with one and nobody means it.
 */
export function tailLines(text: string, n: number): string {
  const body = String(text ?? '')
  if (!body) return ''
  if (!Number.isFinite(n) || n <= 0) return ''
  const lines = body.replace(/\r\n/g, '\n').replace(/\n$/, '').split('\n')
  if (lines.length <= n) return lines.join('\n')
  return lines.slice(lines.length - n).join('\n')
}
