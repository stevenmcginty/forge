/**
 * Head-less proof of the downloaded Fire TV app.
 *
 * The real electron/mobile-tv-fetch.ts, driven against a scripted feed: a
 * manifest and some bytes that this file decides the shape of. What is being
 * proven is the one thing that matters about handing a binary to a television —
 * **nothing that fails verification is ever put where the server could serve
 * it.** A Fire Stick installs whatever it is given and can check nothing
 * itself, so this is the last place a bad download can be stopped.
 *
 *   npm run tv-fetch:check
 *
 * The feed is injected rather than reached: a check that needs GitHub to be up
 * is a check that fails for reasons that are not the code's.
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const ROOT = resolve(import.meta.dirname, '..')
const scratch = join(ROOT, 'node_modules', '.forge-tv-fetch-check')
rmSync(scratch, { recursive: true, force: true })
mkdirSync(scratch, { recursive: true })

let failures = 0
const log = (ok, message) => {
  if (!ok) failures++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${message}`)
}

const bundle = join(scratch, 'tv-fetch.mjs')
await build({
  entryPoints: [join(ROOT, 'electron', 'mobile-tv-fetch.ts')],
  outfile: bundle,
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node20',
  external: ['electron'],
  alias: { '@shared': join(ROOT, 'shared') }
})
const { downloadedTv, fetchTvApk, parseTvManifest } = await import(pathToFileURL(bundle).href)

/* ------------------------------------------------------------ the feed */

const store = join(scratch, 'tv')
const apkBytes = Buffer.from('PK a plausible little apk '.repeat(64))
const goodSha = createHash('sha256').update(apkBytes).digest('hex')

const manifestFor = (over = {}) =>
  JSON.stringify({
    versionName: '0.4.0',
    url: 'https://github.com/x/y/releases/download/tv-v0.4.0/forge-tv.apk',
    sizeBytes: apkBytes.length,
    sha256: goodSha,
    ...over
  })

/** A feed that answers with whatever this test hands it. */
const feed = (manifest, bytes) => ({
  dir: store,
  manifestUrl: 'https://example.invalid/tv-latest.json',
  fetchText: async () => {
    if (manifest instanceof Error) throw manifest
    return manifest
  },
  fetchBytes: async () => {
    if (bytes instanceof Error) throw bytes
    return bytes
  }
})

const apkPath = join(store, 'forge-tv.apk')

/* -------------------------------------------------------- 1. the manifest */

log(parseTvManifest(manifestFor()) !== null, 'a well-formed manifest parses')
log(parseTvManifest('<!doctype html><title>404</title>') === null, 'a captive portal or an error page does not')
log(parseTvManifest(manifestFor({ sha256: 'nope' })) === null, 'and neither does one whose hash is not a hash')
log(
  parseTvManifest(manifestFor({ url: 'http://example.com/x.apk' })) === null,
  'or one that would download the APK over plain http'
)

/* ------------------------------------------------------- 2. the happy path */

const first = await fetchTvApk(feed(manifestFor(), apkBytes))
log(first.ok === true, 'a download whose size and hash match is accepted')
log(existsSync(apkPath), 'and the APK is where the link server serves from')
log(readFileSync(apkPath).equals(apkBytes), 'byte for byte')

const have = downloadedTv(store)
log(have?.versionName === '0.4.0', 'and the version is remembered beside it, so a restart still knows what it has')
log(have?.sizeBytes === apkBytes.length, 'with the size read off the file rather than off the manifest')

/* ----------------------------------------------- 3. a download that lies */

const tampered = Buffer.concat([apkBytes.subarray(0, apkBytes.length - 1), Buffer.from('!')])
const bad = await fetchTvApk(feed(manifestFor(), tampered))
log(bad.ok === false, 'bytes that do not match the published hash are refused')
log(typeof bad.error === 'string' && bad.error.length > 20, 'with a sentence a person can act on')
log(readFileSync(apkPath).equals(apkBytes), 'and the good APK already on disk is untouched')
log(!existsSync(join(store, 'forge-tv.apk.part')), 'leaving no half-written file behind')

const short = await fetchTvApk(feed(manifestFor({ sizeBytes: apkBytes.length + 10 }), apkBytes))
log(short.ok === false, 'a download of the wrong length is refused before the hash is even reached')
log(readFileSync(apkPath).equals(apkBytes), 'and again the file in place is untouched')

/* --------------------------------------------------- 4. a feed that is not */

const offline = await fetchTvApk(feed(new Error('getaddrinfo ENOTFOUND'), apkBytes))
log(offline.ok === false, 'an unreachable feed is an error, not an exception')
log(/connection|reach/i.test(offline.error ?? ''), 'and says so in words about the connection')

const html = await fetchTvApk(feed('<!doctype html>', apkBytes))
log(html.ok === false, 'a feed answering with a web page is refused')

const cut = await fetchTvApk(feed(manifestFor(), new Error('socket hang up')))
log(cut.ok === false, 'a download that dies mid-flight is an error')
log(readFileSync(apkPath).equals(apkBytes), 'and still nothing on disk moved')

/* ------------------------------------------------------ 5. a later version */

const nextBytes = Buffer.from('PK the next one '.repeat(80))
const nextSha = createHash('sha256').update(nextBytes).digest('hex')
const upgraded = await fetchTvApk(
  feed(manifestFor({ versionName: '0.5.0', sizeBytes: nextBytes.length, sha256: nextSha }), nextBytes)
)
log(upgraded.ok === true, 'a newer release replaces the one already there')
log(downloadedTv(store)?.versionName === '0.5.0', 'and the remembered version moves with it')
log(readFileSync(apkPath).equals(nextBytes), 'and the served bytes are the new ones')

/* ----------------------------------------------- 6. nothing downloaded yet */

const empty = join(scratch, 'never-used')
mkdirSync(empty, { recursive: true })
log(downloadedTv(empty) === null, 'a directory with no APK in it reports nothing rather than a phantom')
writeFileSync(join(empty, 'forge-tv.apk'), apkBytes)
log(
  downloadedTv(empty)?.versionName === '',
  'and an APK with no record beside it is still reported — the file is the fact, the record is a label'
)

console.log(failures === 0 ? '\ntv-fetch-check: all good' : `\ntv-fetch-check: ${failures} failed`)
process.exit(failures === 0 ? 0 : 1)
