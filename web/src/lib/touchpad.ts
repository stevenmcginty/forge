/**
 * A mouse, made out of a touchscreen.
 *
 * The D-pad version of this problem already exists — mobile/src/lib/pointer.ts,
 * for the television — and the philosophy is ported from there wholesale: the
 * cursor lives *here*, painted the moment a finger moves, and the desktop is
 * told where it has got to. A cursor that waited for the desk's own arrow to
 * appear inside the encoded picture would answer a finger about 150
 * milliseconds late, which is the difference between pointing at something and
 * hunting for it. The desk is following the phone, not the other way round.
 *
 * The difference between a remote and a finger is that the remote has two
 * kinds of event — arrows that move, OK that presses — while a finger landing
 * on glass is both at once. Everything below hangs off the one invention that
 * fact needs: **stillness is the touch-side OK button.** A finger that lands
 * and moves is movement, and only that; a finger that lands and *stays* for a
 * beat has latched, and whatever it does from then on is done with the button
 * down. The grammar, in full:
 *
 *   slide, moving from the moment it lands   the pointer moves; nothing is
 *                                           pressed on anybody's desk
 *   tap — short, and still within the slop  a click, emitted on release
 *   still for LATCH_MS, then slide          a drag: the button goes down at
 *                                           the first movement, not at the
 *                                           touchdown
 *   still for HOLD_MS                       a right-click, and the release is
 *                                           the end of that, not a second
 *                                           event
 *   a second finger, then slide             the wheel, vertically — the
 *                                           protocol has no horizontal wheel
 *                                           to send, so there is no gesture
 *                                           for one
 *
 * The click and the drag behave exactly as pointer.ts's do, including the part
 * that reads like a wart: a tap's `down` is not sent until the finger leaves,
 * because a press still on the glass can yet turn out to be a drag or a
 * right-click, and committing early is how a tap becomes an accidental drag on
 * somebody's real desktop — the thing that makes the absolute mode this
 * replaces unusable on a phone, where a 1920-pixel desk is squeezed into a
 * 390-pixel screen and a fingertip is bigger than most of the targets on it.
 *
 * Like pointer.ts this is not a hook and not a component: it runs on the
 * browser's own pointer events, writes one `transform` per movement, and never
 * re-renders anything. And as everywhere in this protocol, positions are
 * fractions of the picture and every event carries its own — see the header of
 * shared/mobile.ts, where that rule is argued.
 */
import type { MirrorButton } from '@shared/mobile'
import type { WebMirrorInputFrame } from '@shared/web'
import { notchesFor, pictureBox } from './mirror-input'

/**
 * How far the cursor travels per unit of finger travel, at a creep.
 *
 * In fractions of the picture per fraction of the picture, so it means the
 * same on a phone and a tablet: at 0.4, crossing the mirrored screen takes two
 * and a half full swipes of the finger. Slow is the point — this is the gain
 * you aim with, and at 1920 pixels of desktop behind 390 of glass, the target
 * under the ring is smaller than the fingertip that has to find it.
 */
const GAIN_SLOW = 0.4

/**
 * And at a flick. Three picture-widths of pointer per picture-width of finger:
 * a fast swipe crosses the desk in one gesture, which is the other half of
 * what a gain has to do — reach the far side without a sore thumb.
 */
const GAIN_FAST = 3

/**
 * The finger speeds the ramp runs between, in widths of the picture per
 * second. Below SLOW_SPEED the gain is GAIN_SLOW and above FAST_SPEED it is
 * GAIN_FAST; in between it is eased, for the reason pointer.ts gives: the
 * first part of a movement is the part you aim with, and a linear ramp spends
 * it accelerating past the target.
 */
const SPEED_SLOW = 0.6
const SPEED_FAST = 5

/**
 * How much of each movement sample is the new sample, the rest being the
 * running estimate. A single event's speed is noise — one frame of a finger's
 * travel is a couple of pixels, and a gain that jumped with it would make the
 * cursor's acceleration flicker. Smoothed, the ramp says how the finger has
 * been moving over the last few frames instead.
 */
