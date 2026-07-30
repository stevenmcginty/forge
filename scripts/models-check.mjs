/**
 * Unit + integration test for the Parakeet downloader.
 *
 *   node scripts/models-check.mjs
 *
 * The real model is 660 MB, so nothing here downloads it. Instead a local HTTP
 * server serves a small file and is told to misbehave in each of the ways a CDN
 * actually misbehaves — drop the connection mid-body, ignore a Range header,
 * answer 416, serve an error page where a model should be — because those are
 * the paths that only ever run at 3am on a bad connection and therefore have to
 * be tested here rather than discovered there.
 */
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtempSync, writeFileSync, readFileSync, existsSync, statSync } from 'node:fs'
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

const { downloadParakeet, fetchResumable, inspectModelDir, sizeOf, PARAKEET_FILES } = await import(
  '../electron/models/parakeet.ts'
)

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

const root = mkdtempSync(join(tmpdir(), 'forge-models-'))
// Big enough that a mid-body hang-up really does leave bytes on disk, small
// enough that the whole suite runs in under a second.
const BODY = Buffer.from(Array.from({ length: 256 * 1024 }, (_, i) => i % 251))

/* ------------------------------------------------------------------ server */

/**
 * Serves BODY at /<mode>/<name> with Range support. The mode segment picks the
 * misbehaviour: `norange` ignores Range, `short` truncates the body and hangs
 * up, `flaky` fails the first N requests, `html` serves an error page. It is a
 * path segment rather than a query so that `baseUrl + fileName` — exactly how
 * the downloader builds its URLs — still lands on it.
 */
let flakyLeft = 0
const server = createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost')
  const mode = url.pathname.split('/').filter(Boolean)[0] ?? ''

  if (mode === 'html') {
    res.writeHead(404, { 'content-type': 'text/html' })
    res.end('<html>not found</html>')
    return
  }
  if (mode === 'flaky' && flakyLeft > 0) {
    flakyLeft--
    res.socket.destroy()
    return
  }

  const range = req.headers['range']
  let start = 0
  if (range && mode !== 'norange') {
    const m = /bytes=(\d+)-/.exec(range)
    if (m) start = Number(m[1])
    if (start >= BODY.length) {
      res.writeHead(416, { 'content-range': `bytes */${BODY.length}` })
      res.end()
      return
    }
    const slice = BODY.subarray(start)
    res.writeHead(206, {
      'content-length': String(slice.length),
      'content-range': `bytes ${start}-${BODY.length - 1}/${BODY.length}`
    })
    res.end(slice)
    return
  }

  if (mode === 'short') {
    // Declare the full length, send half, hang up: the classic truncation.
    res.writeHead(200, { 'content-length': String(BODY.length) })
    res.write(BODY.subarray(0, BODY.length / 2))
    res.socket.destroy()
    return
  }

  res.writeHead(200, { 'content-length': String(BODY.length) })
  res.end(BODY)
})

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const base = `http://127.0.0.1:${server.address().port}/plain/`
const baseFor = (mode) => `http://127.0.0.1:${server.address().port}/${mode}/`

const FILES = [{ name: 'good', minBytes: BODY.length }]
const dirFor = (name) => {
  const d = join(root, name)
  return d
}

/* ------------------------------------------------------------ fetchResumable */

console.log('\nfetchResumable')
{
  const part = join(root, 'a.part')
  const bytes = await fetchResumable(`${base}good`, part)
  ok(bytes === BODY.length, 'fetches a whole file', `${bytes}`)
  ok(readFileSync(part).equals(BODY), 'bytes match exactly')
}
{
  // Half a file already on disk: only the remainder should come down.
  const part = join(root, 'b.part')
  writeFileSync(part, BODY.subarray(0, 1000))
  const bytes = await fetchResumable(`${base}good`, part)
  ok(bytes === BODY.length, 'resumes from a partial file', `${bytes}`)
  ok(readFileSync(part).equals(BODY), 'resumed file is byte-identical')
}
{
  // The server ignores our Range: the prefix must be thrown away, not appended.
  const part = join(root, 'c.part')
  writeFileSync(part, BODY.subarray(0, 1000))
  const bytes = await fetchResumable(`${baseFor('norange')}good`, part)
  ok(bytes === BODY.length, 'a server that ignores Range restarts the file', `${bytes}`)
  ok(readFileSync(part).equals(BODY), 'no duplicated prefix after a failed resume')
}
{
  // Ranged past the end — we already have everything.
  const part = join(root, 'd.part')
  writeFileSync(part, BODY)
  const bytes = await fetchResumable(`${base}good`, part)
  ok(bytes === BODY.length, '416 counts as complete', `${bytes}`)
}
{
  const part = join(root, 'e.part')
  let threw = null
  try {
    await fetchResumable(`${baseFor('html')}good`, part)
  } catch (err) {
    threw = err
  }
  ok(threw !== null, 'an HTTP error throws')
  ok(threw?.status === 404, 'the status survives for the caller', String(threw?.status))
}
{
  const part = join(root, 'f.part')
  let threw = null
  try {
    await fetchResumable(`${baseFor('short')}good`, part)
  } catch (err) {
    threw = err
  }
  ok(threw !== null, 'a truncated body throws rather than passing silently')
  // Whether or not any bytes survived the hang-up, the retry has to end up with
  // a byte-correct file — that is the property that matters, and it is the one
  // a naive "append whatever comes back" resume gets wrong.
  const bytes = await fetchResumable(`${base}good`, part)
  ok(bytes === BODY.length, 'a retry after a truncated body completes the file', `${bytes}`)
  ok(readFileSync(part).equals(BODY), 'and the retried file is byte-identical')
}

