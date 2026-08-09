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
 * picture, it produces a slideshow and a hot dongle — and the television is
 * 1080p regardless. 30fps is plenty for watching a desktop, which is mostly a
 * still image with a cursor on it.
 */
const MAX_WIDTH = 1920
const MAX_HEIGHT = 1080
const MAX_FPS = 30

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
 * Open a stream onto the primary screen, or null when there is no screen to
 * open one onto.
 *
 * Video only, and not by omission: system audio would carry every notification
 * sound, every call and every video on this desktop to a television in another
 * room, which is a different feature and one nobody asked for.
 */
async function captureScreen(): Promise<MediaStream | null> {
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
 * `send` carries one signalling payload to the viewer; `onClosed` fires once,
 * with a sentence for the television, if the mirror ends by itself. Returns an
 * error sentence when it could not start at all, or null once the offer is
 * away — a mirror that has started can still fail later, and that arrives on
 * `onClosed` rather than here.
 */
export async function startMirror(
  send: (data: string) => void,
  onClosed: (reason: string) => void
): Promise<string | null> {
  // A second start replaces the first rather than stacking. The server allows
  // one viewer, so two peer connections here could only ever be one live one
  // and one quietly holding a screen capture open for nobody.
  stopMirror()

  let stream: MediaStream | null
  try {
    stream = await captureScreen()
  } catch {
    // A refused permission and a cancelled picker land here as the same thing,
    // and the television can do nothing about either beyond being told.
    return 'The desktop would not share its screen.'
  }
  if (!stream) return 'The desktop could not find a screen to share.'

  const track = stream.getVideoTracks()[0]
  if (!track) {
    stopStream(stream)
    return 'The desktop captured no video.'
  }

  // No ICE servers, on purpose. Both ends are on this LAN, so host candidates
  // are the only ones that can ever win a connectivity check; a STUN server
  // would add a round trip to the internet before the first frame and make a
  // feature that works with the router's uplink unplugged depend on it.
  const peer = new RTCPeerConnection({ iceServers: [] })
  const mirror: Mirror = { peer, stream, send, onClosed, closed: false }
  live = mirror

  const transceiver = peer.addTransceiver(track, { direction: 'sendonly', streams: [stream] })
  preferH264(transceiver)

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
    // capture that no longer exists.
    if (live !== mirror) return 'The mirror was stopped before it started.'
    send(JSON.stringify({ kind: 'offer', sdp: peer.localDescription?.sdp ?? offer.sdp ?? '' }))
  } catch {
    // Guarded, like the check above it: a failure here is this mirror's to
    // clean up, and an unguarded stop would take down whichever mirror had
    // replaced it while these awaits were in flight.
    if (live === mirror) stopMirror()
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
  if (!mirror) return
  mirror.closed = true
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
