/**
 * Forge TV screen mirror — the capture half.
 *
 * One peer connection at a time, and it lives in the renderer because this is
 * the only half of Electron with a WebRTC stack: the main process can relay an
 * SDP but cannot make one. So the shape of the feature is a relay with the
 * interesting parts at the ends — a `<video>` on the Fire Stick, this file on
 * the desktop, and `electron/mobile/server.ts` in the middle forwarding
 * strings it never reads. See the screen-mirror block in shared/mobile.ts.
 *
 * Deliberately plain: no React, no app state, no imports beyond the preload
 * bridge. `src/state/AppState.tsx` owns the subscription and nothing else, so
 * everything that can go wrong with a capture is reasoned about in one file.
 *
 * View-only, and structurally so. Nothing here reads an input frame, and there
 * is no channel by which the television could send one.
 */

/**
 * The cap on what leaves this machine.
 *
 * A Fire Stick asked to decode 4K60 over house wifi does not produce a better
 * picture, it produces a slideshow and a hot dongle. 30fps is plenty for
 * watching a desktop, which is mostly a still image with a cursor on it.
 *
 * **1200 rather than 1080, on a television that is 1080p.** The height looks
 * wrong and is deliberate, for two reasons that both come from the same fact:
 * a great many desktops are 16:10, and capping such a screen at 1080 tall makes
 * the capture rescale itself on the way out.
 *
 * The first is sharpness. A 1920x1200 screen squeezed to 1728x1080 is resampled
 * by 0.9 — a non-integer factor, which softens exactly the small text this
 * feature exists to carry — and the encoder then spends its bits compressing
 * that softened result. Sent at its own size, the codec sees crisp native
 * pixels and the television's own scaler does the fitting, after decoding, on
 * a clean image. The picture on the wall is the same size either way; the
 * difference is which end resamples and whether compression happens before or
 * after it.
 *
 * The second is why this changed. Neither 1080 nor 1200 is a strange number to
 * a scaler, but H.264 codes in 16x16 macroblocks, and 1080 is not a multiple of
 * 16: an encoder must pad the frame to 1088 and mark the last eight rows to be
 * cropped away. Hardware encoders are not reliably careful about what they
 * leave in the padding, and a band of uninitialised video memory decodes to a
 * vivid green stripe across the picture — which is what a desktop here did,
 * mid-stream, on an Intel Arc encoder. 1920 and 1200 are both multiples of 16,
 * so there is no padding to get wrong.
 *
 * Still a ceiling, not a target: a 4K screen is capped to this and rescaled,
 * because a Fire Stick decoding 4K is the slideshow above.
 */
const MAX_WIDTH = 1920
const MAX_HEIGHT = 1200
const MAX_FPS = 30

/**
 * The ceiling on the encoder, in bits per second, and the reason the text on
 * the television is readable at all.
 *
 * WebRTC was built to carry faces over the open internet, so left alone it
 * budgets like it: a couple of megabits, spent on keeping motion smooth. A
 * desktop is the opposite problem. It barely moves, and when it does — a
 * scrolling browser, a repainting terminal — every pixel on the screen changes
 * at once, and a codec holding a small budget answers that by throwing away
 * resolution. The picture stays at 30fps and the letters turn to soup, which is
 * exactly what a 1080p wall of ten-pixel type looks like at 960 wide.
 *
 * Eight megabits is generous and is meant to be: both ends are on one LAN with
 * nothing between them, and the number is a ceiling rather than a target. A
 * still desktop spends almost none of it. See `widenTheChannel`, which also
 * tells the encoder which way to fail when the ceiling is not reachable.
 */
const MAX_BITRATE = 8_000_000

/** How often the desktop tells the television how the stream is really going. */
const STATS_MS = 1000

/**
 * Electron's desktop-capture constraints, which `getUserMedia` accepts and
 * `MediaTrackConstraints` has never described.
 *
 * Named as a type rather than cast inline so the shape stays readable:
 * `chromeMediaSourceId` is the id `desktopCapturer` hands out in main (see
 * `mobileMirrorSource`), and the `max*` fields are the only way to bound a
 * desktop stream — Chromium rejects a modern `width`/`frameRate` constraint
 * sitting alongside a `mandatory` block as malformed, so the caps have to live
 * inside it.
 */
