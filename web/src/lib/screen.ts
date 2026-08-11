/**
 * The browser's end of the desktop screen stream — encoded chunks in, pixels on
 * a canvas.
 *
 * Forge Mobile and Forge TV watch the same desktop over WebRTC, and that is
 * exactly why this file is not a copy of mobile/src/lib/mirror.ts. WebRTC media
 * leaves the machine peer-to-peer over UDP; it never enters the tunnel the
 * browser reached this page through, so a browser on somebody else's network
 * needs a TURN server to relay it and the feature acquires a piece of hosted
 * infrastructure that can be down. Sending the picture down the WebSocket that
 * is already carrying the terminals costs a softer image and no adaptive
 * bitrate, and buys a mirror that cannot fail for any network reason the
 * terminals do not already fail for — same socket, same tunnel, same auth, same
 * origin check.
 *
 * So there is no peer connection here and no `<video>` element: what arrives is
 * a stream of already-encoded frames, and turning those back into pixels
 * without a media element is precisely what WebCodecs is for.
 *
 * Framework-free on purpose, exactly like mobile/src/lib/mirror.ts. A decoder
 * outlives renders and must never be rebuilt by one, and a canvas is painted by
 * writing to it rather than by asking React to. The component that owns *when* a
 * stream starts and stops lives elsewhere; this owns what a decoder is.
 *
 * ## What this rules out
 *
 * `VideoDecoder` is supported in Chrome and Edge from 94, Safari from 16.4 —
 * desktop and iOS — and Firefox for desktop from 130. **Firefox for Android has
 * it in no version at all** (mdn/browser-compat-data, api/VideoDecoder.json:
 * `firefox_android: {version_added: false}`), which is the one browser this
 * decision costs. Firefox on a desktop is fine, which is the case that was
 * actually in doubt.
 *
 * It is also secure-context only, so the API is simply absent on a page served
 * over plain http from anything but localhost. Forge Web is served over HTTPS
 * from Firebase Hosting and dialled over `wss://`, so that is not a
 * configuration anybody reaches by accident — but it is a different sentence
 * from "this browser cannot", and the two are told apart below.
 *
 * ## Nothing here is silent
 *
 * A canvas that stops updating looks identical whichever way it broke: no
 * WebCodecs, a codec the desktop chose and this browser has never had, a decoder
 * that died mid-stream, or a stream joined between keyframes. Every one of those
 * arrives at `onTrouble` as a sentence somebody can act on, and the empty string
 * is how this file says the picture is live again.
 *
 * Pacing is not this file's job. Nothing here drops a chunk to catch up or asks
 * the desktop to send less; if the link cannot carry what is being sent, that is
 * decided at the end that is doing the sending.
 */

/**
 * What the desktop is sending, as the decoder needs it described.
 *
 * `codec` is a WebCodecs codec string — `avc1.42E01F` and the like — and not a
 * MIME type. `description` is the codec's own setup bytes (the `avcC` record for
 * H.264 in its length-prefixed form), which some codecs cannot start without and
 * others do not use at all; it is passed through untouched because only the
 * encoder at the other end knows which case it is in.
 */
export interface ScreenSource {
  codec: string
  width: number
  height: number
  description?: BufferSource
}

/** One encoded frame, off the wire. */
export interface ScreenChunk {
  /** A frame that stands alone, as opposed to one that needs its ancestors. */
  key: boolean
  /** Microseconds, which is WebCodecs' unit and not the wire's choice. */
  timestamp: number
  data: BufferSource
}

export interface ScreenOptions {
  /** The canvas painted into. Resized to the decoded frame, never scaled here. */
  canvas: HTMLCanvasElement
  /**
   * What is wrong with the picture, in a sentence, or `''` when nothing is.
   *
   * Called only when the answer changes, so a caller may render it straight
   * into a banner without a decoder's frame rate arriving in its state.
   */
  onTrouble: (reason: string) => void
}

export interface ScreenPainter {
  /**
   * Point the decoder at a stream. Called again whenever the desktop changes
   * what it is sending — a new resolution, a new codec, or a reconnect — and
   * each call discards whatever was decoding before it.
   */
  open(source: ScreenSource): void
  /** One encoded frame. Never throws; a chunk it cannot use is a sentence. */
  push(chunk: ScreenChunk): void
  /**
   * The size of the frames actually being decoded, or zeroes before the first
   * one has painted.
   *
   * This and not `ScreenSource`'s numbers, because the thing that needs them is
   * the pointer mapping (see mirror-input.ts), and a fraction of the wrong
   * rectangle is a click in the wrong place. What decodes is the truth; what was
   * announced is a claim.
   */
  size(): { width: number; height: number }
  /** Finish. Idempotent, and silent — it does not call `onTrouble`. */
  stop(): void
}

/**
 * Can this browser decode video in a page at all?
 *
 * Exported so a component can decide what to draw before it has anything to
 * decode — the honest answer to Firefox for Android is a sentence in place of a
 * canvas, not a canvas that never lights up.
 */
export function canPaintScreen(): boolean {
  return typeof VideoDecoder !== 'undefined' && typeof EncodedVideoChunk !== 'undefined'
}

