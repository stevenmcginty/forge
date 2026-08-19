import { Capacitor } from '@capacitor/core'
import { simDevice } from './sim'

/**
 * The home-screen route: the same bundle the APK wraps and phone Chrome loads,
 * installed on an iPhone as a web app.
 *
 * This exists because there is no Forge iOS app and there is not going to be
 * one. Everything the APK gives an Android phone — an icon, its own window, a
 * token that survives a browser tidy-up — an installed PWA gives an iPhone, and
 * the app code needed almost none of it: `secure.ts`, `scan.ts` and `update.ts`
 * already branch on `Capacitor.isNativePlatform()` and already have a browser
 * fallback, because the browser route has been shipping since Phase 1.
 *
 * ## The one hard requirement: a secure context
 *
 * Over plain `http://192.168.x.x:8420` an iPhone gets *none* of this. Service
 * workers are unavailable, `crypto.randomUUID` is `undefined` (the bug link.ts
 * documents at length), and `getUserMedia` will not start. So the PWA route is
 * an HTTPS route or it is nothing — Tailscale Serve, a named Cloudflare tunnel,
 * or ngrok. See docs/MOBILE.md; the desktop needs no change, because the tunnel
 * dials it from loopback and `isAllowedSource` already passes 100.64.0.0/10.
 *
 * ## Not in the APK
 *
 * `register()` refuses on a native platform, and unregisters anything it finds.
 * Capacitor serves the WebView from `https://localhost`, which *is* a secure
 * context, so a worker would install happily and then quietly fight
 * ForgeUpdaterPlugin: the native updater replaces the assets on disk and the
 * worker goes on serving the previous build out of its cache. An update that
 * installs and changes nothing is the worst bug this app could ship.
 */

/** Stamped into the registration URL so a version bump re-fetches the worker. */
const VERSION = __APK_VERSION_NAME__

/**
 * True when the app is running in its own window rather than a browser tab —
 * an installed PWA, or the APK.
 *
 * Two checks because iOS predates the standard one: Safari has only supported
 * `display-mode: standalone` since 16.4, and `navigator.standalone` is the
 * non-standard property that has meant this on iOS for fifteen years.
 */
export function isStandalone(): boolean {
  if (Capacitor.isNativePlatform()) return true
  const legacy = (navigator as Navigator & { standalone?: boolean }).standalone === true
  return legacy || window.matchMedia('(display-mode: standalone)').matches
}

/**
 * An iPhone or iPad, as far as this app needs to care.
 *
 * iPadOS reports itself as a Mac and has done since 13, so the touch-points
 * check is not paranoia — without it every iPad falls through to the desktop
 * branch and is never told how to install. Nothing security-relevant hangs off
 * this; it decides which sentence appears on the pairing screen.
 *
 * The desk's preview answers first (lib/sim.ts): a desktop frame has a desktop
 * UA no matter which phone it is playing, and the sentence is the point there.
 */
export function isIos(): boolean {
  const sim = simDevice()
  if (sim) return sim === 'ios'
  if (/iPhone|iPad|iPod/i.test(navigator.userAgent)) return true
  return navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1
}

/**
 * Should the pairing screen explain Add to Home Screen?
 *
 * Only on an iPhone, only in a browser tab, and only over HTTPS — an insecure
 * origin can be added to the home screen but comes back a half-broken app, so
 * pointing someone at it would be worse than staying quiet.
 */
export function shouldOfferInstall(): boolean {
  return isIos() && !isStandalone() && window.isSecureContext
}

/**
 * The desktop's own address, when the page was served by it.
 *
 * The browser and PWA routes load this bundle *from* `MobileServer.serveStatic`,
 * so the address the pairing form asks for is already in the address bar —
 * `http://192.168.1.10:8420` on the LAN, `https://<machine>.<tailnet>.ts.net`
 * through a tunnel. Prefilling it turns pairing into pasting one code instead of
 * transcribing a hostname on a phone keyboard, which is the step people get
 * wrong. `toOrigin` still normalises whatever comes out of here; this is a
 * suggestion, not a shortcut past the parsing.
 *
 * Empty in the APK, which loads from Capacitor's `https://localhost` — that is
 * the WebView talking about itself, and prefilling it would send the phone
 * dialling its own loopback and time out with no clue why. Empty for a Vite dev
 * server too (`:5175` serves the bundle but no socket).
 */
export function servedFromOrigin(): string {
  if (Capacitor.isNativePlatform()) return ''
  const { protocol, hostname, host } = window.location
  if (!/^https?:$/.test(protocol)) return ''
  if (hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1') return ''
  if (import.meta.env.DEV) return ''
  return `${protocol}//${host}`
}

/**
 * Register the worker, or undo one that should not be there.
 *
 * Deliberately impossible to fail loudly: this runs before the first paint and
 * nothing about the app requires a worker to work. A rejected registration
 * (insecure origin, a `sw.js` the desktop answered with index.html because the
 * bundle predates this file) means no offline shell, and nothing else.
 */
export async function registerServiceWorker(): Promise<void> {
  if (!('serviceWorker' in navigator)) return

  if (Capacitor.isNativePlatform()) {
    // Belt and braces: a worker cached inside the WebView from an earlier build
    // would outlive the update that removed this call.
    try {
      const existing = await navigator.serviceWorker.getRegistrations()
      await Promise.all(existing.map((r) => r.unregister()))
    } catch {
      /* nothing registered, or the WebView refused to say — either is fine */
    }
    return
  }

  if (!window.isSecureContext) return

  try {
    // `?v=` is what makes the browser re-fetch this file: it byte-compares the
    // worker at the *same URL* and would otherwise keep the old one for a day.
    // `updateViaCache: 'none'` stops the HTTP cache from answering that check.
    await navigator.serviceWorker.register(`./sw.js?v=${encodeURIComponent(VERSION)}`, {
      scope: './',
      updateViaCache: 'none'
    })
  } catch {
    /* see above: no worker is a degraded app, not a broken one */
  }
}
