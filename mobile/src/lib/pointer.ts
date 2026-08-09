/**
 * A mouse, made out of a D-pad.
 *
 * The television is already showing the desktop's screen (lib/mirror.ts); this
 * is the half that lets somebody on a sofa point at it. The whole design
 * follows from two facts about the hardware.
 *
 * **The remote has six buttons that reach this page.** Four arrows, OK, and
 * Back — everything else on a Fire TV remote is taken by the native layer
 * before the WebView sees it (see MainActivity.dispatchKeyEvent). So the
 * grammar has to be built out of *how* those six are pressed rather than out of
 * how many there are: a tap of OK is a click, a hold that moves is a drag, and
 * a hold that stays still is a right-click. Nothing here needs a button that
 * does not exist.
 *
 * **The picture is a moving image of somewhere else.** A cursor drawn by the
 * desktop and watched over WebRTC would answer the D-pad about 150 milliseconds
 * late, which is the difference between pointing at something and hunting for
 * it. So the cursor lives *here*: this module owns the position, paints it on
 * the television immediately, and tells the desktop where it has got to. The
 * desk is following the sofa, not the other way round.
 *
 * Consequences of owning the position that are worth naming:
 *
 *  - **Every event carries its coordinates** (see `MirrorInputFrame`), so a
 *    dropped movement packet cannot make the click after it land somewhere
 *    else. The desktop positions and acts in the same instruction.
 *  - **Positions are fractions, never pixels.** This screen has no idea what
 *    resolution the desk is running, and the encoder rescales the picture on
 *    the way over regardless.
 *  - **A fraction is a fraction of the picture, not of the box it sits in.**
 *    The video is drawn `object-fit: contain`, so a desktop that is not the
 *    television's shape leaves bars down the sides or along the top, and those
 *    bars are not part of anybody's screen. Measuring against the box would put
 *    the ring on the right pixel only in the exact middle and further out the
 *    nearer the edge — see `frame` below.
 *  - **Movement is coalesced.** Sixty frames a second are painted here; at most
 *    thirty go out, each one saying where the pointer *is* rather than where it
 *    went. That is what keeps a smooth cursor comfortably under the desktop's
 *    input rate limit.
 *
 * Deliberately not a hook and not a component: this runs an animation frame
 * loop and writes to a DOM node directly. A cursor that moved by re-rendering
 * React sixty times a second would re-render a full-screen video with it.
 */
import type { MirrorInputFrame } from '@shared/mobile'

/**
 * How fast the pointer starts, as a fraction of the picture's width per second.
 *
 * Slow enough to land on a scrollbar. On a 1080p desktop this is about 300
 * pixels a second — a beat and a half to cross a dialog box, which is what
 * "nudge" has to feel like or nothing small is ever clickable from a sofa.
 */
const SLOW = 0.16

/**
 * And how fast it ends up, held. About 2700 pixels a second on the same
 * desktop: corner to corner in well under a second, because the other half of
 * this feature is reaching the far side of a 1080p screen without a sore thumb.
 */
const FAST = 1.4

/** How long a held arrow takes to get from `SLOW` to `FAST`. */
const RAMP_MS = 900

/**
 * How often the desktop is told where the pointer is.
 *
 * Thirty a second: below the desktop's own ceiling (`MAX_INPUT_PER_SECOND`)
 * with room for clicks and keys beside it, and far above what a picture
 * arriving at 30fps can show anybody.
 */
const SEND_MS = 33

/**
 * How long a direction survives without being re-asserted.
 *
 * The safety net under a missing `keyup`. Android auto-repeats a held D-pad
 * every 50ms or so, so a direction that has not been heard from in a third of
 * a second is one whose release went missing — a WebView losing focus mid-press
 * is the ordinary way that happens. Without this, one swallowed keyup is a
 * cursor that never stops moving, on a screen with no mouse to grab.
 */
const STALE_MS = 320

/**
 * The same net, for a remote that does not auto-repeat at all.
 *
 * The 320ms above is only safe once this screen has *seen* a repeat: on a
 * device that sends one keydown and nothing until the release, a third of a
 * second would cut every hold short and the cursor would crawl. So the short
 * window is earned — one observed repeat proves repeats exist here — and until
 * then a direction is held for as long as anybody could plausibly mean it.
 */
const NO_REPEAT_STALE_MS = 4_000

/** How long OK is held, without moving, to mean the other button. */
const HOLD_MS = 700

/** Wheel: how often a held arrow turns it, and how far. */
const WHEEL_MS = 110
const WHEEL_FAST_AFTER_MS = 900
const WHEEL_NOTCHES = 1
const WHEEL_FAST_NOTCHES = 3

