/**
 * Rules check for the Devices preview (src/components/DevicePreview.tsx).
 *
 *   node scripts/preview-check.mjs
 *
 * The view's decisions live in src/lib/devicePreview.ts with no DOM in it, and
 * this file holds them to it — the same arrangement rail-check.mjs gives the
 * rail. The two blocks that matter most:
 *
 *  - the two presets must load from different hosts. Same-host frames share one
 *    localStorage origin and therefore one deviceId, and the server treats a
 *    deviceId as one session — the second frame's reconnect would kick the
 *    first. That invariant is invisible until it bites, so it is asserted, not
 *    assumed.
 *  - the insets the desk's fake system bars are drawn to must equal the
 *    `--sa-*` values the phone app reserves under `?sim=` (mobile/src/styles.css).
 *    Drift either way means a bar over app content or a gap where the bar
 *    should be — on a screen whose whole job is to show that app.
 *
 * The project mode adds a third: shared/devserver.ts is the only thing standing
 * between a wall of ANSI-coloured PTY output and knowing where this project's
 * site is. It is scanned head-less here against the shapes dev servers actually
 * print, because the alternative is finding out from an empty phone.
 *
 * The last block sweeps the sources, CSP first among them: `frame-src` in
 * index.html is what lets a loopback iframe exist at all, `connect-src` is what
 * lets the liveness probe ask whether anything is there, and nothing at runtime
 * complains when either is missing — the frames just go blank, or the probe
 * calls a healthy server dead.
 */
import { readFileSync } from 'node:fs'
import { registerHooks } from 'node:module'

registerHooks({
  resolve(spec, context, next) {
    if (spec.startsWith('@/')) {
      return next(new URL(`../src/${spec.slice('@/'.length)}.ts`, import.meta.url).href, context)
    }
    if (spec.startsWith('@shared/')) {
      return next(new URL(`../shared/${spec.slice('@shared/'.length)}.ts`, import.meta.url).href, context)
    }
    if (spec.startsWith('.') && !/\.[a-z]+$/i.test(spec)) return next(`${spec}.ts`, context)
    return next(spec, context)
  },
  load(url, context, next) {
    if (url.endsWith('.ts')) return next(url, { ...context, format: 'module-typescript' })
    return next(url, context)
  }
})

const D = await import('../src/lib/devicePreview.ts')
const S = await import('../shared/devserver.ts')

let pass = 0
let fail = 0
const ok = (cond, label, detail = '') => {
  if (cond) {
    pass++
    console.log(`  ✓ ${label}`)
  } else {
    fail++
    console.log(`  ✕ ${label}${detail ? ` — ${detail}` : ''}`)
  }
}

/* ----------------------------------------------------------------- presets */

console.log('\npresets')
const presets = D.PREVIEW_DEVICES
ok(presets.length === 2, 'two phones, no more', JSON.stringify(presets.map((p) => p.id)))
ok(presets[0].id === 'ios' && presets[1].id === 'android', 'iPhone first — the pairing order')
ok(
  new Set(presets.map((p) => p.host)).size === presets.length,
  'every frame loads from a different host (one localStorage origin each)',
  JSON.stringify(presets.map((p) => p.host))
)
ok(
  presets.every((p) => p.host === 'localhost' || p.host === '127.0.0.1'),
  'both hosts are loopback — the preview never leaves this machine'
)
ok(
  new Set(presets.map((p) => p.deviceName)).size === presets.length,
  'distinct device names, so one frame can never satisfy the other’s live check'
)
ok(
  presets.every(
    (p) => p.viewport.w >= 320 && p.viewport.w <= 480 && p.viewport.h >= 640 && p.viewport.h <= 1000
  ),
  'viewports are phone-shaped',
  JSON.stringify(presets.map((p) => p.viewport))
)
ok(presets.every((p) => p.insets.top > 0 && p.insets.bottom > 0), 'both bars exist on both phones')
ok(D.presetFor('ios')?.deviceName === 'Preview · iPhone', 'presetFor finds the iPhone')
ok(D.presetFor('android')?.id === 'android', 'presetFor finds the Pixel')
ok(D.presetFor('ios') !== null && D.presetFor('android') !== null, 'presetFor never guesses')

