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
    )
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
    outDir: resolve(import.meta.dirname, 'dist'),
    emptyOutDir: true,
    target: 'es2022',
    // The desktop serves this over a home network to one phone; a sourcemap is
    // worth far more than the bytes cost when something misbehaves on a device
    // that has no devtools attached.
    sourcemap: true
  }
})
