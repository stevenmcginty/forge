/**
 * The typed-draft tracker behind "Take back typed".
 *
 * Forge sits between the keyboard and the PTY, so it can watch the keystroke
 * stream into a pane and reconstruct the draft the program's line editor is
 * holding: printable keys append, backspace pops, Enter/^C/^U mean the line is
 * gone, a bracketed paste lands wholesale. Escape sequences — arrows, Home/End,
 * alt-chords — are skipped rather than modelled: they move a caret this tracker
 * does not have, so after one the draft is an approximation.
 *
 * Approximate on purpose. The one consumer (terminalHost.takeBack) erases with
 * backspaces, and a backspace at an empty prompt is a no-op in every shell and
 * agent Forge launches — so overshoot is harmless, and undershoot only happens
 * after caret gymnastics that are rare in a prompt being composed.
 *
 * No DOM in here, deliberately: scripts/draft-check.mjs holds this parser to
 * its word the same way mosaic-check holds the wall's arithmetic.
 */

/**
 * The most draft the tracker keeps. Erasure is one backspace per character
 * down the PTY, so the cap is really a bound on how many a takeBack may fire —
 * far beyond anything typed by hand, roomy enough for a pasted spec.
 */
export const TYPED_DRAFT_CAP = 20000

export function clampDraft(s: string): string {
  return s.length > TYPED_DRAFT_CAP ? s.slice(-TYPED_DRAFT_CAP) : s
}

/** Advance `draft` by one chunk of keyboard input on its way to the PTY. */
export function advanceDraft(draft: string, data: string): string {
  for (let i = 0; i < data.length; i++) {
    const ch = data[i]!
    if (ch === '\x1b') {
      if (data.startsWith('[200~', i + 1)) {
        // Bracketed paste: content up to the close marker, markers stripped.
        // Unterminated (split across chunks) takes the rest of the chunk.
        const end = data.indexOf('\x1b[201~', i + 6)
        draft += end === -1 ? data.slice(i + 6) : data.slice(i + 6, end)
        i = end === -1 ? data.length : end + 5
      } else if (data[i + 1] === '[') {
        // CSI: skip params up to and including the final byte.
        i += 2
        while (i < data.length && !/[A-Za-z~]/.test(data[i]!)) i++
      } else if (data[i + 1] === 'O') {
        i += 2 // SS3 function key: ESC O <final>
      } else {
        i += 1 // Alt-chord: ESC <key> — Alt+Enter included, so a newline in
        //        an agent's editor does not read as a submit.
      }
      continue
    }
    if (ch === '\r' || ch === '\n' || ch === '\x03' || ch === '\x15') {
      draft = '' // Submitted (Enter) or wiped (^C, ^U) — either way, gone.
      continue
    }
    if (ch === '\x7f' || ch === '\b') {
      const cps = Array.from(draft) // Code points: never split an emoji.
      cps.pop()
      draft = cps.join('')
      continue
    }
    if (ch === '\x17') {
      draft = draft.replace(/\S+\s*$/, '') // ^W: the word behind the caret.
      continue
    }
    if (ch >= ' ') draft += ch
  }
  return clampDraft(draft)
}
