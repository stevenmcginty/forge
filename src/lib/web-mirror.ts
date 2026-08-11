/**
 * Forge Web screen mirror — the encoding half.
 *
 * The desktop's picture, on its way to a browser tab. Its sibling
 * `src/lib/mirror.ts` sends the same screen to a television over a peer
 * connection; this one encodes it by hand and hands the chunks to the socket
 * that is already carrying the terminals, because WebRTC media is peer-to-peer
 * over UDP and never enters the Cloudflare tunnel a browser reaches this desk
 * through. The whole argument is in the screen-mirror block of shared/web.ts.
 *
 * The consequence for this file is that there is no encoder being driven on our
 * behalf. A peer connection picks a codec, a bitrate, a keyframe cadence and a
 * degradation strategy, and `mirror.ts` only leans on them; here every one of
 * those is a number chosen below, with the reason written beside it. That is
 * the reason this is a module rather than a few lines inside a React effect:
 * `src/state/AppState.tsx` owns *when* a mirror runs, exactly as it does for the
 * television, and everything that can go wrong with a capture or an encoder is
 * reasoned about — and can be driven headlessly — in one place.
 *
 * Deliberately plain: no React, no app state, and the only import is the capture
 * this desktop already knows how to open.
 *
 * ## What this half cannot do
 *
 * Nothing here reads an input frame. A browser driving this desk arrives as a
 * `mirror-input` frame at electron/web-host.ts and ends at `user32.dll`; it does
 * not come past this file, and there is no path from a chunk to a keystroke.
 *
 * There is also no sound, and that is worth saying out loud because a setting
 * appears to promise one. `WebMirrorEvent` carries `audio` — main's answer to
 * `webMirrorAudio` — but shared/web.ts has no frame that can carry a sample:
 * `WebMirrorChunk` is video and `WebMirrorConfig.codec` is a video codec. So the
 * request is honoured as far as the capture (the setting decides what leaves
 * this machine, and that decision belongs in main) and the audio track is then
 * stopped rather than left running, because a Windows loopback capture held open
 * for a stream nobody can receive is a device taken from other applications for
 * nothing. Sound over this link needs a frame in the protocol first.
 */
import { captureScreen } from './mirror'
import type { WebMirrorChunk, WebMirrorConfig } from '@shared/web'

/**
 * The ceiling on the encoder, in bits per second.
 *
 * A quarter of what `mirror.ts` gives the television, and the difference is the
 * link rather than the picture. That mirror is two devices on one LAN with
 * nothing between them, so eight megabits costs nobody anything; this one leaves
 * the house through a domestic *upstream*, which on the fibre-to-the-cabinet
 * lines most of Britain is on is around ten megabits in total — shared with
 * everything else on the network, and with the terminals on this very socket,
 * which are what somebody three hundred miles away actually came for.
 *
 * Three megabits is chosen against that number and not against the picture.
 * base64 adds a third (see the screen-mirror block in shared/web.ts), so this is
 * about four megabits on the wire: a little under half of a typical upstream at
 * its worst, and nothing at all most of the time — it is a ceiling rather than a
 * target, `bitrateMode` is left at its default `variable`, and a desktop that is
 * sitting still spends almost none of it. What it buys against a *scrolling*
 * screen is legibility: an encoder holding a smaller budget answers a full-frame
 * change by throwing away detail, and the detail on this screen is ten-pixel
 * type, which is the whole reason anybody is looking.
 */
const MAX_BITRATE = 3_000_000

/**
 * How often a keyframe is forced, in milliseconds.
 *
 * Two seconds, and it is a recovery time rather than a compression setting.
 * `startScreen` in web/src/lib/screen.ts drops every delta frame until it has
 * seen a keyframe — it must, because a decoder handed a difference from a
 * picture it does not hold throws — so this number *is* how long a browser
 * stares at nothing after joining, after a decoder error, and after any chunk
 * that went missing. Two seconds is short enough that all three read as a
 * stutter rather than as a broken feature, and long enough that keyframes are
 * not most of the bitrate: at 30fps it is one in sixty frames.
 *
 * Forced here rather than left to the codec's own group-of-pictures length,
 * because that length is a property of whichever encoder Windows chose today —
 * hardware encoders routinely default to several seconds — and "how long until
 * the picture comes back" is not a thing this feature should discover per
 * machine.
 */
const KEYFRAME_MS = 2_000