/* ------------------------------------------------------------- preview URLs */

console.log('\npreview URLs')
// A code with characters that must survive one round of URI encoding whole.
const CODE = 'AbC+/99=x&y?z'
const ios = D.presetFor('ios')
const android = D.presetFor('android')
for (const preset of [ios, android]) {
  const url = new URL(D.previewUrl(preset, 8420, CODE))
  ok(url.searchParams.get('sim') === preset.id, `?sim= is ${preset.id}`)
  const link = url.searchParams.get('pair') ?? ''
  const parsed = new URL(link)
  ok(parsed.protocol === 'forge:', 'the pair param is a forge:// link')
  ok(
    parsed.searchParams.get('host') === preset.host,
    `${preset.id}: the link's host is the frame's own host (the originMatchesHost gate)`,
    `${parsed.searchParams.get('host')} vs ${preset.host}`
  )
  ok(parsed.searchParams.get('port') === '8420', `${preset.id}: the port survives`)
  ok(parsed.searchParams.get('pt') === CODE, `${preset.id}: the code round-trips without double-encoding`)
  ok(url.origin === `http://${preset.host}:8420`, `${preset.id}: the frame origin is the preset's host`)
}
ok(D.previewUrl(ios, 8420, 't') !== D.previewUrl(android, 8420, 't'), 'the two frames load different URLs')

/* ------------------------------------------------------------------- scale */

console.log('\nfit scale')
ok(D.fitScale(800, 1600, 400, 800) === 1, 'a phone that fits is never blown up past 1')
ok(D.fitScale(400, 800, 400, 800) === 1, 'exactly fits at 1')
ok(D.fitScale(200, 800, 400, 800) === 0.5, 'half the width is half the scale')
ok(D.fitScale(400, 400, 400, 800) === 0.5, 'height constrains too')
ok(D.fitScale(800, 1600, 417, 852) <= 1 && D.fitScale(800, 1600, 417, 852) > 0.9, 'an awkward fit snaps near, not to, 1')
ok(D.fitScale(0, 800, 400, 800) === 0, 'a zero-width box is 0, not NaN')
ok(D.fitScale(800, 0, 400, 800) === 0, 'a zero-height box is 0, not NaN')
ok(D.fitScale(-5, 800, 400, 800) === 0, 'a negative box is 0, not something scaled up')
for (const [bw, bh] of [
  [1, 1],
  [37, 999],
  [12000, 3]
]) {
  const s = D.fitScale(bw, bh, 400, 800)
  ok(Number.isFinite(s) && s > 0 && s <= 1, `fitScale(${bw}, ${bh}) stays in (0, 1]`, String(s))
}

/* ------------------------------------------------- finding the dev server */

