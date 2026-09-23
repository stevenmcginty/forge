import { readFile, realpath, stat } from 'node:fs/promises'
import { extname, join, sep } from 'node:path'
import { ARTIFACT_SCHEME } from '@shared/browser'
import { CANVAS_READ_MAX_BYTES } from './canvas-board'

/**
 * `forge-artifact://` — canvas files, served by main so an HTML artifact can
 * run its own inline script without the renderer's CSP in the way.
 *
 *   forge-artifact://<projectId>/<file>    <dataDir>/canvas/<projectId>/<file>
 *
 * The project id is the URL's host, so a page's relative links (`pic.png`,
 * even `../pic.png`) resolve inside its own project and nowhere else. The
 * Board frames these with `sandbox="allow-scripts"`; a browser tab shows them
 * in its own in-memory session (shared/browser.ts ARTIFACT_PARTITION).
 *
 * Why a scheme and not srcdoc: a srcdoc (or blob:/data:) frame inherits the
 * renderer's CSP, and the production build's is `script-src 'self'`, so every
 * inline script was refused. A document from its own URL gets the policy of
 * its own response instead — the one below, sent as a header:
 *
 *   default-src 'none'   nothing loads that is not listed
 *   script/style         inline only
 *   img/media/font       data:, blob: and this scheme — never the network
 *   connect-src 'none'   no fetch, XHR, WebSocket or beacon: nothing phones out
 *   form-action, base-uri  'none'
 *   sandbox allow-scripts  the opaque origin the Board's frame gets from its
 *                        sandbox attribute, for a browser tab too
 *   frame-ancestors      only Forge's own window may frame it
 *
 * Not registered with protocol.registerSchemesAsPrivileged: a plain handled
 * scheme loads in an iframe and a tab as it is, and every privilege that call
 * could grant (standard origin, CSP bypass, fetch, CORS, storage) is one an
 * artifact should not have. Read-only: GET and HEAD, nothing else.
 *
 * Path safety is realpath-based: the file's real path (every symlink and
 * junction followed) must sit inside <canvas root>/<projectId>/ as that folder
 * really is on disk. `..`, encoded separators, drive letters and UNC paths are
 * refused before the disk is touched.
 *
 * No `electron` import: scripts/artifact-check.mjs drives this in plain node.
 */

/** Forge's own window: the built renderer is a file: page; the dev server adds its origin. */
export function artifactCsp(frameAncestors: string[] = ['file:']): string {
  return [
    "default-src 'none'",
    "script-src 'unsafe-inline'",
    "style-src 'unsafe-inline'",
    `img-src data: blob: ${ARTIFACT_SCHEME}:`,
    `media-src ${ARTIFACT_SCHEME}: blob:`,
    `font-src data: ${ARTIFACT_SCHEME}:`,
    "connect-src 'none'",
    "form-action 'none'",
    "base-uri 'none'",
    'sandbox allow-scripts',
    `frame-ancestors ${frameAncestors.join(' ')}`
  ].join('; ')
}

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/plain; charset=utf-8',
  '.markdown': 'text/plain; charset=utf-8',
  '.csv': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf'
}

export function artifactContentType(name: string): string {
  return TYPES[extname(name).toLowerCase()] ?? 'application/octet-stream'
}

export type ArtifactResolution =
  | { ok: true; path: string; type: string }
  | { ok: false; status: 400 | 403 | 404; reason: string }

const PROJECT_ID = /^[A-Za-z0-9_-]{1,128}$/

/** Windows paths compare without case; realpath gives the disk's spelling, a URL may not. */
function norm(p: string): string {
  return process.platform === 'win32' ? p.toLowerCase() : p
}

function inside(child: string, dir: string): boolean {
  return norm(child).startsWith(norm(dir.endsWith(sep) ? dir : dir + sep))
}

