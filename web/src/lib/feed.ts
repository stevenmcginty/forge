/**
 * Turn a terminal screen into conversation blocks.
 *
 * Forge Web still *is* a PTY mirror — the bytes come from the desktop, xterm
 * parses them — but an agent's TUI is a full-screen redraw with its own prompt
 * at the bottom, and a phone (or a browser) should not type into that. This
 * file is the other half of that split: take the text xterm already has, drop
 * the live composer the TUI is drawing, and cut what remains into user / agent
 * cards so the page can look like a chat while the PTY stays the source of
 * truth.
 *
 * Conservative on purpose. Every agent CLI draws its chrome differently, so a
 * line this file is not sure about stays in the agent card rather than being
 * dropped or mis-attributed. scripts/feed-check.mjs holds the cuts.
 */

export type FeedRole = 'user' | 'agent' | 'system'

export interface FeedBlock {
  /** Stable for a given (role, text) pair in one capture — not a uuid. */
  id: string
  role: FeedRole
  text: string
}

/** Drop the border a TUI draws around a prompt, so the text inside reads as ordinary lines. */
export function stripBoxDrawing(line: string): string {
  return line.replace(/[─-╿▀-▟]/g, ' ').replace(/\s+/g, ' ').trim()
}

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
 * Model / status chrome that often sits in the last rows next to the prompt
 * (Claude's footer, Gemini's mode line). Dropped only when it is the tail.
 */
const FOOTER_CHROME =
  /^(?:bypass permissions|accept edits|plan mode|default|auto|shift\+tab|ctrl\+|esc\b|tab\b|~\s*$)/i

/**
 * Cut the TUI's own composer off the end of a capture, so our box is the only
 * input on screen.
 *
 * Walks up from the bottom and eats empty lines, a live prompt, a rule, and a
 * single footer-chrome line. Stops at the first line that looks like content.
 * Never eats more than eight lines, so a short screen that is *only* a prompt
 * still yields something rather than vanishing.
 */
export function stripLiveComposer(text: string): string {
  const lines = String(text ?? '').replace(/\r\n/g, '\n').replace(/\r/g, '').split('\n')
  let end = lines.length
  let eaten = 0
  const eat = (ok: (line: string) => boolean): boolean => {
    if (end === 0 || eaten >= 8) return false
    const line = stripBoxDrawing(lines[end - 1] ?? '')
    if (!ok(line)) return false
    end -= 1
    eaten += 1
    return true
  }
  while (eat((line) => line === '')) {
    /* trailing blanks */
  }
  eat((line) => LIVE_PROMPT.test(line))
  eat((line) => line === '' || RULE.test(line))
  eat((line) => FOOTER_CHROME.test(line) || RULE.test(line))
  while (eat((line) => line === '')) {
    /* blanks above the composer */
  }
  return lines.slice(0, end).join('\n').replace(/\s+$/, '')
}

/**
 * A line that starts a user turn in the TUIs Forge actually launches.
 *
 * Claude Code prefixes history with `> `; some shells and Gemini do the same.
 * Grok and a few others write `You:` / `User:` / `Human:`. The live prompt
 * (`❯` alone) is not a turn — it has been stripped already.
 */
const USER_TURN = /^(?:>\s+|(?:you|user|human)\s*:\s+)\S/i

function userText(line: string): string {
  return line.replace(/^(?:>\s+|(?:you|user|human)\s*:\s+)/i, '')
}

function isBanner(line: string): boolean {
  const t = line.trim()
  if (!t) return true
  if (/claude code/i.test(t)) return true
  if (/^\s*\/[a-z]/.test(t) && t.length < 40) return true
  if (/sonnet|opus|haiku|grok|gemini|codex/i.test(t) && t.length < 80) return true
  if (/^~\//.test(t) || /^[A-Z]:\\/.test(t)) return true
  return false
}

function flush(
  blocks: FeedBlock[],
  role: FeedRole,
  lines: string[]
): void {
  const text = lines.join('\n').replace(/^\n+/, '').replace(/\s+$/, '')
  if (!text) return
  blocks.push({
    id: `${role}-${blocks.length}-${text.length}`,
    role,
    text
  })
}

/**
 * Cut a (composer-stripped) capture into cards.
 *
 * Preamble that looks like a TUI banner becomes one system block. Each `> …`
 * or `You:` line opens a user card; everything after it until the next one is
 * the agent. A capture with no user markers at all is a single agent card —
 * that is the honest shape of a shell, or of an agent that has not been
 * spoken to yet.
 */
export function blocksFromCapture(text: string): FeedBlock[] {
  const raw = stripLiveComposer(text)
  if (!raw.trim()) return []

  const lines = raw.split('\n').map((line) => stripBoxDrawing(line))
  const blocks: FeedBlock[] = []

  let i = 0
  const banner: string[] = []
  while (i < lines.length && !USER_TURN.test(lines[i] ?? '') && isBanner(lines[i] ?? '')) {
    if ((lines[i] ?? '').trim()) banner.push(lines[i]!)
    i += 1
  }
  flush(blocks, 'system', banner)

  let role: FeedRole = 'agent'
  let buf: string[] = []
  for (; i < lines.length; i++) {
    const line = lines[i] ?? ''
    if (USER_TURN.test(line)) {
      flush(blocks, role, buf)
      role = 'user'
      buf = [userText(line)]
      continue
    }
    if (role === 'user' && line.trim() && !/^\s/.test(line) && !USER_TURN.test(line)) {
      // An unindented non-prompt line after a user turn is the agent starting.
      flush(blocks, 'user', buf)
      role = 'agent'
      buf = [line]
      continue
    }
    buf.push(line)
  }
  flush(blocks, role, buf)

  if (blocks.length === 0 && raw.trim()) {
    flush(blocks, 'agent', [raw.trim()])
  }
  return blocks
}
