/**
 * The Capacitor shell around Forge Mobile.
 *
 * A `.js` file, not `.ts`, and not by preference: this repo is on
 * TypeScript 7, whose native compiler no longer ships the JS API
 * (`ts.transpileModule` / `ts.ModuleKind`) that Capacitor's CLI uses to load
 * a `capacitor.config.ts`. The CLI loads `.js` with a plain `require`, so
 * this file keeps working no matter what the TypeScript package looks like;
 * the JSDoc type below keeps the editor honest.
 *
 * The web app is unchanged — same bundle, same `mobile/dist` the desktop
 * serves to phone Chrome. Capacitor only wraps it in a WebView so it can be
 * installed, keep its token in app-private storage, and update itself. Two
 * networking decisions here are load-bearing:
 *
 *  - **`androidScheme: 'https'`.** The WebView serves the bundle from an
 *    `https://localhost` origin, which makes it a *secure context*. That
 *    retires a whole class of bug this app has already met once: secure-only
 *    APIs (`crypto.randomUUID` being the documented casualty — see the long
 *    comment in src/lib/link.ts) are simply `undefined` on a plain-http
 *    origin, and fail at runtime on the phone only.
 *
 *  - **`cleartext: true` + `allowMixedContent: true`.** The LAN route is
 *    still `ws://192.168.x.x:8420` — no certificate on the desktop, none
 *    coming. From an https origin that socket is both *mixed content* (the
 *    WebView blocks it) and *cleartext* (Android's network policy blocks it,
 *    separately, on targetSdk 28+ via `usesCleartextTraffic` in the
 *    manifest, which apk-init patches in). Both gates have to open or the
 *    app installs fine and then silently cannot reach the desk. The remote
 *    route is `wss://` through a tunnel or Tailscale and is unaffected by
 *    either flag.
 */

/** @type {import('@capacitor/cli').CapacitorConfig} */
const config = {
  appId: 'com.forge.mobile',
  appName: 'Forge',
  webDir: 'dist',
  server: {
    androidScheme: 'https',
    cleartext: true
  },
  android: {
    allowMixedContent: true
  }
}

module.exports = config
