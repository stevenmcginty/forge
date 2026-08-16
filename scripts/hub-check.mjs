/**
 * The floating voice hub, held to its rules.
 *
 *   node scripts/hub-check.mjs      (npm run hub:check)
 *
 * Two halves, because the hub can break in two quite different ways.
 *
 * 1. ARITHMETIC. Where the hub is, how big it is, what it turns into next and
 *    what survives a restart all live in src/lib/voicehub.ts with no DOM in
 *    them, exactly like the mosaic's geometry — so they can be checked here
 *    rather than by dragging a pill about and hoping. A hub that clamps wrong
 *    is a hub you can throw off the edge of the window and never get back.
 *
 * 2. ONE HEADLESS ENGINE. The hub is now the *only* surface — Steve had the
 *    right-hand panel deleted — and the agent has to work whether it is on
 *    screen or not: a message from his phone must still be answered, and memory
 *    still written, with the hub docked and nothing rendered. That only holds
 *    while the pipeline lives above the app rather than inside a surface, so
 *    the second half of this file reads the source and insists on it: exactly
 *    one of each subscription, all of them in the provider, none in the hub,
 *    the providers wrapping the whole app, and the panel genuinely gone rather
 *    than merely unrendered.
 */
import { existsSync, readFileSync } from 'node:fs'
import { registerHooks } from 'node:module'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