interface DesktopCaptureConstraints {
  mandatory: {
    chromeMediaSource: 'desktop'
    chromeMediaSourceId: string
    maxWidth: number
    maxHeight: number
    maxFrameRate: number
  }
}

interface Mirror {
  peer: RTCPeerConnection
  stream: MediaStream
  send: (data: string) => void
  onClosed: (reason: string) => void
  /** The repeating stats sample, or 0 when none is running. See `reportStats`. */
  statsTimer: number
  /** The previous sample's totals, so a rate can be a rate and not a total. */
  lastBytes: number
  lastAt: number
  /**
   * A mirror ends exactly once, whichever of a failed connection, a closed
   * peer, Steve ending the share or an explicit stop gets there first. Every
   * ending checks this, so the caller is never told twice about a mirror it
   * has already forgotten.
   */
  closed: boolean
}

/** The one live mirror, or none. See the file header for why there is one. */
let live: Mirror | null = null

/**
 * Which attempt is allowed to speak.
 *
 * A capture is slow — `desktopCapturer` plus `getUserMedia` plus an offer is
 * comfortably a second, and can be several — and the television gives up
 * waiting after six. So the ordinary shape of a slow start is: the TV declares
 * silence, the sofa presses Back and then OK again, and a *second* attempt is
 * under way while the first is still inside an await.
 *
 * The failure that made this counter necessary is what happened next. The first
 * attempt would surface its cancellation as an error sentence, the renderer
 * would push it as a `mirror-stop`, and the server would deliver it to whoever
 * is watching *now* — the healthy second attempt — and forget it had a viewer.
 * Every retry was killed by the ghost of the one before it, which is why the
 * television read "the mirror was stopped before it started" no matter how many
 * times anybody pressed OK.
 *
 * Every start takes a number, and only the holder of the current one reports.
 * Anything a superseded attempt has to say is news about a mirror nobody is
 * waiting on, and whoever superseded it already knows.
 */
let generation = 0

/**
 * Open a stream onto the primary screen, or null when there is no screen to
 * open one onto.
 *
 * Video always; sound only when `withAudio`, which is main's answer to the
 * `mobileMirrorAudio` setting and arrives with the request rather than being
 * read here (see MobileMirrorEvent in shared/types.ts). Off by default for the
 * reason this comment used to give for refusing outright: what Windows hands
 * back is the *system* mix, so every notification chime, every call and every
 * video on this desktop goes to a television that may be in a room with other
 * people in it. The reason it can be switched on at all is Forge's own voice
 * agent, which speaks out of the desk's speakers and so cannot be heard from
 * the sofa the mirror is watched from.
 *
 * The audio attempt is separate from the video one on purpose. Windows loopback
 * capture is the part of this that fails — a device that has gone, an exclusive
 * mode owner, a driver that will not share — and it must not be able to take the
 * picture down with it. A mirror with no sound is the feature working slightly
 * less well; a mirror with no picture is the feature not working.
 */
async function captureScreen(withAudio: boolean): Promise<MediaStream | null> {
  const sourceId = await window.forge.mobile.mirrorSource()
  if (!sourceId) return null
  const video: DesktopCaptureConstraints = {
    mandatory: {
      chromeMediaSource: 'desktop',
      chromeMediaSourceId: sourceId,
      maxWidth: MAX_WIDTH,
      maxHeight: MAX_HEIGHT,
      maxFrameRate: MAX_FPS
    }
  }
  if (withAudio) {
    // `chromeMediaSourceId` is deliberately absent from the audio half. Windows
    // loopback is a property of the machine, not of the window or screen being
    // captured, and naming a source here is how the whole call comes back with
    // NotFoundError instead of a stream.
    const audio = { mandatory: { chromeMediaSource: 'desktop' } }
    try {
      return await navigator.mediaDevices.getUserMedia({
        audio: audio as unknown as MediaTrackConstraints,
        video: video as unknown as MediaTrackConstraints
      })
    } catch {
      /* falls through to the silent capture below — see the note above */
    }
  }
  return await navigator.mediaDevices.getUserMedia({
    audio: false,
    video: video as unknown as MediaTrackConstraints
  })
}

