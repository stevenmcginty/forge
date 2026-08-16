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