/**
 * How many frames the encoder may be behind before the next one is dropped.
 *
 * The capture arrives on a clock and the encoder does not: a desk whose CPU is
 * busy with the very agents this link exists to watch will fall behind, and a
 * queue is the wrong place to absorb that. Every frame held is a frame that will
 * be decoded *late* on the far end, so an unbounded queue turns a busy minute
 * into a picture that is permanently seconds behind the desk — which is worse
 * than a lower frame rate, because a mirror somebody is clicking on has to be
 * showing now rather than showing everything.
 *
 * Two, so a brief spike is absorbed and a sustained one is paid for in frames
 * per second, which is the same trade `mirror.ts` makes with
 * `degradationPreference: 'maintain-resolution'` on the television's sender.
 */
const MAX_QUEUE = 2

/**
 * The codecs this desktop will offer, best first.
 *
 * H.264 leads because it is the one every browser decodes and the one Windows
 * encodes in hardware on essentially any GPU made this decade — which matters
 * here in a way it does not on the television, since the machine paying for this
 * encode is also the machine running the agents. The three profiles are tried in
 * turn because hardware encoders are picky in both directions: some will not
 * take High, some will not take Baseline, and which is which is a property of
 * the driver rather than of anything this file can know. Level 5.1 throughout,
 * which covers 1920x1200 at 30fps with room to spare — the capture is capped at
 * exactly that by `mirror.ts` (see MAX_WIDTH there, and its argument about
 * macroblocks).
 *
 * VP8 is the floor and cannot fail: Chromium encodes and decodes it in software
 * everywhere, so a desk with no usable H.264 encoder still mirrors. It costs CPU
 * and a softer picture at the same bitrate, which is the right price for the
 * feature working at all.
 *
 * Nothing is named in shared/web.ts on purpose — `WebMirrorConfig.codec` says
 * why — and the browser is told what was chosen rather than asked to guess.
 */
const CODECS = ['avc1.640033', 'avc1.4D0033', 'avc1.42E033', 'vp8'] as const

/**
 * `MediaStreamTrackProcessor`, which TypeScript's DOM library does not describe.
 *
 * The one piece of WebCodecs still outside the standard lib — `VideoEncoder`,
 * `VideoFrame` and `EncodedVideoChunk` are all there — so it is named here
 * rather than reached for through `any`. Same treatment, for the same reason, as
 * `DesktopCaptureConstraints` in mirror.ts: a shape this file relies on is
 * written down where somebody can read what it is expected to be.
 */
interface TrackProcessor {
  readable: ReadableStream<VideoFrame>
}

interface TrackProcessorConstructor {
  new (init: { track: MediaStreamTrack; maxBufferSize?: number }): TrackProcessor
}

/** What the mirror hands back to whoever started it. See `startWebMirror`. */
export interface WebMirrorHooks {
  /** The capture is up and the first chunk is encoded. Sent once per watch. */
  ready: (config: WebMirrorConfig) => void
  /** One encoded chunk, base64, in the order the encoder produced it. */
  chunk: (chunk: WebMirrorChunk) => void
  /** The mirror ended by itself, with a sentence for the browser. Fires once. */
  closed: (reason: string) => void
}

interface Mirror {
  stream: MediaStream
  encoder: VideoEncoder
  reader: ReadableStreamDefaultReader<VideoFrame>
  hooks: WebMirrorHooks
  /** What the browser was told, so a display that changes size is noticed. */
  width: number
  height: number
  /** True once `ready` has been called, because it may only be called once. */
  announced: boolean
  /**
   * When the last keyframe was forced, on the capture's own microsecond
   * timeline. Negative infinity until there has been one, so the first frame of
   * a watch is always a keyframe — a zero here would make every frame one on a
   * capture whose clock happens to start at zero.
   */
  keyAt: number
  /**
   * A mirror ends exactly once, whichever of a failed encoder, a track that
   * ended, an explicit stop or a browser hanging up gets there first — the same
   * rule, and the same reason, as `Mirror.closed` in mirror.ts.
   */
  closed: boolean
}

/** The one live mirror, or none. One browser watches at a time; see the server. */
let live: Mirror | null = null

/**
 * Which attempt is allowed to speak.
 *
 * Identical in purpose to `generation` in mirror.ts, and necessary here for the
 * same reason: opening a display is slow — `desktopCapturer` plus
 * `getUserMedia` plus configuring an encoder is comfortably a second — so a
 * browser that gives up and asks again puts a second attempt in flight while the
 * first is still inside an await. Only the holder of the current number reports,
 * because anything a superseded attempt has to say is news about a mirror
 * nobody is waiting on.
 */
let generation = 0

