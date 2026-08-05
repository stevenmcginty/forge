/**
 * Check for the typed-draft tracker behind "Take back typed".
 *
 *   node scripts/draft-check.mjs
 *
 * The tracker reconstructs what a pane's line editor is holding from the raw
 * keystroke stream — backspaces, control chords, escape sequences, bracketed
 * pastes. That is a parser, and parsers look right until the one chunk that
 * splits an escape sequence across a boundary. So the rules live in
 * src/lib/draft.ts with no DOM in them, and this file holds them to it.
 */
import { registerHooks } from 'node:module'

registerHooks({
  resolve(spec, context, next) {
    if (spec.startsWith('@shared/')) {
      return next(new URL(`../shared/${spec.slice('@shared/'.length)}.ts`, import.meta.url).href, context)
    }
    if (spec.startsWith('.') && !/\.[a-z]+$/i.test(spec)) return next(`${spec}.ts`, context)
    return next(spec, context)
  },
  load(url, context, next) {
    if (url.endsWith('.ts')) return next(url, { ...context, format: 'module-typescript' })
    return next(url, context)
  }
})

const { advanceDraft, clampDraft, TYPED_DRAFT_CAP } = await import('../src/lib/draft.ts')

let pass = 0
let fail = 0
const ok = (cond, label, detail = '') => {
  if (cond) {
    pass++
    console.log(`  ✓ ${label}`)
  } else {
    fail++
    console.log(`  ✕ ${label}${detail ? ` — ${detail}` : ''}`)
  }
}
const is = (got, want, label) => ok(got === want, label, `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`)

// One keystroke at a time, the way typing actually arrives.
const typed = (...chunks) => chunks.reduce((d, c) => advanceDraft(d, c), '')

console.log('typing')
is(typed('h', 'i', ' ', 'there'), 'hi there', 'printable keys append')
is(typed('hi'), 'hi', 'a multi-char chunk appends whole')
is(typed('hi', '\x7f'), 'h', 'backspace pops')
is(typed('hi', '\b'), 'h', 'so does ^H')
is(typed('\x7f'), '', 'backspace on an empty draft stays empty')
is(typed('a🎉', '\x7f'), 'a', 'backspace pops a whole emoji, not half a surrogate')

console.log('the line ending')
is(typed('deploy', '\r'), '', 'Enter means the draft was submitted')
is(typed('deploy', '\n'), '', 'so does a bare newline')
is(typed('deploy', '\x03'), '', '^C wipes the line')
is(typed('deploy', '\x15'), '', 'so does ^U')
is(typed('rm -rf tmp', '\x17'), 'rm -rf ', '^W kills the word behind the caret')
is(typed('one two  ', '\x17'), 'one ', '^W eats trailing spaces with the word')
is(typed('gone', '\r', 'fresh'), 'fresh', 'typing after Enter starts a new draft')

console.log('escape sequences pass through without polluting the draft')
is(typed('ab', '\x1b[D'), 'ab', 'an arrow key adds nothing')
is(typed('ab', '\x1b[1;5C'), 'ab', 'nor a ctrl-arrow with params')
is(typed('ab', '\x1b[3~'), 'ab', 'nor Delete (tilde final byte)')
is(typed('ab', '\x1bOP'), 'ab', 'nor an SS3 function key')
is(typed('ab', '\x1bx'), 'ab', 'nor an alt-chord')
is(typed('ab', '\x1b\r'), 'ab', 'Alt+Enter is a newline in an editor, not a submit')
is(typed('ab', '\x1b['), 'ab', 'a CSI cut off at the chunk boundary does not crash')

console.log('pastes')
is(typed('\x1b[200~two words\x1b[201~'), 'two words', 'bracketed paste lands wholesale')
is(typed('say: ', '\x1b[200~hi\x1b[201~', '!'), 'say: hi!', 'text keeps flowing after the close marker')
is(typed('\x1b[200~line1\r\nline2\x1b[201~'), 'line1\r\nline2', 'newlines inside a paste are content, not submits')
is(typed('\x1b[200~no close yet'), 'no close yet', 'an unterminated paste takes the rest of the chunk')

console.log('the cap')
is(clampDraft('x'.repeat(TYPED_DRAFT_CAP + 5)).length, TYPED_DRAFT_CAP, 'clampDraft holds the line')
is(typed('x'.repeat(TYPED_DRAFT_CAP + 5)).length, TYPED_DRAFT_CAP, 'and advanceDraft applies it')
ok(clampDraft('short') === 'short', 'a short draft is untouched')

console.log('')
console.log(`${pass} passed, ${fail} failed`)
if (fail > 0) process.exit(1)
