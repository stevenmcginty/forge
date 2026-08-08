/**
 * The Forge Mobile PWA, checked without an iPhone.
 *
 *   node scripts/pwa-check.mjs
 *
 * Three things can break the home-screen route, and all three break it silently
 * on a device with no devtools attached:
 *
 *  1. **A manifest or an icon that does not match its declaration.** iOS shows a
 *     generic page-screenshot icon and says nothing.
 *  2. **A transparent apple-touch-icon.** iOS composites the alpha over white,
 *     so the mark lands as a dark squircle inside a white one. Looks like a
 *     design choice; is a bug.
 *  3. **A service worker that caches the SPA fallback.** electron/mobile/server.ts
 *     answers unknown paths with index.html and a 200, so a worker that trusts
 *     `res.ok` will store HTML under a `.js` URL and white-screen the installed
 *     app on every launch from then on, permanently.
 *
 * The third is not grepped for — this script loads mobile/public/sw.js into a
 * fake worker global with an in-memory CacheStorage and *drives* it, the same
 * way scripts/mobile-smoke.mjs drives the real server. A guard that has only
 * ever been read is a guard nobody has tested.
 */

import { readFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { drawIcon } from './icon-lib.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const PUBLIC = join(ROOT, 'mobile', 'public')
const DIST = join(ROOT, 'mobile', 'dist')

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

/* ------------------------------------------------------------------- png */

/** Width, height and "does any pixel have alpha < 255", straight out of the file. */
function readPng(path) {
  const buf = readFileSync(path)
  const signature = buf.subarray(0, 8).toString('hex')
  if (signature !== '89504e470d0a1a0a') return null
  // IHDR is always the first chunk: 8 signature + 4 length + 4 type.
  return {
    width: buf.readUInt32BE(16),
    height: buf.readUInt32BE(20),
    colourType: buf[25],
    bytes: buf
  }
}

/* -------------------------------------------------------------- manifest */

console.log('\nmanifest')

const manifestPath = join(PUBLIC, 'manifest.webmanifest')
ok(existsSync(manifestPath), 'mobile/public/manifest.webmanifest exists')

let manifest = null
try {
  manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  ok(true, 'manifest is valid JSON')
} catch (err) {
  ok(false, 'manifest is valid JSON', err.message)
}

if (manifest) {
  ok(manifest.name === 'Forge Mobile', 'name', manifest.name)
  ok(manifest.short_name === 'Forge', 'short_name is short enough for a home screen', manifest.short_name)
  // Without `standalone` an installed app opens in a Safari tab with a URL bar,
  // which is the entire thing this route exists to avoid.
  ok(manifest.display === 'standalone', 'display is standalone', manifest.display)
  // Relative, to match `base: './'` in mobile/vite.config.ts — an absolute
  // start_url breaks the moment the bundle is served from anywhere but the root.
  ok(manifest.start_url === './', 'start_url is relative', manifest.start_url)
  ok(manifest.scope === './', 'scope is relative', manifest.scope)
  ok(manifest.background_color === '#0b0c0e', 'background_color matches --bg', manifest.background_color)
  ok(manifest.theme_color === '#0b0c0e', 'theme_color matches --bg', manifest.theme_color)
  ok(Array.isArray(manifest.icons) && manifest.icons.length >= 3, 'at least three icons declared')
  ok(
    (manifest.icons ?? []).some((i) => i.purpose === 'maskable'),
    'a maskable icon is declared'
  )

  for (const icon of manifest.icons ?? []) {
    const path = join(PUBLIC, icon.src)
    const png = existsSync(path) ? readPng(path) : null
    if (!png) {
      ok(false, `${icon.src} is a real PNG`, existsSync(path) ? 'bad signature' : 'missing')
      continue
    }
    const [w, h] = icon.sizes.split('x').map(Number)
    ok(png.width === w && png.height === h, `${icon.src} is ${icon.sizes}`, `${png.width}x${png.height}`)
  }
}

/* ------------------------------------------------------------ apple icon */

console.log('\napple-touch-icon')

const applePath = join(PUBLIC, 'icons', 'apple-touch-icon.png')
const apple = existsSync(applePath) ? readPng(applePath) : null
ok(apple !== null, 'icons/apple-touch-icon.png is a real PNG')
if (apple) {
  ok(apple.width === 180 && apple.height === 180, 'is 180x180', `${apple.width}x${apple.height}`)
  // The reason this file is drawn with `bleed: true`. Compare against a fresh
  // draw rather than decoding the PNG: same generator, same bytes, and a
  // mismatch also catches an icon edited by hand or left stale after a
  // change to icon-lib.mjs.
  ok(apple.bytes.equals(drawIcon(180, 0.02, { bleed: true })), 'is the full-bleed opaque draw (iOS composites alpha over white)')
}

console.log('\nicons match the generator')
for (const [name, bytes] of [
  ['icon-192.png', drawIcon(192, 0.02)],
  ['icon-512.png', drawIcon(512, 0.02)],
  ['icon-512-maskable.png', drawIcon(512, 0.2)]
]) {
  const path = join(PUBLIC, 'icons', name)
  ok(existsSync(path) && readFileSync(path).equals(bytes), `${name} is current`, 'run node scripts/mobile-icons.mjs')
}

/* ------------------------------------------------------------ index.html */

console.log('\nindex.html')

const html = readFileSync(join(ROOT, 'mobile', 'index.html'), 'utf8')
ok(/<link[^>]+rel="manifest"[^>]+href="\.\/manifest\.webmanifest"/.test(html), 'links the manifest')
ok(/<link[^>]+rel="apple-touch-icon"/.test(html), 'links an apple-touch-icon')
// Safari before 16.4 reads only this; it is what makes the icon open without
// browser chrome on every iPhone still in the wild.
ok(/name="apple-mobile-web-app-capable"[^>]+content="yes"/.test(html), 'apple-mobile-web-app-capable')
ok(/name="mobile-web-app-capable"[^>]+content="yes"/.test(html), 'mobile-web-app-capable')
// `black-translucent` is required for the layout to be correct, not for looks:
// the app pads itself with env(safe-area-inset-top), and any other value makes
// iOS reserve the strip as well, padding the top bar twice.
ok(
  /name="apple-mobile-web-app-status-bar-style"[^>]+content="black-translucent"/.test(html),
  'status bar is black-translucent (the app owns its own top inset)'
)
ok(/viewport-fit=cover/.test(html), 'viewport-fit=cover survives')

/* ------------------------------------------------- the worker, driven */

console.log('\nservice worker')

const swPath = join(PUBLIC, 'sw.js')
ok(existsSync(swPath), 'mobile/public/sw.js exists')

/** The smallest CacheStorage that the worker cannot tell from the real one. */
function fakeCaches() {
  const stores = new Map()
  const open = async (name) => {
    if (!stores.has(name)) stores.set(name, new Map())
    const store = stores.get(name)
    return {
      match: async (req) => {
        const hit = store.get(typeof req === 'string' ? req : req.url)
        return hit ? hit.clone() : undefined
      },
      put: async (req, res) => {
        store.set(typeof req === 'string' ? req : req.url, res)
      }
    }
  }
  return {
    open,
    keys: async () => [...stores.keys()],
    delete: async (name) => stores.delete(name),
    stores
  }
}

const ORIGIN = 'https://desk.example.ts.net'
const SCOPE = `${ORIGIN}/`

/**
 * Load sw.js the way a browser would: a classic script over a global that this
 * script controls, so the handlers can be called directly afterwards.
 */
function loadWorker(fetchImpl) {
  const listeners = new Map()
  const self = {
    location: { href: `${SCOPE}sw.js?v=9.9.9`, origin: ORIGIN },
    registration: { scope: SCOPE },
    addEventListener: (type, fn) => listeners.set(type, fn),
    skipWaiting: () => {},
    clients: { claim: async () => {} }
  }
  const caches = fakeCaches()
  const source = readFileSync(swPath, 'utf8')
  // eslint-disable-next-line no-new-func
  const run = new Function('self', 'caches', 'fetch', 'URL', 'Request', 'Response', source)
  run(self, caches, fetchImpl, URL, Request, Response)
  return { listeners, caches, self }
}

/** Drive one fetch event and report what the worker did with it. */
async function drive(worker, request) {
  let responded = null
  const handler = worker.listeners.get('fetch')
  handler({ request, respondWith: (p) => (responded = p) })
  if (responded === null) return { handled: false, response: null }
  return { handled: true, response: await responded }
}

const HTML = { 'content-type': 'text/html; charset=utf-8' }
const JS = { 'content-type': 'text/javascript; charset=utf-8' }

{
  // The whole point. A hashed asset the desktop no longer has comes back as
  // index.html with a 200, and it must not be written into the cache.
  const worker = loadWorker(async () => new Response('<!doctype html><html></html>', { status: 200, headers: HTML }))
  const url = `${SCOPE}assets/index-DEADBEEF.js`
  const out = await drive(worker, new Request(url))
  ok(out.handled, 'a hashed asset is handled by the worker')
  const store = [...worker.caches.stores.values()][0]
  ok(!store || !store.has(url), 'the SPA fallback is NOT cached as an asset', 'a poisoned cache white-screens the app for good')
}

{
  // A real asset is cached, and served from the cache next time even when the
  // network has since gone away.
  let calls = 0
  const worker = loadWorker(async () => {
    calls++
    if (calls > 1) throw new Error('offline')
    return new Response('export default 1', { status: 200, headers: JS })
  })
  const url = `${SCOPE}assets/index-CAFE.js`
  const first = await drive(worker, new Request(url))
  ok(first.response && first.response.status === 200, 'a real asset is fetched')
  const second = await drive(worker, new Request(url))
  ok(second.response && (await second.response.text()) === 'export default 1', 'and served from cache when offline')
  ok(calls === 1, 'without touching the network again', `${calls} fetches`)
}

{
  // The navigation: network wins while there is one, cache stands in when the
  // tunnel drops. This is what replaces Safari's offline page.
  let online = true
  const worker = loadWorker(async () => {
    if (!online) throw new Error('offline')
    return new Response('<!doctype html><title>Forge</title>', { status: 200, headers: HTML })
  })
  const nav = () => new Request(SCOPE, { headers: { accept: 'text/html' } })
  const req = nav()
  Object.defineProperty(req, 'mode', { value: 'navigate' })
  const first = await drive(worker, req)
  ok(first.handled && first.response.status === 200, 'a navigation is handled')

  online = false
  const req2 = nav()
  Object.defineProperty(req2, 'mode', { value: 'navigate' })
  const second = await drive(worker, req2)
  ok(second.response && (await second.response.text()).includes('Forge'), 'the shell is served offline')
}

{
  // Everything the worker must keep its hands off.
  const worker = loadWorker(async () => new Response('nope'))
  const post = await drive(worker, new Request(`${SCOPE}assets/x.js`, { method: 'POST' }))
  ok(!post.handled, 'a non-GET is left alone')
  const cross = await drive(worker, new Request('https://example.com/assets/x.js'))
  ok(!cross.handled, 'a cross-origin request is left alone')
  const api = await drive(worker, new Request(`${SCOPE}something/else`))
  ok(!api.handled, 'an unrecognised same-origin path is left alone')
}

{
  // The cache name is stamped from the `?v=` on the registration URL, and every
  // older Forge cache is dropped on activate — otherwise a phone accumulates a
  // cache per release and keeps serving whichever it finds first.
  const worker = loadWorker(async () => new Response('x'))
  const store = await worker.caches.open('forge-mobile-0.0.1')
  await store.put('stale', new Response('stale'))
  await drive(worker, new Request(`${SCOPE}assets/a.js`))
  const activate = worker.listeners.get('activate')
  let waited = null
  activate({ waitUntil: (p) => (waited = p) })
  await waited
  const names = await worker.caches.keys()
  ok(names.includes('forge-mobile-9.9.9'), 'the cache is named from ?v=', names.join(', '))
  ok(!names.includes('forge-mobile-0.0.1'), 'an older release cache is dropped', names.join(', '))
}

/* ------------------------------------------------------------ the bundle */

console.log('\nbuilt bundle')
if (!existsSync(DIST)) {
  console.log('  – mobile/dist not built; run npm run mobile:build to check it')
} else {
  for (const rel of ['manifest.webmanifest', 'sw.js', 'icons/apple-touch-icon.png', 'icons/icon-192.png']) {
    ok(existsSync(join(DIST, rel)), `dist/${rel} was copied`)
  }
  const built = readFileSync(join(DIST, 'index.html'), 'utf8')
  ok(/rel="manifest"/.test(built), 'dist/index.html links the manifest')
}

/* ------------------------------------------------------------------ done */

console.log(`\n${fail === 0 ? 'ok' : 'FAILED'} — ${pass} passed, ${fail} failed\n`)
process.exit(fail === 0 ? 0 : 1)
