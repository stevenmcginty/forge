#!/usr/bin/env node
/**
 * artifact:check — the forge-artifact:// scheme (electron/artifact-scheme.ts),
 * proved offline against the real code in plain node.
 *
 *   1. addresses   shared/browser.ts builds and recognises artifact URLs; the
 *                  agents' normaliser still refuses them, the surface's accepts.
 *   2. paths       a throwaway canvas root: the right files are served, and
 *                  `..`, encoded traversal (%2e%2e, %2f, %5c), backslashes,
 *                  drive letters, UNC and absolute paths, a junction (and a
 *                  symlink, where Windows lets us make one) pointing outside,
 *                  a project folder that is itself a junction, a folder, and
 *                  an unknown project are all refused — and never leak a byte.
 *   3. responses   every answer, refusals included, carries the CSP header
 *                  (connect-src 'none', default-src 'none', inline script,
 *                  frame-ancestors) and nosniff; content types are right;
 *                  GET and HEAD only.
 *   3b. ranges     bodies stream from disk; byte ranges are 206s; ?v= may cache.
 *   3c. navigation guardArtifactFrames refuses a frame navigating out of an
 *                  artifact to anything that is not one.
 *   4. install     installArtifactScheme registers one handler per session.
 *   5. renderer    index.html's CSP lets the Board frame forge-artifact:.
 *
 * Whether Chromium honours all this (frames load, scripts run, the probe finds
 * every door shut) is proved by hand in a built Forge — see the B5 report.
 */
import { registerHooks } from 'node:module'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

registerHooks({
  resolve(spec, context, next) {
    if (spec.startsWith('@shared/')) {
      return next(new URL(`../shared/${spec.slice('@shared/'.length)}.ts`, import.meta.url).href, context)
    }
    const importer = String(context.parentURL ?? '')
    if (!importer.includes('/node_modules/') && spec.startsWith('.') && !/\.[a-z]+$/i.test(spec)) return next(`${spec}.ts`, context)
    return next(spec, context)
  },
  load(url, context, next) {
    if (url.endsWith('.ts')) return next(url, { ...context, format: 'module-typescript' })
    return next(url, context)
  }
})

const { artifactFrameMayNavigate, artifactResponse, artifactContentType, guardArtifactFrames, installArtifactScheme, resolveArtifact } = await import(
  '../electron/artifact-scheme.ts'
)
const { ARTIFACT_PARTITION, BROWSER_PARTITION, artifactUrl, isArtifactUrl, normaliseBrowserUrl, normaliseSurfaceUrl } = await import(
  '../shared/browser.ts'
)

let passed = 0
let failed = 0
function check(name, ok, detail = '') {
  if (ok) {
    passed++
    console.log(`  ok   ${name}`)
  } else {
    failed++
    console.log(`  FAIL ${name}${detail ? `\n       ${String(detail)}` : ''}`)
  }
}
function section(title) {
  console.log(`\n${title}`)
}

const scratch = mkdtempSync(join(tmpdir(), 'forge-artifact-check-'))
const root = join(scratch, 'canvas')
const outside = join(scratch, 'outside')
const SECRET = 'TOP-SECRET-OUTSIDE-THE-CANVAS'

