/**
 * Head-less proof of the television's cursor — the half that ends at Windows.
 *
 *   npm run input:check
 *
 * Three things are worth proving here and they are different in kind.
 *
 * **What may be expressed at all.** `readMirrorInput` is the only door between
 * a socket and a synthetic OS event, so it is driven with junk, with hostile
 * shapes, with numbers off the end of the screen and with keys nobody listed.
 * Everything that survives is one of five exact shapes; everything else is
 * null. The relay's own gating — only the screen that is watching, only under a
 * rate limit, only while the desktop says yes — is proved against a real socket
 * in `npm run mobile:smoke`, phase E.
 *
 * **What each of those becomes.** `lineFor` is the mapping from an input to the
 * one line the PowerShell helper performs, and it is asserted flag by flag:
 * the extended bit that tells the arrow keys apart from the numeric keypad, the
 * release bit, the sign of a wheel notch, the button masks out of WinUser.h.
 *
 * **The grammar the sofa has.** Six buttons reach the television's page, so
 * every meaning is built out of *how* one is pressed — tap, hold, hold-and-move
 * — and that is timing, which nobody can eyeball. The real `startPointer` is
 * driven against a clock this script owns and animation frames it calls by
 * hand, and everything it emits is fed back through the desktop's own validator.
 *
 * And on Windows, one live check that no amount of reading can replace: the
 * helper is started and waited on until it says it is ready. That proves this
 * machine will let a normal process compile a P/Invoke block and reach user32
 * at all — a locked-down policy fails here, at a keyboard, rather than the
 * first time somebody on a sofa presses OK.
 *
 * **Nothing here performs an input.** No line is ever written to the helper, so
 * running this does not move the cursor of whoever ran it.
 */
import { mkdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const ROOT = resolve(import.meta.dirname, '..')
const scratch = join(ROOT, 'node_modules', '.forge-input-check')
mkdirSync(scratch, { recursive: true })

let failures = 0
const log = (ok, message) => {
  if (!ok) failures++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${message}`)
}

const bundle = join(scratch, 'input.mjs')
await build({
  entryPoints: [join(ROOT, 'scripts', 'fixtures', 'input-entry.ts')],
  outfile: bundle,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  alias: { '@shared': join(ROOT, 'shared') },
  logLevel: 'silent',
  absWorkingDir: ROOT
})
const { readMirrorInput, lineFor, canDriveDesktop, probeDesktopInput, startPointer, MIRROR_KEYS, MAX_WHEEL_NOTCHES } = await import(
  pathToFileURL(bundle).href
)

/* ------------------------------------------- 1. what may be expressed at all */

const junk = [
  null,
  undefined,
  42,
  'move',
  [],
  {},
  { a: 'launch-missiles' },
  { a: 'move' },
  { a: 'move', x: '0.5', y: '0.5' },
  { a: 'move', x: 0.5 },
  { a: 'move', x: Number.NaN, y: 0.5 },
  { a: 'move', x: Number.POSITIVE_INFINITY, y: 0 },
  { a: 'down', x: 0.5, y: 0.5 },
  { a: 'down', button: 'fourth', x: 0.5, y: 0.5 },
  { a: 'wheel', x: 0.5, y: 0.5 },
  { a: 'wheel', wheel: 0, x: 0.5, y: 0.5 },
  { a: 'wheel', wheel: 0.2, x: 0.5, y: 0.5 },
  { a: 'key' },
  { a: 'key', key: 'f13', down: true },
  { a: 'key', key: 'enter' },
  { a: 'key', key: 'enter', down: 'yes' }
]
log(
  junk.every((value) => readMirrorInput(value) === null),
  `every one of ${junk.length} malformed or hostile inputs is refused, and none throws`
)

const moved = readMirrorInput({ a: 'move', x: 0.25, y: 0.75 })
log(moved?.a === 'move' && moved.x === 0.25 && moved.y === 0.75, 'a well-formed move survives with its coordinates')

const clamped = readMirrorInput({ a: 'move', x: 9, y: -9 })
log(clamped?.x === 1 && clamped?.y === 0, 'a coordinate off the end of the screen is clamped to the edge, not refused')

const huge = readMirrorInput({ a: 'wheel', wheel: 9999, x: 0, y: 0 })
log(huge?.wheel === MAX_WHEEL_NOTCHES, 'a wheel turned further than any hand could is capped')
const backwards = readMirrorInput({ a: 'wheel', wheel: -9999, x: 0, y: 0 })
log(backwards?.wheel === -MAX_WHEEL_NOTCHES, 'and capped the other way too')

log(
  MIRROR_KEYS.every((key) => readMirrorInput({ a: 'key', key, down: true })?.key === key),
  `all ${MIRROR_KEYS.length} listed keys are accepted, and nothing outside the list is`
)

// The property that matters more than any single case above: whatever survives
// is one of five shapes, with no field that was not checked into it.
const survivors = [
  { a: 'move', x: 0.5, y: 0.5, extra: 'ignored' },
  { a: 'down', button: 'right', x: 0, y: 0, sneak: { toString: () => 'x' } },
  { a: 'key', key: 'escape', down: false, cmd: 'rm -rf' }
].map((value) => readMirrorInput(value))
log(
  survivors.every((input) => input !== null && !('extra' in input) && !('sneak' in input) && !('cmd' in input)),
  'a frame carrying extra fields loses them: what comes out is rebuilt, never passed through'
)

/* --------------------------------------------- 2. what each of those becomes */

const at = { x: 1280, y: 720 }
log(lineFor({ a: 'move', x: 0.5, y: 0.5 }, at) === 'm 1280 720', 'a move becomes a SetCursorPos at whole pixels')
log(lineFor({ a: 'move', x: 0.5, y: 0.5 }, { x: 100.6, y: 40.2 }) === 'm 101 40', 'and a fractional pixel is rounded')

// MOUSEEVENTF_*, from WinUser.h. Written out here rather than imported so the
// check would fail if the table in input.ts were edited to something else.
log(lineFor({ a: 'down', button: 'left', x: 0, y: 0 }, at) === `b 2 ${at.x} ${at.y}`, 'left down is 0x0002')
log(lineFor({ a: 'up', button: 'left', x: 0, y: 0 }, at) === `b 4 ${at.x} ${at.y}`, 'left up is 0x0004')
log(lineFor({ a: 'down', button: 'right', x: 0, y: 0 }, at) === `b 8 ${at.x} ${at.y}`, 'right down is 0x0008')
log(lineFor({ a: 'up', button: 'right', x: 0, y: 0 }, at) === `b 16 ${at.x} ${at.y}`, 'right up is 0x0010')
log(lineFor({ a: 'down', button: 'middle', x: 0, y: 0 }, at) === `b 32 ${at.x} ${at.y}`, 'middle down is 0x0020')
log(lineFor({ a: 'up', button: 'middle', x: 0, y: 0 }, at) === `b 64 ${at.x} ${at.y}`, 'middle up is 0x0040')

log(lineFor({ a: 'wheel', wheel: 1, x: 0, y: 0 }, at) === `w 120 ${at.x} ${at.y}`, 'one notch of wheel is WHEEL_DELTA')
log(lineFor({ a: 'wheel', wheel: -3, x: 0, y: 0 }, at) === `w -360 ${at.x} ${at.y}`, 'and three the other way is -360')

// The extended bit is the whole reason the key table has a second column: the
// arrows share scancodes with the numeric keypad, and without it an
// application receives a digit where the sofa pressed a direction.
log(lineFor({ a: 'key', key: 'enter', down: true }, at) === 'k 13 0', 'Enter goes down as a plain key')
log(lineFor({ a: 'key', key: 'enter', down: false }, at) === 'k 13 2', 'and comes up with KEYEVENTF_KEYUP')
log(lineFor({ a: 'key', key: 'left', down: true }, at) === 'k 37 1', 'Left carries the extended bit')
log(lineFor({ a: 'key', key: 'left', down: false }, at) === 'k 37 3', 'and carries it on the way up as well')
log(lineFor({ a: 'key', key: 'win', down: true }, at) === 'k 91 1', 'the Windows key is 0x5B, extended')

// Every line is four fields or fewer of digits and one letter — nothing a
// PowerShell `switch` could read as anything but an instruction.
const shapes = [
  ...MIRROR_KEYS.map((key) => lineFor({ a: 'key', key, down: true }, at)),
  lineFor({ a: 'move', x: 0.3, y: 0.3 }, at),
  lineFor({ a: 'wheel', wheel: -2, x: 0, y: 0 }, at),
  lineFor({ a: 'down', button: 'left', x: 0, y: 0 }, at)
]
log(
  shapes.every((line) => /^[mbwk](?: -?\d+){2,3}$/.test(line)),
  'every line the helper can be handed is one letter and two or three integers'
)

/* ------------------------------------------- 3. the grammar the remote has

   Six buttons reach the television's page, so the meanings are built out of
   *how* they are pressed: a tap of OK is a click, a hold that moves is a drag,
   a hold that stays still is a right-click. That is the part of this feature
   nobody can eyeball — it is timing — so it is driven here with a clock this
   script owns and animation frames it calls by hand.

   Everything the pointer emits is passed through `readMirrorInput`, which is
   the desktop's own door. A grammar that produced a frame the desk would
   refuse is the failure this pairing catches. */

let clock = 0
const frames = []
globalThis.window = globalThis
globalThis.performance = { now: () => clock }
globalThis.requestAnimationFrame = (fn) => {
  frames.push(fn)
  return frames.length
}
globalThis.cancelAnimationFrame = () => {}

/** Advance the fake clock and run one animation frame, as the browser would. */
const tick = (ms) => {
  clock += ms
  const next = frames.pop()
  frames.length = 0
  if (next) next()
}

function pointerHarness() {
  const sent = []
  const handle = startPointer({
    cursor: { style: {} },
    stage: { getBoundingClientRect: () => ({ width: 1920, height: 1080 }) },
    send: (frame) => sent.push(frame),
    onChange: () => {}
  })
  return { handle, sent, of: (a) => sent.filter((f) => f.a === a) }
}

const tapped = pointerHarness()
tapped.handle.key('Enter', true)
tapped.handle.key('Enter', false)
const clickPair = tapped.sent.slice(-2)
log(
  clickPair[0]?.a === 'down' && clickPair[1]?.a === 'up' && clickPair[0].button === 'left',
  'a tap of OK is a left button down and up, in that order'
)
log(
  clickPair[0].x === clickPair[1].x && clickPair[0].y === clickPair[1].y,
  'and both halves land on the same spot, so a click cannot straddle two places'
)
tapped.handle.stop()

const dragged = pointerHarness()
dragged.handle.key('Enter', true)
dragged.handle.key('ArrowRight', true)
tick(16)
tick(16)
const downs = dragged.of('down')
log(downs.length === 1 && downs[0].button === 'left', 'moving while OK is held presses the button exactly once')
log(dragged.of('move').length > 0, 'and the pointer keeps moving under it — that is the drag')
dragged.handle.key('Enter', false)
const release = dragged.sent.at(-1)
log(
  release.a === 'up' && release.x > downs[0].x,
  'and the button comes up where the drag ended, not where it began'
)
log(
  release.x >= (dragged.of('move').at(-1)?.x ?? 0),
  'from the pointer’s own position rather than the last one it happened to transmit — the throttle cannot displace a click'
)
dragged.handle.stop()

const abandoned = pointerHarness()
abandoned.handle.key('Enter', true)
abandoned.handle.key('ArrowLeft', true)
tick(16)
abandoned.handle.stop()
log(
  abandoned.sent.at(-1).a === 'up',
  'a television switched off mid-drag still lifts the button — nothing may be left held on the desk'
)

const holding = pointerHarness()
holding.handle.key('Enter', true)
await new Promise((resolveDelay) => setTimeout(resolveDelay, 850))
const rightPair = holding.sent.slice(-2)
log(
  rightPair[0]?.button === 'right' && rightPair[0].a === 'down' && rightPair[1]?.a === 'up',
  'holding OK still is the other button, pressed and released'
)
const afterRight = holding.sent.length
holding.handle.key('Enter', false)
log(holding.sent.length === afterRight, 'and letting go afterwards adds nothing — one press, one meaning')
holding.handle.stop()

const scrolling = pointerHarness()
scrolling.handle.key('ContextMenu', true)
const movesBeforeWheel = scrolling.of('move').length
scrolling.handle.key('ArrowUp', true)
tick(16)
tick(120)
const wheels = scrolling.of('wheel')
log(wheels.length > 0 && wheels[0].wheel > 0, 'Menu turns the arrows into a wheel, and Up scrolls away from the reader')
log(scrolling.of('move').length === movesBeforeWheel, 'and the pointer stops moving while they are the wheel')
scrolling.handle.key('ContextMenu', true)
scrolling.handle.key('ArrowUp', false)
scrolling.handle.key('ArrowRight', true)
const movesBeforeBack = scrolling.of('move').length
tick(16)
log(scrolling.of('move').length > movesBeforeBack, 'and Menu again gives them back to the pointer')
scrolling.handle.stop()

const runaway = pointerHarness()
runaway.handle.key('ArrowRight', true)
// Two keydowns for one press is Android auto-repeating, which is what earns
// the short watchdog. Without ever seeing one, the pointer must not cut a
// hold short on a remote that does not repeat at all.
runaway.handle.key('ArrowRight', true)
tick(16)
const movedBeforeSilence = runaway.of('move').length
// The release never arrives — a WebView that lost focus mid-press. Several
// frames later, with nothing re-asserting the key, the cursor has to stop.
tick(400)
tick(16)
tick(16)
log(runaway.of('move').length <= movedBeforeSilence + 1, 'a held direction whose release went missing stops by itself')
runaway.handle.stop()

const coalescing = pointerHarness()
coalescing.handle.key('ArrowRight', true)
for (let i = 0; i < 60; i++) {
  coalescing.handle.key('ArrowRight', true)
  tick(16)
}
log(
  coalescing.of('move').length <= 35,
  `a second of smooth movement is coalesced into ${coalescing.of('move').length} frames, not sixty`
)
coalescing.handle.stop()

const everything = [
  ...tapped.sent,
  ...dragged.sent,
  ...holding.sent,
  ...scrolling.sent,
  ...coalescing.sent,
  ...runaway.sent
]
log(
  everything.length > 0 && everything.every((frame) => frame.t === 'mirror-input' && readMirrorInput(frame) !== null),
  `all ${everything.length} frames the remote produced are ones the desktop's own validator accepts`
)

/* -------------------------------------------------- 4. does this machine do it */

if (canDriveDesktop()) {
  const problem = await probeDesktopInput()
  log(problem === '', problem === '' ? 'the input helper starts and reaches user32 on this machine' : problem)
} else {
  console.log('SKIP  the live helper check — only Windows has a user32 to reach')
}

console.log(failures === 0 ? '\ninput-check: all good' : `\ninput-check: ${failures} failed`)
process.exit(failures === 0 ? 0 : 1)
