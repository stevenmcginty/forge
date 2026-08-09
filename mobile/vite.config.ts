import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

/**
 * The Forge Mobile bundle.
 *
 * A second Vite build in the same package rather than a separate project, so
 * the phone imports `@shared/*` — the very files the desktop compiles against —
 * instead of a hand-mirrored copy. That is the one thing `companion/web` cannot
 * do (no build step), and the reason its protocol drift is a known gap.
 *
 * Output goes to `mobile/dist`, which `electron/mobile/server.ts` serves as its
 * `webRoot`. Nothing here is packaged into Forge-setup.exe — see the `files`
 * list in electron-builder.yml, which ships `out/**` and nothing else.
 */

/**
 * The APK's idea of its own version, baked in at build time so the web bundle
 * and the native `versionCode`/`versionName` in mobile/android cannot drift —
 * both are stamped from mobile/version.json by scripts/apk-build.mjs, which
 * also sets the FORGE_APK_* env overrides so a bump lands in the very build
 * that follows it. A drift here is the worst kind of update bug: an app that
 * compares the *wrong* number against the manifest either nags forever or
 * never notices a release.
 *
 * The manifest URL is a define too, so apk-check (and any future staging
 * feed) can point a build somewhere else without touching source.
 */
const version = JSON.parse(readFileSync(resolve(import.meta.dirname, 'version.json'), 'utf8')) as {
  versionCode: number
  versionName: string
}

export default defineConfig({
  define: {
    __APK_VERSION_CODE__: JSON.stringify(Number(process.env.FORGE_APK_VERSION_CODE ?? version.versionCode)),
    __APK_VERSION_NAME__: JSON.stringify(process.env.FORGE_APK_VERSION_NAME ?? version.versionName),
    __APK_MANIFEST_URL__: JSON.stringify(
      process.env.FORGE_APK_MANIFEST_URL ??
        'https://github.com/stevenmcginty/forge-mobile-releases/releases/latest/download/latest.json'
    ),
    // The desktop this APK belongs to, stamped by scripts/apk-build.mjs as a
    // `wss://<domain>` origin with **no port** — the tunnel answers on the
    // implicit 443, and a port here becomes an address nothing listens on
    // (the exact bug toOrigin in src/lib/secure.ts documents). Empty in every
    // other build on purpose: the browser route is already *at* the desktop,
    // and an unstamped APK still pairs by QR or typing. Nothing outside
    // apk-build sets the env, so nothing else can bake an address by accident.
    __BAKED_ORIGIN__: JSON.stringify(process.env.FORGE_BAKED_ORIGIN ?? ''),
    // The one seam that turns this bundle into the TV app. Set by
    // scripts/apk-tv-build.mjs and by nothing else, so the browser route and
    // the phone APK compile the TV branches away entirely rather than carrying
    // a dashboard a phone can never usefully show. `=== '1'` rather than a
    // truthiness test: an env var that happens to exist must not flip it.
    __FORGE_TV__: JSON.stringify(process.env.FORGE_TV === '1')
  },
  root: resolve(import.meta.dirname),
  base: './',
  plugins: [react()],
  resolve: {
    alias: {
      '@shared': resolve(import.meta.dirname, '..', 'shared')
    }
  },
  server: {
    // A phone on the same wifi has to be able to reach `npm run mobile:dev`.
    host: true,
    port: 5175
  },
  build: {
    // A TV build writes somewhere else entirely. `mobile/dist` is not only the
    // APK's payload — electron/mobile/server.ts serves it to any browser
    // pointed at the desktop — so a TV bundle landing there would hand a phone
    // an app that draws the television dashboard and dials one hard-coded
    // address. Two directories is what makes that impossible rather than
    // something a build script has to remember to undo afterwards.
    // mobile/capacitor.config.js reads the same env var to match.
    outDir: resolve(import.meta.dirname, process.env.FORGE_TV === '1' ? 'dist-tv' : 'dist'),
    emptyOutDir: true,
    target: 'es2022',
    // The desktop serves this over a home network to one phone; a sourcemap is
    // worth far more than the bytes cost when something misbehaves on a device
    // that has no devtools attached.
    sourcemap: true
  }
})