/* -------------------------------------------------------- downloadParakeet */

console.log('\ndownloadParakeet')
{
  const dir = dirFor('full')
  const result = await downloadParakeet({
    dir,
    baseUrl: base,
    files: FILES,
    retryDelayMs: 0,
    totalHint: BODY.length,
    fetchImpl: fetch
  })
  ok(result.ok === true, 'downloads a complete set', JSON.stringify(result))
  ok(readFileSync(join(dir, 'good')).equals(BODY), 'the finished file is correct')
  ok(!existsSync(join(dir, 'good.part')), 'the .part file is renamed away, not left behind')
}
{
  const dir = dirFor('resume')
  const { mkdirSync } = await import('node:fs')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'good.part'), BODY.subarray(0, 2048))
  const seen = []
  const result = await downloadParakeet({
    dir,
    baseUrl: base,
    files: FILES,
    retryDelayMs: 0,
    totalHint: BODY.length,
    onProgress: (p) => seen.push(p)
  })
  ok(result.ok === true, 'resumes an interrupted download')
  ok(readFileSync(join(dir, 'good')).equals(BODY), 'a resumed set verifies byte-for-byte')
  ok(seen.length > 0, 'progress is reported')
  ok(
    seen.every((p) => p.fraction === null || (p.fraction >= 0 && p.fraction <= 1)),
    'progress fractions stay inside 0..1'
  )
  ok(seen.at(-1).fraction === 1, 'progress ends at 1', String(seen.at(-1).fraction))
}
{
  const dir = dirFor('flaky')
  flakyLeft = 2
  const result = await downloadParakeet({
    dir,
    baseUrl: baseFor('flaky'),
    files: FILES,
    retryDelayMs: 0,
    totalHint: BODY.length
  })
  ok(result.ok === true, 'retries through two dropped connections', JSON.stringify(result))
  flakyLeft = 0
}
{
  const dir = dirFor('fatal')
  const result = await downloadParakeet({
    dir,
    baseUrl: baseFor('html'),
    files: FILES,
    retryDelayMs: 0,
    maxAttempts: 4
  })
  ok(result.ok === false, 'a 404 fails rather than retrying forever')
  ok(/404/.test(result.error ?? ''), 'the error says what happened', result.error)
}
{
  const dir = dirFor('cancel')
  const controller = new AbortController()
  controller.abort()
  const result = await downloadParakeet({
    dir,
    baseUrl: base,
    files: FILES,
    retryDelayMs: 0,
    signal: controller.signal
  })
  ok(result.ok === false && result.cancelled === true, 'an aborted download reports cancelled')
}
{
  // Already complete: nothing should be fetched at all.
  const dir = dirFor('skip')
  const { mkdirSync } = await import('node:fs')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'good'), BODY)
  let calls = 0
  const result = await downloadParakeet({
    dir,
    baseUrl: base,
    files: FILES,
    retryDelayMs: 0,
    fetchImpl: (...args) => {
      calls++
      return fetch(...args)
    }
  })
  ok(result.ok === true, 'an already-complete folder succeeds')
  ok(calls === 0, 'and downloads nothing', `${calls} requests`)
}

/* ------------------------------------------------------------- inspection */

console.log('\ninspectModelDir')
{
  const empty = await inspectModelDir(join(root, 'nothing-here'))
  ok(empty.complete === false, 'a missing folder is not complete')
  ok(empty.bytes === 0, 'and weighs nothing')
  ok(empty.files.length === PARAKEET_FILES.length, 'every expected file is reported')
  ok(
    empty.files.every((f) => f.ok === false),
    'each one flagged missing'
  )

  const good = await inspectModelDir(dirFor('full'), FILES)
  ok(good.complete === true, 'a populated folder is complete')
  ok(good.bytes === BODY.length, 'bytes are totalled', String(good.bytes))

  // A file that is present but far too small — the truncated-download case that
  // makes onnx-asr fail with something unhelpful hours later.
  const dir = dirFor('short-file')
  const { mkdirSync } = await import('node:fs')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'good'), Buffer.alloc(10))
  const shorted = await inspectModelDir(dir, FILES)
  ok(shorted.complete === false, 'a truncated file does not count as installed')
  ok((await sizeOf(join(dir, 'good'))) === 10, 'sizeOf reports real sizes')
  ok((await sizeOf(join(dir, 'nope'))) === 0, 'sizeOf is 0 for a missing file')
}

assert.ok(PARAKEET_FILES.some((f) => f.name.startsWith('encoder')), 'the encoder is in the file list')

server.close()
console.log(`\n${pass} passed, ${fail} failed\n`)
process.exit(fail === 0 ? 0 : 1)
