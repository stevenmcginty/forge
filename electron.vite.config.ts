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
    plugins: [react()],
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
