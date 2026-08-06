/**
 * The JSONL tail, held to the five things that are hard about it.
 *
 *   node scripts/tail-check.mjs
 *
 * electron/jsonl-tail.ts follows a file another process is appending to, and
 * every one of its awkward cases — a truncation, a jump past the read ceiling, a
 * multi-byte character split across a read boundary, a line that never ends, a
 * seek near the end of a huge file — happens on somebody else's schedule and
 * essentially never while you are watching. So they are provoked here on purpose
 * against real files in a real temp folder, driven through the tail's own
 * `drain()` so there is not a timer or a filesystem notification anywhere in the
 * loop.
 */
import { mkdtempSync, rmSync, writeFileSync, appendFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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

const { createTail, TAIL_MAX_CHUNK } = await import('../electron/jsonl-tail.ts')

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

const dir = mkdtempSync(join(tmpdir(), 'forge-tail-'))
const nth = (() => {
  let n = 0
  return () => join(dir, `t${++n}.jsonl`)
})()

/** A tail over `file` that collects every line it is handed. */
function tailing(file, options = {}) {
  const lines = []
  const tail = createTail({ file, onLine: (line) => lines.push(line), ...options })
  return { tail, lines }
}

try {
  /* ------------------------------------------------------------- the basics */

  console.log('\nappending')
  {
    const file = nth()
    writeFileSync(file, 'one\ntwo\n')
    const { tail, lines } = tailing(file)
    tail.drain()
    ok(lines.join('|') === 'one|two', 'both complete lines arrive', lines.join('|'))

    tail.drain()
    ok(lines.length === 2, 'a second drain with nothing new hands over nothing')

    // A line that has not ended yet is held, not delivered half-finished.
    appendFileSync(file, 'thr')
    tail.drain()
    ok(lines.length === 2, 'a partial line is carried, not emitted')

    appendFileSync(file, 'ee\n')
    tail.drain()
    ok(lines[2] === 'three', 'and completes on the next read', String(lines[2]))
  }

  {
    const file = nth()
    const { tail, lines } = tailing(file)
    tail.drain()
    ok(lines.length === 0, 'a file that does not exist yet is not an error')
    writeFileSync(file, 'late\n')
    tail.drain()
    ok(lines[0] === 'late', 'and is picked up once it appears')
  }

  /* ---------------------------------------------------------- truncation */

  console.log('\ntruncation')
  {
    const file = nth()
    writeFileSync(file, 'alpha\nbravo\ncharlie\n')
    const { tail, lines } = tailing(file)
    tail.drain()
    ok(lines.length === 3, 'three lines read')

    // Replaced by something shorter: the offset now means something else, so
    // the file is read again from the start rather than from the middle of it.
    writeFileSync(file, 'delta\n')
    tail.drain()
    ok(lines.length === 4 && lines[3] === 'delta', 'a truncation restarts the offset', lines.join('|'))
  }

  /* ------------------------------------------------------------- the ceiling */

  console.log('\nthe read ceiling')
  ok(TAIL_MAX_CHUNK === 4 * 1024 * 1024, 'the default ceiling is four megabytes', String(TAIL_MAX_CHUNK))

  {
    // maxChunk is overridable so this costs a hundred bytes instead of eight
    // megabytes; the arithmetic it exercises is the same either way.
    const file = nth()
    writeFileSync(file, 'seen\n')
    const { tail, lines } = tailing(file, { maxChunk: 32 })
    tail.drain()
    ok(lines.length === 1, 'the first read is normal')

    // Far more than the ceiling appended at once: the read starts partway
    // through a line, so that leading fragment goes.
    appendFileSync(file, `${'x'.repeat(60)}\nkept-a\nkept-b\n`)
    tail.drain()
    ok(!lines.some((l) => l.startsWith('xxx')), 'a jump past the ceiling drops the leading partial line', lines.join('|'))
    ok(lines.includes('kept-b'), 'and keeps every whole line after it', lines.join('|'))
  }

  {
    const file = nth()
    const { tail, lines } = tailing(file, { maxChunk: 32 })
    // A "line" nothing ever ends, arriving in bites small enough that no single
    // read is a jump — so it is the *carry* ceiling being tested here, not the
    // read ceiling above. Without it the carry grows without bound.
    writeFileSync(file, 'y'.repeat(20))
    tail.drain()
    ok(lines.length === 0, 'an unterminated line is not emitted')
    appendFileSync(file, 'y'.repeat(20))
    tail.drain()
    ok(lines.length === 0, 'and still is not once it passes the ceiling')

    appendFileSync(file, '\nafter\n')
    tail.drain()
    ok(
      lines.length === 2 && lines[1] === 'after',
      'reading carries on normally after it',
      JSON.stringify(lines)
    )
    // The discriminating assertion: had the carry been kept and grown, this
    // would be the forty y's rather than what is left of them, which is nothing.
    ok(lines[0] === '', 'an over-ceiling line is discarded rather than grown', JSON.stringify(lines[0]))
  }

  /* ------------------------------------------------------------ the carry */

  console.log('\nmulti-byte boundaries')
  {
    const file = nth()
    // Two characters that are not one byte each: é is two bytes in UTF-8 and 🔥
    // is four. Split the buffer inside the é and the naive version decodes half
    // of it into a replacement char, and the JSON no longer parses.
    const line = Buffer.from('{"path":"café/🔥.ts"}\n', 'utf8')
    const cut = line.indexOf(0xc3) + 1 // one byte into the é
    ok(cut > 0 && cut < line.length, 'the fixture really does split a multi-byte character', String(cut))

    writeFileSync(file, line.subarray(0, cut))
    const { tail, lines } = tailing(file)
    tail.drain()
    ok(lines.length === 0, 'half a character is not a line')

    appendFileSync(file, line.subarray(cut))
    tail.drain()
    ok(lines.length === 1, 'the rest completes it')
    ok(!lines[0].includes('�'), 'and nothing was replaced on the way', JSON.stringify(lines[0]))
    ok(JSON.parse(lines[0]).path === 'café/🔥.ts', 'the line still parses as the JSON it was', JSON.stringify(lines[0]))
  }

  /* --------------------------------------------------------------- the seed */

  console.log('\ninitialTailBytes')
  {
    const file = nth()
    const old = Array.from({ length: 200 }, (_, i) => `old-${i}`).join('\n')
    writeFileSync(file, `${old}\nlast-a\nlast-b\n`)

    // Start about twenty bytes from the end: that lands mid-line, and the
    // partial line it lands on is dropped rather than handed over as a fragment.
    const { tail, lines } = tailing(file, { initialTailBytes: 20 })
    tail.drain()
    ok(lines.length > 0, 'something is read from near the end', String(lines.length))
    ok(!lines.some((l) => l.startsWith('old-')), 'the far past is not read at all', lines.join('|'))
    ok(lines[lines.length - 1] === 'last-b', 'the newest line is there', lines.join('|'))
    ok(
      lines.every((l) => /^(last-a|last-b)$/.test(l)),
      'and the partial line the seek landed in was dropped',
      lines.join('|')
    )
  }

  {
    const file = nth()
    // Shorter than the seed: seeking would throw the first line away for nothing.
    writeFileSync(file, 'only-a\nonly-b\n')
    const { tail, lines } = tailing(file, { initialTailBytes: 512 * 1024 })
    tail.drain()
    ok(lines.join('|') === 'only-a|only-b', 'a file smaller than the seed is read whole', lines.join('|'))
  }

  {
    const file = nth()
    writeFileSync(file, `${'z'.repeat(400)}\nseeded\n`)
    const { tail, lines } = tailing(file, { initialTailBytes: 32 })
    tail.drain()
    ok(lines.join('|') === 'seeded', 'the seed skips to the first newline', lines.join('|'))
    appendFileSync(file, 'after-seed\n')
    tail.drain()
    ok(lines.join('|') === 'seeded|after-seed', 'and reads on normally from there', lines.join('|'))
  }
} finally {
  rmSync(dir, { recursive: true, force: true })
}

console.log(`\n${pass} passed, ${fail} failed\n`)
process.exit(fail === 0 ? 0 : 1)
