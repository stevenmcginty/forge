/**
 * Unit test for the speech-model downloader — resume, retry, validation and
 * cancellation — against a local HTTP server that can misbehave on demand.
 *
 *   node scripts/stt-download-test.mjs
 *
 * No Electron, no HuggingFace and nothing 660 MB: the files here are a few
 * kilobytes, because every property worth testing (does a `Range` request pick
 * up where the last one stopped, does an HTML error page get rejected, does a
 * dropped connection cost only the last chunk) is size-independent.
 *
 * electron/stt/model-download.ts is copied to a .mts and imported, the same
 * trick scripts/stt-manager-test.mjs uses: Node strips the types, and because it
 * is the real source the test cannot drift from what ships.
 */
import { createServer } from 'node:http'
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const ROOT = resolve(import.meta.dirname, '..')
const scratch = mkdtempSync(join(tmpdir(), 'forge-model-'))

const shim = join(scratch, 'model-download.mts')
writeFileSync(shim, readFileSync(join(ROOT, 'electron', 'stt', 'model-download.ts'), 'utf8'), 'utf8')
const { CancelledError, HttpStatusError, downloadModel, fetchResumable, inspectModel } = await import(
  pathToFileURL(shim).href
)

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

/* ------------------------------------------------------------------ server */

/**
 * A stand-in for HuggingFace with a mean streak.
 *
 *  /good/<name>       serves the body, honouring Range
 *  /flaky/<name>      serves `cutAfter` bytes then hangs up, once per file
 *  /html/<name>       a 200 with an error page in it — the shape that has to be
 *                     caught by size validation rather than by the status code
 *  /gone/<name>       404
 */
const bodies = new Map()
const cutOnce = new Set()
let sawRangeFor = new Map()

const server = createServer((req, res) => {
  const [, mode, ...rest] = req.url.split('/')
  const name = decodeURIComponent(rest.join('/'))
  const body = bodies.get(name)

  if (mode === 'gone' || !body) {
    res.writeHead(404, { 'content-type': 'text/plain' })
    res.end('no such file')
    return
  }

  if (mode === 'html') {
    res.writeHead(200, { 'content-type': 'text/html', 'content-length': '61' })
    res.end('<html><body>Sorry, that model is not available.</body></html>')
    return
  }

  let start = 0
  const range = req.headers['range']
  if (range) {
    const m = /bytes=(\d+)-/.exec(range)
    if (m) {
      start = Number(m[1])
      sawRangeFor.set(name, (sawRangeFor.get(name) ?? 0) + 1)
    }
  }
  if (start >= body.length) {
    res.writeHead(416, { 'content-range': `bytes */${body.length}` })
    res.end()
    return
  }

  const slice = body.subarray(start)
  if (mode === 'flaky' && !cutOnce.has(name)) {
    cutOnce.add(name)
    // Declare the whole length, send half, then hang up: the exact shape of a
    // connection dying mid-download.
    res.writeHead(start ? 206 : 200, {
      'content-length': String(slice.length),
      ...(start ? { 'content-range': `bytes ${start}-${body.length - 1}/${body.length}` } : {})
    })
    res.write(slice.subarray(0, Math.floor(slice.length / 2)))
    setTimeout(() => res.destroy(), 10)
    return
  }

  res.writeHead(start ? 206 : 200, {
    'content-length': String(slice.length),
    ...(start ? { 'content-range': `bytes ${start}-${body.length - 1}/${body.length}` } : {})
  })
  res.end(slice)
})

await new Promise((r) => server.listen(0, '127.0.0.1', r))
const base = (mode) => `http://127.0.0.1:${server.address().port}/${mode}/`

/* ------------------------------------------------------------------ files */

/** Four stand-in "model files", shaped like the real set: three small, one big. */
const FILES = [
  { name: 'config.json', minBytes: 50, expectBytes: 100 },
  { name: 'vocab.txt', minBytes: 500, expectBytes: 600 },
  { name: 'decoder_joint-model.int8.onnx', minBytes: 2_000, expectBytes: 2_048 },
  { name: 'encoder-model.int8.onnx', minBytes: 100_000, expectBytes: 131_072 }
]

const filled = (n, seed) => {
  const b = Buffer.alloc(n)
  for (let i = 0; i < n; i++) b[i] = (i * 31 + seed) & 0xff
  return b
}
bodies.set('config.json', Buffer.from(JSON.stringify({ model: 'parakeet', padding: 'x'.repeat(80) })))
bodies.set('vocab.txt', filled(600, 7))
bodies.set('decoder_joint-model.int8.onnx', filled(2_048, 11))
bodies.set('encoder-model.int8.onnx', filled(131_072, 13))

const fresh = (label) => {
  const dir = join(scratch, label)
  rmSync(dir, { recursive: true, force: true })
  return dir
}
const noSleep = async () => {}

/* ---------------------------------------------------------------- the run */

console.log('\nclean download')
{
  const dir = fresh('clean')
  const seen = []
  const report = await downloadModel({
    dir,
    base: base('good'),
    files: FILES,
    sleep: noSleep,
    onProgress: (p) => seen.push(p)
  })
  ok(report.presence === 'ready', 'all four files land and validate')
  ok(
    FILES.every((f) => bodies.get(f.name).equals(readFileSync(join(dir, f.name)))),
    'every file is byte-identical to what the server served'
  )
  ok(
    seen.length > 0 && seen[seen.length - 1].fraction >= 0.999,
    'progress reaches 1',
    `last fraction ${seen[seen.length - 1]?.fraction}`
  )
  ok(
    seen.every((p, i) => i === 0 || p.fraction >= seen[i - 1].fraction - 1e-9),
    'progress never goes backwards'
  )
  ok(
    !FILES.some((f) => existsSync(join(dir, `${f.name}.part`))),
    'no .part files are left behind'
  )
}