/** The four directions, and which way each pushes. */
const DIRECTIONS: Record<string, { dx: number; dy: number }> = {
  ArrowUp: { dx: 0, dy: -1 },
  ArrowDown: { dx: 0, dy: 1 },
  ArrowLeft: { dx: -1, dy: 0 },
  ArrowRight: { dx: 1, dy: 0 }
}

/** What the pointer is doing with the arrows. */
export type PointerMode = 'move' | 'scroll'

export interface PointerHandle {
  /**
   * One key event from the remote. True when the pointer took it, so the
   * caller knows whether to fall through to its own meaning for the key.
   */
  key(name: string, down: boolean): boolean
  /** Which mode the arrows are in, for the line of hint text. */
  mode(): PointerMode
  /** Finish: stop the loop, release anything held, and forget the cursor. */
  stop(): void
}

export interface PointerOptions {
  /**
   * The node drawn as the cursor. Positioned by `transform` on this element
   * alone — nothing else on the screen moves, and no layout is invalidated.
   */
  cursor: HTMLElement
  /** The box the video element fills — bars and all. */
  stage: HTMLElement
  /**
   * The video itself, for its intrinsic size.
   *
   * What a fraction is a fraction of is the *picture*, and only this element
   * knows how big that is: `videoWidth`/`videoHeight` are the desktop's own
   * resolution, and with `object-fit: contain` they are what decides how much
   * of the stage is screen and how much is letterboxing. Read on a timer rather
   * than subscribed to, because it changes when the desk changes resolution and
   * at no other time.
   */
  picture: HTMLVideoElement
  /** One input, on its way to the desktop. */
  send: (frame: MirrorInputFrame) => void
  /**
   * The mode changed, or the button state did — anything the hint line shows.
   * Called rarely and never from inside the animation loop's fast path, so a
   * React `setState` here is fine.
   */
  onChange?: (mode: PointerMode, holding: boolean) => void
  /**
   * A plain click just happened — a tap of OK, not a drag and not a hold.
   *
   * This exists because a click is the only honest signal that somebody may be
   * about to type. Windows will not say whether the thing now focused is a text
   * box: Chrome keeps its accessibility tree switched off unless it is started
   * with a flag or a screen reader announces itself, and measured on this desk
   * it reports the same "document" node whether an input has focus or nothing
   * does. So the desktop cannot be asked, and the click is what is left.
   *
   * Not fired for a drag or a right-click, which are the two presses that are
   * definitely not somebody landing a caret.
   */
  onClick?: () => void
}

/**
 * Start pointing. The cursor appears in the middle of the picture, because
 * there is nowhere else it could honestly start: this screen cannot see where
 * the desktop's own pointer is, and pretending otherwise would put the first
 * click somewhere nobody chose.
 */