console.log('\ndev-server URLs')
/** A real escape byte, written as an escape rather than pasted in as one. */
const ESC = '\u001B'
// Exactly what Vite writes down the PTY: the banner is coloured and the port
// inside the URL is bolded, so the URL arrives cut in half by escapes.
const VITE = `  ${ESC}[32m➜${ESC}[39m  ${ESC}[1mLocal${ESC}[22m:   ${ESC}[36mhttp://localhost:${ESC}[1m5173${ESC}[22m/${ESC}[39m`
ok(
  S.findDevServerUrl(VITE) === 'http://localhost:5173/',
  'a Vite banner with a bolded port comes back whole',
  JSON.stringify(S.findDevServerUrl(VITE))
)
ok(
  S.findDevServerUrl(`Local: http://localhost:5173/\nNetwork: http://localhost:4173/`) ===
    'http://localhost:4173/',
  'the last URL wins — a restarted server is more current than the one it replaced'
)
ok(
  S.findDevServerUrl('serving at http://0.0.0.0:3000') === 'http://localhost:3000',
  '0.0.0.0 is a bind address, not one a frame can dial — it becomes localhost',
  JSON.stringify(S.findDevServerUrl('serving at http://0.0.0.0:3000'))
)
ok(
  S.findDevServerUrl('listening on http://[::1]:3000/') === 'http://localhost:3000/',
  '[::1] normalises to localhost too, so both frames share one origin story'
)
ok(S.findDevServerUrl('http://[::1]') === 'http://localhost', 'a bare [::1] keeps its whole host')
ok(
  S.findDevServerUrl('open http://127.0.0.1:8080/app.') === 'http://127.0.0.1:8080/app',
  'a URL printed in a sentence loses the full stop, not its path'
)
ok(S.findDevServerUrl('(http://localhost:4000)') === 'http://localhost:4000', 'and its brackets')
ok(
  S.findDevServerUrl(`${ESC}[36mhttp://localhost:5173/${ESC}[0m done`) === 'http://localhost:5173/',
  'a trailing escape ends the URL rather than joining it'
)
ok(
  S.findDevServerUrl(`${ESC}]0;a title${ESC}http://localhost:9000/`) === 'http://localhost:9000/',
  'an OSC window-title sequence is not mistaken for the line it precedes'
)
ok(
  S.findDevServerUrl('https://localhost:8443/x') === 'https://localhost:8443/x',
  'https survives — a manual URL is allowed to be a real site'
)
ok(S.findDevServerUrl('http://example.com:3000') === null, 'a URL that is not loopback is not ours')
ok(S.findDevServerUrl('no server here') === null, 'ordinary output finds nothing')
ok(S.findDevServerUrl('') === null, 'an empty chunk finds nothing')
ok(
  S.findDevServerUrl('http://localhost:5173/a\nhttp://localhost:5173/a') === 'http://localhost:5173/a',
  'the same URL twice is the same answer — what the caller suppresses is a repeat, not a change'
)

/* A dev server prints more URLs than its banner — deps files, its own client,
 * HMR pings, assets in stack traces. None of them is the site, but every one of
 * them is proof a server lives at that origin, so an internals URL collapses to
 * its door rather than pointing two phones at a JavaScript file. */
ok(
  S.findDevServerUrl(
    'Local: http://localhost:5199/\n➜ optimized http://localhost:5199/node_modules/.vite/deps/react.js?v=abc123'
  ) === 'http://localhost:5199/',
  'a Vite deps URL is internals — it keeps the origin and loses the file'
)
ok(
  S.findDevServerUrl('http://localhost:5199/@vite/client failed') === 'http://localhost:5199/',
  'the Vite client is nobody’s homepage, but it does name the server'
)
ok(
  S.findDevServerUrl('GET http://localhost:5199/__vite_ping 200') === 'http://localhost:5199/',
  'an HMR ping too — a banner that scrolled past hours ago is not required'
)
ok(
  S.findDevServerUrl('at http://localhost:3000/assets/index-Dam1jtv5.js:1:100') === 'http://localhost:3000/',
  'a stack-trace asset has a file extension, and a file is not a page — its origin is the answer'
)
ok(
  S.findDevServerUrl('serving http://localhost:8080/app/') === 'http://localhost:8080/app/',
  'a short mount path is still a page — only file-shaped tails are internals'
)
ok(
  S.findDevServerUrl('http://localhost:5199/;curl -sI http://localhost:5199/x.js') ===
    'http://localhost:5199/',
  'a semicolon ends the URL — the next command on the line is not a path'
)
ok(
  // PSReadLine redraws an edited line with cursor moves instead of spaces, so
  // this is exactly what a pasted curl chain can look like down the PTY.
  S.findDevServerUrl('http://localhost:5199/;curl-sIhttp://localhost:5199/') === 'http://localhost:5199/',
  'even glued with no spaces at all, the shell separator is where the URL stops'
)
ok(
  S.findDevServerUrl('see http://localhost:3000/weird:thing') === 'http://localhost:3000/',
  'a colon inside a path segment is another URL glued on, and only the origin survives it'
)
ok(
  S.findDevServerUrl('http://localhost:3000/?open=1') === 'http://localhost:3000/?open=1',
  'a query string on the root is not an extension'
)
ok(
  S.resolvePreviewUrl === undefined,
  'resolvePreviewUrl lives in devicePreview.ts, not here — this guard keeps the split honest'
)

/* ----------------------------------------------- what the frames point at */

