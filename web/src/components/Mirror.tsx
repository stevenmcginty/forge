import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode
} from 'react'
import { Icon } from '@/components/Icon'
import type { MirrorButton, MirrorKey } from '@shared/mobile'
import { PIN_MAX_DIGITS, PIN_MIN_DIGITS } from '@shared/web'
import { askForScreen, sendMirrorInput, stopWatching, watchMirror } from '../lib/client'
import { fractionFor, keyFor, notchesFor } from '../lib/mirror-input'
import { startTouchpad, type TouchpadHandle, type TouchpadState } from '../lib/touchpad'
import { canPaintScreen, startScreen, type ScreenPainter } from '../lib/screen'
import { useForge } from '../state'
import './Mirror.css'

/**
 * The desktop's own screen, in the tab.
 *
 * The last thing in Forge Web that is not Forge: everything else on this page
 * ends inside the app — a pane, a tab, a project — and this ends at a display
 * three hundred miles away and, in its second mode, at that machine's mouse and
 * keyboard. It is drawn as a full-viewport overlay rather than as another view
 * inside the workspace for exactly that reason: watching somebody's whole screen
 * is a different thing from reading their terminals, and it should look like
 * one.
 *
 * The parts underneath it are already written and are not repeated here.
 * `lib/screen.ts` owns the decoder and the canvas; `lib/mirror-input.ts` owns
 * every piece of arithmetic that turns a pointer event into a fraction of
 * somebody's screen, and is proved by `npm run input:check` rather than by
 * anybody squinting at a cursor. What is left in this file is *when*: when to
 * ask, what to do with each of the three answers, and — the part that matters —
 * when this page is allowed to send anything at all.
 *
 * ## Two modes, and the mode is the safety device
 *
 * **Watching** is the default and it is not a permission check, it is an
 * absence: no keyboard listener is installed, so there is no code path from a
 * key press to a frame. **Driving** is entered by clicking the picture, and only
 * on a desktop that said `canControl` — and it is left by a button, by this
 * window losing focus, by the tab being hidden, and by Escape pressed twice
 * inside DOUBLE_ESC_MS.
 *
 * Twice, and never once, because Escape is one of the fifteen keys this link can
 * actually send (`MIRROR_KEYS` in shared/mobile.ts) and it is the key a person
 * driving a remote desktop reaches for most: a single Escape that quietly meant
 * "give me back my browser" would make dismissing a dialog on that desk
 * impossible, which is precisely the thing somebody opened this to do.
 *
 * ## Two ways to point, and why a phone needs the second
 *
 * **Direct** maps a pointer event absolutely: where you press is where the desk
 * is told you pressed. Right for a mouse, unusable for a finger — a 1920-pixel
 * desktop squeezed into a 390-pixel screen puts most of its targets under
 * something bigger than they are, a fingertip's drift during a tap becomes a
 * drag, and there is no scroll and no right-click from glass at all. So there
 * is **Trackpad**, which hands the same three verbs to `lib/touchpad.ts`: the
 * finger moves a cursor this end owns, a tap clicks, a still hold right-clicks,
 * two fingers scroll — the grammar the television already uses, written for a
 * touchscreen (mobile/src/lib/pointer.ts is the original).
 *
 * The mode picks itself — `(pointer: coarse)` at mount, or the first touch
 * this surface ever sees — because the person who needs it is holding a phone
 * and has no way to reach a toggle through a mode that does not fit their
 * hand. The toggle in the bar is for the opposite: a desktop must never be
 * trapped in it, and a phone must be able to give the absolute mapping one
 * more chance. Direct itself is untouched by any of this: with the mode off,
 * every trackpad path below returns before doing anything.
 */

/**
 * How often the desktop is told where the pointer is, at most.
 *
 * The same 33ms as `SEND_MS` in mobile/src/lib/pointer.ts, and for the same two
 * reasons: thirty a second is comfortably under MAX_MIRROR_INPUT_PER_SECOND with
 * room for the clicks and keystrokes beside it, and it is already more often
 * than a picture arriving at thirty frames a second can show anybody. Moves are
 * coalesced through `requestAnimationFrame` first, so what is sent is where the
 * pointer *is* rather than every place it has been — which is also why a dropped
 * move cannot leave the desk's cursor behind: the next one carries the truth.
 */
