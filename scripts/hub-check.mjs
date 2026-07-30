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
 * 2. ONE ENGINE. The hub shows the same conversation as the right-hand voice
 *    panel. If either surface ever grows its own subscription to the transcript
 *    bus, the sidecar or the speaker, then opening both would answer every
 *    sentence twice and say both answers out loud — the single worst bug this
 *    feature could have, and an invisible one until you hear it. So the second
 *    half of this file reads the source and insists there is exactly one of
 *    each, in the provider, and none in any surface.
 */
import { readFileSync } from 'node:fs'
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
ok(H.hubSize('floating').w === H.HUB_PILL_SIZE.w, 'floating is the pill')
ok(H.hubSize('expanded').w === H.HUB_CARD_SIZE.w, 'expanded is the card')
ok(H.hubSize('docked').w === H.HUB_PILL_SIZE.w, 'docked measures as a pill — it is the thing that flies home')
ok(H.HUB_CARD_SIZE.w > H.HUB_PILL_SIZE.w && H.HUB_CARD_SIZE.h > H.HUB_PILL_SIZE.h, 'the card is bigger both ways')

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
const saved = { mode: 'expanded', x: 420, y: 96 }
const round = H.sanitiseHubPlacement(JSON.parse(JSON.stringify(saved)))
ok(round.mode === 'expanded' && round.x === 420 && round.y === 96, 'a good placement survives the round trip')
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
const surface = (voicePanelOpen, mode) => H.agentSurfaceOpen({ voicePanelOpen, voiceHub: { mode, x: 0, y: 0 } })
ok(surface(true, 'docked'), 'the panel alone is an agent surface')
ok(surface(false, 'floating'), 'so is a floating pill with the panel closed')
ok(surface(false, 'expanded'), 'so is the hub card')
ok(surface(true, 'expanded'), 'both at once is still one surface')
ok(!surface(false, 'docked'), 'panel closed and hub docked is nowhere for a phrase to go')

/* ------------------------------------------------- one engine, not three */

console.log('\none engine')
const provider = read('src/state/VoiceAgent.tsx')
const panel = read('src/components/VoicePanel.tsx')
const hub = read('src/components/VoiceHub.tsx')
const surfaceParts = read('src/components/VoiceSurface.tsx')
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
    ['VoicePanel', panel],
    ['VoiceHub', hub],
    ['VoiceSurface', surfaceParts]
  ]) {
    if (src === owner) continue
    ok(count(src, needle) === 0, `${name} does not own ${what}`)
  }
}

ok(count(provider, 'stt.onStatus(') === 1, 'the agent reads the sidecar status once')
ok(count(dictation, 'stt.onStatus(') === 1, 'and dictation reads it once — a read, not a second microphone')
ok(count(panel, 'stt.onStatus(') + count(hub, 'stt.onStatus(') === 0, 'no surface subscribes to the sidecar')

// A provider mounted twice would be exactly as bad as a second subscription.
ok(count(entry, '<VoiceAgentProvider>') === 1, 'the voice agent is mounted once, at the root')
ok(count(entry, '<DictationProvider>') === 1, 'and so is dictation')
ok(count(dictProvider, 'useDictationEngine()') === 1, 'the dictation engine has exactly one caller')
ok(count(panel, 'useDictationEngine') + count(hub, 'useDictationEngine') === 0, 'no surface calls the engine directly')

// Both surfaces really do render the same parts — the point of the refactor.
for (const part of ['VoiceDial', 'VoiceLog', 'VoiceComposer', 'ReplyModeToggle', 'BrainChip']) {
  ok(panel.includes(`<${part}`) && hub.includes(`<${part}`), `${part} is shared by the panel and the hub`)
}

/* ------------------------------------------------------- main/renderer parity */

console.log('\nmain and renderer agree')
const store = read('electron/store.ts')
ok(/voiceHub: hubPlacement\(s\.voiceHub\)/.test(store), 'the store sanitises the saved hub')
ok(/mode: 'docked', x: 0, y: 0/.test(store), "the store's default hub is docked at 0,0")
ok(
  ["'floating'", "'expanded'", "'docked'"].every((m) => store.includes(`v.mode === ${m}`)),
  'the store accepts the same three modes the renderer does'
)
ok(H.DEFAULT_HUB.x === 0 && H.DEFAULT_HUB.y === 0, 'and the renderer default matches it')

const css = read('src/components/VoiceHub.css')
ok(css.includes(`--hub-snap: ${H.HUB_SNAP_MS}ms`), 'the snap-home duration in CSS matches the one in code')
ok(css.includes('prefers-reduced-motion'), 'the hub respects reduced motion')
ok(css.includes('z-index: var(--z-hub)'), 'the hub sits on the shared z scale, not a magic number')
const tokens = read('src/theme/tokens.css')
const z = (name) => Number(new RegExp(`--z-${name}: (\\d+)`).exec(tokens)?.[1] ?? NaN)
ok(z('hub') > z('settings'), 'the hub floats over the panes and the settings page', `${z('hub')} vs ${z('settings')}`)
ok(z('hub') < z('popover') && z('hub') < z('toast'), 'and under popovers and toasts, which open on top of it')
ok(/width: 180px/.test(css) && /height: 56px/.test(css), 'the floating pill is the size the code clamps for')
ok(/width: 380px/.test(css) && /height: 520px/.test(css), 'and so is the card')

/* -------------------------------------------------------------- summary */

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} — ${pass} passed, ${fail} failed\n`)
process.exit(fail === 0 ? 0 : 1)