console.log('\nproject preview')
ok(D.normalizePreviewUrl('localhost:3000') === 'http://localhost:3000', 'a bare host:port becomes a URL')
ok(D.normalizePreviewUrl('  localhost:3000  ') === 'http://localhost:3000', 'and is trimmed on the way')
ok(D.normalizePreviewUrl('https://forge.dev') === 'https://forge.dev', 'a scheme somebody typed is never rewritten')
ok(D.normalizePreviewUrl('http://localhost:1') === 'http://localhost:1', 'http is left alone too')
ok(D.normalizePreviewUrl('') === '' && D.normalizePreviewUrl('   ') === '', 'empty stays empty')
ok(
  D.resolvePreviewUrl('localhost:3000', 'http://localhost:5173/') === 'http://localhost:3000',
  'a typed URL beats a detected one — a decision is not overruled by a banner'
)
ok(
  D.resolvePreviewUrl('', 'http://localhost:5173/') === 'http://localhost:5173/',
  'with nothing typed, the detected URL is what the phones load'
)
ok(
  D.resolvePreviewUrl(undefined, undefined) === '' && D.resolvePreviewUrl('', '') === '',
  'a project with neither resolves to nothing, not to undefined'
)
ok(
  D.resolvePreviewUrl(undefined, 'http://localhost:5199/node_modules/.vite/deps/react.js') ===
    'http://localhost:5199/',
  'a stale internals detection persisted under an older rule heals to its origin, not to a blank phone'
)
ok(
  D.resolvePreviewUrl(undefined, 'http://localhost:5199/') === 'http://localhost:5199/',
  'while a stored banner URL passes back through the scanner untouched'
)

/* The liveness probe. A resolved URL is a memory of a banner, not a running
 * server, and the frames are only mounted once something answers — so what
 * `probeTarget` will and will not ask is the difference between an honest empty
 * state and two white phones under a "Live" chip. It answers for exactly the two
 * hosts index.html's `connect-src` admits, asserted below: a fetch anywhere else
 * is blocked by the CSP, and a blocked fetch rejects exactly like a dead
 * server. */
ok(D.probeTarget('http://localhost:5199/') === 'http://localhost:5199/', 'a loopback dev server is probed')
ok(D.probeTarget('http://127.0.0.1:8080/app') === 'http://127.0.0.1:8080/app', 'and so is the other loopback host')
ok(
  D.probeTarget('https://forge.dev') === null,
  'a site on the internet is not probed — connect-src would block it, and a blocked fetch reads as a dead server',
  JSON.stringify(D.probeTarget('https://forge.dev'))
)
ok(D.probeTarget('https://localhost:8443/') === null, 'nor a loopback https one, for the same CSP reason')
ok(D.probeTarget('') === null && D.probeTarget('   ') === null, 'nothing to probe is not something to probe')
ok(D.probeTarget('localhost:3000') === null, 'an un-normalised host:port is not a URL yet')
ok(D.probeTarget('http://example.com:3000/') === null, 'a non-loopback http host is assumed up rather than judged')
ok(
  D.probeTarget(D.resolvePreviewUrl('', 'http://localhost:5199/')) === 'http://localhost:5199/',
  'what resolvePreviewUrl hands the frames is what gets probed'
)

/* The Start button's command, and the one project that never gets one. A typed
 * command is a decision and the package.json sniff is a guess, so the order here
 * is the same order resolvePreviewUrl uses — and the self latch is a refusal to
 * guess rather than a prohibition, which is why a typed command outranks it. */