/** Where a forge-artifact: URL points, or why it may not be served. Touches the disk only to realpath and stat. */
export async function resolveArtifact(canvasRoot: string, rawUrl: string): Promise<ArtifactResolution> {
  let url: URL
  try {
    url = new URL(rawUrl)
  } catch {
    return { ok: false, status: 400, reason: 'Not an address.' }
  }
  if (url.protocol !== `${ARTIFACT_SCHEME}:`) return { ok: false, status: 400, reason: 'Wrong scheme.' }
  const projectId = url.hostname
  if (!PROJECT_ID.test(projectId)) return { ok: false, status: 404, reason: 'No such project.' }

  let rel: string
  try {
    rel = decodeURIComponent(url.pathname)
  } catch {
    return { ok: false, status: 400, reason: 'Bad encoding.' }
  }
  const parts = rel.replace(/^\/+/, '').split(/[\\/]/)
  if (
    rel.includes('\0') ||
    parts.length === 0 ||
    parts.some((p) => p === '' || p === '.' || p === '..' || p.includes(':'))
  ) {
    return { ok: false, status: 403, reason: 'Outside the canvas folder.' }
  }

  let realRoot: string
  try {
    realRoot = await realpath(canvasRoot)
  } catch {
    return { ok: false, status: 404, reason: 'No canvas folder.' }
  }
  const projectDir = join(realRoot, projectId)
  let realProject: string
  try {
    realProject = await realpath(projectDir)
    if (!(await stat(realProject)).isDirectory()) throw new Error('not a folder')
  } catch {
    return { ok: false, status: 404, reason: 'No such project.' }
  }
  // The project folder itself must be a real folder in the canvas root, not a
  // junction to somewhere else.
  if (norm(realProject) !== norm(projectDir)) {
    return { ok: false, status: 403, reason: 'Outside the canvas folder.' }
  }

  let real: string
  try {
    real = await realpath(join(projectDir, ...parts))
  } catch {
    return { ok: false, status: 404, reason: 'Not found.' }
  }
  if (!inside(real, projectDir)) return { ok: false, status: 403, reason: 'Outside the canvas folder.' }
  try {
    if (!(await stat(real)).isFile()) return { ok: false, status: 404, reason: 'Not found.' }
  } catch {
    return { ok: false, status: 404, reason: 'Not found.' }
  }
  return { ok: true, path: real, type: artifactContentType(real) }
}

export interface ArtifactSchemeOptions {
  /** CSP frame-ancestors sources. Default: `file:` (the built renderer). */
  frameAncestors?: string[]
}

function artifactHeaders(type: string, opts: ArtifactSchemeOptions): Record<string, string> {
  return {
    'Content-Type': type,
    'Content-Security-Policy': artifactCsp(opts.frameAncestors),
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    // Agents rewrite artifacts in place; a reload must show the new file.
    'Cache-Control': 'no-store'
  }
}

const PLAIN = 'text/plain; charset=utf-8'

/** The answer to one request: the file, or a plain-text refusal. Every response carries the CSP. */
export async function artifactResponse(canvasRoot: string, request: Request, opts: ArtifactSchemeOptions = {}): Promise<Response> {
  const refuse = (status: number, reason: string): Response =>
    new Response(request.method === 'HEAD' ? null : reason, { status, headers: artifactHeaders(PLAIN, opts) })

  if (request.method !== 'GET' && request.method !== 'HEAD') return refuse(405, 'Read-only.')
  const found = await resolveArtifact(canvasRoot, request.url)
  if (!found.ok) return refuse(found.status, found.reason)
  try {
    const size = (await stat(found.path)).size
    if (size > CANVAS_READ_MAX_BYTES) return refuse(413, 'Too big.')
    const body = request.method === 'HEAD' ? null : new Uint8Array(await readFile(found.path))
    return new Response(body, { status: 200, headers: { ...artifactHeaders(found.type, opts), 'Content-Length': String(size) } })
  } catch {
    return refuse(404, 'Not found.')
  }
}

/** The part of Electron's `Protocol` this needs, so a check can pass a fake. */
export interface ArtifactProtocol {
  handle(scheme: string, handler: (request: Request) => Response | Promise<Response>): void
}

const installed = new WeakSet<object>()

/** Serve the canvas on `forge-artifact:` in one session (its `protocol`). Once per session; later calls are no-ops. */
export function installArtifactScheme(protocol: ArtifactProtocol, canvasRoot: string, opts: ArtifactSchemeOptions = {}): void {
  if (installed.has(protocol)) return
  installed.add(protocol)
  protocol.handle(ARTIFACT_SCHEME, (request) =>
    artifactResponse(canvasRoot, request, opts).catch(
      () => new Response('Could not read the file.', { status: 500, headers: artifactHeaders(PLAIN, opts) })
    )
  )
}
