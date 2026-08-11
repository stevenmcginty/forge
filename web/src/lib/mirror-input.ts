/**
 * A mouse and a keyboard, made out of a browser's own events.
 *
 * The tab is showing the desktop's screen (see screen.ts); this is the half that
 * turns a pointer event over that canvas into something `readMirrorInput` will
 * accept. It exists as pure functions and nothing else — no element, no
 * listeners, no state — because every hard part of it is arithmetic, and
 * arithmetic can be proved at a terminal instead of squinted at from a chair.
 * `npm run input:check` drives all four of these against synthetic rectangles.
 *
 * The frames themselves are the ones Forge TV already sends: `MirrorInputFrame`
 * in shared/mobile.ts, understood by `electron/mobile/input.ts` at the far end.
 * Nothing new is invented here, and nothing here decides whether an input is
 * allowed — the desktop does that, per device, and this side sending a frame is
 * not permission to act on one.
 *
 * ## Why the picture's rectangle and not the element's
 *
 * A browser window is not the shape of Steve's desktop, so a 16:10 screen shown
 * in a 16:9 canvas leaves black along two edges, and those bars are nobody's
 * screen. This is the same problem `frame()` in mobile/src/lib/pointer.ts
 * solves for the television, solved the same way and worth restating because it
 * is invisible when it is wrong: measuring a fraction against the *element* is
 * exactly right in the centre and drifts further out the nearer the edge, which
 * reads as "the cursor is nearly right" and is the hardest kind of wrong to
 * report. A click that lands on a bar is not a click on the desktop at all, so
 * it comes back as null rather than being clamped to an edge — clamping would
 * put a press on the taskbar every time somebody missed.
 *
 * One deliberate difference from the television's version: the rectangle here is
 * in the viewport's coordinates, not offsets inside a stage. `getBoundingClientRect`
 * and `clientX` are already in that space, and converting between the two is a
 * subtraction nobody would notice getting wrong.
 *
 * ## What cannot be expressed, and is not pretended
 *
 * `MirrorInput` has no modifier field — see shared/mobile.ts, where the key
 * action is `{ a: 'key'; key: MirrorKey; down: boolean }` and `MIRROR_KEYS` is
 * fifteen names long. There is nowhere to say that Ctrl was held, and no key
 * called Ctrl, Alt or Shift to hold. So **Ctrl+C, Ctrl+V, Alt+Tab and every
 * F-key are not representable at all**, and `keyFor` returns `''` for them
 * rather than dropping the modifier and sending the letter — a Ctrl+C that
 * arrives on the desk as a lone `c` types a character into whatever was focused,
 * which is worse than nothing happening. A caller should say out loud that those
 * combinations do not travel; a UI that silently swallows Ctrl+C is worse than
 * one that admits it cannot send it.
 */
import { MAX_WHEEL_NOTCHES, type MirrorKey } from '@shared/mobile'

/**
 * Every browser key name this can carry, and the whole of it.
 *
 * Keyed by `KeyboardEvent.key`, which is the layout-aware name — 'Enter',
 * 'ArrowUp', ' ' for the space bar — rather than `code`, which is a physical
 * position on a US keyboard and would send the wrong thing off any other layout.
 *
 * 'OS' sits beside 'Meta' because it is what older Gecko called the same key and
 * costs one line to keep working.
 */
const KEYS: Record<string, MirrorKey> = {
  Enter: 'enter',
  Escape: 'escape',
  Tab: 'tab',
  Backspace: 'backspace',
  Delete: 'delete',
  ArrowUp: 'up',
  ArrowDown: 'down',
  ArrowLeft: 'left',
  ArrowRight: 'right',
  PageUp: 'pageup',
  PageDown: 'pagedown',
  Home: 'home',
  End: 'end',
  ' ': 'space',
  Meta: 'win',
  OS: 'win'
}

/**
 * How much of each kind of wheel delta is one notch.
 *
 * A wheel event does not report notches; it reports a distance in one of three
 * units, and which unit depends on the browser, the pointing device and the
 * operating system's own scroll settings. Windows turns one detent of a real
 * wheel into three lines by default, which Chrome then reports as 100 pixels and
 * Firefox as 3 lines — the two numbers below are the same click of the same
 * wheel. A page is a screenful, and there is no honest exchange rate for it: 8
 * is a number that scrolls a page's worth of most things and is bounded by
 * `MAX_WHEEL_NOTCHES` anyway.
 */
const PIXELS_PER_NOTCH = 100
const LINES_PER_NOTCH = 3
const NOTCHES_PER_PAGE = 8