/**
 * One encoded chunk's bytes as base64.
 *
 * In slabs rather than one `String.fromCharCode(...bytes)`, which is the obvious
 * spelling and is a stack overflow on a keyframe: the spread becomes one
 * argument per byte, and a keyframe is hundreds of thousands of them.
 */
function toBase64(bytes: Uint8Array): string {
  const SLAB = 0x8000
  let text = ''
  for (let at = 0; at < bytes.length; at += SLAB) {
    text += String.fromCharCode(...bytes.subarray(at, at + SLAB))
  }
  return btoa(text)
}

/** Every track stopped — see `stopStream` in mirror.ts, which says why it matters. */
function stopStream(stream: MediaStream): void {
  for (const track of stream.getTracks()) {
    track.onended = null
    try {
      track.stop()
    } catch {
      /* already stopped */
    }
  }
}

/**
 * The one exit from a live mirror: tear it down, then say why it ended.
 *
 * Order matters, exactly as it does in mirror.ts — the teardown happens first so
 * that `closed`, which pushes a `mirror-stop` at the browser, cannot be answered
 * by a capture that is still holding the screen.
 */
function finish(mirror: Mirror, reason: string): void {
  if (mirror.closed) return
  mirror.closed = true
  if (live === mirror) stopWebMirror()
  mirror.hooks.closed(reason)
}

/**
 * The first codec this machine will actually encode with, at this size, or null.
 *
 * Asked rather than assumed. `VideoEncoder.isConfigSupported` is the only honest
 * way to find out — what a machine can encode is a property of its GPU and its
 * driver — and a config that is merely *valid* still comes back with
 * `supported: false`, which is the case that matters: guessing wrong means an
 * encoder that configures and then closes itself, several frames after anybody
 * could tell the browser why.
 */
async function chooseCodec(config: Omit<VideoEncoderConfig, 'codec'>): Promise<string | null> {
  for (const codec of CODECS) {
    try {
      const answer = await VideoEncoder.isConfigSupported({ ...config, codec })
      if (answer.supported) return codec
    } catch {
      /* a codec string this build will not even parse is simply not the one */
    }
  }
  return null
}

/**
 * Start mirroring this desktop's primary screen to a browser.
 *
 * `withAudio` is main's answer to `webMirrorAudio`, decided when the browser
 * asked and passed in rather than read here — see the note on sound in this
 * file's header for what happens to it. Returns an error sentence when the
 * mirror could not start at all, or null once frames are on their way; a mirror
 * that has started can still fail later, and that arrives on `hooks.closed`.
 */
