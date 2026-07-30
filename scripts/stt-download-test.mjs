/**
 * Unit test for the speech-model downloader — resume, retry, validation and
 * cancellation — against a local HTTP server that can misbehave on demand.
 *
 *   node scripts/stt-download-test.mjs             + one live check
 *   node scripts/stt-download-test.mjs --offline    local server only
 *
 * No Electron, no HuggingFace and nothing 660 MB: the files here are a few
 * kilobytes, because every property worth testing (does a `Range` request pick
 * up where the last one stopped, does an HTML error page get rejected, does a
 * dropped connection cost only the last chunk) is size-independent.
 *
 * electron/stt/model-download.ts is copied to a .mts and imported, the same
 * trick scripts/stt-manager-test.mjs uses: Node strips the types, and because it
 * is the real source the test cannot drift from what ships.
 *
 * This is the *only* downloader suite. The Settings work grew a second one
 * (scripts/models-check.mjs, against a second implementation in
 * electron/models/parakeet.ts); that implementation is gone and its checks that
 * were not already here — a server that ignores Range, an already-complete
 * folder fetching nothing, a present-but-truncated file — were folded in below.
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
const { CancelledError, HttpStatusError, MODEL_FILES, PARAKEET_BASE, downloadModel, fetchResumable, inspectModel } =
  await import(pathToFileURL(shim).href)

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
 *  /norange/<name>    ignores Range entirely and answers 200 with the whole
 *                     body — the proxy/CDN that silently throws your resume
 *                     away. Appending that to a `.part` gives a file of exactly
 *                     the right size and complete nonsense, so it is the one
 *                     failure that validation by size cannot catch.
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
  // Asked for a range, sent the lot, said 200. Entirely legal HTTP, and fatal
  // to a naive resume.
  if (mode === 'norange') {
    res.writeHead(200, { 'content-length': String(body.length) })
    res.end(body)
    return
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

console.log('\na server that ignores Range must not corrupt a resume')
{
  // The one failure size validation cannot catch: appending a whole 200 body to
  // a `.part` produces a file that is too *long*, so `minBytes` waves it
  // through and onnx-asr fails hours later with something unhelpful. The fix is
  // in fetchResumable — a status that is not 206 means the prefix is worthless.
  const dir = fresh('norange')
  const name = 'encoder-model.int8.onnx'
  const whole = bodies.get(name)
  const part = join(dir, `${name}.part`)
  const { mkdirSync } = await import('node:fs')
  mkdirSync(dir, { recursive: true })
  writeFileSync(part, whole.subarray(0, 40_001))

  const size = await fetchResumable(base('norange') + name, part)
  ok(size === whole.length, 'the file ends up its real length, not length + prefix', `got ${size}`)
  ok(whole.equals(readFileSync(part)), 'the abandoned prefix is overwritten, not appended to')

  // ...and the same thing through the whole-set path.
  const report = await downloadModel({ dir, base: base('norange'), files: FILES, sleep: noSleep })
  ok(report.presence === 'ready', 'a full download survives a Range-ignoring server')
  ok(
    FILES.every((f) => bodies.get(f.name).equals(readFileSync(join(dir, f.name)))),
    'and every file is still byte-identical'
  )
}

console.log('\nan already-complete folder is left alone')
{
  const dir = fresh('skip')
  const { mkdirSync } = await import('node:fs')
  mkdirSync(dir, { recursive: true })
  for (const f of FILES) writeFileSync(join(dir, f.name), bodies.get(f.name))

  let calls = 0
  const report = await downloadModel({
    dir,
    base: base('gone'),
    files: FILES,
    sleep: noSleep,
    fetchImpl: (...args) => {
      calls++
      return fetch(...args)
    }
  })
  // The base URL is the 404 one deliberately: if anything were fetched at all,
  // this would throw rather than quietly pass.
  ok(report.presence === 'ready', 'a complete folder reports ready')
  ok(calls === 0, 'and nothing is downloaded', `${calls} requests`)
}

console.log('\ninspectModel')
{
  const dir = fresh('inspect')
  const empty = await inspectModel(dir, FILES)
  ok(empty.presence === 'missing', 'an absent folder is missing')
  ok(empty.missing.length === 4, 'and names every file', JSON.stringify(empty.missing))
  ok(empty.files.length === 4, 'per-file detail covers every expected file')
  ok(
    empty.files.every((f) => f.ok === false && f.bytes === 0),
    'each one reported absent with no bytes'
  )

  const { mkdirSync } = await import('node:fs')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'config.json'), bodies.get('config.json'))
  const partial = await inspectModel(dir, FILES)
  ok(partial.presence === 'partial', 'a folder with one file of four is partial')
  ok(partial.missing.length === 3, 'and names only what is still needed')
  ok(
    partial.files.filter((f) => f.ok).length === 1 && partial.files[0].name === 'config.json',
    'per-file detail marks exactly the one that landed'
  )

  // A file that is present but far too small: the truncated download that
  // otherwise fails much later, inside onnx-asr, with no clue why. The card
  // shows this row in red rather than claiming the model is simply absent.
  const short = fresh('short-file')
  mkdirSync(short, { recursive: true })
  writeFileSync(join(short, 'vocab.txt'), Buffer.alloc(10))
  const shorted = await inspectModel(short, FILES)
  ok(shorted.presence === 'partial', 'a truncated file does not count as installed')
  const vocab = shorted.files.find((f) => f.name === 'vocab.txt')
  ok(vocab.ok === false && vocab.bytes === 10, 'and is reported with its real size', JSON.stringify(vocab))

  // A half-finished `.part` is progress, and the card says so rather than "0 B".
  const resuming = fresh('part-bytes')
  mkdirSync(resuming, { recursive: true })
  writeFileSync(join(resuming, 'encoder-model.int8.onnx.part'), bodies.get('encoder-model.int8.onnx').subarray(0, 5_000))
  const withPart = await inspectModel(resuming, FILES)
  ok(withPart.bytes === 5_000, 'bytes in a .part count towards progress', String(withPart.bytes))

  const nowhere = await inspectModel('', FILES)
  ok(nowhere.presence === 'missing', 'no folder at all is missing, not a crash')
  ok(nowhere.files.length === 4, 'and still reports every expected file')
}

/* --------------------------------------------------------------- the real host
 *
 * Everything above proves the logic. This proves the *addresses* — that the
 * HuggingFace repo, the four file names and the resume support are still what
 * the code believes. Only the two small files are fetched (9.5 KB together);
 * the 652 MB encoder is checked with a 64-byte ranged request, which is enough
 * to learn its real size and that the server answers 206.
 *
 * Skipped with --offline, since it is the one part that needs a network.
 */