console.log('\nthe start command')
const SNIFF = { kind: 'command', command: 'pnpm run dev', script: 'dev' }
ok(D.effectiveDevCommand('', SNIFF) === 'pnpm run dev', 'with nothing typed, the sniffed command is what runs')
ok(
  D.effectiveDevCommand('npx serve .', SNIFF) === 'npx serve .',
  'a typed command beats a sniffed one — a decision is not overruled by a guess'
)
ok(
  D.effectiveDevCommand('  npx serve .  ', null) === 'npx serve .',
  'and is trimmed, so a folder with no package.json still gets a button'
)
ok(
  D.effectiveDevCommand(undefined, null) === '' && D.effectiveDevCommand('   ', null) === '',
  'nothing typed and nothing found is no command, not undefined — the button is simply absent'
)
ok(
  D.effectiveDevCommand('', { kind: 'self' }) === '',
  'the checkout Forge runs from offers no guessed command at all'
)
ok(
  D.effectiveDevCommand('npm run mobile:build', { kind: 'self' }) === 'npm run mobile:build',
  'but a command typed for it by hand still runs — the latch only ever refused to guess'
)
ok(
  D.isSelfPreview('', { kind: 'self' }) && D.isSelfPreview(undefined, { kind: 'self' }),
  'the self answer sends the empty state to the Forge Mobile mode instead of a Start button'
)
ok(
  !D.isSelfPreview('npm run mobile:build', { kind: 'self' }),
  'and stops doing so the moment somebody types a command for this project'
)
ok(
  !D.isSelfPreview('', SNIFF) && !D.isSelfPreview('', null),
  'no other project is ever sent to the Forge Mobile mode'
)

/* Which mode the view opens in, which is now also the only mode most projects
 * have: the header toggle is drawn for the self checkout alone, so a default of
 * `forge` anywhere else would be a mode with no way out of it — and a pairing
 * code minted for a project nobody switched to. */
ok(
  D.defaultPreviewMode('', { kind: 'self' }) === 'forge' &&
    D.defaultPreviewMode(undefined, { kind: 'self' }) === 'forge',
  'the checkout Forge runs from opens straight into the Forge Mobile preview'
)
ok(
  D.defaultPreviewMode('', SNIFF) === 'project' && D.defaultPreviewMode(undefined, null) === 'project',
  'every other project opens on its own site — the mode is simply what the view is'
)
ok(
  D.defaultPreviewMode('npm run mobile:build', { kind: 'self' }) === 'project',
  'and a command typed for the checkout by hand opens on the site that command serves'
)
for (const args of [
  ['', null],
  ['', SNIFF],
  ['', { kind: 'self' }],
  ['npx serve .', null],
  [undefined, { kind: 'self' }]
]) {
  const m = D.defaultPreviewMode(...args)
  ok(m === 'project' || m === 'forge', `defaultPreviewMode(${JSON.stringify(args)}) is one of the two modes`, m)
}

for (const preset of presets) {
  const box = D.siteViewport(preset)
  ok(box.w === preset.viewport.w, `${preset.id}: a site frame is the full viewport wide`)
  ok(
    box.h === preset.viewport.h - preset.insets.top - preset.insets.bottom,
    `${preset.id}: and shorter by both bars, because a website reserves neither`,
    `${box.h} vs ${preset.viewport.h}`
  )
  ok(box.h > 0 && box.h < preset.viewport.h, `${preset.id}: which still leaves a page to look at`)
}

/* ------------------------------------------------- the insets stay in step */

console.log('\ninsets match the phone app')
const css = readFileSync(new URL('../mobile/src/styles.css', import.meta.url), 'utf8')
for (const preset of presets) {
  const block = new RegExp(`body\\.sim-${preset.id}\\s*\\{[^}]*\\}`).exec(css)?.[0] ?? ''
  const top = /--sa-top:\s*(\d+(?:\.\d+)?)px/.exec(block)?.[1]
  const bottom = /--sa-bottom:\s*(\d+(?:\.\d+)?)px/.exec(block)?.[1]
  ok(
    top !== undefined && Number(top) === preset.insets.top,
    `${preset.id}: the desk's status bar height is the app's simulated top inset`,
    `${top} vs ${preset.insets.top}`
  )
  ok(
    bottom !== undefined && Number(bottom) === preset.insets.bottom,
    `${preset.id}: the desk's home bar sits in the app's simulated bottom inset`,
    `${bottom} vs ${preset.insets.bottom}`
  )
}

/* ------------------------------------------------------------- source sweep */