export function startPointer(options: PointerOptions): PointerHandle {
  const { cursor, stage, picture, send, onChange, onClick } = options

  /** Where the pointer is, in fractions of the picture. */
  let x = 0.5
  let y = 0.5
  let mode: PointerMode = 'move'

  /** Held directions, each with when it was last heard from. See STALE_MS. */
  const held = new Map<string, number>()
  /**
   * Has this remote ever auto-repeated a held key? Set by the first keydown
   * for a direction that is already down, and it is what earns the short
   * staleness window above.
   */
  let repeats = false
  /**
   * Is OK down? The whole click/drag/right-click grammar hangs off this.
   *
   * A boolean and not the timestamp it used to be. `performance.now()` can
   * legitimately read 0 — it is milliseconds since the page loaded — and a
   * sentinel that a real clock can produce is a press that never happened.
   * Nothing here needs to know *when* OK went down: the hold has its own timer.
   */
  let okDown = false
  /** Has this press of OK already become a left button that is down? */
  let dragging = false
  /** Has it already become a right-click? Then its release does nothing. */
  let spent = false
  /** When the desktop was last told a position, and which one it was told. */
  let sentAt = 0
  let sentX = -1
  let sentY = -1
  /** When the loop last ran, for a frame-rate-independent step. */
  let steppedAt = 0
  let frame = 0

  /**
   * Where the desktop's screen actually is, inside the stage.
   *
   * Offsets from the stage's top-left, in this screen's pixels, and never the
   * stage itself unless the two happen to be the same shape. Everything that
   * turns a fraction into a place on the television goes through this.
   */
  let shot = { left: 0, top: 0, width: 0, height: 0 }
  /** The intrinsic size the box above was worked out from. See `measure`. */
  let sourceW = -1
  let sourceH = -1
  let measuredAt = 0

  const now = (): number => performance.now()

  /**
   * Work out the picture's box from the stage's, the way `object-fit: contain`
   * does: the largest rectangle of the video's own shape that fits, centred,
   * with the remainder left as bars.
   *
   * Before the first frame decodes there is no intrinsic size to scale by, and
   * the honest fallback is the whole stage — the pointer starts in the middle,
   * where the two agree, and `measure` corrects the rest within a frame of the
   * video knowing its own size.
   */
  const frameBox = (): void => {
    const box = stage.getBoundingClientRect()
    const vw = picture.videoWidth
    const vh = picture.videoHeight
    if (vw <= 0 || vh <= 0 || box.width <= 0 || box.height <= 0) {
      shot = { left: 0, top: 0, width: box.width, height: box.height }
      return
    }
    const scale = Math.min(box.width / vw, box.height / vh)
    const width = vw * scale
    const height = vh * scale
    shot = { left: (box.width - width) / 2, top: (box.height - height) / 2, width, height }
  }

  const paint = (): void => {
    const px = shot.left + x * shot.width
    const py = shot.top + y * shot.height
    cursor.style.transform = `translate3d(${px}px, ${py}px, 0)`
  }

  /**
   * Re-measure, on the second — or immediately when the desk changes shape.
   *
   * The timer is for the television's own layout, which barely moves. The
   * intrinsic-size check is for the desktop's, which can change the instant
   * somebody plugs in a monitor, and where waiting up to a second would leave
   * the ring pointing at bars. Reading `videoWidth` costs nothing; taking a
   * rect is the part worth throttling.
   */
  const measure = (at: number): void => {
    const changed = picture.videoWidth !== sourceW || picture.videoHeight !== sourceH
    if (!changed && at - measuredAt < 1000) return
    measuredAt = at
    sourceW = picture.videoWidth
    sourceH = picture.videoHeight
    frameBox()
    if (changed) paint()
  }

  const tell = (): void => {
    send({ t: 'mirror-input', a: 'move', x, y })
    sentAt = now()
    sentX = x
    sentY = y
  }

  /** The pointer's speed right now, given how long its oldest key was held. */
  const speed = (at: number, since: number): number => {
    const ramp = Math.min(1, (at - since) / RAMP_MS)
    // Eased rather than linear: the first moments of a press are the ones you
    // aim with, and a linear ramp spends them accelerating past the target.
    return SLOW + (FAST - SLOW) * ramp * ramp
  }

  /* --------------------------------------------------------- the wheel */

  let wheelAt = 0
  /** When the current scroll gesture began, or -1 — see `okDown` on why not 0. */
  let wheelSince = -1

  const turnWheel = (at: number): void => {
    const up = held.has('ArrowUp')
    const down = held.has('ArrowDown')
    if (up === down) {
      // Neither, or both cancelling out. The next press starts its own ramp.
      wheelSince = -1
      return
    }
    if (wheelSince < 0) {
      wheelSince = at
      wheelAt = 0
    }
    if (at - wheelAt < WHEEL_MS) return
    wheelAt = at
    const fast = at - wheelSince > WHEEL_FAST_AFTER_MS
    const notches = fast ? WHEEL_FAST_NOTCHES : WHEEL_NOTCHES
    // Positive is away from the reader, which is what Up has to mean.
    send({ t: 'mirror-input', a: 'wheel', wheel: up ? notches : -notches, x, y })
  }

  /* ---------------------------------------------------------- the loop */

  const step = (): void => {
    frame = requestAnimationFrame(step)
    const at = now()
    const elapsed = steppedAt === 0 ? 0 : Math.min(100, at - steppedAt)
    steppedAt = at
    measure(at)

    // Anything not re-asserted recently is a key whose release went missing.
    const stale = repeats ? STALE_MS : NO_REPEAT_STALE_MS
    for (const [name, heard] of held) if (at - heard > stale) held.delete(name)

    if (mode === 'scroll') {
      turnWheel(at)
      return
    }

    let dx = 0
    let dy = 0
    let oldest = at
    for (const [name, heard] of held) {
      const direction = DIRECTIONS[name]
      if (!direction) continue
      dx += direction.dx
      dy += direction.dy
      // The ramp belongs to the press, so a diagonal accelerates as one
      // gesture rather than restarting when the second arrow joins it.
      oldest = Math.min(oldest, heard)
    }
    if (dx === 0 && dy === 0) {
      // A pointer that has stopped still owes the desktop its last position:
      // the throttle swallows the final movement of a fast swipe, and a click
      // landing where the cursor *was* is the bug that causes. Every event
      // carries its own coordinates, so this is belt and braces — but it also
      // keeps the desk's own cursor where the sofa left it.
      if (x !== sentX || y !== sentY) tell()
      return
    }

    // Normalised, so a diagonal is not forty percent faster than a straight
    // line — the one thing that makes a D-pad cursor feel like it is on ice.
    const length = Math.hypot(dx, dy)
    const travel = (speed(at, oldest) * elapsed) / 1000
    x += (dx / length) * travel
    // The same distance in pixels, vertically. `y` is a fraction of a shorter
    // side, so without the aspect correction the cursor would climb a 16:9
    // screen almost twice as fast as it crosses it. The picture's aspect, not
    // the stage's: the desk is the thing being crossed, and a diagonal is only
    // a diagonal at the far end if it is measured against the far end's shape.
    y += (dy / length) * travel * (shot.height > 0 ? shot.width / shot.height : 1)
    x = Math.min(1, Math.max(0, x))
    y = Math.min(1, Math.max(0, y))
    paint()

    // Moving while OK is held is a drag, and this is the moment it becomes one:
    // the button goes down here rather than when OK was pressed, so a press
    // that turns out to be a tap can still be a plain click. See `key`.
    if (okDown && !dragging && !spent) {
      dragging = true
      send({ t: 'mirror-input', a: 'down', button: 'left', x, y })
      onChange?.(mode, true)
    }

    if (at - sentAt >= SEND_MS) tell()
  }

  /* ----------------------------------------------------------- the keys */

  /**
   * OK, held long enough and still enough to mean the other button.
   *
   * Checked from the key handler's own timer rather than the loop, because the
   * whole point is that nothing has happened: no movement, no release, and so
   * no frame that would notice.
   */
  let holdTimer = 0

  const clearHold = (): void => {
    if (holdTimer) {
      clearTimeout(holdTimer)
      holdTimer = 0
    }
  }

  const pressOk = (): void => {
    if (okDown) return // a repeat of a key already down
    okDown = true
    dragging = false
    spent = false
    clearHold()
    holdTimer = window.setTimeout(() => {
      holdTimer = 0
      // Still held, still still. The press has decided what it is.
      if (!okDown || dragging) return
      spent = true
      send({ t: 'mirror-input', a: 'down', button: 'right', x, y })
      send({ t: 'mirror-input', a: 'up', button: 'right', x, y })
      onChange?.(mode, false)
    }, HOLD_MS)
  }

  const releaseOk = (): void => {
    if (!okDown) return
    okDown = false
    clearHold()
    if (spent) {
      // The hold already fired as a right-click; the release is not a second
      // event, it is the end of the first.
      spent = false
      return
    }
    if (dragging) {
      dragging = false
      send({ t: 'mirror-input', a: 'up', button: 'left', x, y })
      onChange?.(mode, false)
      return
    }
    // A tap: the button goes down and up where the pointer is, in that order
    // and in one moment. This is the ordinary click, and it is deliberately
    // emitted on release — the alternative is a press that cannot also be the
    // start of a drag or a right-click without guessing which.
    send({ t: 'mirror-input', a: 'down', button: 'left', x, y })
    send({ t: 'mirror-input', a: 'up', button: 'left', x, y })
    // After the click, never before it: whatever is about to be typed belongs
    // in the thing this press just focused, and the desk has to have been told
    // where to put the caret before anybody starts filling it.
    onClick?.()
  }

  const handle: PointerHandle = {
    key(name: string, down: boolean): boolean {
      if (name in DIRECTIONS) {
        if (down) {
          if (held.has(name)) repeats = true
          held.set(name, now())
        } else {
          held.delete(name)
        }
        return true
      }
      if (name === 'Enter') {
        if (down) pressOk()
        else releaseOk()
        return true
      }
      // Menu, which the native layer hands to this page only while the pointer
      // is running (see MainActivity). One press swaps the arrows between the
      // cursor and the wheel — the only way to scroll a desktop with a remote
      // that has no wheel and no spare buttons.
      if (name === 'ContextMenu') {
        if (!down) return true
        mode = mode === 'move' ? 'scroll' : 'move'
        wheelSince = -1
        onChange?.(mode, dragging)
        return true
      }
      return false
    },

    mode(): PointerMode {
      return mode
    },

    stop(): void {
      cancelAnimationFrame(frame)
      clearHold()
      held.clear()
      // Nothing may be left pressed on somebody's desktop. A drag abandoned by
      // a television that switched off is a mouse button held down until the
      // desk's owner notices, which is the worst thing this file could leave
      // behind.
      if (dragging) send({ t: 'mirror-input', a: 'up', button: 'left', x, y })
      dragging = false
      okDown = false
    }
  }

  measure(now())
  paint()
  tell()
  frame = requestAnimationFrame(step)
  return handle
}
