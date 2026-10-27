/**
 * One Enter is one submit: proof for electron/pty/submit-split.ts and the
 * write path in electron/pty/session-manager.ts that uses it.
 *
 *   (a) invisible format characters are stripped before they reach a PTY
 *       (they make Claude Code hold the message: "Removed 1 invisible character
 *       · review and press Enter to send"), emoji joiners kept;
 *   (b) a write of `text\r` reaches the program as two reads — the words, then
 *       the `\r` alone a beat later — because Claude Code takes a long burst with
 *       its `\r` as a paste and does not submit it. Checked through a real
 *       ConPTY: the manager spawns a node child that reports every stdin read.
 *
 *   npm run submit-split:check
 */
import { mkdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const ROOT = resolve(import.meta.dirname, '..')
const scratch = join(ROOT, 'node_modules', '.forge-smoke')
mkdirSync(scratch, { recursive: true })

let failures = 0
const log = (ok, message) => {
  if (!ok) failures++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${message}`)
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function bundle(source, name) {
  const outfile = join(scratch, name)
  await build({
    entryPoints: [join(ROOT, source)],
    outfile,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    external: ['@lydell/node-pty'],
    logLevel: 'silent',
    absWorkingDir: ROOT
  })
  return import(pathToFileURL(outfile).href)
}

const { stripInvisible, submitHead, ENTER_GAP_MS } = await bundle('electron/pty/submit-split.ts', 'submit-split.mjs')
const { PtySessionManager } = await bundle('electron/pty/session-manager.ts', 'session-manager-split.mjs')

/* ------------------------------------------------- (a) invisible characters */

// Each of these made a real Claude Code show the notice and not submit.
for (const [name, ch] of [
  ['zero-width space U+200B', '​'],
  ['word joiner U+2060', '⁠'],
  ['BOM U+FEFF', '﻿'],
  ['soft hyphen U+00AD', '­'],
  ['left-to-right mark U+200E', '‎'],
  ['tag character U+E0041', '\u{E0041}']
]) {
  log(stripInvisible(`say${ch} hello`) === 'say hello', `strips ${name}`)
}
const family = 'hi \u{1F468}‍\u{1F469}‍\u{1F467}'
log(stripInvisible(family) === family, 'keeps the joiners inside an emoji sequence (Claude Code passes them)')
log(stripInvisible('a‍b') === 'ab', 'drops a joiner between letters')
const plain = 'café — naïve 日本語  x\t\x1b[A'
log(stripInvisible(plain) === plain, 'leaves ordinary text, NBSP, tabs and escape sequences alone')

/* ---------------------------------------------- (b) the Enter goes by itself */

log(submitHead('hello\r') === 'hello', 'text + Enter splits into the text...')
log(submitHead('\r') === null, '...a bare Enter goes as it is')
log(submitHead('abc') === null, '...so does text with no Enter')
log(submitHead('\x1b\r') === null, '...and ESC+CR (Alt/Shift+Enter) is never split into Escape then submit')

/*
 * Through a real ConPTY: the "shell" is a node child that, in raw mode, prints
 * one line per stdin read. Long enough (450 chars) that one burst would be a
 * paste to Claude Code.
 */
const CHILD = [
  "process.stdin.setRawMode(true);",
  "process.stdout.write('READY\\n');",
  "process.stdin.on('data', (b) => process.stdout.write('READ ' + Date.now() + ' ' + JSON.stringify(b.toString()) + '\\n'));"
].join('')
let out = ''
const manager = new PtySessionManager({
  shell: process.execPath,
  shellArgs: ['-e', CHILD],
  onData: (_id, data) => {
    out += data
  },
  onExit: () => {}
})
const made = manager.create({ id: 'split', cwd: ROOT, cols: 400, rows: 50 })
log(made.ok, `spawned a node child on a ConPTY${made.ok ? '' : `: ${made.error}`}`)
if (made.ok) {
  const t0 = Date.now()
  while (!out.includes('READY') && Date.now() - t0 < 15000) await sleep(50)
  const words = 'please note this is a fairly long dictated sentence that goes on. '.repeat(7).trim()
  const zw = 'one​two'
  manager.write('split', `${words}\r`)
  manager.write('split', `${zw}\r`) // arrives inside the first one's beat: must queue behind its Enter
  await sleep(ENTER_GAP_MS * 2 + 1500)
  const reads = [...out.replace(/\r?\n/g, '\n').matchAll(/READ (\d+) (".*?(?<!\\)")/g)].map((m) => ({
    at: Number(m[1]),
    text: JSON.parse(m[2])
  }))
  const joined = reads.map((r) => r.text).join('')
  const cr = reads.filter((r) => r.text === '\r')
  log(joined === `${words}\r${'onetwo'}\r`, `the child read exactly the words, Enter, the stripped words, Enter (${JSON.stringify(joined.slice(-12))})`)
  log(cr.length === 2, `each Enter was a read of its own (${cr.length} lone \\r reads of ${reads.length})`)
  log(!reads.some((r) => r.text.length > 1 && r.text.includes('\r')), 'no read held words and an Enter together')
  const firstWords = reads.find((r) => r.text.includes('please'))
  if (firstWords && cr[0]) {
    const gap = cr[0].at - firstWords.at
    log(gap >= ENTER_GAP_MS - 20, `the first Enter came ${gap} ms after its words (gap ${ENTER_GAP_MS} ms)`)
  } else log(false, 'saw the words and an Enter')
  manager.kill('split')
}

console.log(failures ? `\n${failures} failed` : '\nall passed')
process.exit(failures ? 1 : 0)
