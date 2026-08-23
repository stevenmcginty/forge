/**
 * Check for the web client's conversation feed parser.
 *
 *   node scripts/feed-check.mjs
 *
 * The browser still mirrors a PTY; this file holds the cut that turns that
 * screen into cards — strip the TUI's own composer, split user turns from
 * agent turns — so a wrong heuristic fails here rather than as a missing
 * message on a phone.
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

const { stripBoxDrawing, stripLiveComposer, blocksFromCapture, transcriptFromLines, richFromText, mergeBlocks } =
  await import('../src/lib/feed.ts')

/** A whole screen, the way the terminal would hand one over. */
const screen = (text) => transcriptFromLines(richFromText(text))
/** The roles of a transcript's cards, in order. */
const roles = (blocks) => blocks.map((b) => b.role).join(' ')
/** Does any card carry this text? Used to prove the footer is *not* in one. */
const inAnyBlock = (blocks, re) => blocks.some((b) => re.test(b.text))

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

console.log('box drawing')
is(stripBoxDrawing('│  hello  │'), 'hello', 'a bordered row keeps the words')
is(stripBoxDrawing('╭─────────╮'), '', 'a border-only row comes back empty')

console.log('live composer')
is(stripLiveComposer('hello\n\n❯ '), 'hello', 'drops an empty ❯ prompt')
is(stripLiveComposer('hello\n\n> '), 'hello', 'drops an empty > prompt')
is(stripLiveComposer('hello\n────────────\n❯ '), 'hello', 'drops the rule above it too')
is(
  stripLiveComposer('> went over the same fault\n\nchecking the capture\n\n❯ '),
  '> went over the same fault\n\nchecking the capture',
  'keeps a history > turn and drops only the live box'
)
is(stripLiveComposer('PS C:\\forge>'), '', 'an empty PowerShell prompt is chrome')
ok(
  stripLiveComposer('hello\n❯ type this').includes('type this'),
  'a filled ❯ line is left alone — better to show a draft than eat a user turn'
)

console.log('claude-shaped screen')
const claude = [
  'Claude Code v2.1',
  'Sonnet 4.6 · Claude Pro',
  'C:\\Users\\steve\\Desktop\\forge',
  '',
  '> went over the same fault as yesterday',
  '',
  'Checking yesterday\'s capture for the exact code recorded.',
  '',
  'Running...',
  '',
  '❯ '
].join('\n')
const claudeBlocks = blocksFromCapture(claude)
ok(claudeBlocks[0]?.role === 'system', 'banner is a system card')
ok(claudeBlocks.some((b) => b.role === 'user' && b.text.includes('went over the same fault')), 'user turn is a user card')
ok(claudeBlocks.some((b) => b.role === 'agent' && /Checking yesterday/.test(b.text)), 'the reply is an agent card')
ok(!claudeBlocks.some((b) => /❯/.test(b.text)), 'the live prompt is not in any card')

console.log('you-prefix')
const grok = ['Grok', '', 'You: is it the sensor', '', 'I think it is the wiring.', '', '> '].join('\n')
const grokBlocks = blocksFromCapture(grok)
ok(grokBlocks.some((b) => b.role === 'user' && b.text === 'is it the sensor'), 'You: becomes a user card')
ok(grokBlocks.some((b) => b.role === 'agent' && /wiring/.test(b.text)), 'the reply follows as agent')

console.log('no markers')
const shell = 'PS C:\\forge>\necho hi\nhi\nPS C:\\forge>'
const shellBlocks = blocksFromCapture(shell)
ok(shellBlocks.length >= 1, 'a screen with no user markers still yields a card')
ok(shellBlocks.every((b) => b.role !== 'user'), 'and does not invent a user turn')

console.log('empty')
ok(blocksFromCapture('').length === 0, 'empty capture is no cards')
ok(blocksFromCapture('❯ ').length === 0, 'a prompt alone is no cards')

/*
 * From here down the fixtures are whole screens, as close to what each CLI
 * actually paints as a template string can be — banner, turns, tool calls,
 * spinner, composer box, footer. They are the difference between a parser that
 * passes its own unit tests and one that survives a real pane.
 */

