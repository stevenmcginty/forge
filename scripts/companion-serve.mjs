/**
 * Serve companion/web on localhost, for looking at the phone app on a desktop
 * browser (or on a real phone over the LAN) without deploying anything.
 *
 *   npm run companion:serve            # http://127.0.0.1:5055
 *   npm run companion:serve -- --port 8080
 *
 * Pair it with the emulator suite and the page will drive the emulated Firebase
 * instead of a real project — config.js accepts query overrides on localhost:
 *
 *   firebase emulators:start --only auth,database --project demo-forge-sync \
 *     --config companion/firebase.json
 *   npm run companion:serve
 *   open http://127.0.0.1:5055/?apiKey=demo-forge-sync-key
 *        &db=http://127.0.0.1:9000%3Fns%3Ddemo-forge-sync-default-rtdb
 *        &authBase=http://127.0.0.1:9099/identitytoolkit.googleapis.com/v1
 *        &tokenBase=http://127.0.0.1:9099/securetoken.googleapis.com/v1
 *
 * Deliberately dumb: no watching, no caching, no directory listing. It exists
 * so a browser can see the files, and the files are the deliverable.
 */

import { createServer } from 'node:http'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { extname, join, normalize, resolve, sep } from 'node:path'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'companion', 'web')

const portArg = process.argv.indexOf('--port')
const PORT = portArg !== -1 ? Number(process.argv[portArg + 1]) : 5055

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2'
}

createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`)
  let rel = decodeURIComponent(url.pathname)
  if (rel === '/' || rel.endsWith('/')) rel += 'index.html'

  // Path traversal is the only security concern a static server has. Normalise,
  // then require the result to still be inside the root.
  const target = normalize(join(ROOT, rel))
  if (!target.startsWith(ROOT + sep) && target !== ROOT) {
    res.writeHead(403).end('forbidden')
    return
  }
  if (!existsSync(target) || !statSync(target).isFile()) {
    res.writeHead(404, { 'Content-Type': 'text/plain' }).end('not found')
    return
  }

  res.writeHead(200, {
    'Content-Type': TYPES[extname(target).toLowerCase()] ?? 'application/octet-stream',
    'Cache-Control': 'no-store'
  })
  res.end(readFileSync(target))
}).listen(PORT, () => {
  console.log(`Forge Companion  →  http://127.0.0.1:${PORT}`)
  console.log(`serving ${ROOT}`)
})
