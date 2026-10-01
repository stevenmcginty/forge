/**
 * Check for the pure parts of the phone face's six fixes (2026-10-01).
 *
 *   node scripts/web-phone-six-check.mjs      (npm run web:phone-six)
 *
 * Three rules that can be stated without a phone in the hand:
 *
 *  1. Drafts (web/src/lib/drafts.ts) — a pane's words survive a reload, an
 *     emptied draft is forgotten, the store holds 20 panes of 8,000 characters
 *     and drops the oldest, and a store that throws or holds rubbish costs
 *     nothing but the drafts.
 *  2. The answer picker (`pickAnswer`, web/src/components/ChatView.tsx) — Copy
 *     and Read aloud take the text after the last tool call, and the whole
 *     turn when nothing follows it.
 *  3. Bare URLs (web/src/lib/markdown.tsx) — an `https://…` in prose is a link
 *     that opens in a new tab, its trailing punctuation is prose, code is left
 *     alone, and nothing but http(s) is ever a link.
 *
 * The real modules are bundled with esbuild (they are .tsx, and ChatView pulls
 * in a stylesheet) and imported from memory — nothing is written to disk. The
 * markdown is checked on the React elements `renderMarkdown` returns, walked
 * as data, so no renderer and no DOM are needed either.
 */
import { join, resolve } from 'node:path'
import { build } from 'esbuild'

const ROOT = resolve(import.meta.dirname, '..')

