/**
 * Rules check for the shared scratchpad.
 *
 *   node scripts/share-check.mjs
 *
 * Five markdown files in a project folder, written by up to five agents from
 * four companies plus a person typing into a rail, is a small feature with an
 * unusual number of ways to lose somebody's work. So the parts that could lose
 * it are pure, live in shared/share.ts, shared/ansi.ts and src/lib/paneText.ts,
 * and are held to their rules here.
 *
 * Three things this asserts that are easy to get wrong and impossible to notice:
 *
 *   • a slot file that is *not* in Forge's format still reads back as a usable
 *     slot, because an agent writing the file with its own tools is the whole
 *     point of the feature rather than a corruption to repair;
 *   • truncation never splits a multi-byte character and never lands over the
 *     cap, even though the marker it appends contains the number it computes;
 *   • xterm's wrapped rows are joined without a newline, because a soft-wrapped
 *     300-character line is three rows and joining them with newlines turns one
 *     sentence into three.
 */
import { registerHooks } from 'node:module'

/**
 * `electron`, stubbed — the same trick scripts/git-check.mjs uses.
 *
 * electron/bridge/share-mcp.ts reaches electron/store.ts for the one setting that
 * gates it, and store.ts imports `app`. Nothing this file exercises calls either:
 * `codexFragment`, `openCodeConfig` and `mergeQwenSettings` are pure, and the two
 * functions that would read a setting or write a file are never called here.
 */
const ELECTRON_STUB = 'forge-check:electron'

registerHooks({
  resolve(spec, context, next) {
    if (spec === 'electron') return { url: ELECTRON_STUB, shortCircuit: true }
    if (spec.startsWith('@shared/')) {
      return next(new URL(`../shared/${spec.slice('@shared/'.length)}.ts`, import.meta.url).href, context)
    }
    if (spec.startsWith('@/')) {
      return next(new URL(`../src/${spec.slice('@/'.length)}.ts`, import.meta.url).href, context)
    }
    if (spec.startsWith('.') && !/\.[a-z]+$/i.test(spec)) return next(`${spec}.ts`, context)
    return next(spec, context)
  },
  load(url, context, next) {
    if (url === ELECTRON_STUB) {
      return {
        format: 'module',
        shortCircuit: true,
        source: 'export const app = { getPath: () => "", getAppPath: () => "" }'
      }
    }
    if (url.endsWith('.ts')) return next(url, { ...context, format: 'module-typescript' })
    return next(url, context)
  }
})

const S = await import('../shared/share.ts')
const A = await import('../shared/ansi.ts')
const P = await import('../src/lib/paneText.ts')

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

const bytes = (text) => Buffer.byteLength(text, 'utf8')

/* ---------------------------------------------------------------- identity */

console.log('\nidentity')
ok(S.SHARE_SLOTS === 5, 'five slots')
ok(S.slotFileName(2) === 'slot-2.md', 'a slot is named by its index', S.slotFileName(2))
ok(
  JSON.stringify(S.slotIndexes()) === JSON.stringify([1, 2, 3, 4, 5]),
  'the indexes are 1..5, in order'
)
ok(S.isSlotIndex(1) && S.isSlotIndex(5), 'both ends of the range are slots')
ok(
  !S.isSlotIndex(0) &&
    !S.isSlotIndex(6) &&
    !S.isSlotIndex('2') &&
    !S.isSlotIndex(2.5) &&
    !S.isSlotIndex(Number.NaN) &&
    !S.isSlotIndex(-1) &&
    !S.isSlotIndex(null) &&
    !S.isSlotIndex(undefined),
  'everything that is not a slot index is refused'
)

/* ------------------------------------------------------------- round trip */

console.log('\nformat round trip')
const slot = {
  index: 2,
  title: 'API contract: the #sync endpoint',
  body: 'Line one.\n\n---\n\nA body whose third line is a rule.\n',
  updatedAt: Date.parse('2026-08-08T10:22:41Z'),
  author: 'Claude Code — main',
  via: 'mcp'
}
const rendered = S.formatSlot(slot)
const parsed = S.parseSlot(2, rendered, 1)
ok(parsed.body === slot.body, 'the body comes back byte for byte, rule line and all', JSON.stringify(parsed.body))
ok(parsed.title === slot.title, 'a title containing a colon and a hash survives', parsed.title)
ok(parsed.author === slot.author, 'the author survives')
ok(parsed.via === 'mcp', 'via survives')
ok(parsed.updatedAt === slot.updatedAt, 'updatedAt survives to the second')
ok(!parsed.truncated, 'a body under the cap is not marked truncated')
ok(rendered.startsWith('---\nslot: 2\n'), 'front matter leads with the slot number')
ok(
  S.SHARE_KEYS.every((key) => new RegExp(`^${key}: `, 'm').test(rendered)),
  'every declared front-matter key is actually written'
)

/* -------------------------------------------------------- tolerant reading */

console.log('\ntolerant reading')
const plain = S.parseSlot(3, '# Mobile plan\n\nStep one.\n', 4242)
ok(plain.via === 'agent', 'a file with no front matter reads as written by an agent')
ok(plain.title === 'Mobile plan', 'its title comes from the first heading', plain.title)
ok(plain.updatedAt === 4242, 'its updatedAt comes from the file mtime')
ok(plain.body === '# Mobile plan\n\nStep one.\n', 'its body is the whole file')

ok(S.parseSlot(3, 'just some prose\nand more').title === 'just some prose', 'no heading: the first line will do')
ok(S.parseSlot(3, '').title === 'Slot 3', 'nothing at all: the slot number')
ok(S.parseSlot(3, '   \n\n  ').title === 'Slot 3', 'whitespace only: the slot number')
ok(S.parseSlot(3, '---\n***\n\nbody').title !== '---', 'a rule is never used as a title')

const crlf = S.parseSlot(1, '---\r\nslot: 1\r\ntitle: Windows wrote this\r\nvia: rail\r\n---\r\n\r\nBody.\r\n', 9)
ok(crlf.title === 'Windows wrote this', 'CRLF front matter parses', crlf.title)
ok(crlf.via === 'rail', 'CRLF via parses')
ok(crlf.body === 'Body.\r\n', 'CRLF body keeps its own line endings', JSON.stringify(crlf.body))

const bom = S.parseSlot(1, '﻿---\nslot: 1\ntitle: With a BOM\n---\n\nBody.', 9)
ok(bom.title === 'With a BOM', 'a leading BOM does not hide the front matter', bom.title)

const unclosed = '---\nslot: 1\ntitle: never closed\n\nstill going'
ok(S.parseSlot(1, unclosed, 7).body === unclosed, 'an unterminated header leaves the file as the body')

const badDate = S.parseSlot(1, '---\nslot: 1\ntitle: t\nupdatedAt: not-a-date\n---\n\nb', 5150)
ok(badDate.updatedAt === 5150, 'an unparseable date falls back to the mtime')

const badVia = S.parseSlot(1, '---\nslot: 1\ntitle: t\nvia: telepathy\n---\n\nb', 1)
ok(badVia.via === 'agent', 'an unknown via reads as agent')

/* ---------------------------------------------------------------- capping */

console.log('\ncapping')
const atCap = 'x'.repeat(S.SHARE_MAX_BYTES)
const at = S.capBody(atCap)
ok(!at.truncated && at.body === atCap, 'exactly at the cap is byte-identical and unmarked')