/**
 * Ask for H.264 ahead of everything else, when this build offers it.
 *
 * The Fire Stick decodes H.264 in hardware and VP8 in software, which is the
 * difference between a smooth 1080p desktop and a dongle dropping every other
 * frame. It is a preference and nothing more: a build whose capability list has
 * no H.264, or which will not take the list at all, keeps its own order and
 * mirrors perfectly well. Never worth failing a mirror over.
 */
function preferH264(transceiver: RTCRtpTransceiver): void {
  const capabilities = RTCRtpSender.getCapabilities('video')
  if (!capabilities) return
  const isH264 = (codec: RTCRtpCodec): boolean => /^video\/h264$/i.test(codec.mimeType)
  const h264 = capabilities.codecs.filter(isH264)
  if (h264.length === 0) return
  try {
    transceiver.setCodecPreferences([...h264, ...capabilities.codecs.filter((c) => !isH264(c))])
  } catch {
    /* an older build that will not take the list keeps its own order */
  }
}

/**
 * Tell the encoder it is looking at a screen, not at a room.
 *
 * `contentHint` is the one-word version of the whole problem. Left unset, a
 * track off `getUserMedia` is assumed to be a camera, and every trade the
 * encoder makes is the trade a camera wants: blur a frame rather than stutter,
 * because a soft face at 30fps beats a sharp one at 12. `'text'` reverses it —
 * hold the edges, drop frames if something has to give. On a desktop, where the
 * picture is words and the words are why the television is on, that is the only
 * honest answer.
 *
 * Assigned rather than checked because it is a hint in the strict sense: an
 * engine that has never heard of it ignores the string and mirrors as before.
 */
function preferSharpness(track: MediaStreamTrack): void {
  track.contentHint = 'text'
}

/**
 * Raise the ceiling, and choose which way the picture fails under it.
 *
 * Two settings, and the second matters more than the first.
 * `maxBitrate` lifts the budget to something a LAN can obviously carry. But a
 * budget is only permission to spend; `degradationPreference` decides what
 * happens when the encoder still cannot fit — and its default for a screen
 * share is to keep the frame rate and shrink the frame. That is the blur.
 * `'maintain-resolution'` says the opposite: stay at 1920 and let the frames
 * per second fall instead. A desktop that redraws at 12fps while you scroll and
 * is legible throughout is worth more than a smooth one you cannot read, which
 * is the same reason `MAX_FPS` can stay at 30 — under pressure this now spends
 * the frame rate rather than the pixels, without anybody choosing a number.
 *
 * Applied after `setLocalDescription`, which is where Chromium has finally
 * populated the encodings array; before it, some builds hand back an empty one
 * and quietly drop what is written into it. Failure here is never worth ending
 * a mirror over — a build that will not take these parameters gives the picture
 * it would have given anyway.
 */
async function widenTheChannel(sender: RTCRtpSender): Promise<void> {
  try {
    const parameters = sender.getParameters()
    // One entry, because this sender is not simulcast: a mirror has exactly one
    // viewer on one television, and there is no second quality to publish.
    if (!parameters.encodings || parameters.encodings.length === 0) {
      parameters.encodings = [{}]
    }
    parameters.encodings[0].maxBitrate = MAX_BITRATE
    // Explicit, because a sender that has already scaled itself down once will
    // otherwise keep the factor it chose while it was starved.
    parameters.encodings[0].scaleResolutionDownBy = 1
    parameters.degradationPreference = 'maintain-resolution'
    await sender.setParameters(parameters)
  } catch {
    /* a build that will not take them keeps its own defaults */
  }
}

/**
 * What the desktop knows about its own outbound stream, once a second.
 *
 * The point of this is arbitration. "The television looks blurry" has at least
 * four causes that feel identical from the sofa — a starved encoder, a busy
 * CPU, a lossy wifi hop, or a picture that is genuinely 1920 wide and simply
 * being watched from too far away — and only the sender can tell them apart.
 * `qualityLimitationReason` in particular is the whole argument settled in one
 * word, and it exists nowhere else.
 *
 * Shaped as a JSON payload down the existing signalling channel, because that
 * channel is already a relay for opaque strings and the alternative is a second
 * one. The viewer's own half of the picture — what actually decoded, and on
 * what — is measured on the television; see `readStats` in mobile/src/lib.
 */
