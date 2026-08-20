import { resolve } from 'node:path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'

const r = (p: string) => resolve(__dirname, p)

const sharedAlias = {
  '@shared': r('shared')
}

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    resolve: { alias: sharedAlias },
    build: {
      rollupOptions: {
        input: { index: r('electron/main.ts') }
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    resolve: { alias: sharedAlias },
    build: {
      rollupOptions: {
        input: { index: r('electron/preload.ts') }
      }
    }
  },
  renderer: {
    root: '.',
    plugins: [
      react(),
      {
        // index.html ships the loose CSP the dev server needs: Vite's dev
        // pipeline injects inline scripts and HMR relies on eval, so
        // script-src carries 'unsafe-inline' and 'unsafe-eval' there. The
        // production build loads none of that — it emits plain module chunks
        // from 'self' (the WebGL xterm addon is a bundled dynamic import, not
        // a remote script) — so both flags are stripped on the way out and an
        // injected script in the renderer has no way to execute. Everything
        // else in the policy is untouched: style-src keeps 'unsafe-inline'
        // because React sets element style attributes, and connect-src stays
        // as written because the renderer talks to services over IPC, not
        // fetch. If index.html's policy ever drifts, this fails the build
        // loudly rather than silently shipping the loose one.
        name: 'tighten-csp-for-production',
        apply: 'build',
        transformIndexHtml(html) {
          const loose = "script-src 'self' 'unsafe-inline' 'unsafe-eval'"
          if (!html.includes(loose)) {
            throw new Error(
              `[tighten-csp-for-production] index.html no longer contains "${loose}" — update the CSP or this plugin, do not ship the loose policy by accident`
            )
          }
          return html.replace(loose, "script-src 'self'")
        }
      }
    ],
    server: {
      /**
       * Where the renderer's dev server listens — a fixed address, an
       * uncommon port, and no room for either to drift.
       *
       * This is the fix for Forge opening with somebody else's app inside it.
       * `localhost` has two addresses on Windows, 127.0.0.1 and ::1, and two
       * dev servers can therefore both "have port 5173" without either seeing
       * a collision: Forge's Vite took 127.0.0.1:5173, a project opened in
       * Forge took ::1:5173. Chromium resolves `localhost` IPv6-first, so the
       * desktop window loaded the project — a complete, working app in Forge's
       * own frame, with no way through to Forge.
       *
       * Binding 127.0.0.1 explicitly is what closes that: electron-vite builds
       * `ELECTRON_RENDERER_URL` from this host, so the address Vite listens on
       * and the address Electron dials are the same one literal, with no name
       * resolution in between to disagree about.
       *
       * The port is pinned for a related reason. electron-vite takes the
       * *configured* port, not the one Vite bound, and Vite with `strictPort`
       * off silently steps to the next port when one is taken — so the URL can
       * point somewhere Forge never was. `strictPort` makes that a loud failure
       * instead, and scripts/dev.mjs picks a port that is free before Vite
       * starts, so the loud failure should never come up. 5273 rather than
       * 5173 because 5173 is the port every other Vite project starts from.
       */
      host: '127.0.0.1',
      port: Number(process.env['FORGE_RENDERER_PORT']) || 5273,
      strictPort: true,
      watch: {
        // The renderer's root is the repo root, so vite's watcher sees every
        // file in the tree — and a *.html landing anywhere triggers a full
        // page reload of the desktop window. mobile/APK builds write html
        // into these folders, and a reload mid-op is a phone told "the
        // desktop did not answer in time". Build outputs are not sources.
        ignored: ['**/mobile/dist/**', '**/mobile/android/**', '**/dist-apk/**', '**/.claude/**']
      }
    },
    resolve: {
      alias: {
        ...sharedAlias,
        '@': r('src')
      }
    },
    build: {
      rollupOptions: {
        input: { index: r('index.html') }
      }
    }
  }
})
