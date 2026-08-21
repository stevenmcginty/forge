import { useEffect, useState } from 'react'

/**
 * "A newer Forge Web has been deployed — press to get it."
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
 * and `available` flips; the button that reads it reloads. Nothing is applied
 * behind the user's back — a reload mid-keystroke in a terminal would be worse
 * than being a build behind.
 *
 * Same cadence as the desktop's source-updater: a first look once the page has
 * settled, a look whenever the tab comes back into view (the moment you look
 * is the moment it should know), and every few minutes in between.
 */

const FIRST_CHECK_DELAY_MS = 15_000
const RECHECK_EVERY_MS = 5 * 60 * 1000
const FOCUS_CHECK_MIN_GAP_MS = 30_000

async function latestBuild(): Promise<string | null> {
  try {
    const res = await fetch(`/version.json?t=${Date.now()}`, { cache: 'no-store' })
    if (!res.ok) return null
    const body = (await res.json()) as { build?: unknown }
    return typeof body.build === 'string' ? body.build : null
  } catch {
    return null
  }
}

export function useWebUpdate(): { available: boolean; apply: () => void } {
  const [available, setAvailable] = useState(false)

  useEffect(() => {
    if (__DEV_SERVER__) return
    let stopped = false
    let lastAt = 0

    const check = async (): Promise<void> => {
      lastAt = Date.now()
      const build = await latestBuild()
      if (stopped || !build) return
      if (build !== __WEB_BUILD_ID__) setAvailable(true)
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
    }
  }
}