interface StatsFrame {
  kind: 'stats'
  /** What the capture is handing the encoder, before any scaling. */
  srcWidth: number
  srcHeight: number
  /** What actually left, which is the number the blur argument is about. */
  width: number
  height: number
  fps: number
  kbps: number
  /** 'none' | 'bandwidth' | 'cpu' | 'other' — Chromium's own verdict. */
  limit: string
  /** Seconds spent limited by each cause since the mirror started. */
  limitedBy: { bandwidth: number; cpu: number; other: number }
  /** The codec that won the negotiation, e.g. 'video/H264'. */
  codec: string
  /** Round trip to the television, in milliseconds, or -1 when not yet known. */
  rttMs: number
  /** Fraction of packets the television reported missing, 0–100. */
  lossPct: number
  /** Keyframes the television has had to ask for. Rising means it is struggling. */
  pli: number
}

/** The handful of stats fields this file reads, named rather than left as any. */
interface OutboundVideoStats {
  bytesSent?: number
  frameWidth?: number
  frameHeight?: number
  framesPerSecond?: number
  qualityLimitationReason?: string
  qualityLimitationDurations?: Record<string, number>
  pliCount?: number
  codecId?: string
}

/**
 * Take one sample and send it. Silent on every failure: a stats frame is a
 * courtesy to a debug overlay, and nothing about the picture depends on one
 * arriving. A mirror that ends between the await and the send simply stops.
 */
async function reportStats(mirror: Mirror): Promise<void> {
  let report: RTCStatsReport
  try {
    report = await mirror.peer.getStats()
  } catch {
    return
  }
  if (mirror.closed || live !== mirror) return

  // Gathered onto one object rather than into three locals: the compiler cannot
  // see that a callback it did not call has assigned anything, and narrows a
  // `let` set only inside `forEach` to the null it was declared with.
  const found: {
    outbound?: OutboundVideoStats
    pair?: { currentRoundTripTime?: number }
    remote?: { fractionLost?: number }
  } = {}
  report.forEach((entry: { type?: string; kind?: string; state?: string }) => {
    if (entry.type === 'outbound-rtp' && entry.kind === 'video') found.outbound = entry as OutboundVideoStats
    else if (entry.type === 'candidate-pair' && entry.state === 'succeeded')
      found.pair = entry as { currentRoundTripTime?: number }
    else if (entry.type === 'remote-inbound-rtp' && entry.kind === 'video')
      found.remote = entry as { fractionLost?: number }
  })
  const out = found.outbound
  // Nothing has been sent yet — the first sample of a mirror still negotiating.
  if (!out) return

  const now = performance.now()
  const bytes = out.bytesSent ?? 0
  // The first sample has no predecessor to subtract, and a rate off a single
  // total would read as every byte since the mirror began arriving at once.
  const elapsed = mirror.lastAt > 0 ? (now - mirror.lastAt) / 1000 : 0
  const kbps = elapsed > 0 ? Math.max(0, Math.round(((bytes - mirror.lastBytes) * 8) / 1000 / elapsed)) : 0
  mirror.lastBytes = bytes
  mirror.lastAt = now

  const codecEntry = out.codecId ? (report.get(out.codecId) as { mimeType?: string } | undefined) : undefined
  const track = mirror.stream.getVideoTracks()[0]
  const settings = track?.getSettings() ?? {}
  const durations = out.qualityLimitationDurations ?? {}
  const seconds = (value: number | undefined): number => Math.round(value ?? 0)

  const frame: StatsFrame = {
    kind: 'stats',
    srcWidth: settings.width ?? 0,
    srcHeight: settings.height ?? 0,
    width: out.frameWidth ?? 0,
    height: out.frameHeight ?? 0,
    fps: Math.round(out.framesPerSecond ?? 0),
    kbps,
    limit: out.qualityLimitationReason ?? 'unknown',
    limitedBy: {
      bandwidth: seconds(durations.bandwidth),
      cpu: seconds(durations.cpu),
      other: seconds(durations.other)
    },
    codec: codecEntry?.mimeType ?? 'unknown',
    rttMs:
      found.pair?.currentRoundTripTime === undefined ? -1 : Math.round(found.pair.currentRoundTripTime * 1000),
    lossPct: Math.round((found.remote?.fractionLost ?? 0) * 1000) / 10,
    pli: out.pliCount ?? 0
  }
  mirror.send(JSON.stringify(frame))
}

