/**
 * Markdown paths in a terminal line — the pure half of the Ctrl+click-to-read
 * links (the xterm link provider is in ./terminals.ts).
 *
 * Only *finds* candidates. Whether one is a real file is main's call
 * (`window.forge.reader.resolve`, electron/reader.ts resolveMarkdownRef), so a
 * candidate that does not exist is simply never offered as a link.
 *
 * Free of xterm and of `window`, so scripts/reader-check.mjs drives it as is.
 */

/** One candidate: `text` is the path as printed (plus any `:line[:col]`), `start`/`end` index the line, end exclusive. */
export interface MarkdownRef {
  text: string
  start: number
  end: number
}

// One path segment's characters: no separator, whitespace, quote, backtick,
// bracket, or a character Windows forbids in a name. `:` only after a drive letter.
const SEG = String.raw`[^\s"'\x60<>|*?:()\[\]{},;\\/]`
const EXT = String.raw`\.(?:md|markdown)(?::\d+(?::\d+)?)?`

/**
 * An unquoted path: optional drive (`C:\` or `C:/`), segments, a name ending in
 * .md/.markdown, an optional `:line[:col]`.
 *
 * Not preceded by anything that would make it the tail of a longer token — a
 * word character, `.`, a separator, `:` — which is what keeps
 * `https://x.com/a.md` from matching as `a.md`. Not followed by more name
 * (`foo.mdx`, `README.md.bak`, `x.md/`); a sentence's full stop is fine.
 */
const UNQUOTED = new RegExp(
  String.raw`(?<![\w\-.~%@$\\/:])(?:[a-z]:[\\/])?(?:${SEG}+[\\/])*${SEG}+${EXT}(?![\w\-\\/]|\.\w)`,
  'gi'
)

/**
 * A quoted absolute path, which may hold spaces (`"C:\Users\steve\My Docs\a.md"`).
 * Only absolute: quoted prose that merely mentions a relative path is left to
 * UNQUOTED, which picks the path out of it.
 */
const QUOTED = new RegExp(String.raw`(["'\x60])([a-z]:[\\/][^"'\x60\r\n<>|*?]*?${EXT})\1`, 'gi')

/** Every candidate markdown path in `line`, in order, never overlapping. */
export function findMarkdownRefs(line: string): MarkdownRef[] {
  const out: MarkdownRef[] = []
  for (const m of line.matchAll(QUOTED)) {
    const text = m[2] ?? ''
    const start = (m.index ?? 0) + 1
    out.push({ text, start, end: start + text.length })
  }
  for (const m of line.matchAll(UNQUOTED)) {
    const start = m.index ?? 0
    const end = start + m[0].length
    if (out.some((r) => start < r.end && end > r.start)) continue
    out.push({ text: m[0], start, end })
  }
  return out.sort((a, b) => a.start - b.start)
}

/** The slice of xterm's IBufferLine this module reads. */
export interface CellLine {
  readonly length: number
  getCell(x: number): { getChars(): string; getWidth(): number } | undefined
}

/**
 * Rows of terminal cells as one string, with where each character sits.
 *
 * For code unit `i`: `y[i]` is the index into `rows` of its cell, `x[i]` that
 * cell's 0-based column and `endX[i]` the column just past it — which is
 * xterm's 1-based, inclusive end. So a ref maps to the range
 * `(x[start] + 1, y[start])` .. `(endX[end - 1], y[end - 1])`. A wide character
 * takes two cells and one entry; an empty cell reads as a space.
 */
export function cellText(rows: readonly CellLine[]): { text: string; x: number[]; endX: number[]; y: number[] } {
  let text = ''
  const x: number[] = []
  const endX: number[] = []
  const y: number[] = []
  rows.forEach((row, r) => {
    for (let c = 0; c < row.length; c++) {
      const cell = row.getCell(c)
      if (!cell) continue
      const width = cell.getWidth()
      if (width === 0) continue
      const chars = cell.getChars() || ' '
      for (let k = 0; k < chars.length; k++) {
        x.push(c)
        endX.push(c + width)
        y.push(r)
      }
      text += chars
    }
  })
  return { text, x, endX, y }
}
