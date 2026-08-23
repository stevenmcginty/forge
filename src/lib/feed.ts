/**
 * Turn a terminal screen into a conversation.
 *
 * Forge Web still *is* a PTY mirror — the bytes come from the desktop, xterm
 * parses them — but an agent's TUI is a full-screen redraw with its own prompt
 * at the bottom, and a phone (or a browser) should not type into that. This
 * file is the other half of that split: take the styled screen xterm already
 * has (`captureRich` in lib/term.ts), lift the TUI's own chrome off the bottom
 * of it, and cut what remains into user / agent / tool cards so the page can
 * look like a chat while the PTY stays the source of truth.
 *
 * Two things changed when the display grew up, and both are about *not*
 * throwing information away:
 *
 *  1. **Colour survives.** The input is `RichLine[]`, not text, and every line
 *     handed to a card keeps its runs. An agent that prints a diff in red and
 *     green was previously drawn as grey text about a diff.
 *  2. **The footer is read rather than binned.** Every CLI prints what it is
 *     and what it is allowed to do along the bottom of its own screen — model,
 *     permission mode, cwd, context left, and whether it is mid-turn. That is
 *     exactly what a chat UI wants in its header, so it is parsed into
 *     `PaneStatus` (lib/rich.ts) on the way out instead of being dropped.
 *
 * Conservative on purpose, and the conservatism is the design. Every agent CLI
 * draws its chrome differently and all of them are free to redraw it tomorrow,
 * so: a line this file is not sure about stays in the agent card rather than
 * being dropped or mis-attributed, and a status field it cannot find stays
 * `undefined` rather than being guessed. A wrong badge is worse than no badge.
 * scripts/feed-check.mjs holds the cuts.
 */

import { SHARE_CAPTURE_MAX_LINES } from '@shared/share'
import type { FeedBlock, FeedRole, PaneStatus, PermissionMode, RichLine, Run, Transcript } from './rich'

export type { FeedBlock, FeedRole, RichLine, Transcript } from './rich'

/**
 * A pane nothing has been captured from yet.
 *
 * Shared rather than rebuilt per render so that a pane which parses to nothing
 * does not hand React a new object every frame. Never mutated.
 */
export const EMPTY_TRANSCRIPT: Transcript = {
  blocks: [],
  status: { mode: 'unknown', busy: false, footer: [] }
}

/* ------------------------------------------------------------- line plumbing */

/** Box drawing and block elements — the border a TUI draws, not its words. */
const BOX_ANY = /[─-╿▀-▟]/
const BOX_ALL = /[─-╿▀-▟]/g

/** Drop the border a TUI draws around a prompt, so the text inside reads as ordinary lines. */
export function stripBoxDrawing(line: string): string {
  return line.replace(/[─-╿▀-▟]/g, ' ').replace(/\s+/g, ' ').trim()
}

function runsText(runs: Run[]): string {
  let text = ''
  for (const run of runs) text += run.text
  return text
}

/** The runs between two character offsets of the line's text, styles intact. */
function sliceRuns(runs: Run[], start: number, end: number): Run[] {
  const out: Run[] = []
  let at = 0
  for (const run of runs) {
    const from = Math.max(start, at)
    const to = Math.min(end, at + run.text.length)
    if (to > from) out.push({ ...run, text: run.text.slice(from - at, to - at) })
    at += run.text.length
  }
  return out
}

/**
 * The same line with the TUI's border taken off it, colour kept.
 *
 * Deliberately *not* `stripBoxDrawing` applied to the runs. That collapses runs
 * of spaces, which is fine for matching a chrome line against a regex and wrong
 * for a card: the indentation is the shape of a diff, of a tree, of a `⎿` tool
 * result. So a line with no border is left exactly as captured, and a bordered
 * one only loses the border and the padding either side of it.
 */
function cleanRich(line: RichLine): RichLine {
  const boxed = BOX_ANY.test(line.text)
  const text = boxed ? line.text.replace(BOX_ALL, ' ') : line.text
  const runs = boxed ? line.runs.map((run) => ({ ...run, text: run.text.replace(BOX_ALL, ' ') })) : line.runs
  const start = boxed ? text.length - text.replace(/^\s+/, '').length : 0
  const end = text.replace(/\s+$/, '').length
  if (start === 0 && end === text.length) return boxed ? { runs, text } : line
  return { runs: sliceRuns(runs, start, end), text: text.slice(start, end) }
}