/**
 * The one exit from a live mirror: tear it down, then say why it ended.
 *
 * Order matters. The teardown happens first so that `onClosed` — which pushes a
 * `mirror-stop` at the television — cannot be answered by a peer connection
 * that is still holding the screen.
 */
function finish(mirror: Mirror, reason: string): void {
  if (mirror.closed) return
  mirror.closed = true
  if (live === mirror) stopMirror()
  mirror.onClosed(reason)
}

/**
 * Start mirroring this desktop's primary screen to a television.
 *
 * `withAudio` is main's answer to `mobileMirrorAudio`, decided when the
 * television asked and passed in rather than read here; `send` carries one
 * signalling payload to the viewer; `onClosed` fires once, with a sentence for
 * the television, if the mirror ends by itself. Returns an error sentence when
 * it could not start at all, or null once the offer is away — a mirror that has
 * started can still fail later, and that arrives on `onClosed` rather than here.
 */
export async function startMirror(
  withAudio: boolean,
  send: (data: string) => void,
  onClosed: (reason: string) => void
): Promise<string | null> {
  // A second start replaces the first rather than stacking. The server allows
  // one viewer, so two peer connections here could only ever be one live one
  // and one quietly holding a screen capture open for nobody.
  stopMirror()
  const token = ++generation
  /**
   * Is this attempt still the one the television is waiting on? Checked before
   * every sentence that leaves this function, because an attempt that has been
   * superseded or stopped must end in silence — see `generation`.
   */
  const mine = (): boolean => token === generation
  /** A sentence, or nothing at all if this attempt no longer speaks for anyone. */
  const say = (reason: string): string | null => (mine() ? reason : null)

  let stream: MediaStream | null
  try {
    stream = await captureScreen(withAudio)
  } catch {
    // A refused permission and a cancelled picker land here as the same thing,
    // and the television can do nothing about either beyond being told.
    return say('The desktop would not share its screen.')
  }
  if (!stream) return say('The desktop could not find a screen to share.')

  // A stream that arrived after this attempt was superseded is a capture of
  // Steve's screen running for nobody, and Windows saying so in the tray.
  if (!mine()) {
    stopStream(stream)
    return null
  }

  const track = stream.getVideoTracks()[0]
  if (!track) {
    stopStream(stream)
    return say('The desktop captured no video.')
  }

  // No ICE servers, on purpose. Both ends are on this LAN, so host candidates
  // are the only ones that can ever win a connectivity check; a STUN server
  // would add a round trip to the internet before the first frame and make a
  // feature that works with the router's uplink unplugged depend on it.
  const peer = new RTCPeerConnection({ iceServers: [] })
  const mirror: Mirror = { peer, stream, send, onClosed, closed: false, statsTimer: 0, lastBytes: 0, lastAt: 0 }
  live = mirror

  preferSharpness(track)
  const transceiver = peer.addTransceiver(track, { direction: 'sendonly', streams: [stream] })
  preferH264(transceiver)

  // Sound, when the capture came back with any. Send-only for the same reason
  // the video is: the television has no microphone this desktop wants, and a
  // recvonly half would have Chromium negotiating a return channel that nothing
  // on either end ever fills. Added after the video so the m-line order is
  // stable — video first, audio second — across every renegotiation.
  const audioTrack = stream.getAudioTracks()[0]
  if (audioTrack) peer.addTransceiver(audioTrack, { direction: 'sendonly', streams: [stream] })

  peer.onicecandidate = (event): void => {
    if (!event.candidate) return
    send(JSON.stringify({ kind: 'candidate', candidate: event.candidate.toJSON() }))
  }
  peer.onconnectionstatechange = (): void => {
    if (peer.connectionState === 'failed') finish(mirror, 'The connection to the television dropped.')
    else if (peer.connectionState === 'closed') finish(mirror, 'The mirror closed.')
  }
  // Steve ending the share at the OS level ends it here too, rather than
  // leaving the television on the last frame it happened to receive.
  track.onended = (): void => finish(mirror, 'The desktop stopped sharing its screen.')

  try {
    const offer = await peer.createOffer()
    await peer.setLocalDescription(offer)
    // The world may have moved on across those two awaits — a viewer that hung
    // up is a stopped mirror, and an offer for it would be describing a screen
    // capture that no longer exists. Silently, like every other exit a
    // superseded attempt takes: see `generation`.
    if (live !== mirror) return null
    // After the local description and before the offer goes out, which is the
    // first moment the sender's encodings exist to be written to. Awaited so a
    // mirror is never negotiated at the old ceiling and widened a tick later.
    await widenTheChannel(transceiver.sender)
    if (live !== mirror) return null
    send(JSON.stringify({ kind: 'offer', sdp: peer.localDescription?.sdp ?? offer.sdp ?? '' }))
    // Only once there is something to describe. The timer is the mirror's, and
    // `stopMirror` is the only thing that clears it.
    mirror.statsTimer = window.setInterval(() => void reportStats(mirror), STATS_MS)
  } catch {
    // Guarded, like the check above it: a failure here is this mirror's to
    // clean up, and an unguarded stop would take down whichever mirror had
    // replaced it while these awaits were in flight.
    if (live !== mirror) return null
    stopMirror()
    return 'The desktop could not start the stream.'
  }
  return null
}

