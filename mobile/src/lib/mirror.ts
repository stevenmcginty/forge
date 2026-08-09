/**
 * The television's end of the screen mirror.
 *
 * The desktop shares its Forge window as a WebRTC video track and this side
 * shows it. Deliberately the smaller half of the pair: it captures nothing,
 * offers nothing and sends no media — one recvonly transceiver, an answer, and
 * a stream handed back to whoever asked. Exactly like the rest of the TV
 * build, this surface watches (see the header of components/TvDashboard.tsx).
 *
 * The frames that carry the negotiation are in shared/mobile.ts: `mirror-start`
 * up, `mirror-signal` both ways with an opaque JSON string, `mirror-stop`
 * either way with a sentence. Nothing between the two peers reads that string —
 * the desktop's relay has no WebRTC stack and must not grow one — so this file
 * and its opposite number are the only two things that know what is inside it.
 *
 * A plain module, not a hook: a peer connection outlives renders and must never
 * be rebuilt by one. The component owns *when* a watch starts and stops; this
 * owns what a peer is.
 *
 * **No ICE servers, on purpose.** `iceServers: []` means host candidates only —
 * the two machines are on one LAN, with the desktop's address already known
 * well enough to hold a socket open to it. A STUN server would add a round trip
 * to somebody else's box before the first frame, and would make watching your
 * own PC on your own television depend on the internet being up. There is no
 * NAT between these two to traverse.
 *
 * **Total against its input.** `handleSignal` is fed a string that arrived on a
 * socket, so it parses in a try/catch, accepts exactly two shapes, and drops
 * everything else without a sound. It never throws: the caller is a React
 * effect on a screen with no keyboard, and an exception there is a black
 * television nobody in the room can debug.
 */

/**
 * What the desktop says about its own sending, once a second.
 *
 * The exact shape `src/lib/mirror.ts` builds — the two files are the only
 * things on either side of the relay that read this payload, and they change
 * together. Everything here is a number the sofa cannot see: whether the
 * encoder is starved, whether it is the CPU, and above all what resolution
 * actually left the desk, which is the difference between a blurry stream and
 * a sharp one being watched on a television with the sharpness turned down.
 */
export interface DesktopStats {
  srcWidth: number
  srcHeight: number
  width: number
  height: number
  fps: number
  kbps: number
  limit: string
  limitedBy: { bandwidth: number; cpu: number; other: number }
  codec: string
  rttMs: number
  lossPct: number
  pli: number
}

/**
 * What this end actually managed to decode, measured here.
 *
 * The desktop cannot know any of it. `decoder` is the one that matters most on
 * a Fire Stick: a name like `OMX.…avc.decoder` is the dongle's silicon doing
 * the work, and anything that reads like a software library means the stream
 * negotiated a codec this hardware does not have, which no amount of bitrate
 * will rescue.
 */
export interface ScreenStats {
  width: number
  height: number
  fps: number
  kbps: number
  decoder: string
  /** Times the picture stopped moving while it was supposed to be moving. */
  freezes: number
  /** Seconds spent frozen, total. */
  frozenSecs: number
  packetsLost: number
  jitterMs: number
}

/** A live viewer. Returned by `startMirrorViewer`, owned by its caller. */
export interface MirrorViewer {
  /** One `mirror-signal` payload, straight off the wire. Never throws. */
  handleSignal(data: string): void
  /**
   * This end's own measurement of the picture, or null before there is one.
   * Never throws — the caller is a debug overlay on a screen with no keyboard.
   */
  readStats(): Promise<ScreenStats | null>
  /** Finish. Idempotent, and silent — it does not call `onClosed`. */
  close(): void
}

/** The fields `readStats` reads, named rather than left as `any`. */
interface InboundVideoStats {
  bytesReceived?: number
  frameWidth?: number
  frameHeight?: number
  framesPerSecond?: number
  decoderImplementation?: string
  freezeCount?: number
  totalFreezesDuration?: number
  packetsLost?: number
  jitter?: number
}

/**
 * Where a `mirror-signal` / `mirror-stop` frame goes.
 *
 * Module-level for the same reason `paneListeners` is (see PaneView): App
 * builds the Link's handlers once, at construction, long before any dashboard
 * exists, and routes into here. At most one screen on this device is ever
 * watching, so a pair of slots is the honest shape rather than a subscription
 * system pretending otherwise. Both null whenever nothing is watching, which
 * is nearly always.
 */
export const mirrorListeners: {
  signal: ((data: string) => void) | null
  stop: ((reason: string) => void) | null
} = { signal: null, stop: null }