console.log('\nresume after a dropped connection')
{
  const dir = fresh('resume')
  cutOnce.clear()
  sawRangeFor = new Map()
  const report = await downloadModel({
    dir,
    base: base('flaky'),
    files: FILES,
    sleep: noSleep,
    retryDelayMs: 0
  })
  ok(report.presence === 'ready', 'the retry finishes what the drop started')
  ok(
    bodies.get('encoder-model.int8.onnx').equals(readFileSync(join(dir, 'encoder-model.int8.onnx'))),
    'the resumed big file is byte-identical — nothing duplicated, nothing lost'
  )
  ok(
    (sawRangeFor.get('encoder-model.int8.onnx') ?? 0) >= 1,
    'the second attempt asked for a byte range rather than starting again'
  )
}

console.log('\nresume is byte-exact at an arbitrary offset')
{
  const dir = fresh('offset')
  const name = 'encoder-model.int8.onnx'
  const whole = bodies.get(name)
  const part = join(dir, `${name}.part`)
  rmSync(dir, { recursive: true, force: true })
  const { mkdirSync } = await import('node:fs')
  mkdirSync(dir, { recursive: true })
  writeFileSync(part, whole.subarray(0, 40_001))
  sawRangeFor = new Map()

  const size = await fetchResumable(base('good') + name, part)
  ok(size === whole.length, 'the fetch reports the whole size', `got ${size}`)
  ok(sawRangeFor.get(name) === 1, 'exactly one ranged request')
  ok(whole.equals(readFileSync(part)), 'a 40001-byte head resumes into an identical file')
}

console.log('\na complete .part gets a 416, which means done')
{
  const dir = fresh('done')
  const { mkdirSync } = await import('node:fs')
  mkdirSync(dir, { recursive: true })
  for (const f of FILES) writeFileSync(join(dir, `${f.name}.part`), bodies.get(f.name))
  const report = await downloadModel({ dir, base: base('good'), files: FILES, sleep: noSleep })
  ok(report.presence === 'ready', '416 is treated as success, not as a failure')
  ok(
    FILES.every((f) => bodies.get(f.name).equals(readFileSync(join(dir, f.name)))),
    'the completed parts are promoted intact'
  )
}

console.log('\nan error page is not a model')
{
  const dir = fresh('html')
  let thrown = null
  try {
    await downloadModel({ dir, base: base('html'), files: FILES, sleep: noSleep, maxAttempts: 2, retryDelayMs: 0 })
  } catch (err) {
    thrown = err
  }
  ok(thrown !== null, 'a 200 full of HTML is rejected')
  ok(/too small|not the model/i.test(String(thrown?.message)), 'and says why', String(thrown?.message))
  ok(!existsSync(join(dir, 'vocab.txt')), 'the bogus file is deleted rather than left to fail later')
}

console.log('\na 404 is fatal, not retried')
{
  const dir = fresh('gone')
  const started = Date.now()
  let thrown = null
  try {
    await downloadModel({ dir, base: base('gone'), files: FILES, maxAttempts: 20, retryDelayMs: 5_000 })
  } catch (err) {
    thrown = err
  }
  ok(thrown instanceof HttpStatusError, 'throws HttpStatusError', String(thrown))
  ok(thrown?.status === 404, 'carrying the status')
  ok(Date.now() - started < 2_000, 'and gives up immediately instead of retrying for a minute')
}

console.log('\ncancellation keeps what it has')
{
  const dir = fresh('cancel')
  const ac = new AbortController()
  let thrown = null
  const run = downloadModel({
    dir,
    base: base('good'),
    files: FILES,
    signal: ac.signal,
    sleep: noSleep,
    onProgress: (p) => {
      if (p.file === 'encoder-model.int8.onnx') ac.abort()
    }
  }).catch((err) => {
    thrown = err
  })
  await run
  ok(thrown instanceof CancelledError, 'throws CancelledError', String(thrown))
  const after = await inspectModel(dir, FILES)
  ok(after.presence !== 'ready', 'the model is not claimed to be ready')
  ok(after.bytes > 0, 'but the bytes already fetched are still on disk to resume from')

  // ...and a second, uncancelled run finishes it.
  const done = await downloadModel({ dir, base: base('good'), files: FILES, sleep: noSleep })
  ok(done.presence === 'ready', 'a later attempt picks up and completes')
  ok(
    FILES.every((f) => bodies.get(f.name).equals(readFileSync(join(dir, f.name)))),
    'and the result is still byte-identical'
  )
}

console.log('\ninspectModel')
{
  const dir = fresh('inspect')
  const empty = await inspectModel(dir, FILES)
  ok(empty.presence === 'missing', 'an absent folder is missing')
  ok(empty.missing.length === 4, 'and names every file', JSON.stringify(empty.missing))

  const { mkdirSync } = await import('node:fs')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'config.json'), bodies.get('config.json'))
  const partial = await inspectModel(dir, FILES)
  ok(partial.presence === 'partial', 'a folder with one file of four is partial')
  ok(partial.missing.length === 3, 'and names only what is still needed')

  ok((await inspectModel('', FILES)).presence === 'missing', 'no folder at all is missing, not a crash')
}

/* ------------------------------------------------------------------- done */

server.close()
rmSync(scratch, { recursive: true, force: true })

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