const over = S.capBody(`${'line\n'.repeat(20000)}tail`)
ok(over.truncated, 'one byte over the cap is truncated')
ok(bytes(over.body) <= S.SHARE_MAX_BYTES, 'the truncated body is at or under the cap', String(bytes(over.body)))
ok(S.isTruncatedBody(over.body), 'the truncated body carries the marker')
ok(over.dropped > 0, 'the number of dropped bytes is reported')
ok(new RegExp(`${over.dropped} bytes were dropped`).test(over.body), 'the marker names the same number')
ok(over.body.startsWith('line\n'), 'the head is what was kept')
ok(!over.body.includes('\ntail'), 'the tail is what was lost')

const noBreaks = S.capBody('y'.repeat(200 * 1024))
ok(noBreaks.truncated, 'a body with no line break at all still truncates')
ok(bytes(noBreaks.body) <= S.SHARE_MAX_BYTES, 'and still lands under the cap', String(bytes(noBreaks.body)))

const multibyte = S.capBody('é'.repeat(60 * 1024))
ok(bytes(multibyte.body) <= S.SHARE_MAX_BYTES, 'a multi-byte body lands under the cap')
ok(!multibyte.body.includes('�'), 'and is never cut through a character')

ok(!S.isTruncatedBody('a normal body'), 'an untruncated body carries no marker')

/* -------------------------------------------------------- titles, previews */

console.log('\ntitles and previews')
ok(S.tidyTitle('one\ntwo') === 'one two', 'a newline in a title becomes a space — it would break the header')
ok(S.tidyTitle('  spaced   out  ') === 'spaced out', 'whitespace is collapsed')
const longTitle = S.tidyTitle('t'.repeat(200))
ok(longTitle.length === S.SHARE_MAX_TITLE, 'a long title is cut to the cap', String(longTitle.length))
ok(longTitle.endsWith('…'), 'and says it was cut')

const preview = S.previewOf('first\n\nsecond   third')
ok(preview === 'first second third', 'a preview is one line', preview)
const longPreview = S.previewOf('p'.repeat(1000))
ok(longPreview.length <= S.SHARE_PREVIEW_CHARS + 1, 'a preview never runs past its cap', String(longPreview.length))
const surrogate = S.previewOf('😀'.repeat(400))
ok(!/[\ud800-\udbff]$/.test(surrogate.replace(/…$/, '')), 'a preview never ends mid-surrogate')

ok(S.shareLines('a\nb\nc\n') === 3, 'a trailing newline is not a fourth line')
ok(S.shareLines('') === 0, 'an empty body has no lines')

/* ------------------------------------------------------------- the row view */

console.log('\nthe row view')
const row = S.slotOf(S.parseSlot(2, rendered, 1))
ok(row.filled, 'a slot with a body is filled')
ok(row.preview.length > 0 && !row.preview.includes('\n'), 'the row carries a preview, not a body')
ok(row.bytes === bytes(slot.body), 'the row carries the body size', String(row.bytes))
const blank = S.slotOf(S.parseSlot(4, '---\nslot: 4\ntitle: t\n---\n\n   \n', 1))
ok(!blank.filled, 'a slot with only whitespace in it is empty')
const empty = S.emptySlot(3)
ok(!empty.filled && empty.bytes === 0 && empty.title === 'Slot 3', 'an absent file is an empty slot')

/* ------------------------------------------------------------------- ansi */

console.log('\nansi')
ok(A.stripAnsi('\x1b[31mred\x1b[0m') === 'red', 'colour goes')
ok(A.stripAnsi('\x1b]0;a title\x07rest') === 'rest', 'an OSC terminated by BEL goes whole')
ok(A.stripAnsi('\x1b]8;;http://x\x1b\\link') === 'link', 'an OSC terminated by ST goes whole')
ok(A.stripAnsi('\x1b[?1049hscreen') === 'screen', 'the alternate-screen switch goes')
ok(A.stripAnsi('\x1b[2J\x1b[10;20Hhere') === 'here', 'clear and cursor addressing go')
ok(A.stripAnsi('\x1bP1$r0m\x1b\\after') === 'after', 'a DCS payload containing m and H goes whole')
ok(A.stripAnsi('\x1b_private\x1b\\after') === 'after', 'an APC goes whole')
ok(A.stripAnsi('\x1b(Btext') === 'text', 'a charset designation goes')
ok(A.stripAnsi('\x9b31mtext') === 'text', 'an 8-bit CSI goes')
ok(A.stripAnsi('a\rb') === 'b', 'a carriage return means the line was redrawn')
ok(A.stripAnsi('a\nb') === 'a\nb', 'newlines survive')
ok(A.stripAnsi('a\tb') === 'a\tb', 'tabs survive')
ok(A.stripAnsi('a\bb\x07') === 'ab', 'backspace and bell go')
const innocent = 'Plain text — with an em dash, 😀 and "quotes".\nSecond line.\n'
ok(A.stripAnsi(innocent) === innocent, 'text with no escapes comes back identical')

ok(A.tailLines('1\n2\n3\n4\n5\n', 3) === '3\n4\n5', 'the last three lines, without the trailing blank')
ok(A.tailLines('1\n2', 9) === '1\n2', 'asking for more lines than exist returns everything')
ok(A.tailLines('', 3) === '', 'an empty string tails to nothing')
ok(A.tailLines('1\n2', 0) === '', 'asking for none returns none')

/* --------------------------------------------------------------- paneText */

console.log('\npane text')
const rows = [
  { text: 'a very long line that ', wrapped: false },
  { text: 'was soft-wrapped by ', wrapped: true },
  { text: 'xterm into three rows', wrapped: true },
  { text: 'and then a new line', wrapped: false }
]
ok(
  P.joinBufferRows(rows) === 'a very long line that was soft-wrapped by xterm into three rows\nand then a new line',
  'wrapped rows join into one line; an unwrapped row starts a new one',
  JSON.stringify(P.joinBufferRows(rows))
)
ok(
  P.joinBufferRows([{ text: 'orphan continuation', wrapped: true }]) === 'orphan continuation',
  'a wrapped first row has nothing to continue and starts a line'
)
ok(P.joinBufferRows([]) === '', 'no rows is no text')

ok(P.tidyCapture('\n\n\ntop\n\n\n\nmiddle\nbottom\n\n\n', 99) === 'top\n\nmiddle\nbottom', 'blank runs collapse, ends are trimmed')
ok(P.tidyCapture('1\n2\n3\n4', 2) === '3\n4', 'maxLines keeps the end')
ok(P.tidyCapture('   \n\n ', 10) === '', 'a blank screen captures as nothing')
const wide = P.tidyCapture(Array.from({ length: 900 }, (_, i) => `line ${i}`).join('\n'), 800)
ok(wide.split('\n').length === S.SHARE_CAPTURE_MAX_LINES, 'the hard ceiling wins over the asked-for count', String(wide.split('\n').length))

/* ---------------------------------------------------------------- the store */

const { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, statSync, utimesSync } =
  await import('node:fs')
const { join } = await import('node:path')
const { tmpdir } = await import('node:os')
const { ShareStore } = await import('../electron/share-store.ts')

/** A throwaway project folder. Everything below stays inside one of these. */
const project = (init = () => {}) => {
  const dir = mkdtempSync(join(tmpdir(), 'forge-share-'))
  init(dir)
  return dir
}