registerHooks({
  resolve(spec, context, next) {
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

const H = await import('../src/lib/voicehub.ts')
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const read = (rel) => readFileSync(join(ROOT, rel), 'utf8')
const count = (text, needle) => text.split(needle).length - 1
/**
 * Code with the comments taken out.
 *
 * Needed by the checks that forbid a *call*, because the comment right above
 * such a call almost always has to name the thing it is forbidding — "never
 * `show()`", "it is tempting to pass `parent:`". A check that read the comments
 * too would be a check that punished the explanation, which is exactly
 * backwards: those comments are the reason the rule survives.
 */
const decomment = (text) => text.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(?<!:)\/\/[^\n]*/g, ' ')

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
const at = (p) => `${p.x},${p.y}`

/** A 1440×900 window with Forge's chrome on it. */
const VIEW = { w: 1440, h: 900 }
const BOUNDS = H.hubBounds(VIEW, { top: 0, bottom: 0 })

/* ------------------------------------------------------------------ sizes */

console.log('\nsizes')
const placed = (mode, w = 0, h = 0) => ({ mode, x: 0, y: 0, w, h })
ok(H.hubSize(placed('floating')).w === H.HUB_PILL_SIZE.w, 'floating is the pill')
ok(H.hubSize(placed('expanded')).w === H.HUB_CARD_SIZE.w, 'an unresized card is the default card')
ok(H.hubSize(placed('docked')).w === H.HUB_PILL_SIZE.w, 'docked measures as a pill — it is the thing that flies home')
ok(H.HUB_CARD_SIZE.w > H.HUB_PILL_SIZE.w && H.HUB_CARD_SIZE.h > H.HUB_PILL_SIZE.h, 'the card is bigger both ways')
ok(H.hubSize(placed('expanded', 500, 700)).h === 700, 'a resized card keeps the size he dragged it to')
ok(H.hubSize(placed('floating', 500, 700)).w === H.HUB_PILL_SIZE.w, 'and a pill ignores it — a pill is a pill')

/*
 * The card is the only surface now, so it has to be big enough to read a
 * drafted prompt in — the right-hand panel used to be the place you did that.
 */
ok(H.HUB_CARD_SIZE.w >= 420 && H.HUB_CARD_SIZE.h >= 560, 'the default card is at least 420×560')

console.log('\ncorner resize — what replaced the panel resizer')
const roomy = H.hubBounds({ w: 1920, h: 1200 }, { top: 0, bottom: 0 })
ok(H.clampCardSize({ w: 520, h: 640 }, roomy).w === 520, 'a sensible size is taken as given')
ok(H.clampCardSize({ w: 10, h: 10 }, roomy).w === H.HUB_CARD_MIN.w, 'it cannot be shrunk into nothing')
ok(H.clampCardSize({ w: 5000, h: 5000 }, roomy).w === H.HUB_CARD_MAX.w, 'nor grown past the maximum')
ok(
  H.clampCardSize({ w: 5000, h: 5000 }, BOUNDS).h <= VIEW.h,
  'and never past the window, whatever the maximum says',
  String(H.clampCardSize({ w: 5000, h: 5000 }, BOUNDS).h)
)
ok(
  H.clampCardSize({ w: 100, h: 100 }, H.hubBounds({ w: 300, h: 200 }, { top: 0, bottom: 0 })).w === H.HUB_CARD_MIN.w,
  'in a tiny window the minimum still wins — a composer you cannot reach is worse than an overflow'
)

/* -------------------------------------------------------- state machine */

console.log('\nstate machine')
ok(H.nextHubMode('docked', 'dragOut') === 'floating', 'dragging the docked pill out floats it')
ok(H.nextHubMode('floating', 'expand') === 'expanded', 'a floating pill expands into the card')
ok(H.nextHubMode('floating', 'toggle') === 'expanded', 'double-click on the pill expands')
ok(H.nextHubMode('expanded', 'toggle') === 'floating', 'and double-click on the card header goes back')
ok(H.nextHubMode('expanded', 'minimise') === 'floating', 'minimise leaves the card at the pill')
ok(H.nextHubMode('expanded', 'escape') === 'floating', 'Esc collapses expanded → floating')
ok(H.nextHubMode('floating', 'escape') === 'floating', 'Esc on the pill does NOT dismiss it')
ok(H.nextHubMode('floating', 'dock') === 'docked', 'a pill dropped on its dock goes home')
ok(H.nextHubMode('expanded', 'dock') === 'docked', 'the card can be sent home in one move')
ok(H.nextHubMode('docked', 'dock') === 'docked', 'docking an already-docked hub is a no-op')
ok(H.nextHubMode('docked', 'minimise') === 'docked', 'undefined moves leave the mode alone')

// Every mode must be both reachable and escapable, or the hub can be lost.
const MODES = ['docked', 'floating', 'expanded']
const EVENTS = ['dragOut', 'expand', 'minimise', 'escape', 'dock', 'toggle']
for (const mode of MODES) {
  const reachable = MODES.some((from) => from !== mode && EVENTS.some((e) => H.nextHubMode(from, e) === mode))
  const escapable = EVENTS.some((e) => H.nextHubMode(mode, e) !== mode)
  ok(reachable, `${mode} is reachable from somewhere else`)
  ok(escapable, `${mode} can be left`)
}
ok(
  MODES.every((m) => EVENTS.every((e) => MODES.includes(H.nextHubMode(m, e)))),
  'no transition can produce a mode that does not exist'
)
ok(H.isFloatingHub('floating') && H.isFloatingHub('expanded') && !H.isFloatingHub('docked'), 'isFloatingHub')

/* -------------------------------------------------------------- clamping */

console.log('\nclamping')
const pill = H.HUB_PILL_SIZE
const inside = H.clampHubPos({ x: 400, y: 300 }, pill, BOUNDS)
ok(inside.x === 400 && inside.y === 300, 'a position already inside is left alone', at(inside))

const offLeft = H.clampHubPos({ x: -500, y: 300 }, pill, BOUNDS)
ok(offLeft.x === H.HUB_EDGE, 'dragged off the left edge comes back', at(offLeft))

const offRight = H.clampHubPos({ x: 99999, y: 300 }, pill, BOUNDS)
ok(offRight.x === VIEW.w - H.HUB_EDGE - pill.w, 'dragged off the right edge comes back', at(offRight))

const offTop = H.clampHubPos({ x: 400, y: -900 }, pill, BOUNDS)
ok(offTop.y === H.HUB_EDGE, 'dragged off the top comes back', at(offTop))

const offBottom = H.clampHubPos({ x: 400, y: 99999 }, pill, BOUNDS)
ok(offBottom.y === VIEW.h - H.HUB_EDGE - pill.h, 'dragged off the bottom comes back', at(offBottom))

// The whole card must stay reachable, not merely its top-left corner.
const cardFarRight = H.clampHubPos({ x: 5000, y: 5000 }, H.HUB_CARD_SIZE, BOUNDS)
ok(
  cardFarRight.x + H.HUB_CARD_SIZE.w <= VIEW.w && cardFarRight.y + H.HUB_CARD_SIZE.h <= VIEW.h,
  'the whole card stays on screen, not just its corner',
  at(cardFarRight)
)

// A window smaller than the card still has to put it somewhere visible.
const tiny = H.hubBounds({ w: 320, h: 240 }, { top: 0, bottom: 0 })
const squeezed = H.clampHubPos({ x: 200, y: 200 }, H.HUB_CARD_SIZE, tiny)
ok(squeezed.x === H.HUB_EDGE && squeezed.y === H.HUB_EDGE, 'in a window too small, the floor wins', at(squeezed))

ok(Number.isInteger(H.clampHubPos({ x: 10.6, y: 20.4 }, pill, BOUNDS).x), 'positions come back as whole pixels')

const chromed = H.hubBounds(VIEW, { top: 38, bottom: 26 })
ok(
  H.clampHubPos({ x: 0, y: 0 }, pill, chromed).y === 38 + H.HUB_EDGE,
  'chrome is respected — the hub never covers the titlebar'
)

/* ------------------------------------------------------------ the magnet */

console.log('\ndock magnet')
const dock = H.dockPoint(BOUNDS)
ok(dock.x < VIEW.w && dock.x > VIEW.w - 200, 'the dock is the bottom-right corner', at(dock))

const onTop = { x: dock.x - pill.w / 2, y: dock.y - pill.h / 2 }
ok(H.isNearDock(onTop, pill, dock), 'a pill sitting on the dock is near it')
ok(H.isNearDock({ x: onTop.x - 60, y: onTop.y - 40 }, pill, dock), 'and one just above and left of it still is')
ok(!H.isNearDock({ x: 40, y: 40 }, pill, dock), 'one across the window is not')
ok(!H.isNearDock({ x: onTop.x - 300, y: onTop.y }, pill, dock), 'nor one 300px away')

// The magnet must be a *rim*, not a half-screen: exactly at the radius, in.
const rim = { x: onTop.x - H.HUB_DOCK_RADIUS, y: onTop.y }
ok(H.isNearDock(rim, pill, dock), 'exactly on the radius counts as near')
ok(!H.isNearDock({ x: rim.x - 1, y: rim.y }, pill, dock), 'one pixel outside it does not')

const first = H.defaultHubPos(pill, BOUNDS)
ok(
  first.x >= H.HUB_EDGE && first.x + pill.w <= VIEW.w && first.y + pill.h <= VIEW.h,
  'the first drag-out lands on screen',
  at(first)
)
ok(!H.isNearDock(first, pill, dock), 'and clear of the magnet, so it does not snap straight back')

/* ----------------------------------------------------------- persistence */

console.log('\npersistence')
const saved = { mode: 'expanded', x: 420, y: 96, w: 500, h: 640 }
const round = H.sanitiseHubPlacement(JSON.parse(JSON.stringify(saved)))
ok(
  round.mode === 'expanded' && round.x === 420 && round.y === 96 && round.w === 500 && round.h === 640,
  'a good placement survives the round trip, size and all'
)
ok(H.sanitiseHubPlacement({ mode: 'expanded', w: 20, h: 20 }).w === H.HUB_CARD_MIN.w, 'a silly saved size is clamped')
ok(H.sanitiseHubPlacement({ mode: 'expanded', w: 0, h: 0 }).w === 0, 'zero survives — it means "the default card"')
ok(H.sanitiseHubPlacement({ mode: 'expanded', w: 'wide' }).w === 0, 'and so does junk, which means the same thing')
ok(H.DEFAULT_HUB.w === 0 && H.DEFAULT_HUB.h === 0, 'a fresh install has never resized the card')
ok(H.sanitiseHubPlacement(undefined).mode === 'docked', 'no saved hub means docked')
ok(H.sanitiseHubPlacement(null).x === 0, 'null is not a crash')
ok(H.sanitiseHubPlacement({ mode: 'wide-open', x: 5, y: 5 }).mode === 'docked', 'a nonsense mode falls back to docked')
ok(H.sanitiseHubPlacement({ mode: 'floating', x: NaN, y: 3 }).x === 0, 'NaN is not a position')
ok(H.sanitiseHubPlacement({ mode: 'floating', x: '40', y: 3 }).x === 0, 'a string is not a position either')
ok(H.sanitiseHubPlacement({ mode: 'floating', x: 40.6, y: 3.2 }).x === 41, 'positions are rounded on the way in')
ok(H.sanitiseHubPlacement({ mode: 'floating', x: 1e9, y: 0 }).x === 1e9, 'an absurd position is kept, then clamped')
ok(
  H.clampHubPos(H.sanitiseHubPlacement({ mode: 'floating', x: 1e9, y: 1e9 }), pill, BOUNDS).x <= VIEW.w,
  'a hub saved on a bigger monitor comes back on screen'
)
ok(H.DEFAULT_HUB.mode === 'docked', 'a fresh install is docked')

/* --------------------------------------------------------- agent routing */

console.log('\nagent surfaces')
const surface = (mode) => H.agentSurfaceOpen({ voiceHub: { mode, x: 0, y: 0, w: 0, h: 0 } })
ok(surface('floating'), 'a floating pill carries the round button, so it is an agent surface')
ok(surface('expanded'), 'so is the hub card')
ok(!surface('docked'), 'a docked hub is dictation only — nowhere for an agent phrase to go')

/* -------------------------------------------------- the panel is really gone */

console.log('\nthe right-hand panel is gone')
const app = read('src/App.tsx')
const hub = read('src/components/VoiceHub.tsx')
const surfaceParts = read('src/components/VoiceSurface.tsx')
const settingsType = read('shared/types.ts')
const store = read('electron/store.ts')

ok(!existsSync(join(ROOT, 'src/components/VoicePanel.tsx')), 'the component file is deleted, not merely unused')
ok(!existsSync(join(ROOT, 'src/components/VoicePanel.css')), 'and so is its stylesheet')
ok(existsSync(join(ROOT, 'src/components/VoiceSurface.css')), 'its parts kept their styles, renamed to the surface')
ok(!app.includes('VoicePanel'), 'App does not render it')
ok(!/className="voice"/.test(hub + surfaceParts + app), 'nothing renders the <aside class="voice"> any more')
ok(!/\.voice\s*\{/.test(read('src/components/VoiceSurface.css')), 'and the aside has no styles left to wear')

/*
 * The settings keys go with it, or an old settings.json quietly keeps a panel
 * that no longer exists and nobody can explain the stale width in the file.
 *
 * Matched as *code* — `voicePanelOpen:`, `toggleVoicePanel(` — rather than as a
 * bare word, because the comments that explain the deletion name them, and a
 * check that forbade saying why would be a check that punished the explanation.
 */
for (const dead of ['voicePanelOpen', 'voicePanelWidth']) {
  ok(!new RegExp(`${dead}\\s*[:?]`).test(settingsType), `Settings declares no ${dead}`)
  ok(!store.includes(`${dead}:`), `and the store neither defaults nor normalises ${dead}`)
}
for (const [name, src] of [
  ['AppState', read('src/state/AppState.tsx')],
  ['useShortcuts', read('src/hooks/useShortcuts.ts')],
  ['TitleBar', read('src/components/TitleBar.tsx')]
]) {
  ok(
    !/settings\.voicePanel/.test(src) && !/toggleVoicePanel\s*[(:]/.test(src),
    `${name} has no panel plumbing left`
  )
}
ok(read('src/hooks/useShortcuts.ts').includes('toggleVoiceHubCard'), 'Ctrl+Shift+G opens the hub card instead')
ok(read('src/components/TitleBar.tsx').includes('toggleVoiceHubCard'), 'and so does the titlebar button')

// Everything the panel offered has to be reachable in the card. This is the
// list of parts it used to render.
for (const part of ['VoiceDial', 'VoiceLog', 'VoiceComposer', 'ReplyModeToggle', 'BrainChip', 'DegradedLink', 'LastLine']) {
  ok(hub.includes(`<${part}`), `${part} lives on in the hub card`)
}
ok(surfaceParts.includes('Send to pane'), 'the send-to-pane picker came across too')

/* ------------------------------------------------------- one headless engine */

console.log('\none engine, and it is headless')
const provider = read('src/state/VoiceAgent.tsx')
const dictation = read('src/hooks/useDictation.ts')
const dictProvider = read('src/state/Dictation.tsx')
const entry = read('src/main.tsx')

/** Things that must exist exactly once in the whole renderer. */
const singletons = [
  ['transcriptBus.onPhrase(', 'the transcript subscription', provider],
  ['companion.onUtterance(', 'the phone subscription', provider],
  ['voiceSpeaker.speakOnce(', 'the mouth', provider],
  ['stt.onPhrase(', 'the dictated-phrase subscription', dictation]
]
for (const [needle, what, owner] of singletons) {
  ok(count(owner, needle) === 1, `${what} exists exactly once, in its provider`)
  for (const [name, src] of [
    ['VoiceHub', hub],
    ['VoiceSurface', surfaceParts]
  ]) {
    if (src === owner) continue
    ok(count(src, needle) === 0, `${name} does not own ${what}`)
  }
}

ok(count(provider, 'stt.onStatus(') === 1, 'the agent reads the sidecar status once')
ok(count(dictation, 'stt.onStatus(') === 1, 'and dictation reads it once — a read, not a second microphone')
ok(count(hub, 'stt.onStatus(') === 0, 'the hub subscribes to nothing at all')

/*
 * The whole point of the lift: the pipeline is mounted above the app, not
 * inside a surface, so a phrase from the phone is answered and memory is
 * written with the hub docked and nothing on screen.
 */
ok(count(entry, '<VoiceAgentProvider>') === 1, 'the voice agent is mounted once, at the root')
ok(count(entry, '<DictationProvider>') === 1, 'and so is dictation')
ok(entry.includes('<App />'), 'both wrap the whole app rather than living inside a surface')
ok(count(dictProvider, 'useDictationEngine()') === 1, 'the dictation engine has exactly one caller')
ok(count(hub, 'useDictationEngine') === 0, 'no surface calls the engine directly')

// The runner the panel used to assemble came across whole. These are the
// members that have no other test coverage from the outside.
for (const member of ['makeVideo:', 'makeImage:', 'editImage:', 'recallMemory:', 'forgetMemory:', 'sendPrompt:', 'closeMany:', 'createProject:']) {
  ok(provider.includes(member), `the runner still has ${member.replace(':', '')}`)
}
ok(count(provider, 'agentMemory.record(') >= 2, 'memory is still written for commands and for brain turns')
ok(provider.includes('agentMemory.prime('), 'and still primed per project')

/* ------------------------------------------------------- main/renderer parity */

console.log('\nmain and renderer agree')
ok(/voiceHub: hubPlacement\(s\.voiceHub\)/.test(store), 'the store sanitises the saved hub')
ok(/mode: 'docked', x: 0, y: 0, w: 0, h: 0/.test(store), "the store's default hub is docked, unplaced, unresized")
ok(
  ["'floating'", "'expanded'", "'docked'"].every((m) => store.includes(`v.mode === ${m}`)),
  'the store accepts the same three modes the renderer does'
)
ok(H.DEFAULT_HUB.x === 0 && H.DEFAULT_HUB.y === 0, 'and the renderer default matches it')
// The card's size limits are duplicated in main, which cannot import them.
const dims = /dim\(v\.w, (\d+), (\d+)\), h: dim\(v\.h, (\d+), (\d+)\)/.exec(store)
ok(
  dims &&
    Number(dims[1]) === H.HUB_CARD_MIN.w &&
    Number(dims[2]) === H.HUB_CARD_MAX.w &&
    Number(dims[3]) === H.HUB_CARD_MIN.h &&
    Number(dims[4]) === H.HUB_CARD_MAX.h,
  "the store's card-size limits are the same four numbers as the renderer's",
  dims ? dims.slice(1).join(',') : 'no dim() call found'
)

const css = read('src/components/VoiceHub.css')
ok(css.includes(`--hub-snap: ${H.HUB_SNAP_MS}ms`), 'the snap-home duration in CSS matches the one in code')
ok(css.includes('prefers-reduced-motion'), 'the hub respects reduced motion')
ok(css.includes('z-index: var(--z-hub)'), 'the hub sits on the shared z scale, not a magic number')
const tokens = read('src/theme/tokens.css')
const z = (name) => Number(new RegExp(`--z-${name}: (\\d+)`).exec(tokens)?.[1] ?? NaN)
ok(z('hub') > z('settings'), 'the hub floats over the panes and the settings page', `${z('hub')} vs ${z('settings')}`)
ok(z('hub') < z('popover') && z('hub') < z('toast'), 'and under popovers and toasts, which open on top of it')
ok(/width: 180px/.test(css) && /height: 56px/.test(css), 'the floating pill is the size the code clamps for')
// The card's size is written inline from the store, so the CSS must NOT also
// state one — two sources for the same number is how they end up disagreeing.
ok(!/\.vhub--card\s*\{[^}]*width:/.test(css), 'the card takes its size from the placement, not from CSS')
ok(hub.includes('style={{ width: hubSize(hub).w, height: hubSize(hub).h }}'), 'and the card really is sized from it')
ok(css.includes('.vhub__grow'), 'the corner resizer that replaced the panel resizer is styled')

/* ------------------------------------------------- the overlay is a window */

/*
 * Undocking opens a real always-on-top Windows window now, because that is the
 * only way to be over Chrome and to survive Forge being minimised — a <div>
 * inside Forge is behind whatever is covering Forge, by construction.
 *
 * That buys three new ways to break the hub, and none of them is visible in a
 * screenshot:
 *
 *   1. THE WINDOW STOPS FLOATING. A child window, or the default 'floating'
 *      level, and it slips behind a maximised Chrome — which is the exact case
 *      that was asked for.
 *   2. THE WINDOW BECOMES OPAQUE. One background declaration on body and the
 *      pill is a black rectangle sitting over somebody else's application.
 *   3. THE OVERLAY BECOMES A SECOND AGENT. This is the bad one. It is a second
 *      renderer running the same bundle, so one stray provider gives it its own
 *      transcript subscription, its own sidecar loop and its own mouth — and
 *      the symptom is every sentence answered twice, in two voices, a beat
 *      apart. The whole architecture exists to make that impossible; these
 *      checks are what keep it impossible.
 */

console.log('\nthe overlay is a real window')
const overlayMain = read('electron/overlay-window.ts')
const overlayApp = read('src/overlay/OverlayApp.tsx')
const overlayHost = read('src/state/OverlayHost.tsx')
const overlayCss = read('src/overlay/OverlayApp.css')
const entryMain = read('src/main.tsx')

ok(overlayMain.includes("setAlwaysOnTop(true, 'screen-saver')"), "it floats at the screen-saver level, which beats a maximised Chrome")
ok(/alwaysOnTop:\s*true/.test(overlayMain), 'and is created always-on-top rather than promoted later')
ok(/skipTaskbar:\s*true/.test(overlayMain), 'it is not a taskbar button')
ok(/transparent:\s*true/.test(overlayMain), 'it is transparent, so the pill is a pill and not a box')
ok(/frame:\s*false/.test(overlayMain), 'and frameless')
ok(overlayMain.includes('showInactive()'), 'it appears without stealing focus from whatever he is typing in')
// Code only — the comment above the call has to name the thing it forbids.
const overlayCode = decomment(overlayMain)
ok(!/\.show\(\)/.test(overlayCode), 'and never show(), which would')
ok(overlayMain.includes('backgroundThrottling: false'), 'Chromium does not throttle it for being in the background — which it always is')
ok(overlayMain.includes('visibleOnFullScreen: true'), 'it stays up over a fullscreen window')

/*
 * The one that makes "works when the app is minimised" true. A child window
 * minimises, hides and restores WITH its parent, so `parent: mainWindow` would
 * quietly delete the headline feature while looking tidier.
 */
ok(!/\bparent:/.test(overlayCode), 'the overlay is NOT a child window — a child would minimise with Forge')

// The relay must stay a relay. The moment main starts reading a snapshot, the
// contract between the two renderers has a third opinion in it.
ok(
  !/snapshot\.(phase|turns|armed|draftPhrase)/.test(overlayMain),
  'the main process forwards payloads without looking inside them'
)
ok(overlayMain.includes('disposeOverlay'), 'and an always-on-top window cannot outlive the app')
// The quit path funnels every disposer through `safely(name, fn)` — matching
// either spelling, not just the bare call, so the wrapper cannot quietly
// orphan the overlay while looking tidier.
ok(
  /disposeOverlay\(\)|safely\('disposeOverlay',\s*disposeOverlay\)/.test(read('electron/main.ts')),
  'which main actually calls on the way out'
)
ok(read('electron/main.ts').includes('setOverlayHost(null)'), 'losing the host takes the overlay with it')

console.log('\nthe overlay paints nothing opaque')
ok(/body[^{]*\{[^}]*background:\s*transparent/s.test(overlayCss), 'body is transparent, not themed')
ok(overlayCss.includes('-webkit-app-region: drag'), 'the pill body is a drag region — Windows moves the window')
ok(count(overlayCss, '-webkit-app-region: no-drag') >= 4, 'and every control inside it opts back out, or it cannot be clicked')

console.log('\nthe overlay is a view, not a second agent')
ok(entryMain.includes('window.forge.overlay.isOverlay()'), 'the entry branches on which window it is in')
ok(
  /isOverlay\(\)\s*\)\s*\{\s*root\.render\(<OverlayApp \/>\)/.test(entryMain),
  'and the overlay gets OverlayApp alone — no providers'
)
for (const provider of ['AppStateProvider', 'DictationProvider', 'VoiceAgentProvider']) {
  ok(!overlayApp.includes(`<${provider}`), `the overlay does not mount ${provider}`)
}
// The same singleton list the in-window surfaces are held to. A second copy of
// any of these in the other renderer is the two-voices bug.
for (const [needle, what] of [
  ['transcriptBus.onPhrase(', 'the transcript subscription'],
  ['companion.onUtterance(', 'the phone subscription'],
  ['voiceSpeaker.speakOnce(', 'the mouth'],
  ['stt.onPhrase(', 'the dictated-phrase subscription'],
  ['stt.onStatus(', 'the sidecar status subscription'],
  ['stt.start(', 'starting the microphone']
]) {
  ok(count(overlayApp, needle) === 0, `the overlay does not own ${what}`)
}
ok(overlayApp.includes('VoiceAgentContext.Provider'), 'it provides a mirrored context instead')
ok(provider.includes('export const VoiceAgentContext'), 'which the agent exports for exactly that')
ok(!provider.includes('export function VoiceAgentProvider') || count(entryMain, '<VoiceAgentProvider>') === 1, 'and the real provider is still mounted exactly once')

// The parts are shared rather than reimplemented — that is what stops the two
// surfaces drifting apart the first time either is tuned.
for (const part of ['VoiceDial', 'VoiceLog', 'VoiceComposer', 'ReplyModeToggle', 'BrainChip', 'LastLine']) {
  ok(overlayApp.includes(`<${part}`), `the overlay reuses ${part} rather than copying it`)
}

console.log('\nthe host owns the window and the state')
ok(overlayHost.includes('return null'), 'OverlayHost renders nothing — it is wiring')
ok(overlayHost.includes('useVoiceAgent()'), 'it reads the one real agent')
ok(overlayHost.includes("kind: 'hello'") || overlayHost.includes("case 'hello'"), 'a freshly opened overlay is sent the current state, not just the next change')
ok(overlayHost.includes('pushLevel'), 'the mic level rides its own channel')
ok(
  !/turns:.*level/s.test(read('src/lib/overlaystate.ts').split('export interface OverlaySnapshot')[1]?.split('}')[0] ?? ''),
  'and is NOT in the snapshot, which would re-render a conversation 15 times a second'
)

/* ------------------------------------------------- always on, and full duplex */

console.log('\nalways listening')
/*
 * Steve, on what should decide whether something was meant for Forge:
 * "everything that I say needs to go into forge". So the surface-open condition
 * that used to gate routing is gone — a switch that flips itself back when you
 * dock the hub or click on Chrome is not a switch.
 */
ok(
  !/agentSurfaceOpen\(state\.settings\)\s*&&\s*state\.agentListening/.test(dictation),
  'dictation routes on the switch alone, not on whether a surface is visible'
)
ok(/const toAgent = state\.agentListening/.test(dictation), 'and the switch is the switch')
ok(
  !/if \(!surfaceOpen && armed\) actions\.setAgentListening\(false\)/.test(provider),
  'nothing disarms the agent behind his back'
)

/*
 * The other half of "nothing disarms it for you": something must still be able
 * to disarm it *when he asks*. The only agent button lives on the floating hub,
 * so an armed agent with the hub docked had no off switch on screen at all —
 * every phrase went to the agent, the agent acted on what it heard, and the one
 * control left in the status bar offered to open a second microphone. The
 * docked pill is the guarantee, and these two assertions are its terms: it must
 * tell the truth about where the words are going, and it must be able to stop
 * them going there.
 */
const dockedPill = read('src/components/DictationPill.tsx')
ok(
  /const toAgent = state\.agentListening/.test(dockedPill),
  'the docked pill shows agent mode by the same rule dictation routes by'
)
ok(/else if \(toAgent\) toggleAgent\(\)/.test(dockedPill), 'and clicking it while armed is the off switch')

/*
 * The blip means "your turn". A warm-up is not a turn: the sidecar stops itself
 * on silence and the re-arm loop restarts it, so an armed agent in an empty
 * room ran warming → listening every few seconds — and beeped every time.
 */
const handsBack = provider.split('const HANDS_BACK')[1]?.split(']')[0] ?? ''
ok(!handsBack.includes("'warming'"), 'and a warm-up does not blip — only a turn coming back does')

/*
 * Dictation gets its own pair — mic open, mic shut — because Right Ctrl is
 * pressed while looking at a terminal, not at the status bar.
 *
 * Two properties, and both matter. It hangs off the *phase*, so the hotkey, the
 * docked pill and the hub cannot sound different from each other and the beep
 * cannot arrive before the model has finished loading. And it is skipped while
 * the agent is armed: the agent shares this sidecar and re-starts it after
 * every auto-stop, which is the same metronome the assertion above guards.
 */
ok(
  dictation.includes('earconDictationOn()') && dictation.includes('earconDictationOff()'),
  'dictation beeps when the mic opens and when it shuts'
)
ok(
  /const capturing = status\.phase === 'listening'/.test(dictation),
  'and it beeps off the phase, so pressing the key sounds exactly like clicking the pill'
)
ok(
  /ourSession\.current = !toAgentRef\.current/.test(dictation),
  'an agent-owned session is not a dictation session, and does not beep'
)

console.log('\nfull duplex')
const bargein = read('src/lib/bargein.ts')
ok(provider.includes('bargeIn.arm('), 'the agent opens the echo-cancelled mic while it speaks')
ok(provider.includes('bargeIn.disarm()'), 'and closes it after — it is not held open all day')
ok(bargein.includes('echoCancellation: true'), 'echo cancellation is on, which is the entire reason this is safe')
/*
 * The anti-feedback rule that predates all of this MUST survive. The sidecar
 * has no AEC; if it were left running during a reply, Forge would transcribe
 * itself, answer itself, and keep going until the app was closed.
 */
ok(provider.includes('void window.forge.stt.stop()'), 'the raw sidecar is still stopped while speaking')
/*
 * Code only, and this one is worth being careful about rather than loose: the
 * property is that the AEC'd stream reaches a level meter and nothing else. If
 * it ever reached the sidecar, the transcript bus or a phrase handler, an open
 * microphone during a reply would be the old feedback loop again — Forge
 * hearing itself, answering, and never stopping.
 */
const bargeinCode = decomment(bargein)
for (const forbidden of ['transcri', 'sttPhrase', 'transcriptBus', 'forge.stt', 'onPhrase']) {
  ok(count(bargeinCode, forbidden) === 0, `the barge-in mic never touches ${forbidden} — it is a VAD, not an ASR`)
}
ok(bargeinCode.includes('getFloatTimeDomainData'), 'all it ever reads is a level')
ok(bargein.includes('ABSOLUTE_FLOOR'), 'there is an absolute floor the adaptive threshold cannot sink below')
ok(bargein.includes('setInterval'), 'it polls on a timer, not rAF — rAF does not run in a minimised window')
ok(read('electron/main.ts').includes("callback(permission === 'media')"), 'the renderer is actually allowed a microphone')
ok(
  read('src/lib/tts.ts').includes('duck(level: number)'),
  'and the reply can be turned down without being thrown away'
)

/* -------------------------------------------------------------- summary */

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} passed, ${fail} failed\n`)
process.exit(fail === 0 ? 0 : 1)