const SPEED_MEMORY = 0.35

/**
 * A pause longer than this is a new movement, not a slow continuation of the
 * old one: the speed estimate resets rather than letting a slow deliberate
 * nudge inherit the flick that came before it.
 */
const GLIDE_GAP_MS = 120

/**
 * How far a finger may wander after touchdown and still count as still.
 *
 * Fingers do not land flat and they do not stay put — a tap on glass wobbles a
 * handful of pixels, and an absolute mapping turns every one of them into
 * movement of the desktop's pointer. Drift is measured from the touchdown, not
 * the last event, so ten small moves of one pixel each add up to the same
 * verdict as one move of ten.
 */
const TAP_SLOP_PX = 9

/**
 * How long a landed finger must stay still to latch — the touch-side stand-in
 * for "OK is held", as the header explains. Short, because a latch is not
 * something anybody should have to think about: a deliberate drag already
 * starts with a beat of stillness, and 150ms is inside it.
 */
const LATCH_MS = 150

/**
 * How long a latched, motionless finger takes to mean the other button.
 *
 * The same 700ms as pointer.ts, and for the same reason: long enough that
 * aiming does not stumble into it, short enough that a right-click is one
 * deliberate hold rather than a wait.
 */
const HOLD_MS = 700

/**
 * How often the desktop is told where the pointer is, at most.
 *
 * The same 33ms as MIRROR_SEND_MS in Mirror.tsx and SEND_MS in pointer.ts,
 * and for the same two reasons: thirty a second is comfortably under the
 * desktop's input ceiling with room for the clicks beside it, and it is more
 * often than the picture can show anybody where the cursor is anyway.
 */
const SEND_MS = 33

/**
 * How often the picture's box may be re-measured without a reason.
 *
 * Taking two rectangles is not free, and a pointer event is not the place to
 * pay for one sixty times a second. A new gesture re-measures regardless — a
 * rotated phone is a new picture — and so does a change in what is decoding.
 */
const MEASURE_MS = 1000

/**
 * One wheel notch, in the desktop's own pixels.
 *
 * The same 100 as PIXELS_PER_NOTCH in mirror-input.ts, restated here because
 * that one is private and this file needs the threshold more than the
 * conversion: notchesFor turns *any* nonzero distance into at least one notch
 * — right for a wheel's chunky deltas, wrong for a smooth finger, which would
 * scroll the desk at the first twitch. A gesture owes its first notch only
 * after it has actually travelled one.
 */
const SCROLL_PX_PER_NOTCH = 100

/**
 * What the pad is doing, for the ring the component draws over the picture.
 *
 * Each state is something the eye needs at a glance, mid-gesture:
 *
 *  - 'idle'  nobody is touching the glass; the plain ring
 *  - 'press' a finger is down, unlatched — movement is pointing, not pressing
 *  - 'armed' the finger has latched; everything from here on involves the
 *             button, and holding on reaches the right-click
 *  - 'drag'  the button is down and moving on the desk
 *  - 'scroll' two fingers; the movement is the wheel's
 */
export type TouchpadState = 'idle' | 'press' | 'armed' | 'drag' | 'scroll'

export interface TouchpadHandle {
  /**
   * A pointer landed on the glass. `id` is the browser's `pointerId`, so a
   * second finger is a different id and not a jump of the first.
   */
  down(id: number, x: number, y: number): void
  /** A pointer that has been seen down moved. Unknown ids are ignored. */
  move(id: number, x: number, y: number): void
  /** A pointer left the glass — the release half of the grammar. */
  up(id: number): void
  /**
   * The browser took the gesture away: a call, a notification, a palm.
   *
   * Never a click — the finger did not choose to leave — but a drag in
   * progress is still released, because the button is down on somebody's real
   * desktop either way.
   */
  cancel(id: number): void
  /**
   * Notches of a real wheel, turned somewhere this pad did not measure them.
   *
   * One caller: a mouse over the canvas while the finger grammar is on. Those
   * notches belong at the cursor the fingers left, not wherever the mouse
   * happens to be sitting — in this mode the ring is the only pointer there is.
   */
  wheel(notches: number): void
  /**
   * A whole click at the cursor, for buttons the grammar has no gesture for —
   * a mouse's right or middle button pressed while the trackpad mode is on.
   */
  click(button: MirrorButton): void
  /** Finish: stop everything, release anything held, forget the fingers. */
  stop(): void
}

