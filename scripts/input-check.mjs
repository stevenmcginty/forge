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
// The browser's half of the same feature, bundled separately because it is a
// separate application: web/ compiles against `@shared` exactly as the desktop
// does, but nothing in it is reachable from scripts/fixtures/input-entry.ts and
// it has no business being pulled into the desktop's bundle to be measured.
const webBundle = join(scratch, 'mirror-input.mjs')
await build({
  entryPoints: [join(ROOT, 'web', 'src', 'lib', 'mirror-input.ts')],
  outfile: webBundle,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  alias: { '@shared': join(ROOT, 'shared') },
  logLevel: 'silent',
  absWorkingDir: ROOT
})
const { pictureBox, fractionFor, keyFor, notchesFor } = await import(pathToFileURL(webBundle).href)
// And the phone's trackpad — the grammar that turns a finger into the wire —
// which is a browser module for the same reason and bundled the same way.
const padBundle = join(scratch, 'touchpad.mjs')
await build({
  entryPoints: [join(ROOT, 'web', 'src', 'lib', 'touchpad.ts')],
  outfile: padBundle,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  alias: { '@shared': join(ROOT, 'shared') },
  logLevel: 'silent',
  absWorkingDir: ROOT
})
const { startTouchpad } = await import(pathToFileURL(padBundle).href)

