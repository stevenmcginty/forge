import { SHARE_CAPTURE_MAX_LINES } from '@shared/share'

/**
 * A pane's screen as text.
 *
 * "Capture pane" reads xterm's own buffer rather than the main process's replay
 * bytes, and the reason is the whole point of this file. The replay buffer is a
 * byte stream of cursor-addressed redraws; every agent CLI is a full-screen TUI,
 * so stripping the escapes out of it yields half-overwritten rows in the order
 * they were painted. The renderer already owns the emulator that parsed those
 * exact bytes into a grid — so ask the grid.
 *
 * The one detail that makes or breaks the result: xterm stores a soft-wrapped
 * 300-character line as three *rows*, each flagged `isWrapped` after the first.
 * Joining those with newlines turns one sentence into three, which is how a
 * captured plan arrives at the next agent looking like poetry. `joinBufferRows`
 * exists to not do that.
 *
 * Pure — rows in, text out, no xterm import — so scripts/share-check.mjs can
 * hold it to the wrapping rule without a DOM. The walk over `term.buffer.active`
 * that produces the rows lives in src/lib/terminals.ts, where the terminals do.
 */

export interface BufferRow {
  /** `line.translateToString(true)` — trailing whitespace already trimmed. */
  text: string
  /** `line.isWrapped` — this row is the continuation of the one above it. */
  wrapped: boolean
}

/**
 * Rows to lines. A wrapped row is appended to the line before it; an unwrapped
 * row starts a new one.
 *
 * A wrapped *first* row has nothing to continue — that happens when the capture
 * window starts mid-line — so it starts a line like any other.
 */
export function joinBufferRows(rows: BufferRow[]): string {
  const lines: string[] = []
  for (const row of rows) {
    const text = String(row?.text ?? '')
    if (row?.wrapped && lines.length > 0) {
      lines[lines.length - 1] += text
      continue
    }
    lines.push(text)
  }
  return lines.join('\n')
}

/**
 * The capture, tidied for a markdown file.
 *
 * A terminal screen is mostly blank: an agent's composer sits at the bottom of
 * eighty rows with sixty of them empty. So leading blanks go, trailing blanks
 * go, and a run of three or more blank lines inside becomes one — which keeps
 * the shape of a transcript while dropping the padding.
 *
 * `maxLines` counts *joined* lines, applied last, keeping the end: what a person
 * means by "the last 120 lines" is the last 120 things that were said, not the
 * last 120 rows of a grid that may have been wrapping.
 */
export function tidyCapture(text: string, maxLines: number): string {
  const flat = String(text ?? '').replace(/\r\n/g, '\n').replace(/\r/g, '')
  const collapsed = flat.replace(/\n{3,}/g, '\n\n')
  const trimmed = collapsed.replace(/^\n+/, '').replace(/\s+$/, '')
  if (!trimmed) return ''

  const cap = Number.isFinite(maxLines) && maxLines > 0 ? Math.min(maxLines, SHARE_CAPTURE_MAX_LINES) : SHARE_CAPTURE_MAX_LINES
  const lines = trimmed.split('\n')
  if (lines.length <= cap) return trimmed
  return lines.slice(lines.length - cap).join('\n')
}