if (!process.argv.includes('--offline')) {
  console.log('\nagainst the real model host')
  try {
    const dir = fresh('live')
    const small = MODEL_FILES.filter((f) => f.expectBytes < 100_000)
    const report = await downloadModel({ dir, files: small, sleep: noSleep, maxAttempts: 3 })
    ok(report.presence === 'ready', 'config.json and vocab.txt download from HuggingFace')
    ok(
      statSync(join(dir, 'config.json')).size >= 50 && statSync(join(dir, 'vocab.txt')).size >= 5_000,
      'and are big enough to be real'
    )

    for (const file of MODEL_FILES) {
      const res = await fetch(PARAKEET_BASE + file.name, {
        headers: { range: 'bytes=0-63', 'user-agent': 'Forge/0.1 (+dictation model fetch)' }
      })
      const range = res.headers.get('content-range') ?? ''
      const total = Number(range.split('/')[1] ?? 0)
      ok(res.status === 206, `${file.name}: the host honours Range`, `status ${res.status}`)
      ok(total >= file.minBytes, `${file.name}: ${total} bytes, above the ${file.minBytes} floor`)
      // A drifting expectBytes only skews the progress bar, so this warns
      // rather than fails — but 20% out means the constant is stale.
      const drift = total ? Math.abs(total - file.expectBytes) / total : 1
      if (drift > 0.2) console.log(`  --   ${file.name}: expectBytes is ${(drift * 100).toFixed(0)}% out (${total})`)
    }
  } catch (err) {
    console.log(`  --   skipped: could not reach the model host (${err?.message ?? err})`)
  }
}

/* ------------------------------------------------------------------- done */

server.close()
rmSync(scratch, { recursive: true, force: true })

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