export function startMirrorViewer(
  send: (data: string) => void,
  onStream: (stream: MediaStream) => void,
  onClosed: (reason: string) => void,
  /**
   * The desktop's own numbers, as they arrive. Optional on purpose: a caller
   * that is not showing an overlay should not have to pretend to care, and a
   * desktop too old to send any simply never calls it.
   */
  onStats?: (stats: DesktopStats) => void
): MirrorViewer {
  const peer = new RTCPeerConnection({ iceServers: [] })
  /** Set by `teardown`, checked before every callback and after every await. */
  let torn = false
  let told = false
  let stream: MediaStream | null = null
  /**
   * Candidates that arrived before the offer they belong to.
   *
   * With no STUN there is no reflexive lookup to wait for, so the desktop's
   * host candidates are ready in the same tick it sends its offer and the two
   * frames land here microseconds apart. `setRemoteDescription` is a promise,
   * so a candidate genuinely can be handled first — and `addIceCandidate`
   * before a remote description rejects, which would quietly discard the only
   * route to the desktop on the one network this feature is for.
   */
  const pending: RTCIceCandidateInit[] = []
  /** The previous `readStats` totals, so an incoming rate can be a rate. */
  let lastStatsBytes = 0
  let lastStatsAt = 0

  const teardown = (): void => {
    if (torn) return
    torn = true
    peer.onicecandidate = null
    peer.ontrack = null
    peer.onconnectionstatechange = null
    for (const track of stream?.getTracks() ?? []) track.stop()
    stream = null
    try {
      peer.close()
    } catch {
      /* already closed; there is nothing to close */
    }
  }

  /** Tear down and say why, once. Every unhappy ending funnels through here. */
  const finish = (reason: string): void => {
    teardown()
    if (told) return
    told = true
    onClosed(reason)
  }

  // Declared before the offer arrives so the answer is well formed even if the
  // desktop's offer is the first thing this peer ever sees — an m-line the
  // answer has no transceiver for is a stream that negotiates and never plays.
  peer.addTransceiver('video', { direction: 'recvonly' })

  peer.ontrack = (event) => {
    if (torn) return
    const first = event.streams[0]
    if (!first) return
    stream = first
    onStream(first)
  }

  peer.onicecandidate = (event) => {
    if (torn) return
    // The null candidate is the end-of-gathering marker. Forwarded as-is,
    // because the desktop's peer understands it and nothing in this file
    // should be deciding what a candidate means.
    send(JSON.stringify({ kind: 'candidate', candidate: event.candidate }))
  }

  peer.onconnectionstatechange = () => {
    // 'disconnected' is sometimes recoverable, and is treated as an ending
    // anyway: a last frame frozen on a television while the words still say
    // live is the exact dishonesty the stale banner exists to prevent, and
    // reopening the watch costs one press of OK.
    switch (peer.connectionState) {
      case 'failed':
        finish('The desktop and this screen could not reach each other.')
        return
      case 'disconnected':
        finish('The desktop stopped sending.')
        return
      case 'closed':
        finish('The mirror closed.')
        return
      default:
        return
    }
  }

  const answer = async (sdp: string): Promise<void> => {
    try {
      await peer.setRemoteDescription({ type: 'offer', sdp })
      if (torn) return
      for (const candidate of pending.splice(0)) {
        await peer.addIceCandidate(candidate).catch(() => {})
      }
      const local = await peer.createAnswer()
      await peer.setLocalDescription(local)
      if (torn) return
      send(JSON.stringify({ kind: 'answer', sdp: local.sdp ?? '' }))
    } catch {
      finish('The desktop and this screen could not agree on a stream.')
    }
  }

  return {
    handleSignal(data: string): void {
      if (torn) return
      let value: unknown
      try {
        value = JSON.parse(data)
      } catch {
        return
      }
      if (!value || typeof value !== 'object' || Array.isArray(value)) return
      const signal = value as { kind?: unknown; sdp?: unknown; candidate?: unknown }
      if (signal.kind === 'offer' && typeof signal.sdp === 'string') {
        void answer(signal.sdp)
        return
      }
      if (signal.kind === 'stats') {
        // Trusted no further than shape: it came off the same socket as
        // everything else here, and an overlay reading a hostile number is
        // still only an overlay reading a number.
        if (onStats) onStats(value as DesktopStats)
        return
      }
      if (signal.kind === 'candidate' && signal.candidate && typeof signal.candidate === 'object') {
        const candidate = signal.candidate as RTCIceCandidateInit
        // Before the offer, hold it; after, hand it over and swallow whatever
        // the browser thinks of it. A candidate it cannot use is normal —
        // every peer is offered routes it will never take.
        if (!peer.remoteDescription) pending.push(candidate)
        else void peer.addIceCandidate(candidate).catch(() => {})
      }
    },

    async readStats(): Promise<ScreenStats | null> {
      if (torn) return null
      let report: RTCStatsReport
      try {
        report = await peer.getStats()
      } catch {
        return null
      }
      if (torn) return null
      // One object rather than a local per stat: a `let` assigned only inside
      // this callback is still narrowed to its initialiser by the compiler.
      const found: { inbound?: InboundVideoStats } = {}
      report.forEach((entry: { type?: string; kind?: string }) => {
        if (entry.type === 'inbound-rtp' && entry.kind === 'video') found.inbound = entry as InboundVideoStats
      })
      const inbound = found.inbound
      if (!inbound) return null

      const now = performance.now()
      const bytes = inbound.bytesReceived ?? 0
      // A rate needs two samples. The first reading of a watch reports 0 rather
      // than every byte since it opened, arriving in the last second.
      const elapsed = lastStatsAt > 0 ? (now - lastStatsAt) / 1000 : 0
      const kbps = elapsed > 0 ? Math.max(0, Math.round(((bytes - lastStatsBytes) * 8) / 1000 / elapsed)) : 0
      lastStatsBytes = bytes
      lastStatsAt = now

      return {
        width: inbound.frameWidth ?? 0,
        height: inbound.frameHeight ?? 0,
        fps: Math.round(inbound.framesPerSecond ?? 0),
        kbps,
        decoder: inbound.decoderImplementation ?? 'unknown',
        freezes: inbound.freezeCount ?? 0,
        frozenSecs: Math.round(inbound.totalFreezesDuration ?? 0),
        packetsLost: inbound.packetsLost ?? 0,
        jitterMs: Math.round((inbound.jitter ?? 0) * 1000)
      }
    },

    close: teardown
  }
}
