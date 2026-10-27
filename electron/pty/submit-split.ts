/**
 * Two rules for bytes on their way onto a PTY, so that one Enter is one submit.
 *
 * Both were seen failing against a real Claude Code (v2.1.311) under node-pty:
 *
 * 1. **Text and its Enter in one write.** Claude Code reads a burst that holds
 *    more than about 60 characters as a paste, and a `\r` inside a paste is not
 *    the Enter key: the words sit in its box, unsent. 55 characters + `\r` in one
 *    write submitted; 70 did not; the same 450 characters with the `\r` written
 *    60 ms later did. The composer already keeps its Enter separate
 *    (web/src/components/SessionComposer.tsx); the TV's typed/dictated line,
 *    `pane_send` and Foreman wrote `text\r` in one go. `submitHead` finds those.
 *
 * 2. **Invisible characters.** A format character (Unicode Cf: zero-width space,
 *    word joiner, BOM, soft hyphen, LRM/RLM, tag characters...) in the text makes
 *    Claude Code remove it and hold the message: "Removed 1 invisible character ·
 *    review and press Enter to send". The Enter that came with it is spent on
 *    that notice. `stripInvisible` takes them out first. Kept, because they are
 *    part of something visible and Claude Code passes them (checked): ZWJ inside
 *    an emoji sequence, the tags of an England/Scotland/Wales flag, and ZWNJ or
 *    ZWJ between letters (Persian, Hindi).
 *
 * Pure, so scripts/submit-split-check.mjs can prove both without a PTY.
 */

/** How long the Enter waits after the words. 60 ms was enough in the repro. */
export const ENTER_GAP_MS = 80

const ZWNJ = String.fromCharCode(0x200c)
const ZWJ = String.fromCharCode(0x200d)
const ANY_FORMAT = /\p{Cf}/u
const FORMAT = /\p{Cf}/gu
/** The pictograph a joiner may follow: an emoji, maybe with VS16 or a skin tone. */
const EMOJI_BEFORE = /\p{Extended_Pictographic}[\u{FE0F}\u{1F3FB}-\u{1F3FF}]?$/u
const EMOJI_AFTER = /^\p{Extended_Pictographic}/u
/** Letters and their marks: Persian and Hindi need ZWNJ/ZWJ between them. */
const LETTER_BEFORE = /[\p{L}\p{M}]$/u
const LETTER_AFTER = /^[\p{L}\p{M}]/u
/** A flag's tag run so far: the black flag U+1F3F4 and any tags after it. */
const FLAG_SO_FAR = /\u{1F3F4}[\u{E0020}-\u{E007F}]*$/u
const TAG = /^[\u{E0020}-\u{E007F}]$/u
/** The longest flag tag run looked back over (England: 6 tags, 2 units each). */
const FLAG_LOOKBACK = 2 + 2 * 16

/**
 * Whether the format character `ch` at `at` is part of something visible and
 * must stay: a joiner inside an emoji or between letters, or a tag in an
 * emoji flag (England, Scotland, Wales: U+1F3F4, tags, cancel tag U+E007F).
 */
function keep(ch: string, at: number, whole: string): boolean {
  if (ch === ZWJ || ch === ZWNJ) {
    const before = whole.slice(Math.max(0, at - 4), at)
    const after = whole.slice(at + 1, at + 3)
    if (LETTER_BEFORE.test(before) && LETTER_AFTER.test(after)) return true
    return ch === ZWJ && EMOJI_BEFORE.test(before) && EMOJI_AFTER.test(after)
  }
  return TAG.test(ch) && FLAG_SO_FAR.test(whole.slice(Math.max(0, at - FLAG_LOOKBACK), at))
}

/**
 * `text` without its invisible format characters. Kept: emoji joiners, emoji
 * flag tags, and ZWNJ/ZWJ between letters.
 */
export function stripInvisible(text: string): string {
  if (!ANY_FORMAT.test(text)) return text
  return text.replace(FORMAT, (ch: string, at: number, whole: string) => (keep(ch, at, whole) ? ch : ''))
}

/**
 * `data` split into the part to write now and the Enter to write alone
 * `ENTER_GAP_MS` later, when `data` is something followed by its Enter (`\r`,
 * or `\r\n`, which keeps both bytes). Null when `data` should go as it is: a
 * bare Enter, anything not ending in one, and `ESC \r` (Alt/Shift+Enter, a
 * newline in the box — split, it would become Escape and then a submit).
 */
export function splitSubmit(data: string): [head: string, enter: string] | null {
  const enter = data.endsWith('\r\n') ? '\r\n' : data.endsWith('\r') ? '\r' : ''
  if (!enter || data.length === enter.length) return null
  const head = data.slice(0, -enter.length)
  if (head.endsWith('\x1b')) return null
  return [head, enter]
}

/**
 * Keys that must never wait behind a held Enter: Ctrl+C and a lone Escape are
 * how somebody stops an agent, and they go to the PTY at once.
 */
export function isUrgent(data: string): boolean {
  return data === '\x03' || data === '\x1b'
}