console.log('\nsource sweep')
ok(
  /:root\s*\{[^}]*--sa-top:\s*env\(safe-area-inset-top, 0px\)/s.test(css),
  'styles.css defines --sa-top from env() in :root'
)
ok(
  /:root\s*\{[^}]*--sa-bottom:\s*env\(safe-area-inset-bottom, 0px\)/s.test(css),
  'and --sa-bottom'
)
ok(
  !/env\(safe-area-inset-(?!top, 0px\)|bottom, 0px\))/.test(css),
  'no bare env(safe-area-inset-*) outside the :root definitions — every usage site reads the var',
  (css.match(/env\(safe-area-inset-(?!top, 0px\)|bottom, 0px\))/g) ?? []).join(' ')
)

const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8')
ok(
  html.includes('frame-src http://localhost:* http://127.0.0.1:* https:'),
  "index.html's CSP lets the two loopback frames exist, and a manual URL be a real site"
)
ok(
  html.includes("connect-src 'self' ws: wss: http://localhost:* http://127.0.0.1:*"),
  "and lets the liveness probe reach either loopback host — probeTarget's whole rule",
  'a probe the CSP blocks rejects exactly like a refused connection, i.e. it reports a live server dead'
)
ok(
  html.includes("script-src 'self' 'unsafe-inline' 'unsafe-eval'"),
  'the loose dev script-src is byte-identical to what the build plugin swaps out',
  'electron.vite.config.ts string-matches it — a reworded CSP ships unhardened'
)

/* The Start button's wiring, end to end. Three files have to agree for a click
 * to reach a package.json, and a probe that says "nothing is answering" with no
 * button under it is exactly the state this feature exists to get out of. */
const main = readFileSync(new URL('../electron/main.ts', import.meta.url), 'utf8')
ok(
  main.includes('ipcMain.handle(IPC.previewDevCommand'),
  'main registers the dev-script sniff the empty states offer'
)
ok(
  /DEV_SCRIPTS = \['dev', 'start', 'serve', 'preview'\]/.test(main),
  'and looks for the four script names in that order — `dev` before `preview`, which serves a build'
)
// The function's own body, from its `function` line to the closing brace in
// column 0 — main.ts spawns plenty of things elsewhere, and this asks about one
// of them.
const sniff = /^function previewDevCommand[\s\S]*?^}/m.exec(main)?.[0] ?? ''
ok(
  sniff !== '' && !/spawn|exec|child_process|shell\./.test(sniff),
  'the sniff reads and never runs — the command it finds is typed into a pane, in front of somebody',
  sniff === '' ? 'previewDevCommand not found in main.ts' : ''
)
ok(/readFileSync\(join\(dir, 'package\.json'\)/.test(sniff), 'and the one file it reads is the folder’s package.json')
ok(
  /app\.getAppPath\(\)[\s\S]{0,60}?return \{ kind: 'self' \}/.test(sniff),
  "this checkout answers `{ kind: 'self' }` rather than null — `npm run dev` here is a second Forge on top of the first",
  'the renderer needs to tell "no command" from "not this folder" to offer the Forge Mobile mode instead'
)
ok(/return \{ kind: 'command'/.test(sniff), 'and a real find is tagged as one')
const bridge = readFileSync(new URL('../electron/preload.ts', import.meta.url), 'utf8')
ok(bridge.includes('IPC.previewDevCommand'), 'and the renderer has a door to it')

/* The typed command is only useful if it survives a restart, and the workspace
 * sanitiser is a whitelist — a field missing from it is silently dropped on
 * every load, which has already happened once to this very feature. */
const appState = readFileSync(new URL('../src/state/AppState.tsx', import.meta.url), 'utf8')
ok(
  /isDevCommandString\(ws\.devCommand\)\s*\?\s*\{\s*devCommand:/.test(appState),
  'sanitiseWorkspace keeps devCommand, so a typed start command is still there next launch',
  'the whitelist drops anything it does not name'
)

const host = readFileSync(new URL('../electron/mobile-host.ts', import.meta.url), 'utf8')
ok(
  host.includes('IPC.mobilePreviewPair'),
  'the preview mint channel is registered beside the QR one'
)
ok(/web:\s*!!mobileWebRoot\(\)/.test(host), 'mobile status reports whether a bundle is servable')

/* -------------------------------------------------------------------- end */

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} passed, ${fail} failed\n`)
process.exit(fail === 0 ? 0 : 1)
