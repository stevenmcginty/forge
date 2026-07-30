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

/* -------------------------------------------------------------- summary */

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} passed, ${fail} failed\n`)
process.exit(fail === 0 ? 0 : 1)