console.log('claude code, a whole screen')
const claudeFull = [
  '╭──────────────────────────────────────────────────╮',
  '│ ✻ Welcome to Claude Code                         │',
  '│                                                  │',
  '│   Opus 4.1 · claude.ai/code                      │',
  '│   C:\\Users\\steve\\Desktop\\forge                   │',
  '╰──────────────────────────────────────────────────╯',
  '',
  '> read the feed parser and tell me what it drops',
  '',
  '⏺ I will look at the parser first.',
  '',
  '⏺ Read(web/src/lib/feed.ts)',
  '  ⎿  Read 169 lines (ctrl+o to expand)',
  '',
  '⏺ It drops the footer, which is where the mode lives.',
  '',
  '> now fix it',
  '',
  '⏺ Update(web/src/lib/feed.ts)',
  '  ⎿  Updated web/src/lib/feed.ts with 12 additions',
  '',
  '✢ Thinking… (12s · ↓ 1.2k tokens · esc to interrupt)',
  '',
  '╭──────────────────────────────────────────────────╮',
  '│ >                                                │',
  '╰──────────────────────────────────────────────────╯',
  '  ⏵⏵ bypass permissions on (shift+tab to cycle)      Context left until auto-compact: 23%'
].join('\n')
const claudeScreen = screen(claudeFull)
is(roles(claudeScreen.blocks), 'system user agent tool agent user tool', 'banner, two turns and two tool calls, in order')
is(claudeScreen.status.model, 'Opus 4.1', 'the model comes off the banner')
is(claudeScreen.status.mode, 'bypass', 'the permission mode comes off the footer')
ok(/bypass permissions/i.test(claudeScreen.status.modeLabel ?? ''), 'and keeps the words the TUI printed')
is(claudeScreen.status.context, '23%', 'context left is read')
is(claudeScreen.status.cwd, 'C:\\Users\\steve\\Desktop\\forge', 'the cwd is read')
is(claudeScreen.status.busy, true, 'a spinner line means busy')
is(claudeScreen.status.activity, 'Thinking', 'and names what it is doing')
ok(
  claudeScreen.status.footer.some((line) => /bypass permissions/.test(line)),
  'the footer lines are kept in status.footer'
)
ok(!inAnyBlock(claudeScreen.blocks, /bypass permissions/), 'and the mode line is in no card')
ok(!inAnyBlock(claudeScreen.blocks, /esc to interrupt/), 'nor is the spinner')
ok(!inAnyBlock(claudeScreen.blocks, /^❯|\n❯/), 'nor is the live prompt')
const claudeTool = claudeScreen.blocks.find((b) => b.role === 'tool')
ok(/^⏺ Read\(/.test(claudeTool?.text ?? ''), 'a tool card starts at the call')
ok(/⎿/.test(claudeTool?.text ?? ''), 'and carries its ⎿ result line')
ok(
  claudeScreen.blocks.some((b) => b.role === 'agent' && /I will look at the parser/.test(b.text)),
  'prose under the same ⏺ bullet stays agent prose'
)

console.log('gemini, a whole screen')
const geminiFull = [
  ' ███ GEMINI',
  '',
  ' Tips for getting started:',
  ' 1. Ask questions, edit files, run commands.',
  '',
  '> summarise the diff',
  '',
  '✦ The diff adds a status strip above the feed.',
  '',
  '✓ ReadFile web/src/lib/rich.ts',
  '   Read 76 lines',
  '',
  '╭────────────────────────────────────────────────────╮',
  '│ > Type your message or @path/to/file               │',
  '╰────────────────────────────────────────────────────╯',
  '~/Desktop/forge (main*)   no sandbox (see /docs)   gemini-2.5-pro (97% context left)'
].join('\n')
const geminiScreen = screen(geminiFull)
is(roles(geminiScreen.blocks), 'system agent user agent tool', 'banner, tips, the turn, the reply, the tool')
is(geminiScreen.status.model, 'gemini-2.5-pro', 'gemini names its model in the footer')
is(geminiScreen.status.context, '97%', 'and its context left')
is(geminiScreen.status.cwd, '~/Desktop/forge', 'and its cwd')
is(geminiScreen.status.branch, 'main*', 'and its branch')
is(geminiScreen.status.busy, false, 'an idle screen is not busy')
ok(!inAnyBlock(geminiScreen.blocks, /Type your message/), 'the composer placeholder is not a user turn')
ok(!inAnyBlock(geminiScreen.blocks, /no sandbox/), 'and the footer line is in no card')
ok(
  geminiScreen.blocks.some((b) => b.role === 'user' && b.text === 'summarise the diff'),
  'the > turn is the user'
)
ok(
  geminiScreen.blocks.some((b) => b.role === 'tool' && /ReadFile/.test(b.text)),
  'a ticked tool is a tool card'
)

console.log('codex, a whole screen')
const codexFull = [
  '╭──────────────────────────────────────────────╮',
  '│  >_ OpenAI Codex (v0.5.0)                    │',
  '│                                              │',
  '│  model: gpt-5-codex                          │',
  '│  approval: full-auto                         │',
  '│  sandbox: workspace-write                    │',
  '╰──────────────────────────────────────────────╯',
  '',
  '> run the fast checks',
  '',
  'Running the fast lane now.',
  '',
  '$ npm run check',
  '  1 failed, 42 passed',
  '',
  '▌ Ask Codex to do anything',
  '⏎ send   ctrl+c quit'
].join('\n')
const codexScreen = screen(codexFull)
is(roles(codexScreen.blocks), 'system agent user agent tool', 'banner, settings, the turn, the reply, the command')
is(codexScreen.status.model, 'gpt-5-codex', 'codex names its model')
is(codexScreen.status.mode, 'auto', 'full-auto approval is an auto mode')
ok(
  codexScreen.blocks.some((b) => b.role === 'tool' && /^\$ npm run check/.test(b.text)),
  'a $ command is a tool card'
)
ok(
  codexScreen.blocks.some((b) => b.role === 'tool' && /42 passed/.test(b.text)),
  'and its indented output belongs to it'
)
ok(!inAnyBlock(codexScreen.blocks, /Ask Codex to do anything/), 'the placeholder is not a card')
ok(!inAnyBlock(codexScreen.blocks, /ctrl\+c quit/), 'nor are the key hints')

console.log('grok, a whole screen')
const grokFull = [
  ' grok-4',
  '',
  'You: is it the sensor or the wiring',
  '',
  'I think it is the wiring — the sensor reads fine at idle.',
  '',
  '› '
].join('\n')
const grokScreen = screen(grokFull)
is(roles(grokScreen.blocks), 'system user agent', 'the wordmark, the question, the answer')
is(grokScreen.status.model, 'grok-4', 'grok names its model')
is(grokScreen.status.mode, 'unknown', 'and prints no mode, so none is guessed')
ok(
  grokScreen.blocks.some((b) => b.role === 'user' && b.text === 'is it the sensor or the wiring'),
  'You: is still a user turn'
)

console.log('a plain shell')
const pwshFull = [
  'Windows PowerShell',
  'Copyright (C) Microsoft Corporation. All rights reserved.',
  '',
  'PS C:\\Users\\steve\\Desktop\\forge> npm run feed:check',
  '18 passed',
  'PS C:\\Users\\steve\\Desktop\\forge>'
].join('\n')
const pwshScreen = screen(pwshFull)
is(pwshScreen.status.mode, 'unknown', 'a shell has no permission mode')
is(pwshScreen.status.model, undefined, 'and no model')
is(pwshScreen.status.busy, false, 'and is not busy')
is(roles(pwshScreen.blocks), 'agent', 'a shell is one agent card — the honest shape of it')
ok(!inAnyBlock(pwshScreen.blocks, /forge>\s*$/), 'its live prompt is still chrome')

console.log('colour survives')
const coloured = [
  { runs: [{ text: '> ' }, { text: 'paint it red', fg: 'rgb(224, 108, 117)' }], text: '> paint it red' },
  { runs: [], text: '' },
  { runs: [{ text: 'Done', fg: '#8bd5ca', bold: true }, { text: '.' }], text: 'Done.' }
]
const rich = transcriptFromLines(coloured)
const userBlock = rich.blocks.find((b) => b.role === 'user')
const agentBlock = rich.blocks.find((b) => b.role === 'agent')
is(userBlock?.text, 'paint it red', 'the > marker is cut off the user turn')
ok(
  userBlock?.lines[0]?.runs.some((run) => run.fg === 'rgb(224, 108, 117)'),
  'and the run under it keeps its colour'
)
ok(
  agentBlock?.lines[0]?.runs.some((run) => run.fg === '#8bd5ca' && run.bold === true),
  'an agent run keeps colour and weight'
)

console.log('ids hold still')
const before = ['> one', '', 'the first answer', '', '> two', '', 'the second answer'].join('\n')
const after = `${before}\n  and a little more of it`
const beforeIds = blocksFromCapture(before).map((b) => b.id)
const afterIds = blocksFromCapture(after).map((b) => b.id)
is(afterIds.length, beforeIds.length, 'appending to the last turn adds no card')
ok(
  beforeIds.every((id, i) => id === afterIds[i]),
  'every card keeps its id across a re-parse, the one still growing included'
)

console.log('merge, so Grok keeps what scrolled off the screen')
const frame1 = blocksFromCapture(['> first question', '', 'first answer, which is long enough to matter', '', '❯ '].join('\n'))
const frame2 = blocksFromCapture(
  ['first answer, which is long enough to matter', '', '> second question', '', 'second answer', '', '❯ '].join('\n')
)
const grown = mergeBlocks(frame1, frame2)
ok(
  grown.some((b) => b.role === 'user' && b.text.includes('first question')),
  'a turn that left the TUI frame is still in the log'
)
ok(
  grown.some((b) => b.role === 'user' && b.text.includes('second question')),
  'and the new turn is there too'
)
ok(grown.filter((b) => b.role === 'user').length === 2, 'two user turns, not a replace of the frame')

const streaming = mergeBlocks(
  blocksFromCapture('> ask\n\nHello'),
  blocksFromCapture('> ask\n\nHello world')
)
ok(
  streaming.filter((b) => b.role === 'agent').length === 1 &&
    streaming.some((b) => b.role === 'agent' && b.text === 'Hello world'),
  'the live agent card grows in place rather than duplicating'
)

const claudeReplace = mergeBlocks(blocksFromCapture(before), blocksFromCapture(after))
ok(
  claudeReplace.length === afterIds.length && claudeReplace.every((b, i) => b.role === blocksFromCapture(after)[i]?.role),
  'a full-scrollback capture (Claude Code) still replaces cleanly'
)

const paged = mergeBlocks(
  grown,
  blocksFromCapture(['> first question', '', 'first answer, which is long enough to matter', '', '❯ '].join('\n'))
)
ok(
  paged.filter((b) => b.role === 'user').length === 2,
  'paging the TUI back to an older frame does not drop the turns we already have'
)

console.log('merge, so a streamed turn does not replicate the entry (the Grok bug)')
// A second ask of the *same* words, streamed while the visible window slides
// through the first answer and carries a live spinner. Each frame's top edge
// slices an older block mid-way, so nothing above the aligned region can be
// matched away - and none of it may be prepended either.
const again = ['> run the tests', '', 'Of course, checking the failing case first.', '', 'All green now.'].join('\n')
let log2 = blocksFromCapture(again)
for (let n = 1; n <= 10; n++) {
  const frame = [
    'Of course, checking the failing case fi', // window top, cut mid-line
    `checking the failing case (${n}s) ⠋`, // spinner with a live counter
    '> run the tests',
    '',
    `Running the suite, step ${n} of 10 done.`
  ].join('\n')
  log2 = mergeBlocks(log2, blocksFromCapture(frame))
}
ok(
  log2.filter((b) => b.role === 'user').length === 1,
  'the entry stays one turn, however many frames stream it',
  `got ${log2.filter((b) => b.role === 'user').length}`
)
const sliceCards = log2.filter((b) => b.role === 'agent' && b.text.startsWith('Of course, checking the failing case fi\n')).length
ok(sliceCards === 0, 'a block sliced by the frame top is never added as a card of its own', `got ${sliceCards}`)
ok(log2.some((b) => b.role === 'agent' && b.text.includes('step 10 of 10')), 'the newest reply is in the log')

// The same command asked twice, where the older turn says what the newer one
// is still saying: the anchor has to be the newest occurrence.
const twinPrev = blocksFromCapture(['> status', '', 'Working on it.', '', '> status', '', 'Working on it.'].join('\n'))
const twinNext = mergeBlocks(twinPrev, blocksFromCapture(['> status', '', 'Working on it. Harder.'].join('\n')))
is(
  twinNext[twinNext.length - 1]?.text,
  'Working on it. Harder.',
  'a tie anchors at the newest occurrence, so the reply grows on the latest turn'
)

console.log('opencode-shaped screen')
const openCodeFull = [
  'opencode v1.18',
  '',
  'You',
  'fix the feed duplications',
  '',
  'I will look at the merge first.',
  '',
  '# Read src/lib/feed.ts',
  '└ Read 214 lines',
  '',
  'The merge was prepending the frame top.',
  '',
  'tab  for completions',
  '› '
].join('\n')
const openCodeScreen = screen(openCodeFull)
ok(
  openCodeScreen.blocks.some((b) => b.role === 'user' && b.text === 'fix the feed duplications'),
  'a You header on its own line is a user turn'
)
ok(
  openCodeScreen.blocks.some((b) => b.role === 'tool' && /Read src\/lib\/feed/.test(b.text)),
  'an OpenCode # tool call is a tool card'
)
ok(
  openCodeScreen.blocks.some((b) => b.role === 'tool' && /Read 214 lines/.test(b.text)),
  'and its result line belongs to it'
)
ok(
  openCodeScreen.blocks.some((b) => b.role === 'agent' && /prepending the frame top/.test(b.text)),
  'the reply after the tool stays agent prose'
)
ok(!inAnyBlock(openCodeScreen.blocks, /tab\s+for completions/), 'the key hint is not a card')

console.log('spinner frames stay chrome')
const spinning = [
  '> run the tests',
  '',
  'Checking the suite.',
  '',
  'checking the failing case (4s) ⠋',
  '',
  '❯ '
].join('\n')
const spinningBlocks = blocksFromCapture(spinning)
ok(
  !spinningBlocks.some((b) => /checking the failing case \(4s\)/.test(b.text)),
  'a braille spinner with a counter is not a card'
)
ok(spinningBlocks.some((b) => b.role === 'agent' && /Checking the suite/.test(b.text)), 'the sentence before it stays')

console.log("grok's own composer, which is nothing like anybody else's")
// The real thing: an ASCII spinner rather than braille, a bare `2.2s` rather
// than a bracketed one, and a quota footer under the box. None of the rules
// written for Claude, Gemini or Codex names any of it.
const grokFrame = (n) =>
  [
    'Grok 4.6',
    '',
    '≡ master ~\\Desktop\\forge                                     7.8K / 500K',
    '  Have a look at the two screenshots and answer me this.        12:40 PM',
    '',
    `| Waiting for response… ${n}.2s  ${n}.2s ↓7.84k [stop]`,
    '',
    '> ',
    'Weekly limit left: 3% · Grok 4.6 (high)'
  ].join('\n')

const grokLive = screen(grokFrame(2))
ok(!inAnyBlock(grokLive.blocks, /Weekly limit left/), 'the quota footer is not a card')
ok(!inAnyBlock(grokLive.blocks, /Waiting for response/), 'the ASCII spinner is not a card')
ok(!inAnyBlock(grokLive.blocks, /500K/), 'nor is the turn bar, whose context figure moves')
ok(
  grokLive.blocks.some((b) => b.role === 'user' && /Have a look at the two screenshots/.test(b.text)),
  'the bar opens a user card and the message is in it'
)
is(grokLive.status.model, 'Grok 4.6', 'the footer names the model')
is(grokLive.status.context, '7.8K / 500K', 'and the bar gives the context clock')
ok(grokLive.status.busy, 'the spinner still says busy')

// The bug as it was seen: one question, ten redraws, ten copies of the entry.
let grokLog = blocksFromCapture(grokFrame(1))
for (let n = 2; n <= 10; n++) grokLog = mergeBlocks(grokLog, blocksFromCapture(grokFrame(n)))
is(
  grokLog.filter((b) => b.role === 'user').length,
  1,
  'a ticking counter does not stack the entry once per frame'
)

// The id is React's key, so two cards sharing one is a card that vanishes.
const grokIds = grokLog.map((b) => b.id)
is(new Set(grokIds).size, grokIds.length, 'every card in a merged log has an id of its own')

// A frame's tail numbers itself from its own length, so it collides with the
// log it is being folded into. That is the shape that used to leak two
// `agent-2`s into the same render.
const collide = mergeBlocks(
  [
    { id: 'agent-0', role: 'agent', lines: [], text: 'first' },
    { id: 'user-1', role: 'user', lines: [], text: 'ask' },
    { id: 'agent-2', role: 'agent', lines: [], text: 'second' }
  ],
  [
    { id: 'user-1', role: 'user', lines: [], text: 'ask' },
    { id: 'agent-2', role: 'agent', lines: [], text: 'second' },
    { id: 'agent-2', role: 'agent', lines: [], text: 'third' }
  ]
)
is(new Set(collide.map((b) => b.id)).size, collide.length, 'a colliding tail is renumbered, not handed over twice')
ok(collide.some((b) => b.text === 'third'), 'and the new card is still there')

// The eating rule stays the strict one: prose that quotes a duration is a
// sentence, not a spinner, even when it opens with a dash.
const prose = blocksFromCapture(['> time it', '', '- the build took 2.4s, which is fine'].join('\n'))
ok(
  prose.some((b) => b.role === 'agent' && /the build took 2\.4s/.test(b.text)),
  'a prose bullet with a duration in it is not eaten as chrome'
)

/*
 * The stacking harness.
 *
 * Every multi-frame loop above counts user turns, because the entry stacking
 * was the bug anybody could see. But a feed that mints a fresh *agent* or
 * *tool* card twelve times a second is the same bug wearing a different role,
 * and counting users lets twenty of those through without a word. So this
 * asserts on the whole log instead, and asserts the two things that are
 * actually true of a healthy merge:
 *
 *  1. **It settles.** A screen that is only redrawing — same turns, one
 *     ticking figure — must reach a size and stay there. One card of slack,
 *     for the turn still being written.
 *  2. **It is idempotent.** Folding the very same frame in twice must not add
 *     anything, because that is what the parse loop does whenever the PTY is
 *     quiet and the 80ms timer keeps firing.
 */
const steady = (name, frameFn, frames = 40) => {
  let log = blocksFromCapture(frameFn(1))
  let settled = 0
  let worst = 0
  for (let n = 2; n <= frames; n++) {
    log = mergeBlocks(log, blocksFromCapture(frameFn(n)))
    // Five frames is long enough for the first turn to finish arriving and
    // short enough that a leak has barely started, so it is a fair baseline.
    if (n === 5) settled = log.length
    if (n > 5) worst = Math.max(worst, log.length)
  }
  ok(
    worst <= settled + 1,
    `${name}: ${frames} redraws do not stack cards`,
    `settled at ${settled}, grew to ${worst}`
  )
  const twice = mergeBlocks(log, blocksFromCapture(frameFn(frames)))
  ok(twice.length === log.length, `${name}: re-folding the same frame adds no card`, `${log.length} → ${twice.length}`)
}

console.log('nothing stacks under a redraw')

// Claude ticks its elapsed counter *inside* the tool card, under the ⎿ gutter,
// where the body loop's spinner filter never looked.
steady('claude', (n) =>
  [
    '> run the tests',
    '',
    '⏺ I will run the suite and read what fails.',
    '',
    '⏺ Bash(npm test)',
    `  ⎿  Running… (${n}s)`,
    '',
    '╭──────────────────────────────────────────────────╮',
    '│ >                                                │',
    '╰──────────────────────────────────────────────────╯',
    '  ⏵⏵ bypass permissions on (shift+tab to cycle)'
  ].join('\n')
)

// Codex writes a bare `Thinking… (4s)` with no spinner glyph in front of it,
// and hangs a token meter under its composer. Both figures move.
steady('codex', (n) =>
  [
    '> run the fast checks',
    '',
    'Running the fast lane now.',
    '',
    `Thinking… (${n}s)`,
    '',
    '▌ Ask Codex to do anything',
    `Token usage: ${12000 + n} (▲ ${2000 + n})`,
    '⏎ send   ctrl+c quit'
  ].join('\n')
)

// Antigravity's status line is braille, long, and says "esc to cancel" rather
// than Claude's "esc to interrupt" — so it cleared none of the gates.
steady('antigravity', (n) =>
  [
    '> refactor the planner',
    '',
    'Reading the planner and every one of its callers first.',
    '',
    `⠹ Planning changes across 14 files · ${n}s · esc to cancel`,
    '',
    '❯ '
  ].join('\n')
)

// Grok drops the `[stop]` tail the moment the response starts streaming, and
// what is left is an ASCII spinner, a word, and a clock.
steady('grok', (n) =>
  [
    '≡ master ~\\Desktop\\forge                                     7.8K / 500K',
    '  Why does the feed repeat itself?                             12:40 PM',
    '',
    'It is the tail rule in the merge.',
    '',
    `/ Thinking… ${n}.2s`,
    '',
    '> ',
    'Weekly limit left: 3% · Grok 4.6 (high)'
  ].join('\n')
)

// OpenCode hangs its status bar *below* the prompt, with a token meter that
// climbs while the answer streams.
steady('opencode', (n) =>
  [
    'You',
    'fix the feed duplications',
    '',
    'I will look at the merge first.',
    '',
    '› ',
    `opencode  ~/Desktop/forge  sonnet-4-6  ${12 + n}.4K/200K tokens`
  ].join('\n')
)

if (fail) {
  console.log(`\n${fail} failed, ${pass} passed`)
  process.exit(1)
}
console.log(`\n${pass} passed`)