/**
 * One signalling payload from the television.
 *
 * Total by construction. This string arrived off a socket, so a malformed or
 * hostile one is dropped rather than thrown: two shapes are understood — the
 * answer to our offer, and an ICE candidate — and everything else, including
 * anything that is not JSON at all, is silence.
 */
export function handleSignal(data: string): void {
  const mirror = live
  if (!mirror || mirror.closed) return

  let message: unknown
  try {
    message = JSON.parse(data)
  } catch {
    return
  }
  if (!message || typeof message !== 'object' || Array.isArray(message)) return
  const { kind, sdp, candidate } = message as { kind?: unknown; sdp?: unknown; candidate?: unknown }

  if (kind === 'answer') {
    if (typeof sdp !== 'string' || !sdp) return
    // An answer that will not apply is the negotiation failing, and there is no
    // second one coming — so this one ends the mirror rather than hanging.
    void mirror.peer.setRemoteDescription({ type: 'answer', sdp }).catch(() => {
      finish(mirror, 'The television answered in a way this desktop could not read.')
    })
    return
  }

  if (kind === 'candidate') {
    if (!candidate || typeof candidate !== 'object') return
    // A candidate that will not parse is one lost path, not a lost mirror: the
    // others are still being tried, and on a LAN one of them is the answer.
    void mirror.peer.addIceCandidate(candidate as RTCIceCandidateInit).catch(() => {})
  }
}

/**
 * Tear the mirror down. Idempotent, and safe when there never was one — every
 * path that ends a mirror comes through here, including the ones that are also
 * telling somebody why.
 *
 * Deliberately silent: an explicit stop is not news to report over `onClosed`,
 * because whoever called this is the one who already knows.
 */
export function stopMirror(): void {
  const mirror = live
  live = null
  // Before the early return, not after: a stop that lands while a capture is
  // still being opened has no `live` mirror to tear down, and that is exactly
  // the case this counter exists for — the attempt in flight must come back to
  // find itself superseded and say nothing.
  generation += 1
  if (!mirror) return
  mirror.closed = true
  // Before anything else can send: a sample landing after the teardown is a
  // stats frame for a mirror the television has already been told is over.
  if (mirror.statsTimer) clearInterval(mirror.statsTimer)
  mirror.statsTimer = 0
  // Unhooked before the close, or `peer.close()` would come straight back
  // through the state-change handler as an ending to announce.
  mirror.peer.onicecandidate = null
  mirror.peer.onconnectionstatechange = null
  stopStream(mirror.stream)
  try {
    mirror.peer.close()
  } catch {
    /* already gone */
  }
}

/**
 * Every track stopped — the capture is a real OS-level share, and a track left
 * running keeps Windows believing this desktop is still being watched.
 */
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