export interface TouchpadOptions {
  /**
   * The node drawn as the cursor. Positioned by `transform` on this element
   * alone — nothing else on the screen moves, and no layout is invalidated,
   * sixty times a second over a picture that is decoding.
   */
  cursor: HTMLElement
  /** The box the cursor is positioned inside; its top-left is the cursor's origin. */
  stage: HTMLElement
  /**
   * The element the picture is painted into. Its rectangle is the picture's —
   * a canvas sized to its own frames with `object-fit: contain` makes the two
   * the same box — which is what every fraction below is a fraction of.
   */
  picture: HTMLElement
  /**
   * The size of the frames actually decoding, or null before the first.
   *
   * This and not the size the desktop announced, for the reason
   * `ScreenPainter.size()` gives: the pointer mapping has to measure against
   * what is really on the glass, and a fraction of the wrong rectangle is a
   * click in the wrong place.
   */
  frameSize: () => { width: number; height: number } | null
  /** One input body, on its way to the desktop by the existing path. */
  send: (input: Omit<WebMirrorInputFrame, 'type'>) => void
  /**
   * The state changed — the ring's colour and shape. Called on transitions
   * only, never per movement, so a React `setState` here is fine.
   */
  onChange?: (state: TouchpadState) => void
}

/**
 * Start the pad. The cursor appears in the middle of the picture, because
 * there is nowhere else it could honestly start: this screen cannot see where
 * the desktop's own pointer is, and pretending otherwise would put the first
 * click somewhere nobody chose.
 */