console.log('\nthe store')
{
  const dir = project()
  const store = new ShareStore(dir)
  const created = store.ensure()
  ok(created.ok && created.created, 'ensure() creates the folder and says it did')
  ok(existsSync(join(dir, '.forge', 'share', 'README.md')), 'and writes the protocol README')
  ok(
    JSON.stringify(store.entries()) === JSON.stringify(['README.md']),
    'and nothing else — the slots are created lazily',
    JSON.stringify(store.entries())
  )
  ok(store.ensure().created === false, 'a second ensure() creates nothing')

  const rows = store.list()
  ok(rows.length === S.SHARE_SLOTS, 'list() always returns five slots')
  ok(rows.every((r) => !r.filled && r.bytes === 0), 'all five start empty')

  const wrote = store.write(
    { index: 2, title: 'API contract', body: 'The brief.\n', author: 'Claude Code — main', via: 'rail' },
    2_000_000_000_000
  )
  ok(wrote.ok, 'write() puts a body in a slot', wrote.error)
  ok(existsSync(join(dir, '.forge', 'share', 'slot-2.md')), 'in the file named for the slot')
  ok(!store.entries().some((e) => e.endsWith('.tmp')), 'and leaves no .tmp behind', JSON.stringify(store.entries()))

  const after = store.list()
  ok(after[1].filled && after[1].title === 'API contract', 'the row reflects it')
  ok(after[1].author === 'Claude Code — main' && after[1].via === 'rail', 'author and via survive the round trip')
  ok(after[0].filled === false && after[2].filled === false, 'the other slots are untouched')

  ok(store.read(2).body === 'The brief.\n', 'read() gives the body back byte for byte', JSON.stringify(store.read(2).body))
  ok(store.read(1) === null, 'read() of an empty slot is null, not an error')

  const appended = store.write(
    { index: 2, title: '', body: 'A second thought.', author: 'Codex', via: 'mcp', append: true },
    2_000_000_001_000
  )
  ok(appended.ok, 'append adds rather than replaces')
  ok(store.read(2).body === 'The brief.\n\nA second thought.', 'with exactly one blank line between', JSON.stringify(store.read(2).body))
  ok(store.read(2).title === 'API contract', 'an append with no title keeps the one that was there')

  const stale = store.write({ index: 2, title: 'x', body: 'clobber', author: 'a', via: 'rail', expectUpdatedAt: 1 })
  ok(!stale.ok && stale.conflict, 'a write that names the wrong version is refused')
  ok(/changed since you read it/.test(stale.error ?? ''), 'and says why', stale.error)
  ok(/Codex/.test(stale.error ?? ''), 'and names who got there first', stale.error)
  ok(store.read(2).body === 'The brief.\n\nA second thought.', 'and the file on disk is untouched')

  const fresh = store.write({
    index: 2,
    title: 'Agreed',
    body: 'ok',
    author: 'a',
    via: 'rail',
    expectUpdatedAt: store.read(2).updatedAt
  })
  ok(fresh.ok, 'a write that names the right version goes through', fresh.error)

  ok(store.clear(2).ok && !existsSync(join(dir, '.forge', 'share', 'slot-2.md')), 'clear() deletes the file')
  ok(store.list()[1].filled === false, 'and the row goes back to empty')
  ok(store.clear(2).ok, 'clearing an already-empty slot is not an error')

  const before = store.entries().length
  const refused = [0, 6, '2', 2.5, null, '../../evil'].map((index) => store.write({ index, title: 't', body: 'b', author: 'a', via: 'rail' }))
  ok(refused.every((r) => !r.ok), 'every index that is not a slot is refused')
  ok(/slots are 1 to 5/.test(refused[0].error ?? ''), 'and the refusal says what a slot is', refused[0].error)
  ok(store.entries().length === before, 'and nothing was created trying')

  ok(
    S.slotIndexes().every((n) => store.contains(store.slotPath(n))),
    'every slot path is inside the folder the store owns'
  )
  ok(store.slotPath(9) === null, 'there is no path for a slot that is not one')
}

console.log('\nwhat an agent wrote itself')
{
  const dir = project()
  const store = new ShareStore(dir)
  store.ensure()
  const path = join(dir, '.forge', 'share', 'slot-3.md')
  writeFileSync(path, '# Codex review\n\nLooks fine to me.\n', 'utf8')
  utimesSync(path, new Date(1_700_000_000_000), new Date(1_700_000_000_000))

  const row = store.list()[2]
  ok(row.filled, 'a file written with an agent’s own tools fills the slot')
  ok(row.via === 'agent', 'and is credited to an agent rather than to Forge')
  ok(row.title === 'Codex review', 'with its title taken from the first heading', row.title)
  ok(Math.abs(row.updatedAt - 1_700_000_000_000) < 2000, 'and its time taken from the file', String(row.updatedAt))
}

console.log('\nwhen a slot cannot be read')
{
  const dir = project()
  const store = new ShareStore(dir)
  store.ensure()
  // A directory where a slot should be. chmod is a no-op on Windows, so this is
  // how an unreadable slot is simulated on the platform Forge ships on.
  mkdirSync(join(dir, '.forge', 'share', 'slot-4.md'))
  const rows = store.list()
  ok(typeof rows[3].problem === 'string' && rows[3].problem.length > 0, 'the row carries a problem', rows[3].problem)
  ok(rows[3].filled === false, 'and reads as empty rather than as broken')
  ok(rows[0].problem === undefined, 'and the other rows are unaffected')
  ok(store.read(4) === null, 'read() answers null rather than throwing')
  ok(store.write({ index: 4, title: 't', body: 'b', author: 'a', via: 'rail' }).ok === false, 'and a write over it is refused')
}

console.log('\nthe roster and the README')
{
  const dir = project()
  const store = new ShareStore(dir)
  store.ensure()
  const path = join(dir, '.forge', 'share', 'panes.json')

  store.writeRoster([{ paneId: 'p1', title: 'main', agent: 'Claude Code', profileId: 'claude', openedAt: 1 }], 1000)
  ok(existsSync(path), 'writeRoster writes panes.json')
  const first = readFileSync(path, 'utf8')
  ok(JSON.parse(first).panes.length === 1, 'with the panes in it')

  store.writeRoster([{ paneId: 'p1', title: 'main', agent: 'Claude Code', profileId: 'claude', openedAt: 1 }], 9999)
  ok(readFileSync(path, 'utf8') === first, 'the same roster again rewrites nothing')

  store.writeRoster(
    Array.from({ length: 99 }, (_, i) => ({ paneId: `p${i}`, title: `t${i}`, agent: 'Codex', profileId: 'codex', openedAt: i })),
    2000
  )
  ok(JSON.parse(readFileSync(path, 'utf8')).panes.length === S.SHARE_MAX_PANES, 'the roster is capped')
  ok(store.readRoster().length === S.SHARE_MAX_PANES, 'readRoster reads back what share_panes will see')

  const readme = join(dir, '.forge', 'share', 'README.md')
  const kept = readFileSync(readme, 'utf8')
  store.writeReadme()
  ok(readFileSync(readme, 'utf8') === kept, 'writeReadme is idempotent')
  writeFileSync(readme, 'my own notes, thanks', 'utf8')
  store.writeReadme()
  ok(readFileSync(readme, 'utf8') === 'my own notes, thanks', 'a README whose marker is gone is never overwritten')
}

/* ------------------------------------------------------------ git hygiene */

console.log('\ngit hygiene')
const excludeOf = (dir) => join(dir, '.git', 'info', 'exclude')