/** `WheelEvent.DOM_DELTA_LINE` and `DOM_DELTA_PAGE`; pixels are 0. */
const DELTA_LINE = 1
const DELTA_PAGE = 2

/**
 * Where the desktop's picture actually is, inside the box it is drawn in.
 *
 * The largest rectangle of the desktop's own shape that fits, centred, with the
 * remainder left as bars — which is what `object-fit: contain` does to a video
 * and what a canvas sized to its frames does when CSS fits it into a box.
 *
 * With no decoded frame there is nothing to letterbox by, and the honest
 * fallback is the whole box: the two agree in the middle, and a caller that
 * maps a click before the first frame has painted is mapping it onto a canvas
 * showing nothing.
 */
export function pictureBox(box: DOMRect, videoW: number, videoH: number): DOMRect {
  if (videoW <= 0 || videoH <= 0 || box.width <= 0 || box.height <= 0) {
    return new DOMRect(box.x, box.y, box.width, box.height)
  }
  const scale = Math.min(box.width / videoW, box.height / videoH)
  const width = videoW * scale
  const height = videoH * scale
  return new DOMRect(box.x + (box.width - width) / 2, box.y + (box.height - height) / 2, width, height)
}

/**
 * Where a pointer event landed on the desktop, as a fraction of it, or null when
 * it did not land on the desktop at all.
 *
 * Fractions rather than pixels for the reason given in shared/mobile.ts: this
 * tab has no idea what resolution the desk is running, and the desk can change
 * it while somebody is watching. 0..1 survives that; a pixel does not.
 *
 * Null is a real answer and the caller must respect it. A click on a black bar
 * is a click on the space around somebody's screen, and the nearest edge of that
 * screen — where clamping would put it — is the taskbar, the close button, and
 * everything else that lives at an edge precisely because edges are easy to hit.
 */
export function fractionFor(
  box: DOMRect,
  videoW: number,
  videoH: number,
  clientX: number,
  clientY: number
): { x: number; y: number } | null {
  const picture = pictureBox(box, videoW, videoH)
  if (picture.width <= 0 || picture.height <= 0) return null
  const x = (clientX - picture.left) / picture.width
  const y = (clientY - picture.top) / picture.height
  // Written as a positive test so that a NaN — a zero-width box mid-layout, a
  // coordinate that arrived as nothing — falls out here rather than being sent.
  if (!(x >= 0 && x <= 1 && y >= 0 && y <= 1)) return null
  return { x, y }
}

/**
 * The desktop's name for a key the browser just reported, or `''` when there is
 * no such name.
 *
 * Total by construction, and the empty string is the answer for most of a
 * keyboard: see the note in this file's header on what `MirrorInput` cannot say.
 * A caller should treat `''` as "this key does not travel" and leave the
 * browser's own default alone, rather than swallowing the event for nothing.
 */
export function keyFor(key: string): MirrorKey | '' {
  return KEYS[key] ?? ''
}

/**
 * How many notches of wheel one browser wheel event is worth, signed the way a
 * real wheel is.
 *
 * The sign is inverted, and deliberately. A browser reports `deltaY` as the
 * distance the *content* should move, so scrolling down the page is positive;
 * `MirrorInputFrame.wheel` is the wheel itself, where positive is away from the
 * reader (and becomes a positive `WHEEL_DELTA` on Windows, which means the same
 * thing). The same gesture, described from opposite ends.
 *
 * Any real movement is at least one notch. A trackpad reports a flick as a long
 * run of very small deltas, and rounding those to zero is a surface that scrolls
 * nothing at all; whether a run of them is sent or coalesced first is the
 * caller's decision, not this function's. Zero in is zero out — that is not a
 * gesture — and the result is bounded by the same `MAX_WHEEL_NOTCHES` the
 * desktop's own door clamps to, so nothing this returns can be refused for size.
 */
export function notchesFor(deltaY: number, deltaMode: number): number {
  if (!Number.isFinite(deltaY) || deltaY === 0) return 0
  const perNotch =
    deltaMode === DELTA_PAGE ? 1 / NOTCHES_PER_PAGE : deltaMode === DELTA_LINE ? LINES_PER_NOTCH : PIXELS_PER_NOTCH
  const notches = Math.max(1, Math.round(Math.abs(deltaY) / perNotch))
  return deltaY > 0 ? -Math.min(notches, MAX_WHEEL_NOTCHES) : Math.min(notches, MAX_WHEEL_NOTCHES)
}