/** Said while the stream has been opened but no keyframe has arrived yet. */
const WAITING = 'Waiting for the desktop to send a full frame.'

export function startScreen(options: ScreenOptions): ScreenPainter {
  const { canvas, onTrouble } = options
  /**
   * Taken once. A context is per-canvas and permanent — asking a second time
   * returns the same object — and the failure case is a canvas that has already
   * been given a different kind of context by somebody else.
   */
  const context = canvas.getContext('2d')

  let decoder: VideoDecoder | null = null
  /**
   * Is the next usable chunk a keyframe?
   *
   * A decoder handed a delta frame with nothing to decode it against throws, so
   * the deltas between joining a stream and the next keyframe are dropped here
   * rather than offered to it. The ordinary case: the browser opened the stream
   * mid-second and the desktop's next keyframe is not out yet.
   */
  let waiting = true
  /** The last sentence given to `onTrouble`, so it is only told when it changes. */
  let trouble = ''
  let width = 0
  let height = 0
  let stopped = false

  const say = (reason: string): void => {
    if (reason === trouble) return
    trouble = reason
    onTrouble(reason)
  }

  /** Let go of the decoder without saying anything about why. */
  const release = (): void => {
    const going = decoder
    decoder = null
    if (!going) return
    try {
      if (going.state !== 'closed') going.close()
    } catch {
      /* a decoder that is already gone is the state this wanted anyway */
    }
  }

  const paint = (frame: VideoFrame): void => {
    try {
      if (stopped || !context) return
      // `display*` rather than `coded*`: a codec pads its frames out to whole
      // macroblocks, and the coded size includes the padding that is meant to
      // be cropped away — the same 1080-into-1088 problem the desktop's capture
      // caps avoid by never asking for a height that is not a multiple of 16.
      const frameWidth = frame.displayWidth
      const frameHeight = frame.displayHeight
      // Only on a real change: assigning to `canvas.width` clears the canvas,
      // so doing it every frame is a picture that flickers through black.
      if (frameWidth !== width || frameHeight !== height) {
        width = frameWidth
        height = frameHeight
        canvas.width = frameWidth
        canvas.height = frameHeight
      }
      context.drawImage(frame, 0, 0)
      // Something decoded, so whatever was wrong is over. This is the only
      // place the picture is declared healthy, because it is the only evidence.
      say('')
    } finally {
      // Load-bearing, and in a `finally` because of it. A `VideoFrame` holds a
      // real buffer — often GPU memory — until it is closed, the decoder draws
      // its output from a pool of a few of them, and a handful of leaked frames
      // is a picture that freezes with no error anywhere to explain it.
      frame.close()
    }
  }

  return {
    open(source: ScreenSource): void {
      if (stopped) return
      release()
      waiting = true
      if (!context) {
        say('This browser would not give the canvas something to paint into.')
        return
      }
      if (!canPaintScreen()) {
        // Two different problems wearing the same missing global. WebCodecs is
        // secure-context only, so a page served over plain http has no
        // `VideoDecoder` however modern the browser is, and telling somebody to
        // change browser when the answer is the address bar helps nobody.
        say(
          window.isSecureContext
            ? 'This browser cannot decode video in a page. Every current browser can except Firefox for Android.'
            : 'The screen can only be shown on a page served over HTTPS.'
        )
        return
      }
      try {
        const next = new VideoDecoder({
          output: paint,
          // Where an unsupported codec actually lands. `configure` validates the
          // shape of a config synchronously and reports its *support* here,
          // asynchronously, by closing the decoder — so both endings need
          // catching and neither is reliably the one that fires.
          error: (error: DOMException): void => {
            release()
            waiting = true
            say(`The picture stopped decoding: ${error.message || 'the decoder gave up'}`)
          }
        })
        next.configure({
          codec: source.codec,
          codedWidth: source.width,
          codedHeight: source.height,
          description: source.description,
          // A mirror is watched live, so a frame held back to smooth playback is
          // a frame arriving late. This asks the decoder to emit as soon as it
          // can rather than to buffer for an even cadence.
          optimizeForLatency: true
        })
        decoder = next
        say(WAITING)
      } catch {
        release()
        say(`The desktop is sending video this browser cannot decode (${source.codec}).`)
      }
    },

    push(chunk: ScreenChunk): void {
      const live = decoder
      // Not an error worth a sentence: a chunk arriving after a decoder died or
      // was closed is the socket being one frame behind the teardown, and the
      // reason the decoder is gone has already been said.
      if (stopped || !live || live.state !== 'configured') return
      if (waiting) {
        if (!chunk.key) return
        waiting = false
      }
      try {
        live.decode(
          new EncodedVideoChunk({
            type: chunk.key ? 'key' : 'delta',
            timestamp: chunk.timestamp,
            data: chunk.data
          })
        )
      } catch (error) {
        release()
        waiting = true
        say(`The picture stopped decoding: ${error instanceof Error ? error.message : 'a frame would not decode'}`)
      }
    },

    size(): { width: number; height: number } {
      return { width, height }
    },

    stop(): void {
      stopped = true
      release()
    }
  }
}