const {
  readMirrorInput,
  lineFor,
  linesFor,
  pairsWith,
  canDriveDesktop,
  probeDesktopInput,
  startPointer,
  MIRROR_KEYS,
  MAX_WHEEL_NOTCHES,
  MAX_TEXT_CHARS,
  DEFAULT_DOUBLE_CLICK_MS,
  DOUBLE_CLICK_MARGIN_MS,
  DOUBLE_CLICK_PX
} = await import(
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

const doubled = readMirrorInput({ a: 'dblclick', button: 'left', x: 0.25, y: 0.75 })
log(
  doubled?.a === 'dblclick' && doubled.button === 'left' && doubled.x === 0.25 && doubled.y === 0.75,
  'a double-click survives the door with its button and its place'
)
log(readMirrorInput({ a: 'dblclick', x: 0.5, y: 0.5 }) === null, 'but not without a button')
log(readMirrorInput({ a: 'dblclick', button: 'left' }) === null, 'nor without a place')

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

/* ------------------------------------------------------- the double-click

   Not a sixth verb at the helper: a `dblclick` is the press-and-release pair
   written once more if the click the desk just made is still inside Windows'
   double-click window, and written twice if it is not. The judgement is the
   whole feature, so its boundary is walked here in the desk's own clock. */

const dct = DEFAULT_DOUBLE_CLICK_MS
const inside = dct - DOUBLE_CLICK_MARGIN_MS
const justClicked = { button: 'left', x: at.x, y: at.y, at: 10_000 }
const press = `b 2 ${at.x} ${at.y}`
const lift = `b 4 ${at.x} ${at.y}`
const second = { a: 'dblclick', button: 'left', x: 0.5, y: 0.5 }

log(
  linesFor(second, at, justClicked, 10_000 + 150, dct).join(' ') === `${press} ${lift}`,
  'a double-click 150ms after a click on the same spot is one more press: Windows pairs them'
)
log(
  linesFor(second, at, justClicked, 10_000 + inside, dct).join(' ') === `${press} ${lift}`,
  `and so is one at the edge of the window less the pipe's margin (${inside}ms)`
)
log(
  linesFor(second, at, justClicked, 10_000 + inside + 1, dct).join(' ') === `${press} ${lift} ${press} ${lift}`,
  'one millisecond later the window is spent and the whole pair is performed'
)
log(
  linesFor(second, at, null, 10_000, dct).join(' ') === `${press} ${lift} ${press} ${lift}`,
  'with no click before it at all, the whole pair is performed'
)
log(
  linesFor(second, at, { ...justClicked, button: 'right' }, 10_000 + 100, dct).length === 4,
  'a recent click of the other button does not pair'
)
log(
  linesFor(second, at, { ...justClicked, x: at.x + DOUBLE_CLICK_PX + 1 }, 10_000 + 100, dct).length === 4,
  'nor does one further away than the double-click rectangle'
)
log(
  linesFor(second, at, { ...justClicked, x: at.x + DOUBLE_CLICK_PX }, 10_000 + 100, dct).length === 2,
  'but one inside it does'
)
log(
  pairsWith(justClicked, 'left', at, 10_000 + 150, 300) === true && pairsWith(justClicked, 'left', at, 10_000 + 150, 250) === false,
  "a Windows whose double-click time was turned down is judged by the number it reported, not the default"
)
log(pairsWith(justClicked, 'left', at, 9_000, dct) === false, 'a click from the future never pairs')
log(
  linesFor(second, at, justClicked, 10_000 + 100, dct).every((line) => /^b (2|4) \d+ \d+$/.test(line)),
  'and every line of it is a button line the helper already had'
)

/* -------------------------------------------------------- typing a phrase

   The fifth verb, and the one that widened what a paired television can do:
   before it, a remote could click anything and press Enter but could not put a
   letter anywhere. So the door is worth leaning on. What must hold is that a
   phrase becomes one `t` line per character and nothing else — no route to a
   scancode, no way to hold a modifier down across the end of a phrase, and no
   length a television can choose. */

const typed = readMirrorInput({ a: 'text', text: 'Hello, desk.' })
log(typed?.a === 'text' && typed.text === 'Hello, desk.', 'a phrase survives the door intact')

const controlled = readMirrorInput({ a: 'text', text: 'rm -rf\r\nnow ' })
log(
  controlled?.text === 'rm -rfnow',
  'control characters are stripped out of it — a newline is Enter, and Enter is a key somebody presses on purpose'
)

log(readMirrorInput({ a: 'text', text: '' }) === null, 'an empty phrase is not an instruction')
log(readMirrorInput({ a: 'text' }) === null, 'and neither is one with no text at all')
log(readMirrorInput({ a: 'text', text: 42 }) === null, 'nor one whose text is not a string')
log(readMirrorInput({ a: 'text', text: ' ' }) === null, 'nor one that is only control characters')

const long = readMirrorInput({ a: 'text', text: 'a'.repeat(MAX_TEXT_CHARS * 4) })
log(
  long?.text.length === MAX_TEXT_CHARS,
  `a phrase longer than any sentence is cut to ${MAX_TEXT_CHARS} — one frame cannot hold the desk's keyboard`
)

const hi = linesFor({ a: 'text', text: 'Hi!' }, at)
log(
  hi.length === 3 && hi[0] === 't 72' && hi[1] === 't 105' && hi[2] === 't 33',
  'a phrase becomes one line per character, each carrying the code point and nothing else'
)
log(
  linesFor({ a: 'text', text: '\u{1F600}ok' }, at).join(' ') === 't 111 t 107',
  'a character outside the basic plane is dropped whole rather than sent as half a surrogate'
)
log(
  linesFor({ a: 'move', x: 0.5, y: 0.5 }, at).length === 1,
  'and every other input is still exactly one line — typing is the only verb that is many'
)
log(
  linesFor({ a: 'text', text: 'Ünïcodé — £' }, at).every((line) => /^t \d+$/.test(line)),
  'every typed line is the letter t and one integer; which key that is belongs to the layout on the desk'
)

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

/**
 * One pointer, with a fake television around it.
 *
 * The stage and the picture are separate arguments because they are separate
 * things: the video is drawn `object-fit: contain`, so a desktop that is not
 * the stage's shape is painted inside it with bars either side. The defaults
 * make the two agree, which is the case the grammar tests below want — the
 * letterboxing has its own section.
 */
function pointerHarness(box = { width: 1920, height: 1080 }, source = { width: 1920, height: 1080 }) {
  const sent = []
  const cursor = { style: {} }
  const handle = startPointer({
    cursor,
    stage: { getBoundingClientRect: () => box },
    picture: { videoWidth: source.width, videoHeight: source.height },
    send: (frame) => sent.push(frame),
    onChange: () => {}
  })
  /** Where the ring has actually been drawn, in the stage's pixels. */
  const at = () => {
    const found = /translate3d\((-?[\d.]+)px, (-?[\d.]+)px/.exec(cursor.style.transform ?? '')
    return found ? { x: Number(found[1]), y: Number(found[2]) } : null
  }
  return { handle, sent, cursor, at, of: (a) => sent.filter((f) => f.a === a) }
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
// The arrow is released before the mode moves, so nothing is being held across
// a change in what holding it means — and then Menu is pressed *twice*, because
// the ring has three stops and not two. This check pressed it once and asserted
// the pointer was back, which has been wrong since the keyboard mode was added:
// `pointer.ts` cycles `move → scroll → keys → move` and its own comment says so
// ("Three meanings for one D-pad… pointer, wheel, keyboard"), so one press from
// the wheel lands on the keyboard. The check was stale, not the code, and the
// way home being a single press *from the far side* is the property the ring's
// order exists to give — which is what the second press below is standing on.
scrolling.handle.key('ArrowUp', false)
scrolling.handle.key('ContextMenu', true)
scrolling.handle.key('ContextMenu', true)
scrolling.handle.key('ArrowRight', true)
const movesBeforeBack = scrolling.of('move').length
tick(16)
log(scrolling.of('move').length > movesBeforeBack, 'and Menu twice more comes round the ring and gives them back to the pointer')
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

/* ------------------------------------------ 3b. the ring is on the picture

   The one thing a pointer can get wrong without anybody being able to name it:
   pointing accurately at the wrong place. The video is drawn `object-fit:
   contain`, so a 16:9 desktop inside a stage that is wider than 16:9 is painted
   with a bar down each side, and those bars are nobody's screen. Measuring a
   fraction against the stage puts the ring on the right pixel in the exact
   middle and progressively further out towards the edges — which reads as "it
   is nearly right", and is the hardest kind of wrong to see from a sofa.

   A stage of 1920x900 showing a 1920x1080 desk: contain scales it to 1600x900,
   leaving 160px of black either side. */
const letterboxed = pointerHarness({ width: 1920, height: 900 }, { width: 1920, height: 1080 })
log(
  letterboxed.at()?.x === 960 && letterboxed.at()?.y === 450,
  'a pointer starting in the middle is in the middle of the stage too — the one place bars cannot show'
)
letterboxed.handle.key('ArrowLeft', true)
// Long enough at full speed to be pinned against the left edge of the desk.
for (let i = 0; i < 200; i++) {
  letterboxed.handle.key('ArrowLeft', true)
  tick(16)
}
const home = letterboxed.of('move').at(-1)
log(home?.x === 0, 'holding Left reaches the left edge of the desktop')
log(
  letterboxed.at()?.x === 160,
  `and the ring stops on the picture's own edge (${letterboxed.at()?.x}px), not on the stage's — the black bar is not part of anybody's screen`
)
letterboxed.handle.stop()

/* And the same picture decides how fast the cursor climbs. `y` is a fraction of
   a shorter side, so vertical travel is scaled by the aspect it is a fraction
   *of* — the desk's, 16:9, not the stage's 1920x900. Held for the same time in
   both directions, the cursor must cross the same number of desktop pixels. */
const square = pointerHarness({ width: 1920, height: 900 }, { width: 1920, height: 1080 })
square.handle.key('ArrowRight', true)
for (let i = 0; i < 12; i++) {
  square.handle.key('ArrowRight', true)
  tick(16)
}
const across = (square.of('move').at(-1)?.x ?? 0) - 0.5
square.handle.key('ArrowRight', false)
const down = pointerHarness({ width: 1920, height: 900 }, { width: 1920, height: 1080 })
down.handle.key('ArrowDown', true)
for (let i = 0; i < 12; i++) {
  down.handle.key('ArrowDown', true)
  tick(16)
}
const downwards = (down.of('move').at(-1)?.y ?? 0) - 0.5
log(
  Math.abs(across * 1920 - downwards * 1080) < 1,
  `the same hold moves the same distance in desktop pixels either way (${Math.round(across * 1920)} across, ${Math.round(downwards * 1080)} down)`
)
square.handle.stop()
down.handle.stop()

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

/* ------------------------------------------- 3d. the phone's trackpad grammar

   Forge Web on a phone has no D-pad and no mouse: a finger on the glass is a
   trackpad, and lib/touchpad.ts is the grammar that reads it. Only the part
   that changed is walked here — the double-tap — against the same fake clock,
   with timers this script fires by hand. The rest of the grammar (tap, drag,
   hold, scroll) is the television's, ported, and proved above. */

const realSetTimeout = globalThis.setTimeout
const realClearTimeout = globalThis.clearTimeout
const timers = []
globalThis.setTimeout = (fn, ms) => {
  const timer = { fn, due: clock + (ms ?? 0), id: timers.length + 1 }
  timers.push(timer)
  return timer.id
}
globalThis.clearTimeout = (id) => {
  const index = timers.findIndex((timer) => timer.id === id)
  if (index >= 0) timers.splice(index, 1)
}
/** Advance the fake clock, firing every timer that comes due on the way. */
const wait = (ms) => {
  const until = clock + ms
  for (;;) {
    const next = timers.filter((timer) => timer.due <= until).sort((a, b) => a.due - b.due)[0]
    if (!next) break
    timers.splice(timers.indexOf(next), 1)
    clock = next.due
    next.fn()
  }
  clock = until
}
globalThis.addEventListener = () => {}
globalThis.removeEventListener = () => {}

function padHarness() {
  const sent = []
  const box = { left: 0, top: 0, width: 1920, height: 1080, right: 1920, bottom: 1080 }
  const handle = startTouchpad({
    cursor: { style: {} },
    stage: { getBoundingClientRect: () => box },
    picture: { getBoundingClientRect: () => box },
    frameSize: () => ({ width: 1920, height: 1080 }),
    getShot: () => ({ left: 0, top: 0, width: 1920, height: 1080 }),
    send: (frame) => sent.push(frame),
    onChange: () => {}
  })
  /** One tap: a finger lands, stays inside the slop, and leaves `holdMs` later. */
  const tap = (id, holdMs = 60) => {
    handle.down(id, 500, 500)
    wait(holdMs)
    handle.up(id)
  }
  return { handle, sent, tap, wait, of: (a) => sent.filter((f) => f.a === a) }
}

const aimed = padHarness()
aimed.handle.down(1, 500, 500)
aimed.wait(20)
aimed.handle.move(1, 700, 620)
// Past SEND_MS, so the trailing flush timer has told the desk where it went.
aimed.wait(40)
aimed.handle.up(1)
log(
  aimed.of('move').length >= 2 && aimed.of('down').length === 0 && aimed.of('up').length === 0,
  'a slide moves the cursor and its release sends no click — aiming does not click'
)
aimed.handle.stop()

const single = padHarness()
single.tap(1)
log(
  single.of('down').length === 1 && single.of('up').length === 1 && single.of('dblclick').length === 0,
  'one tap is one click — a down and an up, and no double'
)
single.handle.stop()

const twice = padHarness()
twice.tap(1)
twice.wait(120)
twice.tap(2)
const twiceButtons = twice.sent.filter((f) => f.a !== 'move').map((f) => f.a)
log(
  twiceButtons.join(' ') === 'down up dblclick',
  `a second tap 120ms later is sent as a dblclick after the first click (${twiceButtons.join(' ')})`
)
const dbl = twice.of('dblclick')[0]
const first = twice.of('up')[0]
log(dbl?.button === 'left' && dbl.x === first.x && dbl.y === first.y, 'at exactly the place the first click landed')
twice.handle.stop()

const slow = padHarness()
slow.tap(1)
slow.wait(600)
slow.tap(2)
log(
  slow.of('dblclick').length === 0 && slow.of('down').length === 2,
  'two taps 600ms apart are two single clicks'
)
slow.handle.stop()

const wandered = padHarness()
wandered.tap(1)
wandered.wait(50)
wandered.handle.down(2, 500, 500)
wandered.handle.move(2, 560, 500)
wandered.handle.up(2)
wandered.wait(50)
wandered.tap(3)
log(
  wandered.of('dblclick').length === 0,
  'a slide between two taps moves the cursor, and a tap somewhere else is not the second half of anything'
)
wandered.handle.stop()

const thrice = padHarness()
thrice.tap(1)
thrice.wait(100)
thrice.tap(2)
thrice.wait(100)
thrice.tap(3)
const thriceButtons = thrice.sent.filter((f) => f.a !== 'move').map((f) => f.a)
log(
  thriceButtons.join(' ') === 'down up dblclick down up',
  `tap-tap-tap is a double-click and then a click, never a triple (${thriceButtons.join(' ')})`
)
thrice.handle.stop()

const heldLong = padHarness()
heldLong.tap(1)
heldLong.wait(100)
heldLong.tap(2, 900)
log(
  heldLong.of('dblclick').length === 0 && heldLong.of('down').some((f) => f.button === 'right'),
  'a second finger that stays down is the hold it always was: a right-click, not a double'
)
heldLong.handle.stop()

const padFrames = [...aimed.sent, ...single.sent, ...twice.sent, ...slow.sent, ...wandered.sent, ...thrice.sent, ...heldLong.sent]
log(
  padFrames.length > 0 && padFrames.every((frame) => readMirrorInput(frame) !== null),
  `all ${padFrames.length} frames the trackpad produced are ones the desktop's own validator accepts`
)

globalThis.setTimeout = realSetTimeout
globalThis.clearTimeout = realClearTimeout

/* ------------------------------------- 3c. the browser's half of the mapping

   Forge Web shows the same desktop in a tab, and a tab has a mouse already — so
   there is no grammar to build out of six buttons here, only arithmetic: where
   on the desk did that click land, which browser key is a key the desk knows,
   and how many notches is one turn of somebody's wheel. All of it is pure
   functions in web/src/lib/mirror-input.ts, and all of it is the kind of thing
   that is wrong by a little rather than wrong outright.

   The letterboxing is the part worth the most attention, for the reason 3b
   gives about the television: a fraction measured against the element instead
   of the picture is exactly right in the middle and further out towards every
   edge. The case below is a browser window of 1920x900 showing a 1920x1080
   desk, which `contain` paints as 1600x900 with a 160px bar down each side.

   The box is deliberately not at the origin. `getBoundingClientRect` and
   `clientX` are both viewport coordinates, and a mapping that forgot where the
   canvas starts would still pass every assertion made against a rect at 0,0. */

// Node has no DOMRect and `pictureBox` returns one. The four fields it is built
// from are the four the arithmetic reads; `left` and `top` are the aliases the
// mapping uses, and a rect whose sides disagreed with its origin would be a
// stranger thing than this file needs to model.
globalThis.DOMRect = class {
  constructor(x, y, width, height) {
    this.x = x
    this.y = y
    this.width = width
    this.height = height
    this.left = x
    this.top = y
    this.right = x + width
    this.bottom = y + height
  }
}

/** Floating point: 1920 * (900/1080) is 1600.0000000000002, not 1600. */
const near = (value, want) => typeof value === 'number' && Math.abs(value - want) < 1e-9

const canvas = new DOMRect(40, 20, 1920, 900)
const picture = pictureBox(canvas, 1920, 1080)
log(
  near(picture.width, 1600) && near(picture.height, 900),
  'a 1920x1080 desk inside a 1920x900 window is painted 1600x900 — the widest that fits, not the box'
)
log(
  near(picture.left, 200) && near(picture.top, 20),
  "and it sits 160px in from the window's own left edge, which is where the black bar ends"
)

const middle = fractionFor(canvas, 1920, 1080, 40 + 960, 20 + 450)
log(near(middle?.x, 0.5) && near(middle?.y, 0.5), 'the centre of the window is the centre of the desk')

const topLeft = fractionFor(canvas, 1920, 1080, 200, 20)
log(near(topLeft?.x, 0) && near(topLeft?.y, 0), "the picture's top-left corner is the desktop's origin")
const bottomRight = fractionFor(canvas, 1920, 1080, 1800, 920)
log(near(bottomRight?.x, 1) && near(bottomRight?.y, 1), 'and its bottom-right corner is the far end of the screen')

// The whole reason for the letterboxing arithmetic, in one number: a quarter of
// the way across the *window* is a fifth of the way across the *desk*, because
// the first 160px of the window is not anybody's screen. A mapping measured
// against the element answers 0.25 here and is wrong by 96 desktop pixels.
const quarter = fractionFor(canvas, 1920, 1080, 40 + 480, 20 + 450)
log(
  near(quarter?.x, 0.2),
  `a quarter of the way across the window is ${quarter?.x} of the way across the desk, not 0.25`
)

log(fractionFor(canvas, 1920, 1080, 100, 470) === null, 'a click on the left black bar is not a click on the desktop')
log(fractionFor(canvas, 1920, 1080, 1900, 470) === null, 'and neither is one on the right')
log(
  fractionFor(canvas, 1920, 1080, 1000, 950) === null,
  'nor one below the window entirely — a pointer that left is not clamped back onto the screen'
)

// A window the desk's own shape has no bars, and the mapping must not invent
// any: the picture is the box, and a quarter across is a quarter across.
const unboxed = new DOMRect(0, 0, 1600, 900)
const exact = fractionFor(unboxed, 1920, 1080, 400, 225)
log(near(exact?.x, 0.25) && near(exact?.y, 0.25), 'a window of the desk’s own shape maps straight through, bars and all')

/* The keys. Fifteen names reach the desktop and the rest of a keyboard does
   not — there is no modifier field in `MirrorInput`, so Ctrl+C, Alt+Tab and the
   F-keys cannot be said at all. What matters is that the ones that do travel
   are spelled the way the desktop's own door expects, and that everything else
   comes back as the empty string rather than as something plausible. */

const browserKeys = [
  'Enter',
  'Escape',
  'Tab',
  'Backspace',
  'Delete',
  'ArrowUp',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
  'PageUp',
  'PageDown',
  'Home',
  'End',
  ' ',
  'Meta'
]
log(
  browserKeys.every((key) => readMirrorInput({ a: 'key', key: keyFor(key), down: true }) !== null),
  `all ${browserKeys.length} browser key names map onto keys the desktop's own validator accepts`
)
log(
  keyFor('ArrowUp') === 'up' && keyFor(' ') === 'space' && keyFor('Meta') === 'win',
  'and they map onto the right ones — the space bar is a key, not a character'
)
const unsendable = ['a', 'C', 'Control', 'Alt', 'Shift', 'F5', 'F11', 'CapsLock', 'Insert', 'Dead', '']
log(
  unsendable.every((key) => keyFor(key) === ''),
  'a key with no name on the desk — a letter, a modifier, an F-key — is refused rather than sent as something else'
)

/* The wheel. A browser reports how far the content should move; the frame
   carries how far the wheel turned, which is the same gesture described from
   the other end and therefore the opposite sign. */

log(notchesFor(100, 0) === -1, 'one notch of a wheel rolled towards the reader is 100 pixels of browser delta')
log(notchesFor(-100, 0) === 1, 'and the same roll away from the reader is positive, like a real wheel')
log(notchesFor(3, 1) === -1, 'a browser measuring in lines calls the same notch three of them')
log(notchesFor(-1, 2) === 8, 'and one that measures in pages is worth a screenful of notches')
log(notchesFor(4, 0) === -1, 'a trackpad nudge is a whole notch — rounding it to nothing is a surface that will not scroll')
log(notchesFor(0, 0) === 0 && notchesFor(Number.NaN, 0) === 0, 'and no movement at all is no notches, not one')
log(
  notchesFor(99999, 0) === -MAX_WHEEL_NOTCHES && notchesFor(-99999, 0) === MAX_WHEEL_NOTCHES,
  'a flick nobody could make with a hand is capped where the desktop would have capped it anyway'
)
log(
  [100, -100, 3, 4, 99999].every(
    (delta) => readMirrorInput({ a: 'wheel', wheel: notchesFor(delta, 0), x: 0.5, y: 0.5 }) !== null
  ),
  'and every notch count this produces is one the desktop accepts unchanged'
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
