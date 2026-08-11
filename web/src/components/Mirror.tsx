import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react'
import { Icon } from '@/components/Icon'
import type { MirrorButton, MirrorKey } from '@shared/mobile'
import { PIN_MAX_DIGITS, PIN_MIN_DIGITS } from '@shared/web'
import { askForScreen, sendMirrorInput, stopWatching, watchMirror } from '../lib/client'
import { fractionFor, keyFor, notchesFor } from '../lib/mirror-input'
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

  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const painterRef = useRef<ScreenPainter | null>(null)
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
    if (!drivingRef.current) {
      if (!canControl || phase.kind !== 'live') return
      event.preventDefault()
      drive()
      return
    }
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

      <div className="mirror__stage" data-driving={driving}>
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

        {phase.kind === 'live' && !driving && canControl ? (
          <p className="mirror__hint">Click the picture to take the mouse and keyboard. Press Escape twice to let go.</p>
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