const MIRROR_SEND_MS = 33

/** How close together two presses of Escape must be to mean "let go". */
const DOUBLE_ESC_MS = 500

/**
 * How long a browser waits for an answer before saying so.
 *
 * There is deliberately nothing on the wire between `mirror-start` and either
 * `mirror-ok` or `mirror-stop` — shared/web.ts says why: the desktop has to open
 * a display and configure an encoder before anything in `mirror-ok` is known,
 * and a frame full of guesses would be a decoder configured wrongly rather than
 * early. So this is the only thing standing between a desk that answers nothing
 * and a spinner that never ends.
 *
 * Fifteen seconds, which is generous on purpose: opening a capture is
 * comfortably a second and can be several on a machine that is busy, and the
 * cost of being impatient is a sentence in place of a picture that was about to
 * arrive.
 */
const ANSWER_MS = 15_000

/** Where the viewer is up to. Each one is a different thing on screen. */
type Phase =
  /** Asked, and nothing has come back yet. */
  | { kind: 'asking' }
  /** The desktop wants its unlock PIN, again, before it will show anything. */
  | { kind: 'pin'; message: string }
  /** Frames are arriving, or are about to. */
  | { kind: 'live' }
  /** It is not happening, and this is why. */
  | { kind: 'over'; message: string }

/**
 * How a pointer becomes the desk's: absolutely, or through the trackpad.
 *
 * A union rather than a boolean because both ends of it are named in the bar —
 * a toggle that says "Trackpad: off" has explained nothing, and this is a
 * grammar somebody is being asked to learn in one word.
 */
type InputMode = 'direct' | 'trackpad'

/**
 * One base64 field off the wire, as the bytes a decoder wants.
 *
 * The buffer is named in the type because `BufferSource` — what `screen.ts` and
 * WebCodecs take — excludes a view onto a `SharedArrayBuffer`, and an unadorned
 * `Uint8Array` could be either.
 */
function bytesOf(base64: string): Uint8Array<ArrayBuffer> {
  const text = atob(base64)
  const bytes = new Uint8Array(new ArrayBuffer(text.length))
  for (let at = 0; at < text.length; at++) bytes[at] = text.charCodeAt(at)
  return bytes
}

/** `PointerEvent.button`, as the three buttons this protocol has a word for. */
function buttonOf(button: number): MirrorButton | null {
  if (button === 0) return 'left'
  if (button === 1) return 'middle'
  if (button === 2) return 'right'
  return null
}

