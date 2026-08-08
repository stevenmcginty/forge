/**
 * Forge Mobile's service worker: cache the shell, never the link.
 *
 * The only reason this file exists is iOS. Android has the APK, which carries
 * its own assets and updates itself; an iPhone gets the same bundle as a
 * home-screen web app, and without a worker it shows Safari's offline page the
 * moment the tunnel blinks — instead of the app it already has, saying
 * "reconnecting". Everything below follows from that one job.
 *
 * ## What it is allowed to touch
 *
 * Same-origin GETs only, and only three shapes:
 *
 *   the navigation      network-first, so a rebuilt bundle is picked up on the
 *                       next launch rather than a launch after that
 *   /assets/*           cache-first — Vite content-hashes these, so a name that
 *                       is already cached can never be the wrong bytes
 *   icons + manifest    stale-while-revalidate; they change once a year
 *
 * Everything else falls straight through to the network. The WebSocket at
 * MOBILE_WS_PATH never reaches a worker at all (workers do not see upgrades),
 * which is the one thing that absolutely must not be interfered with.
 *
 * ## The SPA-fallback trap
 *
 * `electron/mobile/server.ts` answers *any* unknown path with index.html and a
 * 200. So a request for an asset the desktop no longer has does not 404 — it
 * returns HTML, and a naive worker would cache that HTML under a `.js` URL and
 * white-screen the app on every subsequent launch, permanently, with no way for
 * the user to tell why. `cacheable()` therefore refuses to store an HTML body
 * against a non-navigation request. This is the single most important rule in
 * the file.
 *
 * ## Versioning
 *
 * No build step writes a precache list here: the file is served verbatim out of
 * `mobile/public`, and the bundle's own hashed filenames are the cache keys. The
 * cache *name* comes from the `?v=` on the registration URL (see
 * mobile/src/lib/pwa.ts), which is stamped from mobile/version.json. Bumping the
 * version changes the registration URL, which is what makes the browser re-fetch
 * this file at all, and changes the cache name, which drops everything the old
 * build left behind.
 */

const VERSION = new URL(self.location.href).searchParams.get('v') || 'dev'
const CACHE = `forge-mobile-${VERSION}`

/** The document itself, however it was requested. */
function isNavigation(request) {
  return request.mode === 'navigate' || request.destination === 'document'
}

/** Hashed build output: the name is the content, so cached is always correct. */
function isHashedAsset(url) {
  return url.pathname.includes('/assets/')
}

/** Small, stable, and worth having offline: the icons and the manifest. */
function isShell(url) {
  return url.pathname.includes('/icons/') || url.pathname.endsWith('.webmanifest')
}

/**
 * Is this response safe to keep?
 *
 * `res.ok` is not enough — see the SPA-fallback note above. HTML is only ever
 * stored for a navigation; anything else claiming to be HTML is the fallback
 * page wearing an asset's URL, and caching it is how the app breaks for good.
 */
function cacheable(request, res) {
  if (!res || !res.ok || res.type === 'opaque') return false
  const type = res.headers.get('content-type') || ''
  if (type.includes('text/html') && !isNavigation(request)) return false
  return true
}

self.addEventListener('install', () => {
  // Nothing is precached. The desktop may be unreachable at the moment the
  // worker installs, and an `addAll` that rejects would abort the install and
  // leave the app with no worker at all — worse than an empty cache that fills
  // itself on the very next launch.
  self.skipWaiting()
})

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('forge-mobile-') && k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  )
})

self.addEventListener('fetch', (e) => {
  const request = e.request
  if (request.method !== 'GET') return

  const url = new URL(request.url)
  if (url.origin !== self.location.origin) return

  if (isNavigation(request)) {
    e.respondWith(networkFirst(request))
    return
  }
  if (isHashedAsset(url)) {
    e.respondWith(cacheFirst(request))
    return
  }
  if (isShell(url)) {
    e.respondWith(staleWhileRevalidate(request))
  }
  // Anything else: no respondWith, so the browser handles it as normal.
})

/**
 * The document. Network wins when there is one, because the desktop is the
 * source of truth for which bundle is current; the cache is what stands in when
 * the phone is on a train.
 */
async function networkFirst(request) {
  const cache = await caches.open(CACHE)
  try {
    const res = await fetch(request)
    if (cacheable(request, res)) cache.put(request, res.clone())
    return res
  } catch {
    // Match on the scope root as well as the exact request: a launch from the
    // home screen and a launch from a `?pair=` link are different URLs and
    // must not each need their own cached copy.
    const cached = (await cache.match(request)) || (await cache.match(new URL('./', self.registration.scope).href))
    if (cached) return cached
    throw new Error('offline and nothing cached')
  }
}

/** Content-hashed: if it is in the cache under that name, it is right. */
async function cacheFirst(request) {
  const cache = await caches.open(CACHE)
  const cached = await cache.match(request)
  if (cached) return cached
  const res = await fetch(request)
  if (cacheable(request, res)) cache.put(request, res.clone())
  return res
}

/** Serve what we have, refresh behind it. */
async function staleWhileRevalidate(request) {
  const cache = await caches.open(CACHE)
  const cached = await cache.match(request)
  const fresh = fetch(request)
    .then((res) => {
      if (cacheable(request, res)) cache.put(request, res.clone())
      return res
    })
    .catch(() => cached)
  return cached || fresh
}
