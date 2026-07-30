/**
 * Service worker: cache the shell, never the data.
 *
 * Stale-while-revalidate for the handful of files that make up the app, and
 * network-only for everything else. The bypass list is load-bearing rather than
 * decorative — caching a Firebase response would serve stale projects, and
 * caching an SSE stream would hang the page waiting for a body that never ends.
 *
 * Bump CACHE on every deploy. `firebase deploy` will not do it for you; see
 * companion/GO-LIVE.md, which stamps it from the git SHA the way DictationMic's
 * workflow does.
 */

const CACHE = 'forge-companion-v1'

const SHELL = [
  './',
  'index.html',
  'styles.css',
  'config.js',
  'manifest.webmanifest',
  'js/app.js',
  'js/auth.js',
  'js/rtdb.js',
  'js/outbox.js',
  'js/imgpack.js',
  'icons/icon-192.png',
  'icons/icon-512.png'
]

const SHELL_PATHS = new Set(SHELL.map((p) => new URL(p, self.registration.scope).pathname))

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches
      .open(CACHE)
      // `no-cache` on the precache fetch: without it a fresh install can
      // faithfully precache the previous deploy out of the HTTP cache, and the
      // update you just shipped never arrives.
      .then((c) => c.addAll(SHELL.map((p) => new Request(p, { cache: 'no-cache' }))))
      .then(() => self.skipWaiting())
  )
})

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  )
})

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url)
  if (
    e.request.method !== 'GET' ||
    url.hostname.endsWith('googleapis.com') ||
    url.hostname.includes('firebaseio.com') ||
    url.hostname.includes('firebasedatabase.app') ||
    !SHELL_PATHS.has(url.pathname)
  ) {
    return // network only
  }

  e.respondWith(
    caches.open(CACHE).then(async (cache) => {
      const cached = await cache.match(e.request)
      const fresh = fetch(e.request)
        .then((res) => {
          if (res.ok) cache.put(e.request, res.clone())
          return res
        })
        .catch(() => cached)
      return cached || fresh
    })
  )
})