export function Mirror({ onClose }: { onClose: () => void }): ReactNode {
  const { state } = useForge()
  const desktopName = state.picture?.desktopName || 'the desktop'

  const [phase, setPhase] = useState<Phase>({ kind: 'asking' })
  const [canControl, setCanControl] = useState(false)
  const [driving, setDriving] = useState(false)
  /** What `lib/screen.ts` says is wrong with the picture, or '' when nothing is. */
  const [trouble, setTrouble] = useState('')
  const [pin, setPin] = useState('')
  /**
   * Which way a pointer becomes the desk's. Chosen at mount by the only honest
   * signal there is — `(pointer: coarse)` is a phone or a tablet — and then by
   * the first touch this surface sees, because a finger that has to reach a
   * toggle through the absolute mapping is a finger that cannot reach it.
   */
  const [input, setInput] = useState<InputMode>(() =>
    window.matchMedia('(pointer: coarse)').matches ? 'trackpad' : 'direct'
  )
  /** What the trackpad's ring should look like. Owned by `lib/touchpad.ts`. */
  const [padState, setPadState] = useState<TouchpadState>('idle')

  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const painterRef = useRef<ScreenPainter | null>(null)
  const stageRef = useRef<HTMLDivElement | null>(null)
  const padCursorRef = useRef<HTMLDivElement | null>(null)
  /** The running trackpad, or null outside trackpad-and-driving. */
  const padRef = useRef<TouchpadHandle | null>(null)
  const answerTimer = useRef(0)
  /**
   * Re-arm the silence timer. Held in a ref because the timer belongs to the
   * watch — which is one long-lived effect — while the two things that ask
   * again are a form and a button that live out here.
   */
  const armRef = useRef<() => void>(() => {})
  /**
   * The desktop's name, for the one sentence written from inside the watch.
   *
   * A ref rather than a dependency, because the effect below is the watch: it
   * asks on the way in and stops on the way out, so re-running it because a
   * `hello-ok` arrived with the same name spelled from a different object would
   * silently restart somebody's screen share.
   */
  const nameRef = useRef(desktopName)
  nameRef.current = desktopName
  /**
   * The mode, again, outside React.
   *
   * The listeners below are native and long-lived, and a handler that closed
   * over `driving` would be reading whatever it was when the listener was
   * attached. This is the copy those read; `setDriving` is the copy the screen
   * draws. They are written together, in `drive` and `release`, which are the
   * only two places either changes.
   */
  const drivingRef = useRef(false)
  /**
   * The input mode, outside React, for exactly the reason `drivingRef` exists:
   * the pointer handlers below are plain functions on a canvas that never
   * re-attaches, and the copy they close over would be whichever one was
   * rendered when the page loaded.
   */
  const inputRef = useRef<InputMode>('direct')
  inputRef.current = input
  /**
   * Has anybody chosen the mode by hand? Until they have, the first touch
   * anywhere on the picture may switch it — after, it may not, because a phone
   * that flipped back on every touch could never take the toggle's other path.
   */
  const choseInput = useRef(false)
  /**
   * The press that armed driving is spent on arming, and must not also become
   * a trackpad gesture when it bubbles on to the stage one dispatch later —
   * see `onStageDown`, which consumes it.
   */
  const armBounce = useRef(false)
  /** Everything held down right now, so leaving can let go of all of it. */
  const heldKeys = useRef(new Set<MirrorKey>())
  const heldButtons = useRef(new Set<MirrorButton>())
  /** The last fraction actually worked out, for a release with no event to read. */
  const lastAt = useRef({ x: 0.5, y: 0.5 })
  /** The pending pointer move: where it is, and when one was last sent. */
  const move = useRef({ x: 0, y: 0, frame: 0, sentAt: 0 })
  const lastEscape = useRef(0)

  /**
   * Where a pointer event landed on that desktop, or null when it landed on the
   * black beside it.
   *
   * Measured against the canvas and the size of the frames actually decoding —
   * never against the announced size and never against the stage — which is the
   * whole argument in the header of lib/mirror-input.ts. Null is a real answer
   * and is respected everywhere it is returned: a click on a bar is a click on
   * the space around somebody's screen, and clamping it to an edge would put a
   * press on the taskbar every time anybody missed.
   */
  const fractionAt = useCallback((clientX: number, clientY: number): { x: number; y: number } | null => {
    const canvas = canvasRef.current
    const size = painterRef.current?.size()
    if (!canvas || !size) return null
    const at = fractionFor(canvas.getBoundingClientRect(), size.width, size.height, clientX, clientY)
    if (at) lastAt.current = at
    return at
  }, [])

  /**
   * Let go of the desk: every held key up, every held button up, and back to
   * watching.
   *
   * The releases are not a courtesy. A `key` frame is one half of a pair (see
   * `MirrorInputFrame`), so a mode left while Shift or an arrow is down leaves
   * that key held on somebody's real keyboard with nothing on this page still
   * listening for the release — a desktop that scrolls forever, or types one
   * letter into everything.
   */
  const release = useCallback((): void => {
    if (!drivingRef.current) return
    drivingRef.current = false
    // The trackpad settles here too, first: every way out of driving passes
    // through this function while the socket is still open, and a trackpad
    // drag is a button held on the desk exactly as a Direct one is. The pad's
    // own effect tears down after this and calls `stop()` again — harmlessly,
    // because the first call already let go.
    padRef.current?.stop()
    for (const key of heldKeys.current) sendMirrorInput({ a: 'key', key, down: false })
    heldKeys.current.clear()
    for (const button of heldButtons.current) {
      sendMirrorInput({ a: 'up', button, x: lastAt.current.x, y: lastAt.current.y })
    }
    heldButtons.current.clear()
    if (move.current.frame) cancelAnimationFrame(move.current.frame)
    move.current.frame = 0
    setDriving(false)
  }, [])

  const drive = useCallback((): void => {
    drivingRef.current = true
    // The press that armed the mode bubbles on to the stage's own handlers one
    // dispatch later; this is how they know to let it pass unprocessed. The
    // arming click is never forwarded — not in Direct mode, and not here.
    armBounce.current = true
    lastEscape.current = 0
    setDriving(true)
  }, [])

  /* ------------------------------------------------------ the watch itself */

  /**
   * Ask, listen, and paint. One effect for the whole life of this surface,
   * because a decoder and a canvas outlive renders: rebuilding either on a state
   * change is a picture that goes black every time somebody presses a button.
   */
  useEffect(() => {
    const canvas = canvasRef.current
    // Asked before the desktop is, and that order is the point. `startScreen`
    // would say the same thing at the decoder, but by then this desk has opened
    // a capture, raised a notification and started encoding for a page that was
    // never going to show a pixel of it.
    if (!canPaintScreen()) {
      setPhase({
        kind: 'over',
        message: window.isSecureContext
          ? 'This browser cannot decode video in a page, so it cannot show that screen. Every current browser can except Firefox for Android.'
          : 'That screen can only be shown on a page served over HTTPS.'
      })
      return
    }
    if (!canvas) return

    const painter = startScreen({ canvas, onTrouble: setTrouble })
    painterRef.current = painter

    /** Nothing has come back. Said once, and only while still waiting. */
    const arm = (): void => {
      window.clearTimeout(answerTimer.current)
      answerTimer.current = window.setTimeout(() => {
        setPhase((current) =>
          current.kind === 'asking'
            ? { kind: 'over', message: `${nameRef.current} has not answered. It may be busy, or asleep — try again.` }
            : current
        )
      }, ANSWER_MS)
    }
    armRef.current = arm

    const drop = watchMirror({
      onOk: (frame) => {
        window.clearTimeout(answerTimer.current)
        setCanControl(frame.canControl === true)
        setPhase({ kind: 'live' })
        painter.open({
          codec: frame.codec,
          width: frame.width,
          height: frame.height,
          ...(frame.description ? { description: bytesOf(frame.description) } : {})
        })
      },
      onChunk: (chunk) => {
        painter.push({ key: chunk.key === true, timestamp: chunk.timestamp, data: bytesOf(chunk.data) })
      },
      onStop: (reason, needsPin) => {
        window.clearTimeout(answerTimer.current)
        // Whatever else has happened, this page is not driving anything now.
        // The desk has stopped listening, and a mode left armed would send the
        // next keystroke into a watch that has ended.
        release()
        setCanControl(false)
        setTrouble('')
        setPhase(needsPin ? { kind: 'pin', message: reason } : { kind: 'over', message: reason })
      }
    })

    // The first ask carries no PIN, always: a desktop with one set answers
    // `needsPin` and the *second* ask carries what the person typed, so this
    // page only ever holds a PIN it was just asked for. See
    // `WebMirrorStartFrame`.
    askForScreen('')
    arm()

    return () => {
      window.clearTimeout(answerTimer.current)
      drop()
      // Before the socket is told anything, because these are frames: a viewer
      // closed mid-drag would otherwise leave a button or an arrow held down on
      // a real keyboard, with nothing left on this page to release it.
      release()
      // The desktop stops capturing on this frame. Sent before the painter is
      // torn down so a browser that is closing is not still being encoded for.
      stopWatching()
      painter.stop()
      painterRef.current = null
    }
  }, [release])

  /** The PIN box's submit: ask again, carrying what was typed. */
  const submitPin = useCallback((): void => {
    if (pin.length < PIN_MIN_DIGITS) return
    const typed = pin
    setPin('')
    setPhase({ kind: 'asking' })
    askForScreen(typed)
    // Re-armed on every ask, so a desktop that goes quiet after a correct PIN
    // is a sentence rather than a spinner.
    armRef.current()
  }, [pin])

  /* ------------------------------------------------------------- the input */

  /**
   * Everything that can only exist while this page is driving.
   *
   * Attached and detached with the mode rather than gated inside a handler,
   * which is the difference between "no input is sent" and "no listener exists":
   * in watching mode there is nothing here to run at all, so there is no
   * condition anybody can get wrong later.
   *
   * `capture: true` on the keyboard pair, so a key bound by something else on
   * this page cannot eat a keystroke meant for that desk.
   */
  useEffect(() => {
    if (!driving) return

    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        const now = performance.now()
        if (now - lastEscape.current < DOUBLE_ESC_MS) {
          // The second press is spent on leaving and is not sent. Sending it too
          // would be a stray Escape landing on the desk at the moment somebody
          // asked for their browser back.
          event.preventDefault()
          lastEscape.current = 0
          release()
          return
        }
        lastEscape.current = now
      }
      const mapped = keyFor(event.key)
      if (mapped) {
        heldKeys.current.add(mapped)
        sendMirrorInput({ a: 'key', key: mapped, down: true })
        event.preventDefault()
        return
      }
      // A modifier is held, and this protocol has no field to say so — see the
      // limits in the toolbar, and the header of lib/mirror-input.ts. The
      // browser's own default is deliberately left alone: swallowing Ctrl+C to
      // send nothing would break copying here as well as there.
      if (event.ctrlKey || event.altKey || event.metaKey) return
      // One character, by code point rather than by `length`, so an emoji is one
      // character and not two halves of a surrogate pair.
      if ([...event.key].length !== 1) return
      sendMirrorInput({ a: 'text', text: event.key })
      event.preventDefault()
    }

    const onKeyUp = (event: KeyboardEvent): void => {
      const mapped = keyFor(event.key)
      if (!mapped) return
      // Only if this page is the one that pressed it. A key held before the
      // mode was entered releases into the browser, where it was pressed.
      if (!heldKeys.current.delete(mapped)) return
      sendMirrorInput({ a: 'key', key: mapped, down: false })
      event.preventDefault()
    }

    /**
     * The wheel, natively and not through React, because React attaches its own
     * wheel listener passively at the root — so an `onWheel` prop cannot call
     * `preventDefault`, and the page behind the overlay would scroll while the
     * desk scrolled too.
     */
    const onWheel = (event: WheelEvent): void => {
      const notches = notchesFor(event.deltaY, event.deltaMode)
      if (!notches) return
      // In trackpad mode the ring is the only pointer there is: these notches
      // belong at the cursor the fingers left, not under a mouse that happens
      // to be sitting on the canvas while the finger grammar is on.
      if (inputRef.current === 'trackpad') {
        event.preventDefault()
        padRef.current?.wheel(notches)
        return
      }
      const at = fractionAt(event.clientX, event.clientY)
      if (!at) return
      event.preventDefault()
      sendMirrorInput({ a: 'wheel', wheel: notches, x: at.x, y: at.y })
    }

    /**
     * Anything that means this page has stopped being looked at.
     *
     * Both, and not one: a hidden tab is the case where a key press is going
     * somewhere else entirely, and a blurred window is the case where it is
     * going to another application on *this* machine. Either way the desk should
     * not be holding a key down on this page's behalf.
     */
    const onAway = (): void => release()
    const onVisibility = (): void => {
      if (document.hidden) release()
    }

    const canvas = canvasRef.current
    window.addEventListener('keydown', onKeyDown, true)
    window.addEventListener('keyup', onKeyUp, true)
    window.addEventListener('blur', onAway)
    document.addEventListener('visibilitychange', onVisibility)
    canvas?.addEventListener('wheel', onWheel, { passive: false })
    return () => {
      window.removeEventListener('keydown', onKeyDown, true)
      window.removeEventListener('keyup', onKeyUp, true)
      window.removeEventListener('blur', onAway)
      document.removeEventListener('visibilitychange', onVisibility)
      canvas?.removeEventListener('wheel', onWheel)
    }
  }, [driving, fractionAt, release])

  /* --------------------------------------------------- the trackpad's half */

  /**
   * The trackpad's whole lifetime, modelled on the pointer's in the television
   * (TvDashboard): built when trackpad driving starts, torn down when it stops
   * or the mode changes — and the teardown is the safety device. A drag
   * abandoned by a hidden tab, a lost socket or a flip of the toggle would
   * otherwise leave a mouse button held down on somebody's real desktop, and
   * `stop()` is what releases it.
   */
  useEffect(() => {
    if (!driving || input !== 'trackpad') return
    const stage = stageRef.current
    const cursor = padCursorRef.current
    const canvas = canvasRef.current
    if (!stage || !cursor || !canvas) return
    const handle = startTouchpad({
      cursor,
      stage,
      picture: canvas,
      frameSize: () => {
        const size = painterRef.current?.size()
        // Zeroes are "nothing has decoded", and a fraction of nothing is not a
        // place. The pad falls back to the canvas's own box until a frame
        // arrives, which is the whole stage's honest middle.
        return size && size.width > 0 && size.height > 0 ? size : null
      },
      send: sendMirrorInput,
      onChange: setPadState
    })
    padRef.current = handle
    return () => {
      padRef.current = null
      handle.stop()
    }
  }, [driving, input])

  /**
   * The trackpad's own pointer handlers, on the stage and not the canvas.
   *
   * A finger on a phone is a trackpad, and a trackpad is the whole surface: in
   * this mode the black bars around the picture are glass like any other part
   * of it, and a pad that stopped tracking the finger at the edge of the video
   * would be a pointer that can only ever move half as far as its user's thumb.
   * They are gated rather than conditionally attached, so that Direct mode is
   * untouched — when the mode is 'direct', every one of these returns before
   * doing anything, and the canvas's own handlers below do all the work.
   */
  const onStageDown = (event: ReactPointerEvent<HTMLDivElement>): void => {
    // The arming press arrives here twice — once at its target and once by
    // bubbling — and the second copy has already been spent on entering the
    // mode. Consumed here whatever the mode, so a flag set in Direct mode
    // cannot sit waiting to eat the first trackpad tap of a later session.
    if (armBounce.current) {
      armBounce.current = false
      return
    }
    if (!drivingRef.current || inputRef.current !== 'trackpad') return
    const pad = padRef.current
    if (!pad) return
    event.preventDefault()
    // Keep the finger's events even when it slides off the stage or off the
    // screen entirely: a gesture that ends because the glass ran out is a
    // grammar with an edge in it, and the edge is always exactly where the
    // pointer was heading.
    event.currentTarget.setPointerCapture(event.pointerId)
    if (event.pointerType !== 'touch' && event.button !== 0) {
      // A real mouse button pressed while the finger grammar is on. The
      // grammar has no gesture for it, but the button does not need one — it
      // goes through whole, at the cursor the fingers left.
      const button = buttonOf(event.button)
      if (button) pad.click(button)
      return
    }
    pad.down(event.pointerId, event.clientX, event.clientY)
  }

  const onStageMove = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (!drivingRef.current || inputRef.current !== 'trackpad') return
    padRef.current?.move(event.pointerId, event.clientX, event.clientY)
  }

  const onStageUp = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (!drivingRef.current || inputRef.current !== 'trackpad') return
    padRef.current?.up(event.pointerId)
  }

  /**
   * The browser took the gesture away — a call, a notification, a palm landing
   * beside the finger. A cancelled press never clicks (see `cancel` in
   * lib/touchpad.ts), so there is nothing to forward and everything to release.
   */
  const onStageCancel = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (!drivingRef.current || inputRef.current !== 'trackpad') return
    padRef.current?.cancel(event.pointerId)
  }

  /**
   * No browser menu over the glass in trackpad mode: a long press is this
   * grammar's right-click, half of a gesture the pad is mid-way through
   * reading, and a menu that stole it would turn the hold into nothing.
   */
  const onStageMenu = (event: ReactMouseEvent<HTMLDivElement>): void => {
    if (drivingRef.current && inputRef.current === 'trackpad') event.preventDefault()
  }

  /* ------------------------------------------------------- the canvas's half */

  /**
   * The pointer, coalesced.
   *
   * A browser reports a move per pixel of travel and a mirrored desktop does not
   * need one: what the desk has to know is where the pointer *is*, so the frames
   * are collapsed onto an animation frame and then held to MIRROR_SEND_MS. The
   * position is read from the queue at the moment it is sent rather than at the
   * moment it arrived, so a burst of movement costs one frame carrying the
   * newest place instead of a queue of stale ones.
   */
  const onPointerMove = (event: ReactPointerEvent<HTMLCanvasElement>): void => {
    if (!drivingRef.current) return
    // Trackpad gestures are the stage's: the same event reaches its handler by
    // bubbling, and routing it here as well would count every movement twice.
    if (inputRef.current === 'trackpad') return
    move.current.x = event.clientX
    move.current.y = event.clientY
    if (move.current.frame) return
    const flush = (): void => {
      move.current.frame = 0
      if (!drivingRef.current) return
      const now = performance.now()
      if (now - move.current.sentAt < MIRROR_SEND_MS) {
        // Not yet: keep the newest position and look again next frame, rather
        // than dropping this movement or sending over the budget.
        move.current.frame = requestAnimationFrame(flush)
        return
      }
      const at = fractionAt(move.current.x, move.current.y)
      if (!at) return
      move.current.sentAt = now
      sendMirrorInput({ a: 'move', x: at.x, y: at.y })
    }
    move.current.frame = requestAnimationFrame(flush)
  }

  /**
   * A press: the gesture that enters driving, and after that a real click.
   *
   * The click that arms the mode is deliberately not also sent. It is the one
   * gesture whose meaning is "start sending", and forwarding it too would mean
   * that reaching for control always costs one press on whatever happens to be
   * under the cursor on that desk.
   */
  const onPointerDown = (event: ReactPointerEvent<HTMLCanvasElement>): void => {
    // The first touch this surface has ever seen picks the mode by itself.
    // After a hand has chosen, it stops: a phone that flipped back on every
    // touch could never take the toggle's other path.
    if (event.pointerType === 'touch' && !choseInput.current) setInput('trackpad')
    if (!drivingRef.current) {
      if (!canControl || phase.kind !== 'live') return
      event.preventDefault()
      drive()
      return
    }
    // The stage's, by bubbling — see the block above for why handling it here
    // as well would double every gesture.
    if (inputRef.current === 'trackpad') return
    const button = buttonOf(event.button)
    const at = fractionAt(event.clientX, event.clientY)
    if (!button || !at) return
    event.preventDefault()
    // Its own position rather than the last one transmitted, which is the rule
    // shared/mobile.ts sets for every pointer frame: a dropped move must not be
    // able to make the click after it land somewhere else.
    heldButtons.current.add(button)
    sendMirrorInput({ a: 'down', button, x: at.x, y: at.y })
  }

  const onPointerUp = (event: ReactPointerEvent<HTMLCanvasElement>): void => {
    if (!drivingRef.current) return
    // The stage's, by bubbling — including the release of the press that armed
    // driving, which the pad never saw land and so ignores.
    if (inputRef.current === 'trackpad') return
    const button = buttonOf(event.button)
    const at = fractionAt(event.clientX, event.clientY)
    if (!button || !at) return
    // Only if this page is the one that pressed it, exactly as a key release is.
    // The press that *entered* driving is not sent, so its release must not be
    // either — a lone `up` is a click somebody never made, delivered to whatever
    // was under the cursor on that desk.
    if (!heldButtons.current.delete(button)) return
    sendMirrorInput({ a: 'up', button, x: at.x, y: at.y })
  }

  return (
    <div className="mirror" role="dialog" aria-modal="true" aria-label={`The screen of ${desktopName}`}>
      <div className="mirror__bar">
        <span className="mirror__mode" data-driving={driving}>
          <span className="mirror__dot" />
          {driving ? 'Driving' : 'Watching'}
        </span>
        <span className="mirror__name truncate">{desktopName}</span>

        {/*
          What this cannot do, said where the person is rather than in a
          document they will never open. Every sentence here is a real
          limitation of `MirrorInput` — see the header of lib/mirror-input.ts,
          which has no modifier field to put Ctrl in and strips control
          characters out of typed text — and a UI that silently swallowed
          Ctrl+C would be worse than one that admits it cannot send it.
        */}
        <p className="mirror__limits">
          <strong>Ctrl+C, Ctrl+V, Alt+Tab and the F-keys cannot be sent</strong> — this link has no way to say a
          modifier was held. Pasted text arrives as one line, only the primary monitor is shared, and a UAC prompt will
          not accept anything typed from here.
        </p>

        {/*
          The input mode, both ways out of it always one press. Auto-selected
          for a touch, but never locked: a desktop that strayed into trackpad
          has no finger and needs the way back, and a phone that wants the
          picture pressed directly — a big button on the desk is easier to hit
          absolutely than a cursor is to drive — has the way back too. The
          label names where it is, not where the press goes, because "Direct:
          off" has told nobody anything.
        */}
        <button
          type="button"
          className="ghost-btn mirror__btn"
          aria-pressed={input === 'trackpad'}
          title={
            input === 'trackpad'
              ? 'Trackpad: slide to move the pointer, tap to click, hold still to right-click, two fingers to scroll'
              : 'Direct: the pointer goes where you press'
          }
          onClick={() => {
            choseInput.current = true
            setInput(input === 'trackpad' ? 'direct' : 'trackpad')
          }}
        >
          {input === 'trackpad' ? 'Trackpad' : 'Direct'}
        </button>

        {driving ? (
          <button type="button" className="ghost-btn mirror__btn" onClick={() => release()}>
            Stop driving
          </button>
        ) : null}
        <button
          type="button"
          className="ghost-btn mirror__btn"
          title="Close"
          aria-label="Stop watching this screen"
          onClick={onClose}
        >
          <Icon name="close" size={14} />
        </button>
      </div>

      <div
        className="mirror__stage"
        data-driving={driving}
        data-input={input}
        ref={stageRef}
        onPointerDown={onStageDown}
        onPointerMove={onStageMove}
        onPointerUp={onStageUp}
        onPointerCancel={onStageCancel}
        onContextMenu={onStageMenu}
      >
        <canvas
          ref={canvasRef}
          className="mirror__picture"
          data-live={phase.kind === 'live'}
          onPointerMove={onPointerMove}
          onPointerDown={onPointerDown}
          onPointerUp={onPointerUp}
          // Or a right-click never arrives: the browser's own menu opens over
          // the picture and the press underneath it is never delivered.
          onContextMenu={(event) => event.preventDefault()}
        />

        {/*
          The trackpad's cursor, over the picture and outside React entirely:
          lib/touchpad.ts moves it by writing one transform, because a cursor
          that re-rendered the component sixty times a second would re-render a
          decoding canvas with it. Placed by the same picture-box arithmetic
          the clicks are measured with, so the ring and the click cannot
          disagree about where the desk is being pointed.
        */}
        {driving && input === 'trackpad' ? (
          <div ref={padCursorRef} className="mirror__pad" data-state={padState} aria-hidden="true" />
        ) : null}

        {phase.kind === 'live' && !driving && canControl ? (
          input === 'trackpad' ? (
            <p className="mirror__hint">
              Tap the picture to take the mouse and keyboard. Slide to point, tap to click, hold still for a
              right-click, hold a beat then slide to drag, two fingers to scroll.
            </p>
          ) : (
            <p className="mirror__hint">Click the picture to take the mouse and keyboard. Press Escape twice to let go.</p>
          )
        ) : null}
        {phase.kind === 'live' && !canControl ? (
          <p className="mirror__hint">Watching only — this desktop is not letting a browser drive it.</p>
        ) : null}

        {phase.kind === 'asking' ? <p className="mirror__note">Asking {desktopName} for its screen…</p> : null}
        {phase.kind === 'live' && trouble ? <p className="mirror__note">{trouble}</p> : null}

        {phase.kind === 'pin' ? (
          <form
            className="mirror__card"
            onSubmit={(event) => {
              event.preventDefault()
              submitPin()
            }}
          >
            <p className="mirror__note">{phase.message}</p>
            <input
              className="gate__input"
              value={pin}
              // Digits only and never longer than the protocol allows, exactly
              // as the sign-in box does it — the desktop refuses anything else
              // and a stray character would spend a strike rather than an ask.
              onChange={(event) => setPin(event.target.value.replace(/\D/g, '').slice(0, PIN_MAX_DIGITS))}
              type="password"
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={PIN_MAX_DIGITS}
              aria-label="The desktop's unlock PIN"
              autoFocus
            />
            <button type="submit" className="cta-btn" disabled={pin.length < PIN_MIN_DIGITS}>
              Show me the screen
            </button>
          </form>
        ) : null}

        {phase.kind === 'over' ? (
          <div className="mirror__card">
            <p className="mirror__note">{phase.message}</p>
            <button
              type="button"
              className="cta-btn"
              onClick={() => {
                setPhase({ kind: 'asking' })
                askForScreen('')
                armRef.current()
              }}
            >
              Try again
            </button>
          </div>
        ) : null}
      </div>
    </div>
  )
}
