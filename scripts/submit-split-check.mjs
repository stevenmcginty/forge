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

const { stripInvisible, splitSubmit, isUrgent, ENTER_GAP_MS } = await bundle('electron/pty/submit-split.ts', 'submit-split.mjs')
const { PtySessionManager } = await bundle('electron/pty/session-manager.ts', 'session-manager-split.mjs')

/** Characters by code point, so no invisible character sits in this file. */
const U = (...cps) => String.fromCodePoint(...cps)
const ZWNJ = U(0x200c)
const ZWJ = U(0x200d)
const flag = (letters) => U(0x1f3f4, ...[...letters].map((c) => 0xe0000 + c.charCodeAt(0)), 0xe007f)

/* ------------------------------------------------- (a) invisible characters */

// Each of these made a real Claude Code show the notice and not submit.
for (const [name, cp] of [
  ['zero-width space U+200B', 0x200b],
  ['word joiner U+2060', 0x2060],
  ['BOM U+FEFF', 0xfeff],
  ['soft hyphen U+00AD', 0x00ad],
  ['left-to-right mark U+200E', 0x200e],
  ['a stray tag character U+E0041', 0xe0041]
]) {
  log(stripInvisible(`say${U(cp)} hello`) === 'say hello', `strips ${name}`)
}
const family = `hi ${U(0x1f468)}${ZWJ}${U(0x1f469)}${ZWJ}${U(0x1f467)}`
log(stripInvisible(family) === family, 'keeps the joiners inside an emoji sequence (Claude Code passes them)')
for (const [name, letters] of [
  ['England', 'gbeng'],
  ['Scotland', 'gbsct'],
  ['Wales', 'gbwls']
]) {
  const text = `go ${flag(letters)} now`
  log(stripInvisible(text) === text, `keeps the ${name} flag whole (U+1F3F4 + tags + U+E007F)`)
}
const persian = `${U(0x645, 0x6cc)}${ZWNJ}${U(0x62e, 0x648, 0x627, 0x647, 0x645)}`
log(stripInvisible(persian) === persian, 'keeps ZWNJ between Persian letters')
const hindi = `${U(0x915, 0x94d)}${ZWJ}${U(0x937)}`
log(stripInvisible(hindi) === hindi, 'keeps ZWJ after a Hindi virama, before a letter')
log(stripInvisible(`a${ZWJ}b`) === `a${ZWJ}b`, 'keeps ZWJ between two letters')
log(stripInvisible(`say ${ZWNJ}hi${ZWJ} `) === 'say hi ', 'drops ZWNJ/ZWJ that sit next to a space')
const plain = `caf${U(0xe9)} ${U(0x2014)} ${U(0x65e5, 0x672c)} ${U(0xa0)}x\t\x1b[A`
log(stripInvisible(plain) === plain, 'leaves ordinary text, NBSP, tabs and escape sequences alone')

/* ---------------------------------------------- (b) the Enter goes by itself */

const same = (got, want) => JSON.stringify(got) === JSON.stringify(want)
log(same(splitSubmit('hello\r'), ['hello', '\r']), 'text + \\r splits into the text, then \\r')
log(same(splitSubmit('hello\r\n'), ['hello', '\r\n']), 'text + \\r\\n splits the same way, keeping both bytes')
log(splitSubmit('\r') === null && splitSubmit('\r\n') === null, 'a bare Enter goes as it is')
log(splitSubmit('abc') === null, 'so does text with no Enter')
log(splitSubmit('\x1b\r') === null, 'and ESC+CR (Alt/Shift+Enter) is never split into Escape then submit')
log(isUrgent('\x03') && isUrgent('\x1b') && !isUrgent('\x1b[A') && !isUrgent('x'), 'Ctrl+C and a lone Escape are urgent; arrows and letters are not')

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
  const zw = `one${U(0x200b)}two`
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
  /*
   * Ctrl+C and Escape inside the beat: they must not queue behind the held
   * Enter. Timed at node-pty's own write (a spy on the session's proc), which
   * is "reached the PTY"; the child's reads only confirm the order.
   */
  const proc = manager.sessions.get('split').proc
  const realWrite = proc.write.bind(proc)
  const wrote = []
  proc.write = (data) => {
    wrote.push({ at: performance.now(), data })
    return realWrite(data)
  }
  out = ''
  manager.write('split', 'stop this one\r')
  for (const [name, key] of [
    ['Ctrl+C', '\x03'],
    ['Escape', '\x1b']
  ]) {
    const asked = performance.now()
    manager.write('split', key)
    const hit = wrote.find((w) => w.data === key && w.at >= asked)
    const took = hit ? hit.at - asked : Infinity
    log(took < 10, `${name} written inside the Enter's beat reached the PTY in ${took.toFixed(2)} ms (< 10)`)
  }
  await sleep(ENTER_GAP_MS * 2 + 1000)
  log(
    same(
      wrote.map((w) => w.data),
      ['stop this one', '\x03', '\x1b', '\r']
    ),
    `the held Enter still went, after them (${JSON.stringify(wrote.map((w) => w.data))})`
  )
  const session = manager.sessions.get('split')
  proc.write = realWrite

  /* kill() during the beat drops the held Enter and its queue. */
  manager.write('split', 'never sent\r')
  manager.write('split', 'queued')
  log(Boolean(session.enterTimer) && session.afterEnter?.length === 1, 'a held Enter and a queued write are pending...')
  manager.kill('split')
  log(session.enterTimer === undefined && session.afterEnter === undefined, '...and kill() clears both')
  log(manager.write('split', 'x') === false, 'a write to a killed session returns false')
}

/*
 * onExit during the beat clears them too. The child quits on the "q" of
 * "q\r", so it exits while that write's Enter is held; the spy shows the held
 * Enter is never written to the dead PTY.
 */
{
  let exited = 0
  let ready = false
  const quick = new PtySessionManager({
    shell: process.execPath,
    shellArgs: [
      '-e',
      "process.stdin.setRawMode(true);process.stdout.write('READY\\n');process.stdin.on('data',(d)=>{if(String(d).includes('q'))process.exit(0)})"
    ],
    onData: (_id, data) => {
      if (data.includes('READY')) ready = true
    },
    onExit: () => {
      exited = performance.now()
    }
  })
  const ok = quick.create({ id: 'exit', cwd: ROOT, cols: 80, rows: 10 }).ok
  const session = quick.sessions.get('exit')
  const t0 = Date.now()
  while (!ready && Date.now() - t0 < 15000) await sleep(20)
  const wrote = []
  const realWrite = session.proc.write.bind(session.proc)
  session.proc.write = (data) => {
    wrote.push(data)
    return realWrite(data)
  }
  const sent = performance.now()
  quick.write('exit', 'q\r')
  quick.write('exit', 'queued behind it')
  const held = Boolean(session.enterTimer) && session.afterEnter?.length === 1
  while (!exited && performance.now() - sent < 5000) await sleep(2)
  await sleep(ENTER_GAP_MS * 3)
  log(ok && held && exited > 0, `the child exited ${(exited - sent).toFixed(0)} ms after "q", with its Enter held`)
  log(session.enterTimer === undefined && session.afterEnter === undefined, 'onExit cleared the held Enter and its queue')
  log(same(wrote, ['q']), `nothing else was written to the exited PTY (${JSON.stringify(wrote)})`)
  log(quick.write('exit', 'x') === false, 'a write to an exited session returns false')
}

console.log(failures ? `\n${failures} failed` : '\nall passed')
process.exit(failures ? 1 : 0)
