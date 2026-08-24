import { useEffect, useRef, useState } from 'react'

/**
 * "A newer Forge Web has been deployed — reload to run it."
 *
 * This client has no service worker, so there is nothing to install and
 * nothing to skip-wait: Firebase serves `index.html` with `no-cache`, and a
 * reload fetches the new bundle by its new hashed name. What was missing was
 * the *telling* — a tab left open on a phone went on running the old bundle
 * for days, and the only way to learn a push had landed was to clear the site.
 *
 * So the page asks. `/version.json` is written beside the bundle by the build
 * (web/vite.config.ts) and carries the same id that was stamped into this
 * bundle as `__WEB_BUILD_ID__`. When the two disagree, a newer build is live
 * and `available` flips; the banner that reads it (UpdateBanner) offers the
 * reload. Nothing is applied behind the user's back — a reload mid-keystroke
 * in a terminal would be worse than being a build behind.
 *
 * Dismissal is per *deploy*, the desktop UpdateBanner's per-version rule one
 * shade finer: the remembered id is a build id, so declining one deploy of
 * 0.3.1 does not silence the next one, and `dismiss` is remembered in
 * `localStorage` beside the session and the snapshot, so a phone that said
 * not-now stays said.
 *
 * Same cadence as the desktop's source-updater: a first look once the page has
 * settled, a look whenever the tab comes back into view (the moment you look
 * is the moment it should know), and every few minutes in between.
 */

const FIRST_CHECK_DELAY_MS = 15_000
const RECHECK_EVERY_MS = 5 * 60 * 1000
const FOCUS_CHECK_MIN_GAP_MS = 30_000

/** Where "not now" is remembered. Holds one build id, or nothing. */
const DISMISSED_KEY = 'forge-web-update-dismissed'

async function latestBuild(): Promise<{ build: string; version: string } | null> {
  try {
    const res = await fetch(`/version.json?t=${Date.now()}`, { cache: 'no-store' })
    if (!res.ok) return null
    const body = (await res.json()) as { build?: unknown; version?: unknown }
    if (typeof body.build !== 'string') return null
    return { build: body.build, version: typeof body.version === 'string' ? body.version : '' }
  } catch {
    return null
  }
}

/** What `useWebUpdate` hands back, named so the banner can take it whole. */
export type WebUpdate = {
  available: boolean
  /** The app version of the deployed build, when version.json deigned to say. */
  version: string
  apply: () => void
  dismiss: () => void
}

export function useWebUpdate(): WebUpdate {
  const [available, setAvailable] = useState(false)
  const [version, setVersion] = useState('')
  // The newest deploy this page has heard of, so a dismissal can name the
  // build it is declining rather than only the moment it declined.
  const latest = useRef<{ build: string; version: string } | null>(null)

  useEffect(() => {
    // `?fake-update` — the web twin of the desktop's FORGE_FAKE_UPDATE: a way
    // to look at the banner on a build that has nothing to offer. Works in a
    // dev server too, which never polls, so the banner can be styled in place.
    if (new URLSearchParams(window.location.search).has('fake-update')) {
      setAvailable(true)
      setVersion('9.9.9')
      return
    }
    if (__DEV_SERVER__) return
    let stopped = false
    let lastAt = 0

    const check = async (): Promise<void> => {
      lastAt = Date.now()
      const found = await latestBuild()
      if (stopped || !found) return
      latest.current = found
      if (found.build !== __WEB_BUILD_ID__ && found.build !== localStorage.getItem(DISMISSED_KEY)) {
        setVersion(found.version)
        setAvailable(true)
      }
    }
    const onVisible = (): void => {
      if (document.visibilityState !== 'visible') return
      if (Date.now() - lastAt < FOCUS_CHECK_MIN_GAP_MS) return
      void check()
    }

    const first = setTimeout(() => void check(), FIRST_CHECK_DELAY_MS)
    const timer = setInterval(() => void check(), RECHECK_EVERY_MS)
    document.addEventListener('visibilitychange', onVisible)
    window.addEventListener('focus', onVisible)
    return () => {
      stopped = true
      clearTimeout(first)
      clearInterval(timer)
      document.removeEventListener('visibilitychange', onVisible)
      window.removeEventListener('focus', onVisible)
    }
  }, [])

  return {
    available,
    version,
    apply: () => {
      // `no-cache` on index.html means a plain reload revalidates it and
      // follows the new bundle names. Clearing the Cache Storage first is
      // belt-and-braces for a browser that installed this as a PWA and kept
      // a copy anyway.
      const go = (): void => window.location.reload()
      if (typeof caches === 'undefined') return go()
      caches
        .keys()
        .then((keys) => Promise.all(keys.map((k) => caches.delete(k))))
        .then(go, go)
    },
    dismiss: () => {
      if (latest.current) localStorage.setItem(DISMISSED_KEY, latest.current.build)
      setAvailable(false)
    }
  }
}
