/**
 * The catch-up buffer's one dangerous property: it is *output*, and some output
 * asks questions.
 *
 * A program probes its terminal as it starts — "what are you?" (Device
 * Attributes), "what colour are you?" (OSC 10/11), "do you do synchronised
 * output?" (DECRQM) — and a terminal answers by writing back down the PTY.
 * That is correct while the program is listening for the answer.
 *
 * It is disastrous on a replay. A renderer reload re-adopts the running session
 * and feeds the remembered screen through xterm a second time; xterm sees the
 * questions again, dutifully answers ones nobody asked, and the answers land in
 * whatever is reading stdin *now*. That is where a restored Codex pane got
 * `[?1;2c]10;rgb:e8e8/eaea/eded\]11;rgb:0e0e/0f0f/1212\` sitting in its
 * composer as though Steve had typed it — once per reload.
 *
 * A replay is a picture of what was already on screen. It must never speak
 * back. So the questions come out of the copy that gets replayed; the live
 * stream is untouched, because a live question does deserve an answer.
 */

/**
 * The sequences xterm answers on sight. Every one of them is a query and
 * nothing else — none of them puts a glyph on screen — so removing them from a
 * repaint costs the picture nothing.
 */
const QUESTIONS: RegExp[] = [
  /* Device Attributes and Device Status Report: CSI c, CSI > c, CSI ? n, … */
  /\x1b\[[?>=]?[0-9;]*[cn]/g,
  /* DECRQM — "is mode N set?", which is how a modern TUI asks for 2026. */
  /\x1b\[\??[0-9;]*\$p/g,
  /* OSC colour and palette queries: anything ending `?` before BEL or ST. */
  /\x1b\][0-9;]*\?(?:\x07|\x1b\\)/g,
  /* The obsolete single-character DA, which xterm still answers. */
  /\x1bZ/g
]

/** The same bytes, with everything that would provoke a reply taken out. */
export function withoutQuestions(data: string): string {
  let out = data
  for (const question of QUESTIONS) out = out.replace(question, '')
  return out
}
