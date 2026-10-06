/**
 * The Markdown reader's disk half, driven head-less.
 *
 *   npm run reader:check
 *
 * Imports the *real* electron/reader.ts (with `electron` stubbed, the way
 * scripts/handoff-check.mjs does it) and drives its pure functions against a
 * temp dir — never the real data root, never the registry:
 *
 *   - list: finds .md/.markdown, skips node_modules, build output and every
 *     dot-folder, honours the depth limit and the 2000-file cap
 *   - read: refuses a non-markdown file, a directory and a relative path
 *   - write: a stale baseHash is a conflict that writes nothing and hands back
 *     what is on disk; a CRLF file stays CRLF; a BOM stays put
 *   - the inbox: a UTF-16LE-with-BOM request (what Open in Forge.vbs writes) and
 *     a UTF-8 one, both naming a path with non-ASCII in it, decode to that path
 *     and are deleted; dot-files and .tmp files are left alone
 *   - resolve: peels backticks, quotes and `:12:3`, takes a relative path
 *     against the base dir, refuses what does not exist
 *   - the "Open with" registration refuses to run outside the stable channel,
 *     before it reaches reg.exe
 */
import { registerHooks } from 'node:module'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const ELECTRON_STUB = 'forge-check:electron'

registerHooks({
  resolve(spec, context, next) {
    if (spec === 'electron') return { url: ELECTRON_STUB, shortCircuit: true }
    if (spec.startsWith('@shared/')) {
      return next(new URL(`../shared/${spec.slice('@shared/'.length)}.ts`, import.meta.url).href, context)
    }
    if (spec.startsWith('.') && !/\.[a-z]+$/i.test(spec)) return next(`${spec}.ts`, context)
    return next(spec, context)
  },
  load(url, context, next) {
    if (url === ELECTRON_STUB) {
      return {
        format: 'module',
        shortCircuit: true,
        source: 'export const ipcMain = { handle() {}, on() {} }; export const shell = { openPath: async () => "" }'
      }
    }
    if (url.endsWith('.ts')) return next(url, { ...context, format: 'module-typescript' })
    return next(url, context)
  }
})

const R = await import('../electron/reader.ts')
const S = await import('../shared/reader.ts')