/** Plain text as lines with one run each — the bridge for callers that have no terminal. */
export function richFromText(text: string): RichLine[] {
  return String(text ?? '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '')
    .split('\n')
    .map((line) => ({ runs: line ? [{ text: line }] : [], text: line }))
}

/** One captured line in the three forms the parser needs. */
interface Cut {
  /** What a card shows: border gone, colour and indentation kept. */
  rich: RichLine
  /** As captured, so leading whitespace still means "this continues the line above". */
  raw: string
  /** Border gone, whitespace collapsed — what the regexes classify on. */
  flat: string
}

function cut(line: RichLine): Cut {
  const runs = Array.isArray(line?.runs) ? line.runs : []
  const raw = typeof line?.text === 'string' ? line.text : runsText(runs)
  return { rich: cleanRich({ runs, text: raw }), raw, flat: stripBoxDrawing(raw) }
}

/* --------------------------------------------------------------- the chrome */

/**
 * A line that is only the TUI's live prompt glyph — empty input, waiting.
 *
 * History turns look like `> went over the same fault`; those have content and
 * must not match. The live box is `❯`, `›`, `>`, `$` or `PS …>` with nothing
 * after it (or a dim placeholder the TUI has not replaced yet).
 */
const LIVE_PROMPT = /^\s*(?:[❯›◆●]|[>$]|PS[^>]*>)\s*$/

/** A horizontal rule the TUI draws above its composer. */
const RULE = /^[\s─━_═-]+$/

/**
 * The dim placeholder a TUI leaves sitting in an empty composer.
 *
 * `LIVE_PROMPT` only knows an empty box, and Gemini's box is never empty: it
 * holds "Type your message or @path/to/file" until you type over it. Without
 * this the placeholder reads as a `>` turn and the feed invents a message
 * nobody sent. Only these literal phrases, so somebody who really does type
 * "ask anything" still sees their draft.
 */
const PLACEHOLDER = /^(?:[❯›>◆●|]\s*)?(?:type your message|ask anything|ask codex|ask claude|send a message|try ")/i

/** The permission / mode line every agent prints beside its composer. */
const MODE_LINE =
  /(?:bypass(?:ing)? permissions|accept edits|auto-accept(?: edits)?|plan mode|yolo mode|normal mode|default mode|approval:|sandbox:)/i

/** The keyboard hints a TUI prints under its box. */
const HINT_LINE = /^(?:\?|⏎|↑|shift\+tab|ctrl\+|esc\b|tab\b|for shortcuts)/i

/** Context budget, however the CLI phrases it. */
const CONTEXT_LINE = /(?:context left|context remaining|auto-compact|% context|context:)/i

/** Codex writes its whole footer as `key: value` lines. */
const CODEX_FOOTER = /^(?:model|approval|sandbox|reasoning|workdir|directory|cwd)\s*:\s*\S/i

/** A path, alone or leading a footer — Gemini's cwd, Claude's banner line. */
const PATH_LINE = /^(?:~[\\/]|[A-Za-z]:\\|\/(?:home|Users|mnt|opt|usr|var|tmp)\/)/

/** `esc to interrupt` is the one thing every Claude spinner line carries. */
const BUSY_HINT = /\besc to interrupt\b/i
/** A braille spinner frame, wherever it sits on the line. */
const BRAILLE = /[⠀-⣿]/
/** The glyphs a CLI cycles as its spinner. */
const SPINNER_GLYPH = /^\s*[✢✳✶✻✽✻◐◓◑◒·*+•●○◆◇]\s/
/** An elapsed-time counter, which no prose line has. */
const ELAPSED = /\(\s*\d+s\b/

/**
 * Grok's live line, which none of the rules above sees.
 *
 * It cycles an ASCII spinner (`|` `/` `-` `\`) rather than braille, writes its
 * counter bare (`2.2s`) rather than bracketed, and ends in the tokens it has
 * streamed and a `[stop]` hint:
 *
 *     | Waiting for response… 2.2s  2.2s ↓7.84k [stop]
 *
 * Because the counter ticks, a frame that kept this line never matched the
 * frame before it, so every redraw minted another copy of the turn — the same
 * entry stacked down the feed once per second. The `[stop]` / `↓ tokens` tail
 * is what keeps this off a prose bullet that happens to quote a duration.
 */
const GROK_BUSY = /^[|/\\-]\s.*\b\d+(?:\.\d+)?s\b.*(?:\[stop\]|[↓↑]\s*[\d.]+k?\b)/i

/**
 * Grok's footer: what is left of the plan's quota, then the model.
 *
 *     Weekly limit left: 3% · Grok 4.6 (high)
 *
 * Nothing else on the screen says this, and `splitTail` stops dead at the first
 * line it cannot name — so until this existed the walk up the screen ate
 * *nothing*, and Grok's whole composer stayed in the conversation.
 */
const QUOTA_LINE = /\b(?:weekly|daily|monthly|hourly)\s+limit\s+left\b/i

/**
 * The bar Grok draws over each turn: branch, cwd, and the context clock.
 *
 *     ≡ master ~\Desktop\forge                          7.8K / 500K
 *
 * It marks a user turn the way `> ` does for Claude Code, so it opens a user
 * card — and, like `> `, the marker itself is dropped rather than shown. The
 * context figure on it moves, and a card carrying a moving number can never
 * match its own next frame.
 */
const GROK_BAR = /^[≡☰]\s.*\b\d+(?:\.\d+)?[KM]\s*\/\s*\d+(?:\.\d+)?[KM]\b/

/** A word that is being done to you — "Thinking…", "Baking…", "Working…". */
const ACTIVITY = /([A-Z][A-Za-z]+(?:\s[a-z]+)?)…/

/**
 * Is this line the TUI telling you it is mid-turn?
 *
 * Two grades, and the difference matters. A spinner *frame* is chrome and is
 * eaten off the bottom of the screen; a bare `Working…` on its own line is a
 * sentence the agent wrote, which sets the busy flag but stays in the card. The
 * cost of getting that backwards is a vanished message, so the eating rule is
 * the strict one.
 */
function busyLine(flat: string): boolean {
  if (!flat) return false
  if (BUSY_HINT.test(flat)) return true
  if (BRAILLE.test(flat)) return true
  if (GROK_BUSY.test(flat)) return true
  if (SPINNER_GLYPH.test(flat) && flat.includes('…')) return true
  return /^[A-Z][A-Za-z]+(?:\s[a-z]+)?…\s*$/.test(flat)
}

/** The strict half of `busyLine`: safe to lift off the screen. */
function spinnerChrome(flat: string): boolean {
  if (!flat) return false
  if (BUSY_HINT.test(flat)) return true
  // Grok/OpenCode cycle a braille frame with an elapsed counter and no
  // ellipsis; that line is chrome, not a sentence. Requiring `…` left those
  // frames in the body, and each one became a new card as the counter ticked.
  if (BRAILLE.test(flat) && (flat.includes('…') || ELAPSED.test(flat) || flat.length < 48)) return true
  if (GROK_BUSY.test(flat)) return true
  if (SPINNER_GLYPH.test(flat) && flat.includes('…') && ELAPSED.test(flat)) return true
  return SPINNER_GLYPH.test(flat) && flat.includes('…') && flat.length < 40
}

/** Everything that is the TUI talking about itself rather than to you. */
function chromeLine(flat: string): boolean {
  if (!flat) return true
  if (LIVE_PROMPT.test(flat) || RULE.test(flat) || PLACEHOLDER.test(flat)) return true
  if (MODE_LINE.test(flat) || CODEX_FOOTER.test(flat)) return true
  if (CONTEXT_LINE.test(flat)) return true
  if (QUOTA_LINE.test(flat)) return true
  if (HINT_LINE.test(flat)) return true
  if (spinnerChrome(flat)) return true
  return PATH_LINE.test(flat) && flat.length < 120
}

/**
 * How much of the bottom of a screen may be chrome.
 *
 * Claude's tail is a spinner, a blank, three box rows and a mode line, which is
 * six; Gemini and Codex print a couple more. Twelve is room for all of them and
 * still a hard floor under "ate somebody's message", which is what an unbounded
 * walk up a screen of short lines would eventually do.
 */
const MAX_TAIL = 12

/**
 * Split the TUI's own composer and footer off the end of a capture.
 *
 * Walks up from the bottom, eating chrome, and stops dead at the first line
 * that looks like something somebody said. A *filled* prompt (`❯ fix the
 * thing`) is content by that rule and stays — better to show a draft than to
 * eat a user turn.
 */
function splitTail(lines: Cut[]): { body: Cut[]; footer: string[] } {
  let end = lines.length
  let eaten = 0
  while (end > 0 && eaten < MAX_TAIL && chromeLine(lines[end - 1]!.flat)) {
    end -= 1
    eaten += 1
  }
  const footer: string[] = []
  for (let i = end; i < lines.length; i++) {
    const flat = lines[i]!.flat
    if (flat) footer.push(flat)
  }
  return { body: lines.slice(0, end), footer }
}

/**
 * Cut the TUI's own composer off the end of a capture, so our box is the only
 * input on screen. Text in, text out — the shape callers outside this file
 * (and scripts/feed-check.mjs) have always used.
 */
export function stripLiveComposer(text: string): string {
  const { body } = splitTail(richFromText(text).map(cut))
  return body
    .map((line) => line.raw)
    .join('\n')
    .replace(/\s+$/, '')
}

/* --------------------------------------------------------------- the status */

/**
 * Model names, most specific first.
 *
 * Codex prints `model: gpt-5-codex`, so the labelled form wins over any bare
 * name that might also be on the line; Claude prints either `Opus 4.1` in its
 * banner or a full `claude-opus-4-1` in `/status`.
 */
const MODEL_PATTERNS: RegExp[] = [
  /\bmodel\s*:\s*([\w.-]+)/i,
  /\b(claude-(?:opus|sonnet|haiku)-[\w.-]+)/i,
  /\b((?:opus|sonnet|haiku)\s+\d+(?:\.\d+)?)\b/i,
  /\b(gemini-[\w.-]+)/i,
  /\b(gpt-[\w.-]+)/i,
  /\b(grok-[\w.-]+)/i,
  // Grok's footer spells it out rather than using the slug: `Grok 4.6 (high)`.
  /\b(grok\s+\d+(?:\.\d+)?)\b/i
]

/**
 * Permission modes, most specific first.
 *
 * The label is the phrase as the CLI printed it, trailing "on" included, so a
 * tooltip can quote the screen rather than this file's vocabulary.
 */
const MODE_PATTERNS: { re: RegExp; mode: PermissionMode }[] = [
  { re: /\b(bypass(?:ing)? permissions(?:\s+on)?)/i, mode: 'bypass' },
  { re: /\b(plan mode(?:\s+on)?)/i, mode: 'plan' },
  { re: /\bapproval\s*:\s*(full-auto)/i, mode: 'auto' },
  { re: /\bapproval\s*:\s*(auto-edit)/i, mode: 'accept-edits' },
  { re: /\bapproval\s*:\s*(suggest)/i, mode: 'default' },
  { re: /\b(yolo mode(?:\s+on)?)/i, mode: 'auto' },
  { re: /\b(auto-accept(?: edits)?(?:\s+on)?)/i, mode: 'accept-edits' },
  { re: /\b(accept edits(?:\s+on)?)/i, mode: 'accept-edits' },
  { re: /\b(normal mode|default mode)\b/i, mode: 'default' }
]

const CONTEXT_PATTERNS: RegExp[] = [
  /context left until auto-compact\s*:\s*(\d+%)/i,
  /(\d+%)\s*context left/i,
  /context(?: left| remaining| used)?\s*:\s*(\d+%)/i,
  /(\d+(?:\.\d+)?k)\s*(?:tokens\s*)?left/i,
  // Grok's bar prints used over budget: `7.8K / 500K`.
  /(\d+(?:\.\d+)?[KM]\s*\/\s*\d+(?:\.\d+)?[KM])\b/
]

/** A cwd as any of the three shells Forge launches prints one. */
const CWD_PATTERN = /(?:^|\s)(~[\\/][^\s()>]*|[A-Za-z]:\\[^\s()>]*|\/(?:home|Users|mnt|opt|usr|var|tmp)\/[^\s()>]*)/

/** `(main*)` — a branch, and not `(97% context left)`, which has spaces in it. */
const BRANCH_PATTERN = /\(([A-Za-z0-9._/-]+\*?)\)/

function firstMatch(lines: string[], patterns: RegExp[]): string | undefined {
  for (const line of lines) {
    for (const re of patterns) {
      const m = re.exec(line)
      if (m?.[1]) return m[1].trim()
    }
  }
  return undefined
}

/**
 * Read the agent's own footer back as a status.
 *
 * The footer is searched first and the body only as a fallback, because the
 * footer is the CLI's current answer and the body may hold an older one — a
 * `/status` from ten minutes ago, a banner from before a `/model`. The
 * exception is the cwd and the model name, which several CLIs print only once,
 * in the banner, and never repeat.
 */
function readStatus(footer: string[], body: Cut[]): PaneStatus {
  const bodyFlat = body.map((line) => line.flat).filter(Boolean)
  const everywhere = [...footer, ...bodyFlat]

  const status: PaneStatus = { mode: 'unknown', busy: false, footer }

  const model = firstMatch(everywhere, MODEL_PATTERNS)
  if (model) status.model = model

  for (const line of everywhere) {
    let hit = false
    for (const { re, mode } of MODE_PATTERNS) {
      const m = re.exec(line)
      if (!m?.[1]) continue
      status.mode = mode
      status.modeLabel = m[1].trim()
      hit = true
      break
    }
    if (hit) break
  }

  const context = firstMatch(everywhere, CONTEXT_PATTERNS)
  if (context) status.context = context

  const cwd = firstMatch(everywhere, [CWD_PATTERN])
  if (cwd) status.cwd = cwd

  for (const line of footer) {
    if (!CWD_PATTERN.test(line)) continue
    const branch = BRANCH_PATTERN.exec(line)?.[1]
    if (branch && !/^\d+$/.test(branch)) {
      status.branch = branch
      break
    }
  }

  // Busy is a *now* fact: only the footer that was just lifted off the screen
  // and the last few lines still on it can say anything about it. A spinner
  // fifty lines up is a turn that finished.
  const recent = [...footer, ...bodyFlat.slice(-3)]
  for (const line of recent) {
    if (!busyLine(line)) continue
    status.busy = true
    const activity = ACTIVITY.exec(line)?.[1]
    if (activity) status.activity = activity.trim()
    break
  }

  return status
}

/* --------------------------------------------------------------- the blocks */

/**
 * A line that starts a user turn in the TUIs Forge actually launches.
 *
 * Claude Code prefixes history with `> `; some shells and Gemini do the same.
 * Grok and a few others write `You:` / `User:` / `Human:`. The live prompt
 * (`❯` alone) is not a turn — it has been stripped already.
 */
const USER_TURN = /^(?:>\s+|(?:you|user|human)\s*:\s+)\S/i
const USER_MARKER = /^(?:>\s+|(?:you|user|human)\s*:\s+)/i
/**
 * OpenCode (and Grok's sticky header) often put the role on its own line —
 * `You` then the message — rather than `You: message`. A whole-line match so
 * a sentence that starts with "You" stays the agent's.
 */
const USER_HEADER = /^(?:you|user|human)\s*$/i

/**
 * A tool call, as opposed to the agent talking.
 *
 * Claude draws both with the same bullet — `⏺ Read(file)` is a call and
 * `⏺ The tests pass.` is a sentence — so the call *shape* (a name, then an
 * open bracket) is the whole of the distinction, and anything else stays prose.
 * Codex shells out with `$ cmd` / `exec`; Gemini ticks its finished tools.
 */
const TOOL_START = [
  /^[⏺●]\s+[A-Za-z][\w.-]*\(/,
  /^\$\s+\S/,
  /^⚙/,
  /^exec\s+\S/i,
  /^[✓✔✗✖]\s+[A-Z][A-Za-z0-9_]*\b/,
  // OpenCode: `# Read src/lib/feed.ts` — the hash is the whole of the tell,
  // so a sentence that happens to start with a capital word stays prose.
  /^#\s+[A-Z][A-Za-z][\w.-]*/
]

/** Claude's result gutter, OpenCode's `└`, and the box rows some CLIs hang under a call. */
const TOOL_CONT = /^[⎿⋮↳└]/

function isToolStart(flat: string): boolean {
  return TOOL_START.some((re) => re.test(flat))
}

/**
 * Does this line continue the tool call above?
 *
 * `└` (and the rest of the box-drawing gutter) is stripped from `flat` by
 * `stripBoxDrawing`, so the test has to look at the raw capture too — otherwise
 * OpenCode's `└ Read 214 lines` becomes a bare sentence and falls out of the
 * tool card.
 */
function isToolCont(line: Cut): boolean {
  if (TOOL_CONT.test(line.flat)) return true
  if (/^[⎿⋮↳└]/.test(line.raw.trimStart())) return true
  return /^\s/.test(line.raw)
}

function isBanner(line: string): boolean {
  const t = line.trim()
  if (!t) return true
  if (/claude code/i.test(t)) return true
  if (/^\s*\/[a-z]/.test(t) && t.length < 40) return true
  if (/sonnet|opus|haiku|grok|gemini|codex|opencode/i.test(t) && t.length < 80) return true
  if (/^~\//.test(t) || /^[A-Z]:\\/.test(t)) return true
  return false
}

function trimEdges(lines: RichLine[]): RichLine[] {
  let start = 0
  let end = lines.length
  while (start < end && !lines[start]!.text.trim()) start += 1
  while (end > start && !lines[end - 1]!.text.trim()) end -= 1
  return lines.slice(start, end)
}

/**
 * Push a card, if there is anything in it.
 *
 * The id is role and position and nothing else — no digest, no counter, no
 * uuid — so that re-parsing a screen hands React the same key for every card,
 * including the one still being written. A digest of the text was in here
 * once; it re-keyed the streaming card on every PTY chunk, each remount came
 * back at `contain-intrinsic-size`'s 80px guess before snapping to its real
 * height, and the feed bounced up and down until the turn ended.
 */
function flush(blocks: FeedBlock[], role: FeedRole, lines: RichLine[]): void {
  const kept = trimEdges(lines)
  const text = kept
    .map((line) => line.text)
    .join('\n')
    .replace(/\s+$/, '')
  if (!text.trim()) return
  blocks.push({ id: `${role}-${blocks.length}`, role, lines: kept, text })
}

/**
 * Cut a (footer-stripped) screen into cards.
 *
 * Preamble that looks like a TUI banner becomes one system block. Each `> …`
 * or `You:` line opens a user card; a tool call and its indented results become
 * a tool card; everything else is the agent. A capture with no markers at all
 * is a single agent card — that is the honest shape of a shell, or of an agent
 * that has not been spoken to yet.
 */
function cutBlocks(body: Cut[]): FeedBlock[] {
  const blocks: FeedBlock[] = []
  let i = 0

  const banner: RichLine[] = []
  while (
    i < body.length &&
    !USER_TURN.test(body[i]!.flat) &&
    !USER_HEADER.test(body[i]!.flat) &&
    !GROK_BAR.test(body[i]!.flat) &&
    isBanner(body[i]!.flat)
  ) {
    if (body[i]!.flat) banner.push(body[i]!.rich)
    i += 1
  }
  flush(blocks, 'system', banner)

  let role: FeedRole = 'agent'
  let buf: RichLine[] = []
  /**
   * `You` on its own line: the next unindented line *is* the message, not the
   * agent answering. Cleared once that first body line has been taken.
   */
  let headerPending = false

  for (; i < body.length; i++) {
    const line = body[i]!

    // A spinner frame in the *body* (Grok/OpenCode stream one into the
    // window, not only the footer) is chrome. Leaving it in would mint a
    // new agent card every time the counter ticked.
    if (spinnerChrome(line.flat)) continue

    // Grok's `≡ branch cwd  7.8K / 500K` bar opens a turn the way `You` does,
    // and is dropped rather than shown: the context figure on it moves, and a
    // card that carries a moving number cannot match its own next frame.
    if (GROK_BAR.test(line.flat)) {
      flush(blocks, role, buf)
      role = 'user'
      buf = []
      headerPending = true
      continue
    }

    if (USER_HEADER.test(line.flat)) {
      flush(blocks, role, buf)
      role = 'user'
      buf = []
      headerPending = true
      continue
    }

    if (USER_TURN.test(line.flat)) {
      flush(blocks, role, buf)
      role = 'user'
      headerPending = false
      const marker = USER_MARKER.exec(line.rich.text)?.[0]?.length ?? 0
      buf = [{ runs: sliceRuns(line.rich.runs, marker, line.rich.text.length), text: line.rich.text.slice(marker) }]
      continue
    }

    if (isToolStart(line.flat)) {
      flush(blocks, role, buf)
      headerPending = false
      const tool: RichLine[] = [line.rich]
      let j = i + 1
      for (; j < body.length; j++) {
        const next = body[j]!
        // A blank line ends the call: every CLI that draws results under one
        // draws them contiguously, and reading past a gap is how the agent's
        // next sentence ends up inside the tool card.
        if (!next.flat) break
        if (!isToolCont(next)) break
        tool.push(next.rich)
      }
      i = j - 1
      flush(blocks, 'tool', tool)
      role = 'agent'
      buf = []
      continue
    }

    if (role === 'user' && line.flat && !/^\s/.test(line.raw) && !headerPending) {
      // An unindented line after a user turn is the agent starting; an indented
      // one is the rest of what was typed.
      flush(blocks, 'user', buf)
      role = 'agent'
      buf = [line.rich]
      continue
    }

    if (headerPending && line.flat) headerPending = false
    buf.push(line.rich)
  }

  flush(blocks, role, buf)
  return blocks
}

/**
 * The whole read: a styled screen in, cards plus the agent's own status out.
 */
export function transcriptFromLines(lines: RichLine[]): Transcript {
  const cuts = (Array.isArray(lines) ? lines : []).map(cut)
  const { body, footer } = splitTail(cuts)
  return { blocks: cutBlocks(body), status: readStatus(footer, body) }
}

/**
 * The same read from plain text, for callers that have no styled capture —
 * and for the checks, which hold this file to its cuts without a terminal.
 */
export function blocksFromCapture(text: string): FeedBlock[] {
  return transcriptFromLines(richFromText(text)).blocks
}

/* ---------------------------------------------------------- growing log */

/** How many conversation cards we keep. Matches the capture cap. */
const MAX_MERGED_BLOCKS = SHARE_CAPTURE_MAX_LINES

function bodyOf(blocks: FeedBlock[]): FeedBlock[] {
  return blocks.filter((block) => block.role !== 'system')
}

function systemOf(blocks: FeedBlock[]): FeedBlock | undefined {
  return blocks.find((block) => block.role === 'system')
}

/** Same turn, possibly still being written. */
function sameTurn(a: FeedBlock, b: FeedBlock): boolean {
  if (a.role !== b.role) return false
  if (a.text === b.text) return true
  if (a.text.startsWith(b.text) || b.text.startsWith(a.text)) return true
  // A TUI frame often starts mid-turn: the visible tail of a card we already have.
  if (a.text.endsWith(b.text) || b.text.endsWith(a.text)) return true
  return false
}

function pickTurn(a: FeedBlock, b: FeedBlock): FeedBlock {
  return b.text.length >= a.text.length ? { ...b, id: a.id } : a
}

function matchLen(prev: FeedBlock[], i: number, next: FeedBlock[], j: number): number {
  let n = 0
  while (i + n < prev.length && j + n < next.length && sameTurn(prev[i + n]!, next[j + n]!)) n++
  return n
}

function nextId(role: FeedRole, used: Set<string>): string {
  let n = 0
  while (used.has(`${role}-${n}`)) n++
  const id = `${role}-${n}`
  used.add(id)
  return id
}

/**
 * Give every card in the merged log an id no other card has.
 *
 * A block keeps the id it arrived with whenever that id is still free, because
 * the id is React's key and a card that changes key is a card that remounts —
 * losing an expanded tool result, a text selection, the scroll under a thumb.
 * Only a collision mints a new one, and `nextId` reserves as it goes, so two
 * cards can never leave here as the same key. They used to: the guard read
 * "already taken? then keep it", which handed React two `agent-2`s the moment
 * a frame's tail numbered itself over a block the log already held.
 */
function withIds(blocks: FeedBlock[], used: Set<string>): FeedBlock[] {
  return blocks.map((block) => {
    if (block.id && !used.has(block.id)) {
      used.add(block.id)
      return block
    }
    return { ...block, id: nextId(block.role, used) }
  })
}

/**
 * One command painted as a sticky header must still be one bubble.
 *
 * Alignment usually catches this; the leftover case is consecutive user
 * cards that say the same thing after a frame where the header reappeared
 * next to a slice that could not be matched. Growing the later one in
 * place is what the reader sees as "the entry didn't replicate".
 */
function collapseTwinUsers(blocks: FeedBlock[]): FeedBlock[] {
  const out: FeedBlock[] = []
  for (const block of blocks) {
    const last = out[out.length - 1]
    if (last && last.role === 'user' && block.role === 'user' && sameTurn(last, block)) {
      out[out.length - 1] = pickTurn(last, block)
      continue
    }
    out.push(block)
  }
  return out
}

/**
 * Fold a newly captured screen into the conversation we already have.
 *
 * Claude Code writes the normal buffer, so one capture *is* the conversation
 * and a replace is correct. Grok and OpenCode live on the alternate screen:
 * a capture is one frame, and replacing would throw away every turn that had
 * scrolled off the top. That is why only Claude Code scrolled like a log.
 *
 * A frame is a *window* onto the log, and two facts about windows drive every
 * choice here. **New content only ever appears at the bottom** — a terminal
 * appends, so anything a frame shows above its aligned region is history this
 * log already holds, and prepending it was duplicating the visible turns once
 * per frame: type one command into Grok and by the time the reply had streamed
 * for ten frames your entry sat in the feed ten times over. And **the anchor
 * must be the newest occurrence** — ask the same thing twice in a session and
 * both turns carry your words, so an alignment that ties has to prefer the
 * later position in the log or the reply grows on the older turn while the
 * newer one starves.
 *
 * So: find the longest alignment between the two bodies, ties broken toward
 * the bottom; keep everything the log already has around it; take blocks from
 * `next` only where they run past what prev holds (the genuinely new tail).
 * System banners are not conversation and are taken from `next`.
 */
export function mergeBlocks(prev: FeedBlock[], next: FeedBlock[]): FeedBlock[] {
  const prevBody = bodyOf(prev)
  const nextBody = bodyOf(next)
  if (!nextBody.length) return prev.length ? prev : next
  if (!prevBody.length) return next

  let best = { i: 0, j: 0, L: 0 }
  for (let i = 0; i < prevBody.length; i++) {
    for (let j = 0; j < nextBody.length; j++) {
      const L = matchLen(prevBody, i, nextBody, j)
      // Longer wins; a tie anchors as far down the log — and as far into the
      // frame — as it can, which is what picks the newest "run the tests"
      // when an older one says the same thing.
      if (L > best.L || (L === best.L && (i > best.i || (i === best.i && j > best.j)))) best = { i, j, L }
    }
  }

  let merged: FeedBlock[]
  if (best.L === 0) {
    const last = prevBody[prevBody.length - 1]!
    const first = nextBody[0]!
    merged = sameTurn(last, first) ? [...prevBody.slice(0, -1), ...nextBody] : [...prevBody, ...nextBody]
  } else {
    const { i, j, L } = best
    // History above the anchor comes from the log alone. The frame may show
    // blocks there too, but they are either copies of these or slices cut by
    // its top edge — and a slice is neither a prefix nor a suffix of the block
    // it came from, so it can never be matched away. Taking the frame's word
    // for its own top was the duplication.
    const head = prevBody.slice(0, i)
    const overlap: FeedBlock[] = []
    for (let k = 0; k < L; k++) overlap.push(pickTurn(prevBody[i + k]!, nextBody[j + k]!))
    const prevTail = prevBody.slice(i + L)
    let nextTail = nextBody.slice(j + L)
    // Sticky user headers (Grok, OpenCode) reappear in every frame. If we
    // aligned on an agent slice rather than on the turn itself, that header
    // sits in nextTail and must not mint a second bubble for the same words.
    // When the overlap already holds a user, a further user in nextTail is a
    // real later turn and stays.
    if (!overlap.some((block) => block.role === 'user')) {
      const held = [...head, ...overlap, ...prevTail]
      nextTail = nextTail.filter(
        (block) => !(block.role === 'user' && held.some((h) => h.role === 'user' && sameTurn(h, block)))
      )
    }
    const tail =
      i + L >= prevBody.length
        ? nextTail // the alignment runs to the live edge; whatever the frame holds past it is new
        : [...prevTail, ...nextTail] // the frame ended inside our history: keep what we hold, take anything new
    merged = [...head, ...overlap, ...tail]
  }

  merged = collapseTwinUsers(merged)
  if (merged.length > MAX_MERGED_BLOCKS) merged = merged.slice(merged.length - MAX_MERGED_BLOCKS)

  const used = new Set<string>()
  const identified = withIds(merged, used)
  const sys = systemOf(next) ?? systemOf(prev)
  if (!sys) return identified
  const sysId = used.has(sys.id) ? nextId('system', used) : sys.id
  used.add(sysId)
  return [{ ...sys, id: sysId }, ...identified]
}

/** Cards plus the newest status line. */
export function mergeTranscript(prev: Transcript, next: Transcript): Transcript {
  return { blocks: mergeBlocks(prev.blocks, next.blocks), status: next.status }
}
