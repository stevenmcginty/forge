import type { ChatBlock, ChatTurn } from '@shared/chat'
import type { FeedBlock, RichLine } from '@/lib/feed'

/**
 * Turns, read off a screen.
 *
 * A Claude pane's chat comes from the session's JSONL, and it reads like the
 * official app because every turn there is structured at source. Grok (and
 * any other alt-screen TUI) writes nothing to disk that Forge reads, so its
 * chat has to be built from the cards `lib/feed.ts` cut out of the terminal —
 * and a card is a run of screen lines, not a turn. This file is the
 * difference: it reads a tool card's first line back into a name and a gist,
 * a thinking card back into a fold, a TUI's bullets back into markdown the
 * chat renders, and the clock the parser lifted off a user line into the
 * turn's own `clock`.
 *
 * Conservative in the same way the parser is. A line this file cannot name is
 * handed on as prose rather than dropped, and nothing here guesses at a
 * failure it did not see printed.
 */

/** Lines of a tool result the chip carries before it says "and N more". */
const NOTE_LINES = 24

/**
 * Grok's tool verbs, as the CLI prints them. The past tense is a finished
 * call, the progressive a running one; the chip shows either as it stands.
 */
const GROK_TOOL =
  /^[◆▸▶•●·]?\s*(Read(?:ing)?|List(?:ed|ing)|Fetch(?:ed|ing)|Search(?:ed|ing)|Edit(?:ed|ing)|Call(?:ed|ing)|Ran|Running|Wrote|Writing)\b\s*(.*)$/
/** Claude's `⏺ Read(web/src/lib/term.ts)`. */
const CALL_SHAPE = /^[⏺●]?\s*([A-Za-z][\w.-]*)\((.*)\)\s*$/
/** Codex's `$ npm test`. */
const SHELL_SHAPE = /^\$\s+(.*)$/
/** OpenCode's `# Read src/lib/feed.ts`. */
const HASH_SHAPE = /^#\s+([A-Z][A-Za-z][\w.-]*)\s*(.*)$/
/** Gemini's ticked (or crossed) finished tool. */
const TICK_SHAPE = /^([✓✔✗✖])\s+([A-Z][A-Za-z0-9_]*)\b\s*(.*)$/
/** A parenthetical detail on the end of a gist: `(966 lines)`, `(3 matches)`. */
const DETAIL = /\s*\(([^()]{1,60})\)\s*$/
/** The gutter a CLI hangs result lines under. */
const GUTTER = /^\s*[⎿⋮↳└├│]\s?/
/** A TUI bullet, as printed, that markdown would otherwise read as a word. */
const BULLET = /^(\s*)[•◦▪‣]\s+/
/** Claude's `⏺` in front of the first line of a reply. */
const REPLY_MARK = /^[⏺]\s+/

function lineText(line: RichLine): string {
  return line.text || line.runs.map((run) => run.text).join('')
}

function blockLines(block: FeedBlock): string[] {
  if (block.lines.length) return block.lines.map(lineText)
  return block.text.split('\n')
}

/* ------------------------------------------------------------------- tools */

/** One tool card read back into the chip the chat draws. */
function toolBlock(block: FeedBlock): ChatBlock {
  const lines = blockLines(block)
  const head = (lines[0] ?? '').trim()
  const rest = lines.slice(1)

  let name = ''
  let gist = ''
  let failed: boolean | undefined
  let m: RegExpExecArray | null

  if ((m = GROK_TOOL.exec(head))) {
    name = m[1]!
    gist = m[2]!
  } else if ((m = CALL_SHAPE.exec(head))) {
    name = m[1]!
    gist = m[2]!
  } else if ((m = SHELL_SHAPE.exec(head))) {
    name = 'Shell'
    gist = m[1]!
  } else if ((m = HASH_SHAPE.exec(head))) {
    name = m[1]!
    gist = m[2]!
  } else if ((m = TICK_SHAPE.exec(head))) {
    name = m[2]!
    gist = m[3]!
    if (m[1] === '✗' || m[1] === '✖') failed = true
  } else {
    const space = head.search(/\s/)
    name = space === -1 ? head : head.slice(0, space)
    gist = space === -1 ? '' : head.slice(space + 1)
  }

  // `Read src/lib/feed.ts (966 lines)`: the detail is the result's own
  // one-liner, which is what `note` is for — not part of the path.
  const notes: string[] = []
  const detail = DETAIL.exec(gist)
  if (detail) {
    gist = gist.slice(0, detail.index)
    notes.push(detail[1]!)
  }
  gist = gist.trim()

  const body = rest.map((line) => line.replace(GUTTER, '').replace(/\s+$/, '')).filter((line) => line.trim())
  if (body.length) {
    const shown = body.slice(0, NOTE_LINES)
    if (body.length > shown.length) shown.push(`… ${body.length - shown.length} more lines`)
    notes.push(shown.join('\n'))
  }

  const out: ChatBlock = { kind: 'tool', name: name || 'tool', gist }
  if (notes.length) out.note = notes.join('\n')
  if (failed) out.failed = true
  return out
}