let pass = 0
let fail = 0
const ok = (cond, label, detail = '') => {
  if (cond) {
    pass++
    console.log(`  ok   ${label}`)
  } else {
    fail++
    console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`)
  }
}

const scratch = mkdtempSync(join(tmpdir(), 'forge-reader-check-'))
const put = (rel, body) => {
  const full = join(scratch, rel)
  mkdirSync(join(full, '..'), { recursive: true })
  writeFileSync(full, body)
  return full
}

try {
  /* ------------------------------------------------------------------ list */
  console.log('\nlist')
  {
    const root = join(scratch, 'proj')
    put('proj/README.md', '# hi')
    put('proj/docs/guide.markdown', 'guide')
    put('proj/docs/notes.txt', 'not markdown')
    put('proj/node_modules/pkg/README.md', 'dep')
    put('proj/.git/info.md', 'git')
    put('proj/.forge/handoff/x.md', 'dot')
    put('proj/out/main.md', 'build')
    put('proj/dist/x.md', 'build')
    put('proj/a/b/c/d/e/f/g/h/eight.md', 'depth 8')
    put('proj/a/b/c/d/e/f/g/h/i/nine.md', 'depth 9')
    const rels = R.listMarkdown(root).map((e) => e.rel.replace(/\\/g, '/'))
    ok(rels.includes('README.md') && rels.includes('docs/guide.markdown'), 'finds .md and .markdown', rels.join(', '))
    ok(!rels.some((r) => r.endsWith('.txt')), 'ignores other files')
    ok(!rels.some((r) => r.startsWith('node_modules/')), 'skips node_modules')
    ok(!rels.some((r) => r.startsWith('.git/') || r.startsWith('.forge/')), 'skips dot-folders')
    ok(!rels.some((r) => r.startsWith('out/') || r.startsWith('dist/')), 'skips build output')
    ok(rels.includes('a/b/c/d/e/f/g/h/eight.md') && !rels.some((r) => r.endsWith('nine.md')), 'depth limit 8')
    ok(R.listMarkdown('relative/path').length === 0, 'a relative root lists nothing')
    ok(R.listMarkdown(join(root, 'README.md')).length === 0, 'a file as root lists nothing')

    const many = join(scratch, 'many')
    mkdirSync(many)
    for (let i = 0; i < S.READER_LIST_MAX_ENTRIES + 25; i++) writeFileSync(join(many, `f${i}.md`), '')
    ok(R.listMarkdown(many).length === S.READER_LIST_MAX_ENTRIES, `caps at ${S.READER_LIST_MAX_ENTRIES}`)
  }

  /* ------------------------------------------------------------------ read */
  console.log('\nread')
  {
    const md = put('read/doc.md', '\ufeff# Title\r\nline two\r\n')
    const doc = R.readMarkdown(md)
    ok(!('error' in doc) && doc.text === '# Title\nline two\n', 'BOM dropped, CRLF shown as LF', JSON.stringify(doc.text))
    ok(!('error' in doc) && /^[0-9a-f]{64}$/.test(doc.hash), 'carries a hash')
    const txt = put('read/doc.txt', 'plain')
    ok('error' in R.readMarkdown(txt), 'refuses a non-markdown file')
    const dir = join(scratch, 'read', 'folder.md')
    mkdirSync(dir)
    ok('error' in R.readMarkdown(dir), 'refuses a directory, even one named .md')
    ok('error' in R.readMarkdown('read/doc.md'), 'refuses a relative path')
    ok('error' in R.readMarkdown(join(scratch, 'read', 'missing.md')), 'refuses a missing file')
  }

  /* ----------------------------------------------------------------- write */
  console.log('\nwrite')
  {
    const md = put('write/lf.md', 'one\ntwo\n')
    const first = R.readMarkdown(md)
    const saved = R.writeMarkdown(md, 'one\ntwo\nthree\n', first.hash)
    ok(saved.ok === true && readFileSync(md, 'utf8') === 'one\ntwo\nthree\n', 'saves with a fresh hash')
    ok(saved.ok === true && saved.hash === R.readMarkdown(md).hash, 'returns the new hash')

    writeFileSync(md, 'someone else edited this\n')
    const stale = R.writeMarkdown(md, 'mine\n', first.hash)
    ok(stale.ok === false && stale.conflict === true, 'stale baseHash is a conflict', JSON.stringify(stale))
    ok(readFileSync(md, 'utf8') === 'someone else edited this\n', 'a conflict writes nothing')
    ok(stale.conflict === true && stale.doc.text === 'someone else edited this\n', 'the conflict carries the current doc')

    const crlf = put('write/crlf.md', '# A\r\nb\r\n')
    const c = R.readMarkdown(crlf)
    const cs = R.writeMarkdown(crlf, '# A\nb\nc\n', c.hash)
    ok(cs.ok === true && readFileSync(crlf, 'utf8') === '# A\r\nb\r\nc\r\n', 'CRLF preserved on write', JSON.stringify(readFileSync(crlf, 'utf8')))

    const bom = put('write/bom.md', '\ufeffx\n')
    const b = R.readMarkdown(bom)
    R.writeMarkdown(bom, 'y\n', b.hash)
    const bytes = readFileSync(bom)
    ok(bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf && bytes.subarray(3).toString() === 'y\n', 'UTF-8 BOM kept')

    const txt = put('write/x.txt', 'plain')
    ok(R.writeMarkdown(txt, 'nope', '').ok === false && readFileSync(txt, 'utf8') === 'plain', 'refuses a non-markdown file')
    ok(R.writeMarkdown(join(scratch, 'write', 'new.md'), 'x', '').ok === false, 'refuses to create a file')
  }

  /* ----------------------------------------------------------------- inbox */
  console.log('\ninbox')
  {
    const target = put('Notizen für Zoë/über.md', '# unicode')
    const inbox = join(scratch, 'reader-inbox')
    mkdirSync(inbox)
    // What FileSystemObject's CreateTextFile(…, True, True) writes: FF FE + UTF-16LE.
    writeFileSync(join(inbox, 'req-1.req'), Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(target, 'utf16le')]))
    writeFileSync(join(inbox, 'req-2.req'), Buffer.from(`${target}\r\n`, 'utf8'))
    writeFileSync(join(inbox, 'req-3.req'), Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(target, 'utf8')]))
    writeFileSync(join(inbox, '.forge-pid'), '1234')
    writeFileSync(join(inbox, 'req-4.tmp'), 'still being written')
    const got = R.takeInboxRequests(inbox)
    ok(got.length === 3, 'takes the three finished requests', JSON.stringify(got))
    ok(got[0] === target, 'UTF-16LE + BOM decodes a non-ASCII path', JSON.stringify(got[0]))
    ok(got[1] === target, 'UTF-8 decodes a non-ASCII path', JSON.stringify(got[1]))
    ok(got[2] === target, 'UTF-8 + BOM decodes a non-ASCII path', JSON.stringify(got[2]))
    const left = readdirSync(inbox).sort()
    ok(left.join(',') === '.forge-pid,req-4.tmp', 'requests deleted; pid file and .tmp left alone', left.join(','))
    ok(R.openInReader(target, 'windows').ok === true, 'openInReader accepts the decoded path')
  }

  /* --------------------------------------------------------------- resolve */
  console.log('\nresolve')
  {
    const base = join(scratch, 'res')
    const md = put('res/docs/PLAN.md', '# plan')
    ok(R.resolveMarkdownRef('`docs/PLAN.md:12:3`', base) === md, 'strips backticks and :12:3', String(R.resolveMarkdownRef('`docs/PLAN.md:12:3`', base)))
    ok(R.resolveMarkdownRef('"docs/PLAN.md"', base) === md, 'strips quotes')
    ok(R.resolveMarkdownRef('docs/PLAN.md:7', base) === md, 'strips :line')
    ok(R.resolveMarkdownRef(`${md}.`, null) === md, 'absolute, trailing full stop')
    ok(R.resolveMarkdownRef(`\`${md}\`:12`, null) === md, 'absolute with backticks outside :line')
    ok(R.resolveMarkdownRef('docs/PLAN.md', null) === null, 'relative with no base dir is null')
    ok(R.resolveMarkdownRef('docs/missing.md', base) === null, 'missing file is null')
    ok(R.resolveMarkdownRef('docs', base) === null, 'a folder is null')
  }

  /* --------------------------------------------------------------- recent */
  console.log('\nrecent')
  {
    const root = join(scratch, 'data')
    mkdirSync(root)
    const a = put('rec/a.md', 'a')
    const b = put('rec/b.md', 'b')
    R.rememberRecent(root, a, 1)
    R.rememberRecent(root, b, 2)
    R.rememberRecent(root, a, 3)
    rmSync(b)
    const rec = R.readRecent(root)
    ok(rec.length === 1 && rec[0].path === a && rec[0].rel === 'a.md', 'newest first, deduped, missing dropped', JSON.stringify(rec))
  }

  /* ------------------------------------------------------------- open with */
  console.log('\nopen with')
  {
    const skipped = await R.registerMarkdownOpenWith({ checkoutRoot: scratch, channel: undefined, packaged: false })
    ok(skipped === 'skipped', 'no FORGE_CHANNEL: does not register')
    ok((await R.registerMarkdownOpenWith({ checkoutRoot: scratch, channel: 'dev', packaged: false })) === 'skipped', 'dev channel: does not register')
    ok((await R.registerMarkdownOpenWith({ checkoutRoot: scratch, channel: 'stable', packaged: true })) === 'skipped', 'packaged: does not register')
    // No Open in Forge.vbs in the scratch dir, so even 'stable' stops before reg.exe.
    ok((await R.registerMarkdownOpenWith({ checkoutRoot: scratch, channel: 'stable', packaged: false })) === 'skipped', 'stable without the VBS: does not register')
    const values = R.openWithValues('C:\\forge', 'C:\\Windows')
    const command = values.find((v) => v.key.endsWith('\\shell\\open\\command'))
    ok(command?.data === '"C:\\Windows\\System32\\wscript.exe" "C:\\forge\\Open in Forge.vbs" "%1"', 'open command', command?.data)
    ok(values.every((v) => v.key.startsWith('HKCU\\Software\\Classes\\Forge.Markdown') || /\\\.(md|markdown)\\OpenWithProgids$/.test(v.key)), 'writes only Forge.Markdown and OpenWithProgids')
    ok(!values.some((v) => /\\\.(md|markdown)$/.test(v.key)), 'never the extension default value')
    const q = R.parseRegQuery('\r\nHKEY_CURRENT_USER\\Software\\Classes\\.md\\OpenWithProgids\r\n    Forge.Markdown    REG_SZ    \r\n\r\n')
    ok(q?.type === 'REG_SZ' && q.data === '', 'parses an empty REG_SZ', JSON.stringify(q))
    const q2 = R.parseRegQuery('HKEY_CURRENT_USER\\x\r\n    (Default)    REG_SZ    "C:\\a b.exe" "%1"\r\n')
    ok(q2?.data === '"C:\\a b.exe" "%1"', 'parses a default value with spaces', JSON.stringify(q2))
  }
} finally {
  rmSync(scratch, { recursive: true, force: true })
}

ok(!existsSync(scratch), 'temp dir removed')
console.log(`\nreader:check — ${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