{
  const dir = project()
  const store = new ShareStore(dir)
  ok(store.ensureExcluded() === false, 'a folder that is not a repo gets no exclude line')
  ok(!existsSync(join(dir, '.git')), 'and no .git is invented for it')
  ok(store.excluded() === false, 'and it reports itself as not excluded')
}
{
  const dir = project((d) => mkdirSync(join(d, '.git'), { recursive: true }))
  const store = new ShareStore(dir)
  ok(store.ensureExcluded(), 'a repo with no exclude file gets one')
  const text = readFileSync(excludeOf(dir), 'utf8')
  ok(/^\.forge\/$/m.test(text), 'containing the rule', JSON.stringify(text))
  ok(/# Forge/.test(text), 'and a note saying who put it there')
  ok(store.excluded(), 'and it now reports itself as excluded')

  store.ensureExcluded()
  ok(readFileSync(excludeOf(dir), 'utf8') === text, 'a second call is byte-identical')
}
for (const rule of ['.forge', '.forge/', '/.forge/', '.forge/**']) {
  const dir = project((d) => {
    mkdirSync(join(d, '.git', 'info'), { recursive: true })
    writeFileSync(excludeOf(d), `# theirs\n${rule}\n`, 'utf8')
  })
  const store = new ShareStore(dir)
  const before = readFileSync(excludeOf(dir), 'utf8')
  store.ensureExcluded()
  ok(readFileSync(excludeOf(dir), 'utf8') === before, `an existing \`${rule}\` rule is left exactly as it is`)
  ok(store.excluded(), `and \`${rule}\` counts as excluded`)
}
{
  const dir = project((d) => {
    mkdirSync(join(d, '.git', 'info'), { recursive: true })
    writeFileSync(excludeOf(d), '# we deliberately do not ignore .forge/ here\n', 'utf8')
  })
  const store = new ShareStore(dir)
  ok(!store.excluded(), 'a comment mentioning the rule is not the rule')
  store.ensureExcluded()
  ok(/^\.forge\/$/m.test(readFileSync(excludeOf(dir), 'utf8')), 'so the rule is still appended')
}
{
  const dir = project((d) => {
    mkdirSync(join(d, '.git', 'info'), { recursive: true })
    writeFileSync(excludeOf(d), 'build/\r\ndist/\r\n', 'utf8')
  })
  new ShareStore(dir).ensureExcluded()
  const text = readFileSync(excludeOf(dir), 'utf8')
  ok(!/[^\r]\n/.test(text), 'a CRLF exclude file stays CRLF', JSON.stringify(text.slice(-24)))
}
{
  const dir = project((d) => {
    mkdirSync(join(d, '.git', 'info'), { recursive: true })
    writeFileSync(excludeOf(d), 'build/', 'utf8')
  })
  new ShareStore(dir).ensureExcluded()
  const text = readFileSync(excludeOf(dir), 'utf8')
  ok(/^build\/$/m.test(text) && /^\.forge\/$/m.test(text), 'a file with no trailing newline keeps its last rule intact', JSON.stringify(text))
}
{
  // A linked worktree or a submodule: .git is a file pointing elsewhere.
  const dir = project((d) => writeFileSync(join(d, '.git'), 'gitdir: ../elsewhere/.git/worktrees/x\n', 'utf8'))
  const store = new ShareStore(dir)
  ok(store.ensureExcluded() === false, 'a worktree is skipped rather than guessed at')
  ok(statSync(join(dir, '.git')).isFile(), 'and its .git file is left alone')
  ok(store.excluded() === false, 'and it reports itself as not excluded, which the rail says out loud')
}

console.log('\nnever .gitignore')
{
  // The store is allowed to *talk about* .gitignore — the header and the README
  // it writes both explain at length why Forge does not touch it. What it may
  // never do is name it as a filename, which in this codebase means a quoted
  // literal of exactly that.
  const src = readFileSync(new URL('../electron/share-store.ts', import.meta.url), 'utf8')
  ok(!/['"]\.gitignore['"]/.test(src), 'the store never names .gitignore as a file')
  ok(!/join\([^)]*gitignore/i.test(src), 'and never builds a path to one')
  ok(/join\(gitDir, 'info', 'exclude'\)/.test(src), 'it writes .git/info/exclude instead')
}

/* ------------------------------------------------------------- the MCP server
 *
 * Driven over real stdio JSON-RPC, hand-rolled exactly as bridge-smoke.mjs does
 * it — deliberately not through the MCP SDK's client, because a server broken in
 * the same way as the client it was tested with is a server that passes.
 */

const { spawn } = await import('node:child_process')
const { fileURLToPath } = await import('node:url')
// fileURLToPath, not `.pathname`: this repo lives in a folder with a space in it,
// and a percent-encoded path is a module Node cannot find.
const SERVER = fileURLToPath(new URL('../bridge/share-bridge.mjs', import.meta.url))

/**
 * The environment every case below starts from: this machine's, less every
 * variable Forge sets on a pane.
 *
 * Not hygiene for its own sake. This script is normally run *inside a Forge
 * pane*, which means FORGE_SHARE_DIR (the scratchpad of whatever project Forge
 * is showing) and FORGE_SHARE_LINK (a live pipe to a running Forge, with real
 * panes behind it) are both in the inherited environment. Without this, the
 * cwd-walk cases would find Steve's actual scratchpad and "refuses when there is
 * no scratchpad" would be answered by his actual panes — a check that passes or
 * fails depending on where it was run from is not a check.
 */
const CLEAN_ENV = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('FORGE_SHARE_')))

function openServer(cwd, env = CLEAN_ENV) {
  const child = spawn(process.execPath, [SERVER], { cwd, stdio: ['pipe', 'pipe', 'pipe'], env })
  let buffer = ''
  let stderr = ''
  const stdoutLines = []
  const waiters = new Map()

  child.stdout.on('data', (chunk) => {
    buffer += chunk.toString()
    let nl
    while ((nl = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, nl).trim()
      buffer = buffer.slice(nl + 1)
      if (!line) continue
      stdoutLines.push(line)
      let msg
      try {
        msg = JSON.parse(line)
      } catch {
        continue
      }
      const w = waiters.get(msg.id)
      if (w) {
        waiters.delete(msg.id)
        w(msg)
      }
    }
  })
  child.stderr.on('data', (d) => {
    stderr += d.toString()
  })

  let nextId = 1
  const request = (method, params) =>
    new Promise((res, rej) => {
      const id = nextId++
      const timer = setTimeout(() => {
        waiters.delete(id)
        rej(new Error(`timeout waiting for ${method}\nstderr: ${stderr}`))
      }, 20_000)
      waiters.set(id, (msg) => {
        clearTimeout(timer)
        res(msg)
      })
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
    })

  return {
    child,
    request,
    notify: (method, params) => child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`),
    stdoutLines: () => stdoutLines,
    stderrText: () => stderr,
    close: () => child.kill()
  }
}

const textOf = (reply) => (reply?.result?.content ?? []).map((c) => c.text ?? '').join('\n')

async function handshake(server) {
  const init = await server.request('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'share-check', version: '1.0.0' }
  })
  server.notify('notifications/initialized', {})
  return init
}

console.log('\nthe MCP server')
{
  const dir = project()
  const store = new ShareStore(dir)
  store.ensure()
  store.writeRoster([{ paneId: 'p1', title: 'worker', agent: 'Codex', profileId: 'codex', openedAt: 0 }], 1000)

  // Started in a *subdirectory* of the project, which is the realistic case: an
  // agent's cwd is wherever the person opened it, and the walk upward is what
  // makes the server project-correct without being told which project it is in.
  mkdirSync(join(dir, 'src', 'deep'), { recursive: true })
  const server = openServer(join(dir, 'src', 'deep'))
  try {
    const init = await handshake(server)
    ok(init?.result?.serverInfo?.name === 'forge-share', 'it introduces itself as forge-share', JSON.stringify(init?.result?.serverInfo))
    ok(Boolean(init?.result?.capabilities?.tools), 'and offers tools')

    const list = await server.request('tools/list', {})
    const names = (list?.result?.tools ?? []).map((t) => t.name).sort()
    ok(
      JSON.stringify(names) ===
        JSON.stringify(['pane_read', 'pane_send', 'share_clear', 'share_list', 'share_panes', 'share_read', 'share_write']),
      'exactly the five share tools and the two pane tools, and nothing else',
      JSON.stringify(names)
    )
    ok(
      (list?.result?.tools ?? []).every((t) => (t.description ?? '').length > 40 && t.inputSchema?.properties),
      'each one is described properly and has a schema'
    )
    const required = Object.fromEntries((list?.result?.tools ?? []).map((t) => [t.name, t.inputSchema?.required ?? []]))
    ok(
      JSON.stringify(required.share_read) === '["slot"]' &&
        JSON.stringify(required.share_write) === '["slot","body"]' &&
        JSON.stringify(required.share_clear) === '["slot"]' &&
        JSON.stringify(required.share_list) === '[]' &&
        JSON.stringify(required.share_panes) === '[]' &&
        JSON.stringify(required.pane_send) === '["pane","text"]' &&
        JSON.stringify(required.pane_read) === '["pane"]',
      'and asks for exactly the arguments it needs',
      JSON.stringify(required)
    )

    const wrote = await server.request('tools/call', {
      name: 'share_write',
      arguments: { slot: 3, title: 'Codex review', body: 'Looks fine to me.\n', author: 'Codex — worker' }
    })
    ok(!wrote?.result?.isError, 'share_write writes', textOf(wrote))
    ok(existsSync(join(dir, '.forge', 'share', 'slot-3.md')), 'to the file the rail reads')
    ok(store.list()[2].via === 'mcp', 'and is credited to the tool rather than to a person')

    const readBack = await server.request('tools/call', { name: 'share_read', arguments: { slot: 3 } })
    ok(textOf(readBack).includes('Looks fine to me.'), 'share_read gives the body back', textOf(readBack))
    ok(/updated_at \d+/.test(textOf(readBack)), 'and hands over the updated_at a safe write needs')

    const stale = await server.request('tools/call', {
      name: 'share_write',
      arguments: { slot: 3, title: 'x', body: 'clobber', expect_updated_at: 1 }
    })
    ok(stale?.result?.isError, 'a write naming the wrong version is refused')
    ok(/Codex — worker/.test(textOf(stale)), 'and names who got there first', textOf(stale))
    ok(store.read(3).body === 'Looks fine to me.\n', 'and the file is untouched')

    for (const slot of [0, 6, 'two', null]) {
      const bad = await server.request('tools/call', { name: 'share_write', arguments: { slot, body: 'b' } })
      ok(bad?.result?.isError, `slot ${JSON.stringify(slot)} is refused gracefully`)
      ok(/1 to 5/.test(textOf(bad)), 'and the refusal says what a slot is')
    }

    const big = await server.request('tools/call', {
      name: 'share_write',
      arguments: { slot: 4, title: 'huge', body: `${'line of text\n'.repeat(20000)}` }
    })
    ok(!big?.result?.isError, 'a 200 KiB write succeeds')
    ok(/bytes were dropped from the END/.test(textOf(big)), 'and says how much it lost', textOf(big))
    ok(bytes(store.read(4).body) <= S.SHARE_MAX_BYTES, 'and the slot is under the cap')

    const listed = await server.request('tools/call', { name: 'share_list', arguments: {} })
    ok(/Codex review/.test(textOf(listed)), 'share_list names the slots')
    ok(!textOf(listed).includes('line of text\nline of text\nline of text'), 'and never dumps a body')

    const panes = await server.request('tools/call', { name: 'share_panes', arguments: {} })
    ok(/worker/.test(textOf(panes)) && /Codex/.test(textOf(panes)), 'share_panes reads the roster Forge wrote', textOf(panes))

    const cleared = await server.request('tools/call', { name: 'share_clear', arguments: { slot: 3 } })
    ok(!cleared?.result?.isError && !existsSync(join(dir, '.forge', 'share', 'slot-3.md')), 'share_clear empties a slot')

    const unknown = await server.request('tools/call', { name: 'share_teleport', arguments: {} })
    ok(unknown?.result?.isError, 'an unknown tool fails gracefully')
    ok(server.child.exitCode === null, 'and the server is still alive')

    ok(
      server.stdoutLines().every((line) => {
        try {
          JSON.parse(line)
          return true
        } catch {
          return false
        }
      }),
      'every line on stdout is JSON-RPC — nothing else may go there'
    )
  } finally {
    server.close()
  }
}

console.log('\nthe server refuses to litter')
{
  // No .forge/share anywhere above: every tool must say how to fix it, and the
  // directory must be exactly as it was afterwards.
  const dir = project()
  const before = JSON.stringify(readdirSync(dir))
  const server = openServer(dir)
  try {
    await handshake(server)
    for (const name of ['share_list', 'share_panes']) {
      const reply = await server.request('tools/call', { name, arguments: {} })
      ok(reply?.result?.isError, `${name} refuses when there is no scratchpad`)
      ok(/Switch the Share section on/.test(textOf(reply)), 'and says how to make one')
    }
    const wrote = await server.request('tools/call', { name: 'share_write', arguments: { slot: 1, body: 'x' } })
    ok(wrote?.result?.isError, 'so does share_write')
    ok(JSON.stringify(readdirSync(dir)) === before, 'and nothing was created in the folder it was started in', before)
  } finally {
    server.close()
  }
}

console.log('\nFORGE_SHARE_ROOT')
{
  const dir = project()
  const store = new ShareStore(dir)
  store.ensure()
  store.write({ index: 5, title: 'pointed at', body: 'found by the override', author: 'a', via: 'rail' }, 3_000_000_000_000)

  const elsewhere = project()
  const server = openServer(elsewhere, { ...CLEAN_ENV, FORGE_SHARE_ROOT: store.root })
  try {
    await handshake(server)
    const listed = await server.request('tools/call', { name: 'share_list', arguments: {} })
    ok(/pointed at/.test(textOf(listed)), 'the override wins over the cwd walk', textOf(listed))
  } finally {
    server.close()
  }
}

console.log('\nno key, no network')
{
  /*
   * This block used to assert "no socket at all", and that was the right claim
   * while the server only ever touched files. `pane_send` and `pane_read` gave it
   * one channel — a local pipe to Forge's own main process — so the claim is now
   * the narrower true one, and deliberately *stronger* in the dimension that
   * mattered: no port, no host, no DNS, no fetch, and the one path it connects to
   * is the one Forge handed it in an environment variable. See the file header
   * and electron/share-link.ts.
   */
  const src = readFileSync(new URL('../bridge/share-bridge.mjs', import.meta.url), 'utf8')
  ok(!/node:http|node:https|node:dgram|node:tls|undici|from 'ws'/.test(src), 'the server imports nothing that can reach the network')
  ok(!/\bfetch\(/.test(src), 'and never calls fetch')
  ok(!/\bspawn\(|execFile|child_process/.test(src), 'and never spawns a process')
  ok(!/createServer/.test(src), 'and never listens for anything')
  // `connect(path)` and nothing else: a port, a host or an options object would
  // all be a socket that could leave this machine. Bare calls only — the MCP
  // SDK's own `server.connect(transport)` is a method on an object, not a dial.
  const connects = [...src.matchAll(/(?<![.\w])connect\(([^)]*)\)/g)].map((m) => m[1].trim())
  ok(
    connects.length === 1 && connects[0] === 'path',
    'and dials exactly once, by path — never a host or a port',
    JSON.stringify(connects)
  )
  ok(/const path = linkPath\(\)/.test(src), 'with that path coming from the environment rather than from a literal')
  // The header is allowed to explain *why* it holds no key; the code may not
  // read one. Asserted as "these four variables and nothing else", which is a
  // stronger claim than the absence of the word KEY and cannot be defeated by a
  // rename.
  const envReads = [...src.matchAll(/process\.env\['([^']+)'\]/g)].map((m) => m[1]).sort()
  ok(
    JSON.stringify([...new Set(envReads)]) ===
      JSON.stringify(['FORGE_SHARE_AGENT', 'FORGE_SHARE_DIR', 'FORGE_SHARE_LINK', 'FORGE_SHARE_ROOT']),
    'and reads exactly four environment variables, none of them a credential',
    JSON.stringify(envReads)
  )
}

/* -------------------------------------------------------------- drift guard */

console.log('\nthe bridge and shared/share.ts agree')
{
  const bridgeSrc = readFileSync(new URL('../bridge/share-bridge.mjs', import.meta.url), 'utf8')
  const sharedSrc = readFileSync(new URL('../shared/share.ts', import.meta.url), 'utf8')
  const numberOf = (src, name) => {
    const m = new RegExp(`${name}\\s*=\\s*([^\\n]+)`).exec(src)
    if (!m) return null
    try {
      // The declarations are arithmetic on purpose (`64 * 1024`), so they are
      // compared by value rather than by the text they are written as.
      return Function(`"use strict";return (${m[1].replace(/\/\/.*$/, '').trim()})`)()
    } catch {
      return null
    }
  }
  for (const name of ['SHARE_SLOTS', 'SHARE_MAX_BYTES', 'SHARE_MAX_TITLE', 'SHARE_PREVIEW_CHARS']) {
    const a = numberOf(bridgeSrc, name)
    const b = numberOf(sharedSrc, name)
    ok(a !== null && a === b, `${name} matches in both files`, `${a} vs ${b}`)
  }
  const keysOf = (src) => /SHARE_KEYS\s*=\s*\[([^\]]*)\]/.exec(src)?.[1]?.replace(/\s|'/g, '') ?? null
  ok(keysOf(bridgeSrc) !== null && keysOf(bridgeSrc) === keysOf(sharedSrc), 'the front-matter keys match', `${keysOf(bridgeSrc)} vs ${keysOf(sharedSrc)}`)
  const markerOf = (src) => /truncated at \$\{SHARE_MAX_BYTES\} bytes; \$\{dropped\} bytes were dropped/.test(src)
  ok(markerOf(bridgeSrc) && markerOf(sharedSrc), 'the truncation marker is worded identically')
  ok(/shared\/share\.ts/.test(bridgeSrc), 'the bridge names the file it is duplicated from')
  ok(/share-bridge\.mjs/.test(sharedSrc), 'and that file names the bridge')
}

/* ------------------------------------------------------------- registration
 *
 * The highest-risk part of the feature: a wrong string here does not degrade the
 * scratchpad, it stops a pane launching. So the shapes are asserted here and the
 * real CLIs are asked at the bottom of the file.
 */

const M = await import('../electron/bridge/share-mcp.ts')
const SCRIPT_PATH = fileURLToPath(new URL('../bridge/share-bridge.mjs', import.meta.url))

console.log('\nthe Codex fragment')
{
  const fragment = M.codexFragment(SCRIPT_PATH)
  ok(fragment?.startsWith('-c "mcp_servers.forge_share={'), 'is a -c override on a bare snake_case key', fragment)
  /*
   * `codex -c mcp_servers."forge-share"=…` produces a server literally named
   * `"forge-share"`, quotes included — Codex does not unquote a dotted-path
   * segment. Verified by running it.
   */
  ok(!/forge[-.]share/.test(fragment ?? ''), 'never spells the key with a dash or a dot')
  ok(!/["']forge_share/.test(fragment ?? ''), 'and never quotes it')
  /*
   * The fragment is *typed into PowerShell* (session-manager.ts writes the
   * bootstrap command into pwsh), so an embedded double quote is re-quoted and an
   * embedded `$` is expanded. Neither may appear inside the braces.
   */
  const inner = /\{(.*)\}/.exec(fragment ?? '')?.[1] ?? ''
  ok(inner.length > 0 && !inner.includes('"'), 'carries no double quote inside the braces', inner)
  ok(!inner.includes('$'), 'and no dollar sign')
  ok(inner.includes("'"), 'using TOML literal strings, so a Windows path keeps its backslashes', inner)
  ok(fragment?.includes(SCRIPT_PATH), 'and the path arrives verbatim, spaces and all')

  // A TOML literal string has no escape for an apostrophe, and PowerShell will
  // mangle the alternatives. Refused, so the pane launches without the tools
  // rather than not launching at all.
  ok(M.codexFragment("C:\\it's\\a\\path.mjs") === null, 'a path with an apostrophe is refused rather than mangled')
  ok(M.codexFragment('C:\\"quoted"\\path.mjs') === null, 'and so is one with a double quote')
  ok(M.codexFragment('C:\\$env\\path.mjs') === null, 'and one PowerShell would expand')
  ok(M.codexFragment('') === null, 'no path, no fragment')
}

console.log('\nthe OpenCode value')
{
  const value = JSON.parse(M.openCodeConfig(SCRIPT_PATH))
  ok(
    JSON.stringify(Object.keys(value)) === '["mcp"]' && JSON.stringify(Object.keys(value.mcp)) === '["forge_share"]',
    'declares exactly one server under mcp',
    JSON.stringify(Object.keys(value.mcp ?? {}))
  )
  const entry = value.mcp.forge_share
  ok(
    JSON.stringify(Object.keys(entry).sort()) === '["command","enabled","type"]',
    'with the three fields OpenCode wants',
    JSON.stringify(Object.keys(entry))
  )
  ok(entry.type === 'local' && entry.enabled === true, 'a local server, enabled')
  ok(JSON.stringify(entry.command) === JSON.stringify(['node', SCRIPT_PATH]), 'run by node')
}

console.log('\nthe Qwen entry')
{
  const entry = M.qwenEntry(SCRIPT_PATH)
  ok(entry.command === 'node' && JSON.stringify(entry.args) === JSON.stringify([SCRIPT_PATH]), 'is the shape `qwen mcp add` writes')
  ok(String(entry.description).includes(M.QWEN_MARKER), 'and is marked as Forge’s, which is what makes it safe to remove')

  const theirs = JSON.stringify({ ui: { autoModeAcknowledged: true }, mcpServers: { theirs: { command: 'x' } } }, null, 2)
  const added = M.mergeQwenSettings(theirs, SCRIPT_PATH)
  ok(added.action === 'write', 'it is added to a file that already has settings in it')
  ok(JSON.stringify(added.settings.ui) === JSON.stringify({ autoModeAcknowledged: true }), 'their other settings are untouched')
  ok(added.settings.mcpServers.theirs?.command === 'x', 'and so are their other MCP servers')

  const removed = M.mergeQwenSettings(JSON.stringify(added.settings), null)
  ok(removed.action === 'write' && !('forge_share' in removed.settings.mcpServers), 'turning it off takes it out again')
  ok(removed.settings.mcpServers.theirs?.command === 'x', 'and still leaves theirs alone')

  const onlyOurs = M.mergeQwenSettings(JSON.stringify({ mcpServers: { forge_share: M.qwenEntry(SCRIPT_PATH) } }), null)
  ok(onlyOurs.action === 'write' && !('mcpServers' in onlyOurs.settings), 'an empty mcpServers is not left behind as litter')

  const unmarked = M.mergeQwenSettings(JSON.stringify({ mcpServers: { forge_share: { command: 'their-own-thing' } } }), SCRIPT_PATH)
  ok(unmarked.action === 'refuse', 'a forge_share Forge did not write is refused rather than overwritten')
  ok(/did not write/.test(unmarked.reason ?? ''), 'and says so', unmarked.reason)

  ok(M.mergeQwenSettings('{ this is not json', SCRIPT_PATH).action === 'refuse', 'an unparseable file is left alone')
  ok(M.mergeQwenSettings('[1,2,3]', SCRIPT_PATH).action === 'refuse', 'and so is one that is not an object')
  ok(M.mergeQwenSettings(null, null).action === 'none', 'no file and nothing wanted writes nothing')
  ok(M.mergeQwenSettings(null, SCRIPT_PATH).action === 'write', 'no file and tools wanted creates one')
}

console.log('\nevery other command is left alone')
{
  const src = readFileSync(new URL('../electron/bridge/share-mcp.ts', import.meta.url), 'utf8')
  /*
   * `applyShareBridge` reads a setting, so it is asserted by source rather than
   * called — the three properties that matter are all visible in it, and calling
   * it would drag the real settings store into a parser test.
   */
  ok(/if \(!cmd \|\| !wanted\(\)\) return bootstrapCommand/.test(src), 'nothing is appended while the setting is off')
  ok(/if \(commandExe\(cmd\) !== 'codex'\) return cmd/.test(src), 'and nothing is appended to anything that is not codex')
  ok(/if \(cmd\.includes\(`mcp_servers\.\$\{SERVER_KEY\}`\)\) return cmd/.test(src), 'and applying it twice appends once')
  ok(/if \(!fragment\) \{[\s\S]{0,220}return cmd\s*\}/.test(src), 'a path that cannot be expressed skips registration rather than breaking the launch')
  ok(/agy|antigravity/i.test(src), 'the vendors that are deliberately out of scope are named')
}

/* ---------------------------------------------------------- live CLI probes
 *
 * The assertions that catch a vendor changing its mind. Each one is skipped with
 * a printed note when the CLI is absent, so this script still passes on a machine
 * that has none of them.
 */

const { execFileSync } = await import('node:child_process')

const skip = (label, why) => {
  console.log(`  -- ${label} — skipped (${why})`)
}

/**
 * Run a command line *through PowerShell*, which is the only faithful way to test
 * these.
 *
 * Forge does not spawn an agent CLI with an argv array — electron/pty/session-
 * manager.ts types the whole command into pwsh and presses return. PowerShell's
 * native-argument re-quoting is therefore part of what is being tested, and
 * passing the fragment as an execFileSync argument would test a path Forge never
 * takes. It also means the agent CLIs' `.cmd` shims resolve the way they do in a
 * pane.
 */
const runCli = (command, env) => {
  try {
    return {
      ok: true,
      out: execFileSync('pwsh', ['-NoProfile', '-NonInteractive', '-Command', command], {
        encoding: 'utf8',
        timeout: 90_000,
        windowsHide: true,
        env: { ...process.env, ...(env ?? {}) },
        stdio: ['ignore', 'pipe', 'pipe']
      })
    }
  } catch (err) {
    return { ok: false, out: `${err?.stdout ?? ''}${err?.stderr ?? ''}`, error: err }
  }
}

const has = (exe) => runCli(`${exe} --version`).ok

console.log('\nlive: codex')
if (!has('codex')) {
  skip('the -c fragment is still accepted', 'codex is not installed')
} else {
  // The one that matters: if Codex renames or drops `-c`, every Codex pane dies
  // at launch and this is what says so before a release does.
  const fragment = M.codexFragment(SCRIPT_PATH)
  const probe = runCli(`codex mcp list ${fragment}`)
  ok(probe.ok, 'codex accepts the -c fragment, typed into PowerShell exactly as a pane types it', probe.out?.slice(0, 300))
  ok(/forge_share/.test(probe.out ?? ''), 'and lists forge_share as a server', probe.out?.slice(0, 300))
  ok(!/"forge/.test(probe.out ?? ''), 'named without stray quotes')
}

console.log('\nlive: opencode')
if (!has('opencode')) {
  skip('OPENCODE_CONFIG_CONTENT still merges', 'opencode is not installed')
} else {
  const before = runCli('opencode debug config')
  const after = runCli('opencode debug config', { OPENCODE_CONFIG_CONTENT: M.openCodeConfig(SCRIPT_PATH) })
  ok(after.ok, 'opencode still starts with the variable set', after.out?.slice(0, 200))
  ok(/forge_share/.test(after.out ?? ''), 'and the server is in its config', after.out?.slice(0, 200))
  if (before.ok) {
    let baseline = {}
    try {
      baseline = JSON.parse(before.out)
    } catch {
      /* not JSON on this version; the merge assertion below is skipped */
    }
    const keys = Object.keys(baseline)
    if (keys.length === 0) {
      skip('the variable merges rather than replaces', 'opencode debug config is not JSON on this version')
    } else {
      ok(
        keys.every((key) => new RegExp(`"${key.replace('$', '\\$')}"`).test(after.out ?? '')),
        'and every key the user already had survived — it merges, it does not replace',
        keys.join(', ')
      )
    }
  }
}

console.log('\nlive: qwen')
if (!has('qwen')) {
  skip('qwen still has no MCP launch flag', 'qwen is not installed')
} else {
  const help = runCli('qwen --help')
  // The premise of the Qwen half: there is no flag, so a config file is the only
  // way in. The day that stops being true, the file write should stop too.
  ok(!/--mcp-config/.test(help.out ?? ''), 'qwen still has no --mcp-config, so the config write is still the only way in')
  const mcpHelp = runCli('qwen mcp --help')
  ok(/\badd\b/.test(mcpHelp.out ?? ''), 'and `qwen mcp add` still exists, which is the surface the written entry imitates')
}

/* --------------------------------------------------------- the release notes
 *
 * Part of the same release as the scratchpad, and pure for the same reason: the
 * rules that turn commits into a card somebody reads once are easy to get subtly
 * wrong and impossible to notice, because the wrong answer still looks like a
 * list of sentences.
 */

const W = await import('../shared/whatsnew.ts')

console.log('\nparsing commits')
{
  const raw = [
    `First subject${String.fromCharCode(31)}Body line one.\n\nHighlight: The rail holds still now.\n`,
    `Second subject${String.fromCharCode(31)}`,
    `Third subject${String.fromCharCode(31)}No highlight here.\n`
  ].join(String.fromCharCode(30))

  const commits = W.parseCommits(raw)
  ok(commits.length === 3, 'three records, three commits', String(commits.length))
  ok(commits[0].subject === 'First subject', 'the subject is the first field', commits[0].subject)
  ok(commits[0].body.includes('Highlight:'), 'the body is the rest')
  ok(commits[1].body === '', 'a commit with no body parses fine')
  ok(W.parseCommits('').length === 0, 'no output, no commits')
  ok(W.parseCommits(String.fromCharCode(30, 30, 30)).length === 0, 'empty records are dropped rather than counted')

  // A body containing a newline-heavy footer is the normal case in this repo, and
  // the separator is a control character precisely so it cannot appear in one.
  const gnarly = W.parseCommits(
    `Subject: with a colon${String.fromCharCode(31)}Line\n\nCo-Authored-By: Someone <a@b.c>\n${String.fromCharCode(30)}`
  )
  ok(gnarly.length === 1 && gnarly[0].subject === 'Subject: with a colon', 'a colon in the subject is not a field break')
}

console.log('\nhighlights')
{
  ok(
    JSON.stringify(W.highlightsIn('Highlight: One thing.')) === JSON.stringify(['One thing.']),
    'a highlight is the text after the trailer'
  )
  ok(
    JSON.stringify(W.highlightsIn('highlight:   spaced   out  ')) === JSON.stringify(['spaced out']),
    'case and whitespace do not matter'
  )
  ok(
    JSON.stringify(W.highlightsIn('Highlight: A long one that\nwrapped at seventy-two\ncolumns.')) ===
      JSON.stringify(['A long one that wrapped at seventy-two columns.']),
    'a wrapped highlight is folded back into one sentence'
  )
  ok(
    JSON.stringify(W.highlightsIn('Highlight: The feature.\n\nAnd then prose nobody asked for.')) ===
      JSON.stringify(['The feature.']),
    'a blank line ends it'
  )
  ok(
    JSON.stringify(W.highlightsIn('Highlight: The feature.\nCo-Authored-By: Someone <a@b.c>')) ===
      JSON.stringify(['The feature.']),
    'and so does the next trailer — the footer is not swallowed'
  )
  ok(
    JSON.stringify(W.highlightsIn('Highlight: One.\n\nHighlight: Two.')) === JSON.stringify(['One.', 'Two.']),
    'two highlights in one commit are both kept'
  )
  ok(W.highlightsIn('No trailer at all.').length === 0, 'a body with no trailer has no highlights')
  ok(W.highlightsIn('').length === 0, 'and neither does an empty one')
  const long = W.highlightsIn(`Highlight: ${'x'.repeat(900)}`)[0]
  ok(long.length === W.WHATS_NEW_MAX_HIGHLIGHT && long.endsWith('…'), 'a runaway highlight is cut and says so', String(long.length))
}

console.log('\nbuilding notes')
{
  const commits = [
    { subject: 'Share panel lands', body: 'Highlight: Push a plan from one agent, have another review it.' },
    { subject: 'A branch row could rewind the folder', body: '' },
    { subject: 'Merge branch of nothing', body: '' },
    { subject: 'A branch row could rewind the folder', body: '' }
  ]
  const notes = W.notesFrom(commits, { version: '0.3.5', date: '2026-08-08', url: 'https://example.invalid' })
  ok(notes.highlights.length === 1, 'the highlight is promoted')
  ok(
    JSON.stringify(notes.changes) === JSON.stringify(['A branch row could rewind the folder']),
    'the rest become changes, deduped',
    JSON.stringify(notes.changes)
  )
  ok(!notes.changes.some((c) => /^Share panel/.test(c)), 'a commit with a highlight is not announced twice')
  ok(!notes.changes.some((c) => /^Merge/.test(c)), 'merges are not news')
  ok(notes.version === '0.3.5' && notes.date === '2026-08-08', 'the version and date come through')

  const many = W.notesFrom(
    Array.from({ length: 90 }, (_, i) => ({ subject: `change ${i}`, body: '' })),
    { version: '1.0.0', date: '', url: '' }
  )
  ok(many.changes.length === W.WHATS_NEW_MAX_CHANGES, 'the change list is capped rather than endless', String(many.changes.length))

  ok(W.isEmptyNotes(W.notesFrom([], { version: '1.0.0', date: '', url: '' })), 'no commits is empty notes')
  ok(W.isEmptyNotes(null) && W.isEmptyNotes(undefined), 'and so is nothing at all')
  ok(!W.isEmptyNotes(notes), 'real notes are not empty')
}

console.log('\nrendering the release body')
{
  const notes = W.notesFrom(
    [
      { subject: 'x', body: 'Highlight: The headline.' },
      { subject: 'A smaller thing', body: '' }
    ],
    { version: '0.3.5', date: '2026-08-08', url: 'https://example.invalid' }
  )
  const md = W.renderNotes(notes)
  ok(md.startsWith('Forge 0.3.5.'), 'it opens with the version', md.split('\n')[0])
  ok(md.includes('## What’s new') && md.includes('- The headline.'), 'the highlights are a section')
  ok(md.includes('## Also changed') && md.includes('- A smaller thing'), 'and so is everything else')
  // The download and SmartScreen paragraphs live in release.mjs, which is the only
  // place that knows the artifact's filename.
  ok(!/SmartScreen|Download \*\*/.test(md), 'and it stops before the download paragraph')

  const quiet = W.renderNotes(W.notesFrom([], { version: '0.3.6', date: '', url: '' }))
  ok(/Housekeeping only/.test(quiet), 'a release with nothing in it says so rather than showing empty headings')
}

console.log('\nthe generator and the release script agree')
{
  const gen = readFileSync(new URL('../scripts/whats-new.mjs', import.meta.url), 'utf8')
  const rel = readFileSync(new URL('../scripts/release.mjs', import.meta.url), 'utf8')
  ok(/src', 'generated'/.test(gen) && /'src', 'generated'/.test(rel), 'both name the same generated folder')
  ok(/release-notes\.md/.test(gen) && /release-notes\.md/.test(rel), 'and the same file within it')
  ok(!/Forge \$\{version\}\.\\n\\n` \+\s*`Download/.test(rel), 'release.mjs no longer hardcodes the notes')
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  ok(/whats-new\.mjs/.test(pkg.scripts.predev ?? ''), 'predev generates the notes')
  ok(/whats-new\.mjs/.test(pkg.scripts.pretypecheck ?? ''), 'and so does pretypecheck, so a fresh clone compiles')
  const ignore = readFileSync(new URL('../.gitignore', import.meta.url), 'utf8')
  ok(/^src\/generated\/$/m.test(ignore), 'the generated folder is gitignored — its version is CI’s to decide')
}

/* -------------------------------------------------------------------- end */

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} passed, ${fail} failed\n`)

/**
 * `process.exitCode`, not `process.exit()`.
 *
 * The sibling checks call `process.exit()` and get away with it. This one does
 * not: with three TypeScript modules loaded through registerHooks, an immediate
 * exit tears the loader down while it still holds handles and Node aborts with
 * `Assertion failed: !(handle->flags & UV_HANDLE_CLOSING), src\win\async.c` —
 * *after* printing PASS, so the run looks green and the exit code is 127. Which
 * would make this script's own failure mode "silently reports success to CI".
 * Setting the code and letting the event loop drain is the same contract without
 * the race.
 */
process.exitCode = fail === 0 ? 0 : 1
