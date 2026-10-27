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
 *    that notice. `stripInvisible` takes them out first. The zero-width joiner
 *    inside an emoji sequence stays: Claude Code passes it, and without it a
 *    family emoji falls apart into three people.
 *
 * Pure, so scripts/submit-split-check.mjs can prove both without a PTY.
 */

/** How long the Enter waits after the words. 60 ms was enough in the repro. */
export const ENTER_GAP_MS = 80

const ZWJ = '‍'
const ANY_FORMAT = /\p{Cf}/u
const FORMAT = /\p{Cf}/gu
/** The pictograph a joiner may follow: an emoji, maybe with VS16 or a skin tone. */
const JOIN_BEFORE = /\p{Extended_Pictographic}[\u{FE0F}\u{1F3FB}-\u{1F3FF}]?$/u
const JOIN_AFTER = /^\p{Extended_Pictographic}/u

/** `text` without its invisible format characters (emoji joiners kept). */
export function stripInvisible(text: string): string {
  if (!ANY_FORMAT.test(text)) return text
  return text.replace(FORMAT, (ch: string, at: number, whole: string) =>
    ch === ZWJ &&
    JOIN_BEFORE.test(whole.slice(Math.max(0, at - 4), at)) &&
    JOIN_AFTER.test(whole.slice(at + 1, at + 3))
      ? ch
      : ''
  )
}

/**
 * The part of `data` to write now, when `data` is something followed by its
 * Enter — the caller writes this, then `\r` alone `ENTER_GAP_MS` later. Null
 * when `data` should go as it is: a bare Enter, anything not ending in `\r`,
 * and `ESC \r` (Alt/Shift+Enter, a newline in the box — split, it would become
 * Escape and then a submit).
 */
export function submitHead(data: string): string | null {
  if (data.length < 2 || !data.endsWith('\r')) return null
  const head = data.slice(0, -1)
  if (head.endsWith('\x1b')) return null
  return head
}
