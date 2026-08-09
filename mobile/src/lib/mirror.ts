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

/** A live viewer. Returned by `startMirrorViewer`, owned by its caller. */
export interface MirrorViewer {
  /** One `mirror-signal` payload, straight off the wire. Never throws. */
  handleSignal(data: string): void
  /** Finish. Idempotent, and silent — it does not call `onClosed`. */
  close(): void
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
  onClosed: (reason: string) => void
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
      if (signal.kind === 'candidate' && signal.candidate && typeof signal.candidate === 'object') {
        const candidate = signal.candidate as RTCIceCandidateInit
        // Before the offer, hold it; after, hand it over and swallow whatever
        // the browser thinks of it. A candidate it cannot use is normal —
        // every peer is offered routes it will never take.
        if (!peer.remoteDescription) pending.push(candidate)
        else void peer.addIceCandidate(candidate).catch(() => {})
      }
    },

    close: teardown
  }
}
