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

const { stripBoxDrawing, stripLiveComposer, blocksFromCapture } = await import('../web/src/lib/feed.ts')

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

if (fail) {
  console.log(`\n${fail} failed, ${pass} passed`)
  process.exit(1)
}
console.log(`\n${pass} passed`)