try {
  mkdirSync(join(root, 'proj1', 'sub'), { recursive: true })
  mkdirSync(outside, { recursive: true })
  writeFileSync(join(root, 'proj1', 'page.html'), '<!doctype html><p>hi</p><script>document.title="ran"</script>')
  writeFileSync(join(root, 'proj1', 'a b.html'), '<p>spaced</p>')
  writeFileSync(join(root, 'proj1', 'pic.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]))
  writeFileSync(join(root, 'proj1', 'sub', 'style.css'), 'p{color:red}')
  writeFileSync(join(root, 'proj1', 'font.woff2'), 'w')
  writeFileSync(join(root, 'proj1', 'blob.bin'), 'b')
  writeFileSync(join(root, 'proj1', 'clip.mp4'), 'm')
  writeFileSync(join(root, 'proj1', 'notes.md'), '# hi')
  writeFileSync(join(outside, 'secret.txt'), SECRET)
  writeFileSync(join(root, 'secret.txt'), SECRET) // beside the project folders, still not in one
  writeFileSync(join(root, 'proj1.board.json'), '{}')
  // A junction inside the project pointing outside it — no admin rights needed.
  symlinkSync(outside, join(root, 'proj1', 'link'), 'junction')
  // A whole project folder that is a junction to somewhere else.
  symlinkSync(outside, join(root, 'proj2'), 'junction')
  // A file symlink needs Developer Mode or admin on Windows; tried, and skipped if refused.
  let fileLink = true
  try {
    symlinkSync(join(outside, 'secret.txt'), join(root, 'proj1', 'sneaky.html'), 'file')
  } catch {
    fileLink = false
  }

  const get = (url, method = 'GET') => artifactResponse(root, new Request(url, { method }), { frameAncestors: ['file:'] })

  /* ------------------------------------------------------------ 1 */
  section('1. addresses')
  check('artifactUrl encodes the name', artifactUrl('proj1', 'a b.html') === 'forge-artifact://proj1/a%20b.html', artifactUrl('proj1', 'a b.html'))
  check('isArtifactUrl knows its own', isArtifactUrl('forge-artifact://proj1/x.html') && isArtifactUrl('FORGE-ARTIFACT://p/x'))
  check('isArtifactUrl refuses the rest', !isArtifactUrl('https://example.com') && !isArtifactUrl('file:///C:/x.html') && !isArtifactUrl(''))
  check('agents cannot open an artifact (http and https only)', normaliseBrowserUrl('forge-artifact://proj1/page.html').error !== '')
  check('the surface can', normaliseSurfaceUrl('forge-artifact://proj1/page.html').url === 'forge-artifact://proj1/page.html')
  check('the surface still refuses file:', normaliseSurfaceUrl('file:///C:/Windows/win.ini').error !== '')
  check('the surface still normalises web addresses', normaliseSurfaceUrl('example.com').url === 'https://example.com')
  check('artifact tabs get their own in-memory partition', ARTIFACT_PARTITION !== BROWSER_PARTITION && !ARTIFACT_PARTITION.startsWith('persist:'), ARTIFACT_PARTITION)

  /* ------------------------------------------------------------ 2 */
  section('2. paths')
  const served = [
    ['forge-artifact://proj1/page.html', 'page.html'],
    ['forge-artifact://proj1/a%20b.html', 'a b.html'],
    ['forge-artifact://proj1/sub/style.css', 'style.css'],
    ['forge-artifact://proj1/page.html?v=123#top', 'page.html'],
    ['forge-artifact://PROJ1/page.html', 'page.html']
  ]
  for (const [url, name] of served) {
    const r = await resolveArtifact(root, url)
    const okCase = process.platform === 'win32' || !url.includes('PROJ1')
    if (okCase) check(`serves ${url}`, r.ok && r.path.endsWith(name), JSON.stringify(r))
  }
  const refused = [
    ['raw ..', 'forge-artifact://proj1/../secret.txt'],
    ['raw ../..', 'forge-artifact://proj1/../../outside/secret.txt'],
    ['encoded %2e%2e', 'forge-artifact://proj1/%2e%2e/secret.txt'],
    ['encoded %2E%2E/%2e%2e', 'forge-artifact://proj1/%2E%2E/%2e%2e/outside/secret.txt'],
    ['encoded slash ..%2f', 'forge-artifact://proj1/..%2fsecret.txt'],
    ['encoded slash %2e%2e%2f%2e%2e%2f', 'forge-artifact://proj1/%2e%2e%2f%2e%2e%2foutside%2fsecret.txt'],
    ['backslash ..%5c', 'forge-artifact://proj1/..%5c..%5coutside%5csecret.txt'],
    ['raw backslash', 'forge-artifact://proj1/..\\..\\outside\\secret.txt'],
    ['absolute drive path', `forge-artifact://proj1/${join(outside, 'secret.txt').replace(/\\/g, '/')}`],
    ['absolute drive path, encoded', `forge-artifact://proj1/${encodeURIComponent(join(outside, 'secret.txt'))}`],
    ['UNC path', 'forge-artifact://proj1//localhost/c$/Windows/win.ini'],
    ['UNC path, encoded', 'forge-artifact://proj1/%5c%5clocalhost%5cc$%5cWindows%5cwin.ini'],
    ['NUL byte', 'forge-artifact://proj1/page.html%00.png'],
    ['a junction pointing outside', 'forge-artifact://proj1/link/secret.txt'],
    ['a project folder that is a junction', 'forge-artifact://proj2/secret.txt'],
    ['an unknown project', 'forge-artifact://nope/page.html'],
    ['a project id with odd characters', 'forge-artifact://proj1.board.json/x'],
    ['the project folder itself', 'forge-artifact://proj1/'],
    ['a sub-folder', 'forge-artifact://proj1/sub'],
    ['a missing file', 'forge-artifact://proj1/missing.html'],
    ['another scheme', `file:///${join(outside, 'secret.txt').replace(/\\/g, '/')}`]
  ]
  if (fileLink) refused.push(['a file symlink pointing outside', 'forge-artifact://proj1/sneaky.html'])
  for (const [name, url] of refused) {
    let r
    try {
      r = await resolveArtifact(root, url)
    } catch (err) {
      r = { ok: false, status: 0, reason: String(err) }
    }
    const res = await get(url).catch(() => null)
    const body = res ? await res.text() : ''
    check(`refuses ${name}`, !r.ok && res && res.status >= 400 && !body.includes(SECRET), `${url} -> ${JSON.stringify(r)} / ${res?.status} ${body.slice(0, 60)}`)
  }
  if (!fileLink) console.log('  --   file symlink not tried: Windows refused to make one (needs Developer Mode or admin); the junction covers the same path')
  {
    const r = await resolveArtifact(root, 'forge-artifact://nope/page.html')
    check('unknown project is a 404', !r.ok && r.status === 404, JSON.stringify(r))
    const j = await resolveArtifact(root, 'forge-artifact://proj1/link/secret.txt')
    check('the junction escape is a 403', !j.ok && j.status === 403, JSON.stringify(j))
    const e = await resolveArtifact(root, 'forge-artifact://proj1/..%2fsecret.txt')
    check('encoded traversal is a 403', !e.ok && e.status === 403, JSON.stringify(e))
  }

  /* ------------------------------------------------------------ 3 */
  section('3. responses')
  const page = await get('forge-artifact://proj1/page.html')
  const csp = page.headers.get('content-security-policy') ?? ''
  const directives = Object.fromEntries(
    csp
      .split(';')
      .map((d) => d.trim())
      .filter(Boolean)
      .map((d) => [d.split(/\s+/)[0], d.split(/\s+/).slice(1).join(' ')])
  )
  check('200 with the file', page.status === 200 && (await page.text()).includes('<p>hi</p>'))
  check('CSP is a response header', csp.length > 0, csp)
  check("connect-src 'none'", directives['connect-src'] === "'none'", csp)
  check("default-src 'none'", directives['default-src'] === "'none'", csp)
  check("script-src 'unsafe-inline' only", directives['script-src'] === "'unsafe-inline'", csp)
  check("style-src 'unsafe-inline' only", directives['style-src'] === "'unsafe-inline'", csp)
  check('img-src data: blob: forge-artifact:', directives['img-src'] === 'data: blob: forge-artifact:', csp)
  check('media-src forge-artifact: blob:', directives['media-src'] === 'forge-artifact: blob:', csp)
  check('font-src data: forge-artifact:', directives['font-src'] === 'data: forge-artifact:', csp)
  check('frame-ancestors is only the app', directives['frame-ancestors'] === 'file:', csp)
  check('no network source anywhere', !/https?:|\*|ws:|wss:/.test(csp), csp)
  check('nosniff', page.headers.get('x-content-type-options') === 'nosniff')
  check('no caching (agents rewrite in place)', page.headers.get('cache-control') === 'no-store')
  check('text/html; charset=utf-8', page.headers.get('content-type') === 'text/html; charset=utf-8', page.headers.get('content-type'))
  const types = [
    ['forge-artifact://proj1/pic.png', 'image/png'],
    ['forge-artifact://proj1/sub/style.css', 'text/css; charset=utf-8'],
    ['forge-artifact://proj1/font.woff2', 'font/woff2'],
    ['forge-artifact://proj1/clip.mp4', 'video/mp4'],
    ['forge-artifact://proj1/notes.md', 'text/plain; charset=utf-8'],
    ['forge-artifact://proj1/blob.bin', 'application/octet-stream']
  ]
  for (const [url, type] of types) {
    const r = await get(url)
    check(`${url.split('/').pop()} is ${type}`, r.status === 200 && r.headers.get('content-type') === type, `${r.status} ${r.headers.get('content-type')}`)
  }
  check('svg is image/svg+xml (under the same CSP)', artifactContentType('x.SVG') === 'image/svg+xml')
  const refusal = await get('forge-artifact://proj1/link/secret.txt')
  check(
    'a refusal carries the CSP and nosniff too',
    (refusal.headers.get('content-security-policy') ?? '').includes("connect-src 'none'") && refusal.headers.get('x-content-type-options') === 'nosniff'
  )
  check('a refusal is plain text', refusal.headers.get('content-type') === 'text/plain; charset=utf-8')
  const head = await get('forge-artifact://proj1/page.html', 'HEAD')
  check('HEAD: 200, headers, no body', head.status === 200 && head.headers.get('content-length') !== null && (await head.text()) === '')
  for (const method of ['POST', 'PUT', 'DELETE']) {
    const r = await get('forge-artifact://proj1/page.html', method)
    check(`${method} is refused (read-only)`, r.status === 405, String(r.status))
  }
  const dev = await artifactResponse(root, new Request('forge-artifact://proj1/page.html'), { frameAncestors: ['file:', 'http://localhost:5173'] })
  check('dev adds its own origin to frame-ancestors', (dev.headers.get('content-security-policy') ?? '').includes('frame-ancestors file: http://localhost:5173'))

  /* ----------------------------------------------------------- 3b */
  section('3b. streaming, byte ranges, versions')
  writeFileSync(join(root, 'proj1', 'long.mp4'), 'abcdefghij')
  const ranged = (range, url = 'forge-artifact://proj1/long.mp4') =>
    artifactResponse(root, new Request(url, { headers: { range } }), { frameAncestors: ['file:'] })
  const whole = await get('forge-artifact://proj1/long.mp4')
  check('a whole file streams back in full', whole.status === 200 && (await whole.text()) === 'abcdefghij' && whole.headers.get('content-length') === '10')
  check('byte ranges are offered', whole.headers.get('accept-ranges') === 'bytes')
  const mid = await ranged('bytes=2-5')
  check('bytes=2-5 is a 206 with just those bytes', mid.status === 206 && (await mid.text()) === 'cdef', String(mid.status))
  check('with Content-Range and Content-Length', mid.headers.get('content-range') === 'bytes 2-5/10' && mid.headers.get('content-length') === '4', `${mid.headers.get('content-range')} ${mid.headers.get('content-length')}`)
  check('a 206 still carries the CSP', (mid.headers.get('content-security-policy') ?? '').includes("connect-src 'none'"))
  const open = await ranged('bytes=7-')
  check('bytes=7- runs to the end', open.status === 206 && (await open.text()) === 'hij' && open.headers.get('content-range') === 'bytes 7-9/10')
  const tail = await ranged('bytes=-3')
  check('bytes=-3 is the last three', tail.status === 206 && (await tail.text()) === 'hij')
  const past = await ranged('bytes=10-')
  check('a range past the end is a 416 naming the size', past.status === 416 && past.headers.get('content-range') === 'bytes */10', String(past.status))
  const clamp = await ranged('bytes=8-999')
  check('an end past the file is clamped', clamp.status === 206 && (await clamp.text()) === 'ij')
  const many = await ranged('bytes=0-1,4-5')
  check('several ranges are answered with the whole file (allowed)', many.status === 200 && (await many.text()) === 'abcdefghij')
  const rangedEscape = await ranged('bytes=0-5', 'forge-artifact://proj1/link/secret.txt')
  check('a range never gets past the path checks', rangedEscape.status === 403 && !(await rangedEscape.text()).includes(SECRET), String(rangedEscape.status))
  writeFileSync(join(root, 'proj1', 'empty.txt'), '')
  const empty = await get('forge-artifact://proj1/empty.txt')
  check('an empty file is a 200 with no body', empty.status === 200 && (await empty.text()) === '' && empty.headers.get('content-length') === '0')
  const versioned = await get('forge-artifact://proj1/pic.png?v=1712345678901')
  check('a ?v=<mtime> address is one version, so it may be cached', /max-age=\d+/.test(versioned.headers.get('cache-control') ?? '') && versioned.status === 200, versioned.headers.get('cache-control'))
  check('an address without ?v= stays no-store', (await get('forge-artifact://proj1/pic.png')).headers.get('cache-control') === 'no-store')
  const src = readFileSync(new URL('../electron/artifact-scheme.ts', import.meta.url), 'utf8')
  check('bodies stream from disk (no whole-file readFile)', /createReadStream\(path, \{ start, end \}\)/.test(src) && !/\breadFile\(/.test(src))

  /* ----------------------------------------------------------- 3c */
  section('3c. an artifact cannot navigate its frame away')
  check('artifact → artifact is allowed', artifactFrameMayNavigate('forge-artifact://proj1/page.html', 'forge-artifact://proj1/a%20b.html'))
  check('artifact → https is refused', !artifactFrameMayNavigate('forge-artifact://proj1/page.html', 'https://x.example/?d=secret'))
  check('artifact → about:blank, data:, javascript: are refused', ['about:blank', 'data:text/html,hi', 'javascript:alert(1)', 'file:///C:/x.html'].every((to) => !artifactFrameMayNavigate('forge-artifact://proj1/page.html', to)))
  check('a frame that is not an artifact is left alone', artifactFrameMayNavigate('http://localhost:5173/', 'https://example.com/'))
  check('a fresh frame may load an artifact', artifactFrameMayNavigate('', 'forge-artifact://proj1/page.html'))
  const listeners = []
  guardArtifactFrames({ on: (event, fn) => listeners.push({ event, fn }) })
  check('the guard listens on will-frame-navigate', listeners.length === 1 && listeners[0].event === 'will-frame-navigate')
  const nav = (details) => {
    let prevented = false
    listeners[0].fn({ isMainFrame: false, frame: null, initiator: null, ...details, preventDefault: () => (prevented = true) })
    return prevented
  }
  const warn = console.warn
  console.warn = () => {}
  try {
    check('refuses: the Board frame sets location to https', nav({ url: 'https://example.com/?x=1', frame: { url: 'forge-artifact://proj1/page.html?v=1' } }))
    check('refuses: navigation started by an artifact', nav({ url: 'https://example.com/', frame: { url: '' }, initiator: { url: 'forge-artifact://proj1/page.html' } }))
    check('allows: the Board walking to the next artifact', !nav({ url: 'forge-artifact://proj1/a%20b.html?v=2', frame: { url: 'forge-artifact://proj1/page.html?v=1' } }))
    check('allows: the Board opening an artifact in a fresh frame', !nav({ url: 'forge-artifact://proj1/page.html?v=1', frame: { url: 'about:blank' }, initiator: { url: 'file:///C:/app/index.html' } }))
    check('allows: other frames (the Devices preview) to go where they go', !nav({ url: 'https://example.com/', frame: { url: 'http://localhost:3000/' } }))
    check('leaves the main frame to main.ts will-navigate', !nav({ isMainFrame: true, url: 'https://example.com/', frame: { url: 'forge-artifact://proj1/page.html' } }))
  } finally {
    console.warn = warn
  }

  /* ------------------------------------------------------------ 4 */
  section('4. install')
  const calls = []
  const fake = { handle: (scheme, handler) => calls.push({ scheme, handler }) }
  installArtifactScheme(fake, root)
  installArtifactScheme(fake, root)
  check('one handler, on forge-artifact', calls.length === 1 && calls[0].scheme === 'forge-artifact', JSON.stringify(calls.map((c) => c.scheme)))
  const viaHandler = await calls[0].handler(new Request('forge-artifact://proj1/page.html'))
  check('the installed handler serves the canvas', viaHandler.status === 200 && (viaHandler.headers.get('content-security-policy') ?? '').includes("connect-src 'none'"))
  const other = []
  installArtifactScheme({ handle: (scheme) => other.push(scheme) }, root)
  check('a second session gets its own handler', other.length === 1)

  /* ------------------------------------------------------------ 5 */
  section('5. renderer')
  const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8')
  const frameSrc = /frame-src ([^;"]*)/.exec(html)?.[1] ?? ''
  check('index.html frame-src allows forge-artifact:', frameSrc.split(/\s+/).includes('forge-artifact:'), frameSrc)
  const view = readFileSync(new URL('../src/components/hub/ArtifactView.tsx', import.meta.url), 'utf8')
  const frame = /<iframe\s+key=\{item\.id\}[\s\S]*?\/>/.exec(view)?.[0] ?? ''
  check('the Board frame is sandbox="allow-scripts" and nothing more', /sandbox="allow-scripts"/.test(frame) && !/allow-same-origin|allow-top-navigation|allow-forms|allow-popups/.test(view), frame)
  check('the Board frame loads the scheme, not srcdoc', /src=\{`\$\{artifactAddress\(item\)\}/.test(frame) && !/srcDoc/.test(frame), frame)
  const thumb = /<iframe\s+className="artifact-thumb__frame"[\s\S]*?\/>/.exec(view)?.[0] ?? ''
  check('an HTML thumbnail is sandbox="" (no script) from the scheme, not a srcdoc of the whole file', /sandbox=""/.test(thumb) && /src=\{`\$\{artifactAddress\(item\)\}/.test(thumb) && !/srcDoc/.test(view), thumb)
} finally {
  try {
    rmSync(scratch, { recursive: true, force: true })
  } catch {
    /* a junction the OS still holds; tmp is swept anyway */
  }
}

console.log(`\n${failed === 0 ? 'PASS' : 'FAIL'} ${passed} passed, ${failed} failed`)
process.exit(failed === 0 ? 0 : 1)