/* -------------------------------------------------------------------- prose */

/**
 * Screen lines as markdown source.
 *
 * The TUI has already rendered the model's markdown once — bullets are `•`,
 * emphasis is a bold run — so what is on screen is *nearly* plain text. The
 * bullets go back to `-` so the chat sets them as a list rather than as a
 * paragraph full of dots; the rest is left alone, hard wraps included, since
 * the chat keeps line breaks inside a paragraph on purpose.
 */
function proseOf(lines: string[]): string {
  const out: string[] = []
  for (let i = 0; i < lines.length; i++) {
    let line = lines[i]!.replace(/\s+$/, '')
    if (i === 0) line = line.replace(REPLY_MARK, '')
    line = line.replace(BULLET, '$1- ')
    const prev = out[out.length - 1]
    if (prev !== undefined && wrapped(prev, line)) {
      out[out.length - 1] = `${prev} ${line.trim()}`
      continue
    }
    out.push(line)
  }
  return out.join('\n').trim()
}

/**
 * Is `line` the rest of `prev`, broken by the terminal's width rather than
 * by the model?
 *
 * The chat keeps a line break inside a paragraph on purpose — a model's
 * deliberate break should survive — but a screen has already wrapped the
 * model's paragraph to however many columns the pane had, and drawing those
 * wraps as breaks on a 390px phone reads as a ragged right margin. A line is
 * taken as a wrap when the one before it stops mid-sentence (no closing
 * punctuation) or it begins in the middle of one (a lower-case letter), and
 * neither is a bullet, an indent, or blank — the shapes a break is meant on.
 */
function wrapped(prev: string, line: string): boolean {
  if (!prev.trim() || !line.trim()) return false
  if (/^\s/.test(line) || /^\s*(?:[-*+]|\d+[.)])\s/.test(line) || /^\s*(?:[-*+]|\d+[.)])\s/.test(prev)) return false
  if (/^\s*(?:#{1,6}\s|>|```|\||---)/.test(line) || /^\s*(?:```|\|)/.test(prev)) return false
  if (/^[a-z]/.test(line)) return true
  return !/[.!?:;…)\]}"'`]$/.test(prev)
}

/**
 * A thinking card as a fold: the header line is the parser's tag, the lines
 * under it are the reasoning the reader can open.
 */
function thinkingBlock(block: FeedBlock): ChatBlock | null {
  const text = blockLines(block)
    .slice(1)
    .map((line) => line.trim())
    .filter(Boolean)
    .join('\n')
  return text ? { kind: 'thinking', text } : null
}

/* -------------------------------------------------------------------- turns */

/**
 * The conversation a screen holds, as the turns the chat draws.
 *
 * Roles map the obvious way: a user card is a user turn; tool and agent cards
 * are the assistant's and run together into one reply until the next user
 * card, the way a transcript turn holds its tools and its words. The TUI's
 * banner (`system`) is not conversation and is not shown — the status strip
 * already names the model.
 */
export function screenTurns(blocks: FeedBlock[]): ChatTurn[] {
  const turns: ChatTurn[] = []

  const reply = (id: string, pieces: ChatBlock[]): void => {
    if (!pieces.length) return
    const last = turns[turns.length - 1]
    if (last && last.role === 'assistant') {
      last.blocks.push(...pieces)
      return
    }
    turns.push({ id, role: 'assistant', at: 0, blocks: pieces })
  }

  for (const block of blocks) {
    switch (block.role) {
      case 'system':
        continue
      case 'user': {
        const text = block.text.trim()
        if (!text) continue
        const turn: ChatTurn = { id: block.id, role: 'user', at: 0, blocks: [{ kind: 'text', text }] }
        if (block.clock) turn.clock = block.clock
        turns.push(turn)
        continue
      }
      case 'tool':
        reply(block.id, [toolBlock(block)])
        continue
      case 'thinking': {
        const thought = thinkingBlock(block)
        if (thought) reply(block.id, [thought])
        continue
      }
      default: {
        const text = proseOf(blockLines(block))
        if (text) reply(block.id, [{ kind: 'text', text }])
      }
    }
  }
  return turns
}