const bundled = await build({
  stdin: {
    contents: [
      `export * from './web/src/lib/drafts.ts'`,
      `export { pickAnswer } from './web/src/components/ChatView.tsx'`,
      `export { renderMarkdown, trimBareUrl } from './web/src/lib/markdown.tsx'`
    ].join('\n'),
    resolveDir: ROOT,
    loader: 'ts'
  },
  write: false,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  jsx: 'automatic',
  alias: { '@shared': join(ROOT, 'shared'), '@': join(ROOT, 'src') },
  loader: { '.css': 'empty' },
  logLevel: 'silent',
  absWorkingDir: ROOT
})
const source = bundled.outputFiles[0].text
const {
  DRAFTS_KEY,
  DRAFT_CHARS_MAX,
  DRAFT_PANES_MAX,
  clampDraft,
  parseDrafts,
  putDraft,
  readDrafts,
  writeDraft,
  pickAnswer,
  renderMarkdown,
  trimBareUrl
} = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`)

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
const is = (got, want, label) =>
  ok(JSON.stringify(got) === JSON.stringify(want), label, `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`)

/* ------------------------------------------------------------------ drafts */

/** `localStorage`, as far as drafts.ts uses it. */
function memoryStore() {
  const map = new Map()
  return {
    map,
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => void map.set(key, String(value)),
    removeItem: (key) => void map.delete(key)
  }
}

console.log('drafts: kept, restored, forgotten')
{
  const store = memoryStore()
  is(readDrafts(store), {}, 'an empty store holds no drafts')
  writeDraft('pane-a', 'fix the login bug', store, 1)
  writeDraft('pane-b', 'and then the tests', store, 2)
  is(readDrafts(store), { 'pane-a': 'fix the login bug', 'pane-b': 'and then the tests' }, 'each pane gets its own words back')
  writeDraft('pane-a', 'fix the login bug on the phone', store, 3)
  is(readDrafts(store)['pane-a'], 'fix the login bug on the phone', 'a later write replaces the pane\'s draft')
  is(parseDrafts(store.getItem(DRAFTS_KEY)).map((d) => d.pane), ['pane-b', 'pane-a'], 'and makes that pane the newest')
  writeDraft('pane-a', '', store, 4)
  is(readDrafts(store), { 'pane-b': 'and then the tests' }, 'an emptied draft (sent) is forgotten')
  writeDraft('pane-b', '   \n ', store, 5)
  is(readDrafts(store), {}, 'so is one that is only white space')
  ok(!store.map.has(DRAFTS_KEY), 'and the last draft gone leaves no key behind')
}

console.log('drafts: the caps')
{
  const store = memoryStore()
  for (let i = 1; i <= DRAFT_PANES_MAX + 5; i++) writeDraft(`pane-${i}`, `words ${i}`, store, i)
  const kept = readDrafts(store)
  is(DRAFT_PANES_MAX, 20, 'the store holds 20 panes')
  is(Object.keys(kept).length, DRAFT_PANES_MAX, 'and never more, however many are written')
  ok(!('pane-1' in kept) && !('pane-5' in kept), 'the oldest are the ones that went')
  ok('pane-6' in kept && `pane-${DRAFT_PANES_MAX + 5}` in kept, 'the newest twenty are all there')
  // Touching an old pane makes it new again: it is not the next to go.
  writeDraft('pane-6', 'still writing this one', store, 100)
  writeDraft('pane-new', 'one more', store, 101)
  const after = readDrafts(store)
  ok('pane-6' in after && !('pane-7' in after), 'a pane written again is the newest, so the next-oldest goes instead')

  is(DRAFT_CHARS_MAX, 8000, 'a draft is kept to 8,000 characters')
  writeDraft('long', 'x'.repeat(DRAFT_CHARS_MAX + 500), store, 200)
  is(readDrafts(store)['long'].length, DRAFT_CHARS_MAX, 'a longer one is cut to that')
  const emoji = `${'x'.repeat(DRAFT_CHARS_MAX - 1)}🎉`
  is(clampDraft(emoji).length, DRAFT_CHARS_MAX - 1, 'and the cut never leaves half an emoji')
  is(clampDraft('short'), 'short', 'a short draft is left alone')
}

console.log('drafts: a store that misbehaves')
{
  is(parseDrafts(null), [], 'nothing stored is no drafts')
  is(parseDrafts('{not json'), [], 'so is rubbish')
  is(parseDrafts('{"pane":"a"}'), [], 'and JSON of the wrong shape')
  is(
    parseDrafts(JSON.stringify([{ pane: 'a', text: 'ok', at: 1 }, { pane: 7, text: 'no' }, null, { pane: 'b' }])),
    [{ pane: 'a', text: 'ok', at: 1 }],
    'entries that are not drafts are skipped, the rest kept'
  )
  is(putDraft([{ pane: 'a', text: 'one', at: 1 }], 'a', '', 2), [], 'putDraft with no words removes the pane')
  const broken = {
    getItem() {
      throw new Error('SecurityError')
    },
    setItem() {
      throw new Error('QuotaExceededError')
    },
    removeItem() {
      throw new Error('SecurityError')
    }
  }
  let threw = false
  let read = null
  try {
    read = readDrafts(broken)
    writeDraft('pane-a', 'words', broken, 1)
    writeDraft('pane-a', '', broken, 2)
  } catch {
    threw = true
  }
  ok(!threw, 'a store that throws on every call never throws out of drafts.ts')
  is(read, {}, 'and reads as no drafts')
  is(readDrafts(null), {}, 'no store at all (no window) reads as no drafts')
}

/* ------------------------------------------------------- the answer picker */

const text = (words, key = words) => ({ kind: 'text', key, block: { kind: 'text', text: words } })
const tools = (...names) => ({
  kind: 'tools',
  key: names.join('+'),
  tools: names.map((name) => ({ kind: 'tool', name, gist: '' }))
})
const thinking = (words) => ({ kind: 'thinking', key: words, text: words })

console.log('the answer: what Copy and Read aloud take')
{
  const turn = [
    text("I'll start by looking at the composer."),
    tools('Read', 'Grep'),
    text('Found it. Now the fix.'),
    tools('Edit'),
    text('Done: the box stays open.'),
    text('Typecheck passes.')
  ]
  const picked = pickAnswer(turn)
  is(picked.answer, 'Done: the box stays open.\n\nTypecheck passes.', 'the answer is the text after the last tool call')
  is(
    picked.all,
    "I'll start by looking at the composer.\n\nFound it. Now the fix.\n\nDone: the box stays open.\n\nTypecheck passes.",
    'all is every paragraph of the turn, in order'
  )
  ok(picked.answer !== picked.all, 'so the two differ, and the menu offers Copy all / Read all')

  const plain = pickAnswer([text('Yes.'), text('It is in ChatView.tsx.')])
  is(plain.answer, 'Yes.\n\nIt is in ChatView.tsx.', 'a reply with no tools is its own answer')
  is(plain.answer, plain.all, 'and all is the same words — no second menu item')

  const working = pickAnswer([text('Looking into it.'), tools('Bash')])
  is(working.answer, 'Looking into it.', 'nothing after the last tool call falls back to all the text')

  const blank = pickAnswer([text('Checked the logs.'), tools('Bash'), text('  \n')])
  is(blank.answer, 'Checked the logs.\n\n  \n', 'white space after the last tool call is not an answer either')

  const thought = pickAnswer([text('First.'), tools('Read'), thinking('hmm'), text('The answer.')])
  is(thought.answer, 'The answer.', 'thinking is never part of what is copied or read')
  is(thought.all, 'First.\n\nThe answer.', 'not even of all')

  is(pickAnswer([tools('Read')]), { answer: '', all: '' }, 'a turn of tool calls only has no words')
  is(pickAnswer([]), { answer: '', all: '' }, 'nor has an empty one')
}

/* --------------------------------------------------------------- bare URLs */

/** Every element in a React tree, depth first — components are not run, only looked at. */
function elements(node, out = []) {
  if (Array.isArray(node)) for (const child of node) elements(child, out)
  else if (node && typeof node === 'object' && 'props' in node) {
    out.push(node)
    elements(node.props.children, out)
  }
  return out
}
/** The words under a node. */
function words(node) {
  if (node == null || typeof node === 'boolean') return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(words).join('')
  return words(node.props?.children)
}
const links = (markdown) =>
  elements(renderMarkdown(markdown))
    .filter((el) => el.type === 'a')
    .map((el) => el.props.href)
const linkEls = (markdown) => elements(renderMarkdown(markdown)).filter((el) => el.type === 'a')

console.log('bare URLs: a link in prose')
{
  const [a] = linkEls('The PR is at https://github.com/steve/forge/pull/12 now.')
  ok(Boolean(a), 'a bare https URL in a sentence is a link')
  is(a?.props.href, 'https://github.com/steve/forge/pull/12', 'to exactly that address')
  is(words(a), 'https://github.com/steve/forge/pull/12', 'showing the address as its words')
  is(a?.props.target, '_blank', 'it opens in a new tab')
  is(a?.props.rel, 'noopener noreferrer', 'with rel="noopener noreferrer"')
  is(a?.props.className, 'md__link', 'and wears the link class')
  is(links('Preview: http://localhost:5173/app'), ['http://localhost:5173/app'], 'plain http and a port work too')
  is(
    words(renderMarkdown('See https://x.dev/a for more.')),
    'See https://x.dev/a for more.',
    'the sentence reads the same as it was written'
  )
}

console.log('bare URLs: where one ends')
{
  is(links('It is at https://x.dev/pr/12.'), ['https://x.dev/pr/12'], 'a full stop after it is the sentence\'s')
  is(links('Open https://x.dev/a, then https://x.dev/b!'), ['https://x.dev/a', 'https://x.dev/b'], 'so are a comma and a bang')
  is(links('(see https://x.dev/docs)'), ['https://x.dev/docs'], 'a bracket that closes the aside is not in the link')
  is(
    links('https://en.wikipedia.org/wiki/Rust_(programming_language)'),
    ['https://en.wikipedia.org/wiki/Rust_(programming_language)'],
    'a bracket the URL opened itself stays'
  )
  is(links('**https://x.dev/bold**'), ['https://x.dev/bold'], 'bold round a URL still links it, without the stars')
  is(links('https://x.dev/a_b_c and _so on_'), ['https://x.dev/a_b_c'], 'underscores inside a URL are not italics')
  is(links('https://x.dev/q?a=1&b=2#top'), ['https://x.dev/q?a=1&b=2#top'], 'a query and a fragment are kept whole')
  is(trimBareUrl('https://x.dev/a).'), 'https://x.dev/a', 'trimBareUrl takes a run of trailing punctuation off')
  is(trimBareUrl('https://'), '', 'and a scheme with nothing after it is no URL')
}

console.log('bare URLs: what is left alone')
{
  is(links('Run `curl https://x.dev/api` first.'), [], 'a URL inside inline code is not a link')
  const fenced = elements(renderMarkdown('```\nhttps://x.dev/in-a-block\n```'))
  ok(!fenced.some((el) => el.type === 'a'), 'nor is one inside a fenced block')
  const written = linkEls('[the docs](https://x.dev/docs) and [https://x.dev/raw](https://x.dev/raw)')
  is(written.map((el) => el.props.href), ['https://x.dev/docs', 'https://x.dev/raw'], 'a written markdown link is one link, as before')
  ok(
    written.every((el) => !elements(el.props.children).some((inner) => inner.type === 'a')),
    'and a URL used as its words does not nest a second link inside it'
  )
  is(links('javascript://alert(1) ftp://x.dev file:///etc/passwd mailto:a@b.c'), [], 'only http and https are ever linked')
  is(links('xhttps://x.dev and git+https://x.dev/repo'), [], 'a scheme that is the tail of another word is not a URL')
  is(links('just words, no address'), [], 'prose with no URL has no link')
  const table = linkEls('| where | what |\n| --- | --- |\n| https://x.dev/t | the page |')
  is(table.map((el) => el.props.href), ['https://x.dev/t'], 'a URL in a table cell is a link too')
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
