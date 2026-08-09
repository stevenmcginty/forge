import { createSocket, type Socket } from 'node:dgram'
import {
  DISCOVERY_MAX_PROBE_BYTES,
  DISCOVERY_MIN_PROBE_BYTES,
  DISCOVERY_PROBE,
  MOBILE_PROTO,
  type DiscoveryReply
} from '@shared/mobile'

/**
 * "Is there a Forge on this wifi?" — the desktop's answer.
 *
 * A television has a remote control and no keyboard. Typing an IP address with
 * a D-pad is the single worst minute in this whole product, and it is also the
 * one step that cannot be baked into a shareable build: the Fire TV app
 * published on GitHub has to work on somebody else's network, and nothing in
 * an APK can know their address in advance. So the app asks the network, and
 * this is the thing that answers.
 *
 * One UDP datagram in, one JSON datagram back, and nothing else — no session,
 * no state, no membership of the WebSocket server's world beyond reading two
 * strings from it. Its own file for the same reason `auth.ts` is its own file:
 * everything in here is testable from Node with no Electron in the room, and a
 * responder that has only ever run inside the app is a responder nobody has
 * pointed anything hostile at.
 *
 * ## What it says, and what it deliberately does not
 *
 * The reply is a name, an address, a version and the protocol number. That is
 * the same set of facts a port scan of this machine would produce, said
 * politely. It carries no device list, no project names, no pairing state and
 * no token: **discovery finds a door, it never opens one.** A television that
 * has found this desktop still has to ask to pair, and a human at the desk
 * still has to press Allow.
 *
 * ## Two rules that keep it from being a weapon
 *
 * A UDP responder is a reflector: source addresses can be forged, so anyone on
 * the network can ask in somebody else's name and have this machine send the
 * answer to *them*. Two things make that pointless here.
 *
 *  1. **The question must be bigger than the answer** (see
 *     `DISCOVERY_MIN_PROBE_BYTES`). An amplifier that shrinks the traffic is
 *     not an amplifier.
 *  2. **One answer per source per second.** A flood of probes from one address
 *     produces a trickle of replies, and the cost of ignoring the rest is a
 *     map lookup.
 *
 * And it only exists while the link is listening. A Forge with the phone link
 * switched off answers nothing, because "off" has to mean off on every port.
 */

export interface DiscoveryHost {
  /**
   * `http://<lan-ip>:<port>` — the address a television on this network should
   * dial, or '' when there is not one (the link is starting, or this machine
   * has no address a TV could reach). No origin, no reply: an answer with
   * nothing to dial is worse than silence, because the screen would list a
   * desktop it cannot connect to.
   */
  origin: () => string
  /** This computer's name, as the television lists it. */
  name: () => string
  /** Forge's version here, for the line under the name. */
  appVersion: () => string
  log?: (line: string) => void
}

/** How often one source address can be answered. See the header. */
const REPLY_EVERY_MS = 1000

/**
 * How long a remembered source sticks around. Long enough to rate-limit a
 * burst, short enough that the map is a cache and not a leak — a busy network
 * has a few dozen devices, not a few thousand.
 */
const FORGET_AFTER_MS = 60_000

export class DiscoveryResponder {
  private host: DiscoveryHost
  private socket: Socket | null = null
  private bound = 0
  /** Source address → when it was last answered. */
  private answered = new Map<string, number>()
  private now: () => number

  constructor(host: DiscoveryHost & { now?: () => number }) {
    this.host = host
    this.now = host.now ?? ((): number => Date.now())
  }

  /** The port it is bound to, or 0 when it is not running. */
  get port(): number {
    return this.bound
  }

  /**
   * Bind and start answering.
   *
   * `reuseAddr` because a second Forge (a dev build beside the packaged one)
   * must not be the reason this fails to start — both may bind, both may
   * answer, and a television that sees the same desktop twice has a duplicate
   * in a list rather than a broken feature. A bind that fails for any other
   * reason is reported and swallowed: discovery is a convenience, and a Forge
   * whose phone link refused to start because a UDP port was busy would be a
   * far worse trade.
   */
  async start(port: number): Promise<boolean> {
    if (this.socket) return true
    const socket = createSocket({ type: 'udp4', reuseAddr: true })
    socket.on('message', (data, from) => this.answer(data, from.address, from.port))
    // An error after binding must not take the process with it. There is
    // nothing to recover — the next probe either arrives or does not.
    socket.on('error', (err) => {
      this.host.log?.(`discovery socket error: ${err.message}`)
    })
    try {
      await new Promise<void>((resolve, reject) => {
        socket.once('error', reject)
        socket.bind(port, () => {
          socket.removeListener('error', reject)
          resolve()
        })
      })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      this.host.log?.(`discovery is off — could not bind UDP ${port}: ${message}`)
      try {
        socket.close()
      } catch {
        /* never opened */
      }
      return false
    }
    this.socket = socket
    this.bound = port
    this.host.log?.(`answering discovery on UDP ${port}`)
    return true
  }

  async stop(): Promise<void> {
    const socket = this.socket
    this.socket = null
    this.bound = 0
    this.answered.clear()
    if (!socket) return
    await new Promise<void>((resolve) => {
      try {
        socket.close(() => resolve())
      } catch {
        resolve()
      }
    })
  }

  /**
   * One datagram in. Every early return is silent on purpose: a responder that
   * explains why it will not answer is a responder that answers.
   */
  private answer(data: Buffer, address: string, port: number): void {
    const socket = this.socket
    if (!socket) return
    if (data.length < DISCOVERY_MIN_PROBE_BYTES || data.length > DISCOVERY_MAX_PROBE_BYTES) return
    // Only the opening bytes are compared, so the padding that earns the reply
    // can be anything at all — the television fills it with spaces.
    if (data.subarray(0, DISCOVERY_PROBE.length).toString('utf8') !== DISCOVERY_PROBE) return

    const at = this.now()
    const last = this.answered.get(address) ?? 0
    if (at - last < REPLY_EVERY_MS) return

    const origin = this.host.origin()
    if (!origin) return

    this.sweep(at)
    this.answered.set(address, at)

    const reply: DiscoveryReply = {
      t: 'forge-desktop',
      name: this.host.name(),
      origin,
      app: this.host.appVersion(),
      proto: MOBILE_PROTO
    }
    // Fire and forget. A television that missed the answer asks again a second
    // later; a send error here is one lost datagram, not a broken desktop.
    socket.send(Buffer.from(JSON.stringify(reply)), port, address, () => {})
  }

  /** Drop sources nobody has heard from in a while. */
  private sweep(at: number): void {
    for (const [address, when] of this.answered) {
      if (at - when > FORGET_AFTER_MS) this.answered.delete(address)
    }
  }
}