export async function startWebMirror(withAudio: boolean, hooks: WebMirrorHooks): Promise<string | null> {
  // A second start replaces the first rather than stacking, the same as the
  // television's. The server treats a repeat `mirror-start` from the same
  // browser as a restart precisely because this side does — see its comment on
  // that case — so two captures here could only ever be one live one and one
  // holding a display open for nobody.
  stopWebMirror()
  const token = ++generation
  /** Is this attempt still the one a browser is waiting on? See `generation`. */
  const mine = (): boolean => token === generation
  /** A sentence, or nothing at all if this attempt no longer speaks for anyone. */
  const say = (reason: string): string | null => (mine() ? reason : null)

  const Processor = (window as unknown as { MediaStreamTrackProcessor?: TrackProcessorConstructor })
    .MediaStreamTrackProcessor
  if (!Processor || typeof VideoEncoder === 'undefined') {
    return say('This build of Forge cannot encode video, so it cannot share its screen with a browser.')
  }

  let stream: MediaStream | null
  try {
    stream = await captureScreen(withAudio)
  } catch {
    return say('The desktop would not share its screen.')
  }
  if (!stream) return say('The desktop could not find a screen to share.')

  // A capture that arrived after this attempt was superseded is a recording of
  // Steve's screen running for nobody, and Windows saying so in the tray.
  if (!mine()) {
    stopStream(stream)
    return null
  }

  // Sound, stopped rather than carried: this protocol has no frame for it. See
  // the header. Done before anything else can fail, so the loopback device is
  // handed back on every path out of this function rather than only the happy one.
  for (const track of stream.getAudioTracks()) {
    try {
      track.stop()
    } catch {
      /* already stopped */
    }
    stream.removeTrack(track)
  }

  const track = stream.getVideoTracks()[0]
  if (!track) {
    stopStream(stream)
    return say('The desktop captured no video.')
  }

  const settings = track.getSettings()
  // Rounded down to an even number of pixels, because H.264 codes in pairs and
  // an encoder handed an odd dimension refuses to configure. Desktop resolutions
  // are even, so this is a guard rather than a conversion — but the one machine
  // it is wrong for would fail at `configure`, with nothing on screen to explain
  // it.
  const width = Math.floor((settings.width ?? 0) / 2) * 2
  const height = Math.floor((settings.height ?? 0) / 2) * 2
  if (width < 2 || height < 2) {
    stopStream(stream)
    return say('The desktop capture came back with no picture in it.')
  }

  const base: Omit<VideoEncoderConfig, 'codec'> = {
    width,
    height,
    bitrate: MAX_BITRATE,
    framerate: 30,
    // The whole reason a live mirror can be encoded at all. `realtime` tells the
    // encoder to emit each frame as it takes it — no reordering, no B-frames, no
    // multi-frame lookahead — and to hold each one near its share of the budget
    // rather than borrowing against the next second. The second half of that is
    // what keeps a keyframe under MAX_MIRROR_CHUNK_BYTES: at three megabits and
    // thirty frames a second the average frame is about twelve kilobytes, and
    // even the twenty-fold spike a keyframe of a detailed screen represents is
    // half of the 512KB ceiling the server would end the watch over.
    latencyMode: 'realtime'
  }
  const codec = await chooseCodec(base)
  if (!mine()) {
    stopStream(stream)
    return null
  }
  if (!codec) {
    stopStream(stream)
    return say('This desktop has no video encoder a browser could be shown its screen through.')
  }

  const processor = new Processor({ track })
  const reader = processor.readable.getReader()
  const mirror: Mirror = {
    stream,
    // Assigned immediately below. Named here so `onChunk` and `onError`, which
    // are handed to the encoder's own constructor, can close over the record
    // rather than over a mutable module variable that a superseded attempt
    // might have moved on.
    encoder: null as unknown as VideoEncoder,
    reader,
    hooks,
    width,
    height,
    announced: false,
    keyAt: Number.NEGATIVE_INFINITY,
    closed: false
  }

  mirror.encoder = new VideoEncoder({
    output: (chunk, metadata) => onChunk(mirror, codec, chunk, metadata),
    error: (error: DOMException) => {
      finish(mirror, `The desktop's video encoder stopped: ${error.message || 'it gave up'}`)
    }
  })
  try {
    mirror.encoder.configure({ ...base, codec })
  } catch {
    stopStream(stream)
    void reader.cancel().catch(() => {})
    return say('This desktop could not configure a video encoder for its own screen.')
  }

  live = mirror
  // Steve ending the share at the OS level ends it here too, rather than leaving
  // the browser on the last frame it happened to receive.
  track.onended = (): void => finish(mirror, 'The desktop stopped sharing its screen.')
  // Deliberately not awaited: it runs until the track ends or the mirror is torn
  // down, and the caller's answer is "the capture is up", not "the capture is
  // over". Every ending inside it goes to `finish`.
  void pump(mirror)
  return null
}

/**
 * Read frames off the capture and feed them to the encoder, until one of them
 * stops.
 *
 * The whole of the live loop, and it is a loop rather than a callback because
 * `MediaStreamTrackProcessor` hands the capture over as a stream: reading it is
 * how backpressure is expressed, and how a track that ends is noticed without a
 * second event to subscribe to.
 */
async function pump(mirror: Mirror): Promise<void> {
  for (;;) {
    let frame: VideoFrame | undefined
    try {
      const next = await mirror.reader.read()
      if (next.done) break
      frame = next.value
    } catch {
      // A reader cancelled by the teardown lands here, which is not news: the
      // mirror it belonged to has already said whatever it had to say.
      break
    }
    if (mirror.closed || live !== mirror) {
      frame.close()
      break
    }
    try {
      // A display that changed size mid-watch. The protocol says a decoder is
      // configured once per watch (`IPC.webMirrorReady`), and a browser cannot
      // be handed frames of a size it was not configured for — so this ends the
      // watch with a sentence rather than sending pictures that will not decode.
      // Asking again starts a fresh one at the new size, which is one round trip
      // and a correct picture.
      if (mirror.announced && (frame.displayWidth > mirror.width || frame.displayHeight > mirror.height)) {
        finish(mirror, 'The desktop changed its display, so the picture stopped. Ask to watch it again.')
        break
      }
      // Behind, so this frame is dropped rather than queued. See MAX_QUEUE.
      if (mirror.encoder.encodeQueueSize > MAX_QUEUE) continue
      const key = frame.timestamp - mirror.keyAt >= KEYFRAME_MS * 1000
      if (key) mirror.keyAt = frame.timestamp
      mirror.encoder.encode(frame, { keyFrame: key })
    } catch (error) {
      finish(mirror, `The desktop could not encode its screen: ${error instanceof Error ? error.message : 'the encoder refused a frame'}`)
      break
    } finally {
      // Load-bearing, and in a `finally` because of it: a `VideoFrame` holds a
      // real buffer — usually GPU memory — until it is closed, the capture draws
      // from a pool of a few of them, and leaking a handful stalls the capture
      // with no error anywhere to explain it. The same rule `paint` in
      // web/src/lib/screen.ts follows at the other end of this pipe.
      frame.close()
    }
  }
  // The track ended under us — Steve stopped sharing, or the display went away —
  // and `track.onended` did not get there first.
  finish(mirror, 'The desktop stopped sharing its screen.')
}