export function startTouchpad(options: TouchpadOptions): TouchpadHandle {
  const { cursor, stage, picture, frameSize, send, onChange } = options

  /** Where the pointer is, in fractions of the picture. */
  let x = 0.5
  let y = 0.5

  /** Every finger on the glass, at its latest position, by pointer id. */
  const fingers = new Map<number, { x: number; y: number }>()

  /**
   * The gesture finger — the one that landed while the pad was empty — or
   * null. Only it can tap, latch, drag or right-click; the fingers that join
   * it are half of a wheel and nothing else.
   */
  let held: { id: number; x: number; y: number } | null = null
  /** Has the gesture finger been still long enough to mean the button? */
  let latched = false
  /** Has the press become a drag — the button is down on the desk? */
  let dragging = false
  /**
   * Has it fired its right-click? Then its release is the end of that event,
   * not the start of another.
   */
  let spent = false

  /** Is the wheel gesture running — two fingers on the glass? */
  let scrolling = false
  /** How far the fingers have travelled, in the desktop's own pixels, signed. */
  let wheelPx = 0
  /** How many notches of that have already been sent. */
  let wheelSent = 0
  /** When the last wheel frame left, for the same throttle as the moves. */
  let wheelAt = 0

  /** The latch and the right-click, armed together at every touchdown. */
  let latchTimer = 0
  let holdTimer = 0
  /**
   * The move that arrived inside the throttle window and still has to leave.
   * See `offer`.
   */
  let flushTimer = 0

  /** When the desktop was last told a position, and which one it was told. */
  let sentAt = 0
  let sentX = -1
  let sentY = -1
  /** Finger speed, smoothed — see SPEED_MEMORY. */
  let glide = 0
  /** When the finger last moved, for the frame-rate-independent speed. */
  let movedAt = 0

  let state: TouchpadState = 'idle'

  /**
   * Where the picture actually is inside the stage, in the stage's own
   * pixels. `pictureBox` works in the viewport's coordinates; the cursor is
   * positioned inside the stage, so its answer is restated in the stage's
   * words — the one subtraction mirror-input.ts's header says nobody would
   * notice getting wrong, done here so nobody has to notice it at all.
   */
  let shot = { left: 0, top: 0, width: 0, height: 0 }
  /** The intrinsic size `shot` was worked out from. See `measure`. */
  let sourceW = -1
  let sourceH = -1
  let measuredAt = 0

  const now = (): number => performance.now()

  const become = (next: TouchpadState): void => {
    if (state === next) return
    state = next
    onChange?.(state)
  }

  const paint = (): void => {
    cursor.style.transform = `translate3d(${shot.left + x * shot.width}px, ${shot.top + y * shot.height}px, 0)`
  }

  /**
   * Re-measure the picture's box: when forced, when what is decoding has
   * changed shape, or once a second — the desktop may change resolution at any
   * moment, and the phone may be rotated.
   */
  const measure = (force: boolean): void => {
    const size = frameSize()
    const changed = size !== null && (size.width !== sourceW || size.height !== sourceH)
    if (!force && !changed && now() - measuredAt < MEASURE_MS) return
    measuredAt = now()
    if (size) {
      sourceW = size.width
      sourceH = size.height
    }
    const box = pictureBox(picture.getBoundingClientRect(), sourceW, sourceH)
    const origin = stage.getBoundingClientRect()
    shot = { left: box.left - origin.left, top: box.top - origin.top, width: box.width, height: box.height }
    paint()
  }

  const tell = (): void => {
    send({ a: 'move', x, y })
    sentAt = now()
    sentX = x
    sentY = y
  }

  /**
   * A movement has happened; send it if the throttle allows, and if it does
   * not, make sure it still leaves.
   *
   * A finger that stops inside the window has moved all the same, and the
   * desk's own cursor must not be left a frame behind where the next click
   * will land — so the newest position goes out on one trailing timer rather
   * than being dropped. This is the touch-side of the loop pointer.ts runs:
   * its cursor keeps ticking while it re-sends an unsent position every frame,
   * while this one has no loop to tick and arms a timer instead.
   */
  const offer = (): void => {
    if (x === sentX && y === sentY) return
    const at = now()
    if (at - sentAt >= SEND_MS) {
      tell()
      return
    }
    if (!flushTimer) {
      flushTimer = window.setTimeout(() => {
        flushTimer = 0
        tell()
      }, SEND_MS)
    }
  }

  /**
   * Move the cursor by a finger's delta, at the gain the finger has earned.
   *
   * Both axes are scaled by the same gain because both are fractions of a
   * picture that keeps the desktop's own shape — the aspect correction
   * pointer.ts has to do by hand is already done by the fractions being
   * fractions of *this* rectangle, and a diagonal finger is a diagonal cursor
   * without another word being said.
   */
  const applyDeltas = (dx: number, dy: number, at: number): void => {
    if (shot.width <= 0 || shot.height <= 0) return
    const elapsed = at - movedAt
    movedAt = at
    const instant = elapsed > 0 ? (Math.hypot(dx, dy) / elapsed) * (1000 / shot.width) : 0
    glide = elapsed > GLIDE_GAP_MS ? instant : glide * (1 - SPEED_MEMORY) + instant * SPEED_MEMORY
    const ramp = Math.min(1, Math.max(0, (glide - SPEED_SLOW) / (SPEED_FAST - SPEED_SLOW)))
    const gain = GAIN_SLOW + (GAIN_FAST - GAIN_SLOW) * ramp * ramp
    x = Math.min(1, Math.max(0, x + (dx / shot.width) * gain))
    y = Math.min(1, Math.max(0, y + (dy / shot.height) * gain))
  }

  const clearHold = (): void => {
    if (latchTimer) {
      clearTimeout(latchTimer)
      latchTimer = 0
    }
    if (holdTimer) {
      clearTimeout(holdTimer)
      holdTimer = 0
    }
  }

  /**
   * Turn the accumulated finger travel into wheel frames.
   *
   * The notches owed are the difference between what the whole gesture adds up
   * to and what has already gone, which handles a reversal mid-flick for free:
   * the total comes back through the notches already sent and the wheel turns
   * the other way without a special case. Each frame is bounded by the same
   * MAX_WHEEL_NOTCHES the desk clamps to.
   */
  const sendWheel = (at: number): void => {
    const want = Math.abs(wheelPx) < SCROLL_PX_PER_NOTCH ? 0 : notchesFor(wheelPx, 0)
    const owed = want - wheelSent
    if (!owed) return
    // Not yet: the owed notches survive in the difference and go out on the
    // next movement, rather than being dropped or sent over the budget.
    if (at - wheelAt < SEND_MS) return
    wheelAt = at
    wheelSent = want
    send({ a: 'wheel', wheel: owed, x, y })
  }

  const down = (id: number, px: number, py: number): void => {
    fingers.set(id, { x: px, y: py })
    /**
     * A second finger turns a still-pending press into the wheel. One already
     * dragging is joined by nothing: a drag is one finger's promise, and a
     * second finger arriving mid-drag is far more likely a slip than a
     * gesture nobody has been told about. It is tracked — so that it is not
     * mistaken for a new gesture when it lifts — and otherwise ignored.
     */
    if (fingers.size === 2) {
      if (held && !dragging && !spent) {
        clearHold()
        held = null
        latched = false
        scrolling = true
        wheelPx = 0
        wheelSent = 0
        wheelAt = 0
        become('scroll')
      }
      return
    }
    if (fingers.size !== 1 || held) return
    // A new gesture on fresh glass is also the moment to re-measure: a phone
    // that has been rotated is a new picture, and the first thing anybody
    // does with it is point at something.
    measure(true)
    held = { id, x: px, y: py }
    latched = false
    dragging = false
    spent = false
    glide = 0
    movedAt = now()
    become('press')
    // The latch and the hold are armed together and cleared together. The
    // latch fires first and sends nothing — it only changes what the finger
    // means from then on; the hold fires only if nothing has intervened, and
    // its guards re-read every one of those meanings rather than trusting the
    // clock to have been the only thing happening.
    latchTimer = window.setTimeout(() => {
      latchTimer = 0
      if (!held || dragging || spent || scrolling || fingers.size !== 1) return
      latched = true
      become('armed')
    }, LATCH_MS)
    holdTimer = window.setTimeout(() => {
      holdTimer = 0
      // Still held, still still. The press has decided what it is.
      if (!held || dragging || spent || scrolling || fingers.size !== 1) return
      spent = true
      send({ a: 'down', button: 'right', x, y })
      send({ a: 'up', button: 'right', x, y })
      become('idle')
    }, HOLD_MS)
  }

  const move = (id: number, px: number, py: number): void => {
    const finger = fingers.get(id)
    if (!finger) return
    const dx = px - finger.x
    const dy = py - finger.y
    finger.x = px
    finger.y = py
    const at = now()
    measure(false)

    if (scrolling) {
      /**
       * The wheel: each finger's share of the movement, scaled from this
       * screen's pixels into the desktop's own, so a notch means here what it
       * means there. The sign is handed to notchesFor in the browser's own
       * delta convention — a finger dragging *up* is content following the
       * finger upwards, which is the reader scrolling *down* the page, and
       * notchesFor is where that inversion lives.
       */
      const scale = sourceH > 0 && shot.height > 0 ? sourceH / shot.height : 1
      wheelPx -= (dy * scale) / fingers.size
      sendWheel(at)
      return
    }

    if (!held || held.id !== id) return
    /**
     * Drift since touchdown, from the start and not the last event: a tap
     * that creeps ten pixels in ten moves is still a tap that crept.
     */
    const drift = Math.hypot(px - held.x, py - held.y)

    if (!dragging && drift <= TAP_SLOP_PX) {
      // Jitter is not movement. The press is still whatever it was going to
      // be, and the latch needs no help from a wobbling finger.
      return
    }

    if (!dragging && !latched) {
      /**
       * It moved, and too soon to have meant the button: this is the
       * workhorse gesture — the pointer alone, nothing pressed on anybody's
       * desk. The timers are cleared with the decision, because a slide that
       * could turn into a right-click halfway would be a grammar with a trap
       * in it, and its release sends nothing: a slide is not a tap, and in
       * this mode that is exactly what keeps aiming from clicking.
       */
      clearHold()
      become('press')
      applyDeltas(dx, dy, at)
      paint()
      offer()
      return
    }

    if (!dragging) {
      /**
       * Latched, and now it moves: the drag begins *here* and not at the
       * touchdown, which is the whole reason a tap was able to stay
       * uncommitted until this moment. The button goes down at the cursor the
       * finger was left pointing at, and the same event's delta moves it.
       */
      dragging = true
      clearHold()
      become('drag')
      send({ a: 'down', button: 'left', x, y })
      applyDeltas(dx, dy, at)
      paint()
      offer()
      return
    }

    applyDeltas(dx, dy, at)
    paint()
    offer()
  }

  const up = (id: number): void => {
    if (!fingers.delete(id)) return
    if (scrolling) {
      /**
       * One finger of the pair has gone, and the gesture is over even though
       * the other may still be on the glass: the survivor has already spent
       * its meaning as half of a wheel, and letting it carry on as a pointer
       * would be a jump nobody asked for. It is ignored until the hand leaves.
       */
      if (fingers.size < 2) {
        scrolling = false
        wheelPx = 0
        wheelSent = 0
        become('idle')
      }
      return
    }
    if (!held || held.id !== id) return
    clearHold()
    held = null
    const wasDragging = dragging
    const wasSpent = spent
    dragging = false
    spent = false
    latched = false
    glide = 0
    if (wasSpent) {
      // The hold already fired as a right-click; this release is the end of
      // the first event, not the start of a second.
      become('idle')
      return
    }
    if (wasDragging) {
      send({ a: 'up', button: 'left', x, y })
      become('idle')
      return
    }
    /**
     * A tap: the button goes down and up where the pointer is, in that order
     * and in one moment. Deliberately on release — the press could not commit
     * earlier without guessing whether it was this, a drag, or a right-click.
     */
    send({ a: 'down', button: 'left', x, y })
    send({ a: 'up', button: 'left', x, y })
    become('idle')
  }

  const cancel = (id: number): void => {
    fingers.delete(id)
    if (scrolling) {
      if (fingers.size < 2) {
        scrolling = false
        wheelPx = 0
        wheelSent = 0
        become('idle')
      }
      return
    }
    if (!held || held.id !== id) return
    clearHold()
    held = null
    // The one rule that differs from `up`: a gesture the browser took away
    // never clicks. A drag is still released — the button is down on the desk
    // whether the finger meant to lift or not.
    if (dragging) send({ a: 'up', button: 'left', x, y })
    dragging = false
    spent = false
    latched = false
    glide = 0
    become('idle')
  }

  const stop = (): void => {
    clearHold()
    if (flushTimer) {
      clearTimeout(flushTimer)
      flushTimer = 0
    }
    fingers.clear()
    held = null
    scrolling = false
    wheelPx = 0
    wheelSent = 0
    // Nothing may be left pressed on somebody's desktop. A drag abandoned by
    // a browser that hid the tab is a mouse button held down until the desk's
    // owner notices, which is the worst thing this file could leave behind.
    if (dragging) send({ a: 'up', button: 'left', x, y })
    dragging = false
    spent = false
    latched = false
    become('idle')
  }

  measure(true)
  // The desk is told where the cursor starts, so that its own arrow and this
  // one begin the gesture in the same place — the two agree until the next
  // movement, and disagreeing from the first frame is a choice nobody made.
  tell()

  return {
    down,
    move,
    up,
    cancel,
    wheel(notches: number): void {
      if (!notches) return
      send({ a: 'wheel', wheel: notches, x, y })
    },
    click(button: MirrorButton): void {
      send({ a: 'down', button, x, y })
      send({ a: 'up', button, x, y })
    },
    stop
  }
}
