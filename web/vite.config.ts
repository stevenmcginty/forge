import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

/**
 * The Forge Web bundle — the browser client.
 *
 * A third Vite build in the same package, for the same reason mobile/ is a
 * second one: the browser compiles against `@shared/*` — the very files the
 * desktop and `electron/web/server.ts` compile against — rather than a
 * hand-mirrored copy. `companion/web` has no build step and hand-mirrors its
 * protocol, and its drift is the known gap this arrangement exists to avoid.
 *
 * It also aliases `@` to the desktop renderer's `src/`, which mobile does not.
 * That is decision 4 in docs/forge-web.md: this client wears the desktop's face,
 * so it imports the desktop's design tokens and its Electron-free presentational
 * components instead of drawing a second Forge that looks nearly the same.
 * Nothing under `src/` is modified to make that work — a component that reaches
 * for `window.forge` simply is not one of the ones imported.
 *
 * Output goes to `web/dist`, which is deployed to Firebase Hosting (decision
 * 12). Nothing here is packaged into Forge-setup.exe: electron-builder.yml ships
 * `out/**` and nothing else.
 */

const pkg = JSON.parse(readFileSync(resolve(import.meta.dirname, '..', 'package.json'), 'utf8')) as {
  version: string
}

export default defineConfig(({ command }) => ({
  define: {
    /**
     * The build this bundle is, sent in `hello.client` and shown in the
     * desktop's device list. Stamped from the root package.json so the browser
     * and the desktop cannot disagree about which Forge released it.
     */
    __WEB_CLIENT_VERSION__: JSON.stringify(process.env.FORGE_WEB_VERSION ?? pkg.version),
    /**
     * True only when Vite is *serving* — `npm run web:dev` — and false in every
     * artefact `vite build` produces. It is the one gate on the loopback
     * WebSocket address (see `devLoopbackHost` in web/src/config.ts).
     *
     * `command` and not `import.meta.env.DEV`, and the difference is the whole
     * point. Vite derives `DEV`/`PROD` from `process.env.NODE_ENV`, so a build
     * run in a shell that happens to export `NODE_ENV=development` — which is
     * not hypothetical; it is how this repo's own dev tooling leaves the
     * environment — stamps `DEV === true` into a production bundle and ships a
     * client that will dial `ws://` at a loopback address. `command` comes from
     * which Vite subcommand ran and nothing ambient can flip it.
     */
    __DEV_SERVER__: JSON.stringify(command === 'serve')
  },
  root: resolve(import.meta.dirname),
  // Absolute, unlike mobile's './'. Firebase Hosting serves this from the root
  // of a domain and rewrites every unknown path to index.html, so a relative
  // base would break the moment somebody deep-linked.
  base: '/',
  plugins: [react()],
  resolve: {
    alias: {
      '@shared': resolve(import.meta.dirname, '..', 'shared'),
      '@': resolve(import.meta.dirname, '..', 'src')
    }
  },
  server: {
    // 5174 rather than Vite's 5173, which any project opened in Forge is liable
    // to be using. (The desktop renderer is on 5273+ for the same reason — see
    // scripts/dev.mjs.) A desktop that wants to serve this dev loop has to
    // name `http://localhost:5174` in its allowed origins — see `originAllowed`
    // in electron/web/server.ts.
    port: 5174,
    strictPort: true
  },
  build: {
    outDir: resolve(import.meta.dirname, 'dist'),
    emptyOutDir: true,
    target: 'es2022',
    // A public URL with no devtools attached and one user: the sourcemap is
    // worth far more than the bytes, exactly as it is for mobile.
    sourcemap: true
  }
}))