/**
 * One chunk out of the encoder, on its way to the socket.
 *
 * This is also where the browser is told what it is about to receive, because
 * this is the first moment that is fully known: `description` — H.264's `avcC`
 * — is handed over in the *metadata of the first chunk* and nowhere else, and a
 * decoder configured without it cannot start. So `ready` is sent from here
 * rather than the moment the encoder configures, which is what makes it
 * possible to send it exactly once and have it be true.
 */
function onChunk(
  mirror: Mirror,
  codec: string,
  chunk: EncodedVideoChunk,
  metadata: EncodedVideoChunkMetadata | undefined
): void {
  if (mirror.closed || live !== mirror) return
  const bytes = new Uint8Array(chunk.byteLength)
  chunk.copyTo(bytes)

  if (!mirror.announced) {
    const decoder = metadata?.decoderConfig
    // The encoder's own account of what it produced, where it gave one. It knows
    // the coded size — which is padded out to whole macroblocks and is therefore
    // not always the size that was asked for — and it knows the exact codec
    // string for the profile and level it settled on, both of which a decoder is
    // configured with. Our own numbers are the fallback and not the preference.
    mirror.width = decoder?.codedWidth ?? mirror.width
    mirror.height = decoder?.codedHeight ?? mirror.height
    const description = decoder?.description
    mirror.announced = true
    mirror.hooks.ready({
      codec: decoder?.codec ?? codec,
      width: mirror.width,
      height: mirror.height,
      // Absent rather than empty when the codec does not use one: VP8 and an
      // Annex-B H.264 stream carry their parameter sets inline, and a decoder
      // handed a `description` it does not want refuses to configure. See
      // `WebMirrorConfig`.
      ...(description ? { description: toBase64(bufferBytes(description)) } : {})
    })
  }

  mirror.hooks.chunk({
    data: toBase64(bytes),
    key: chunk.type === 'key',
    timestamp: chunk.timestamp,
    ...(chunk.duration === null || chunk.duration === undefined ? {} : { duration: chunk.duration })
  })
}

/**
 * A `BufferSource` as bytes, whichever of the two things it is.
 *
 * `decoderConfig.description` is typed as either a buffer or a view onto one,
 * and the two need different constructions: a view has a byte offset and a
 * length inside a buffer that is very probably larger than it, and wrapping the
 * whole buffer would send the neighbours along with the `avcC`.
 */
function bufferBytes(source: AllowSharedBufferSource): Uint8Array {
  return ArrayBuffer.isView(source)
    ? new Uint8Array(source.buffer, source.byteOffset, source.byteLength)
    : new Uint8Array(source)
}

/**
 * Tear the mirror down. Idempotent, and safe when there never was one — every
 * path that ends a mirror comes through here, including the ones that are also
 * telling somebody why.
 *
 * Deliberately silent, exactly as `stopMirror` in mirror.ts is: an explicit stop
 * is not news to report over `closed`, because whoever called this is the one
 * who already knows.
 */
export function stopWebMirror(): void {
  const mirror = live
  live = null
  // Before the early return, not after: a stop that lands while a capture is
  // still being opened has no `live` mirror to tear down, and that is exactly
  // the case this counter exists for — the attempt in flight must come back to
  // find itself superseded and say nothing.
  generation += 1
  if (!mirror) return
  mirror.closed = true
  // Cancelled before the encoder is closed, so `pump` cannot be woken by one
  // last frame and hand it to something that has gone.
  void mirror.reader.cancel().catch(() => {})
  try {
    if (mirror.encoder.state !== 'closed') mirror.encoder.close()
  } catch {
    /* an encoder that is already gone is the state this wanted anyway */
  }
  stopStream(mirror.stream)
}
