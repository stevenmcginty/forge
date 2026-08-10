/**
 * Forge Web — rendezvous: how a browser tab finds this particular desktop.
 *
 * What it does, in one paragraph: publishes one small record to Firebase RTDB
 * at `users/<uid>/host` saying "Forge is running here, at this hostname,
 * speaking this protocol"; refreshes its timestamp on a heartbeat so absence is
 * detectable; republishes when the tunnel address changes; and deletes the
 * record on the way out. That record is the *only* reason the browser can find
 * a machine whose Cloudflare hostname is different every time the tunnel comes
 * up (docs/forge-web.md, decision 3).
 *
 * Terminal bytes never come near it. Firebase carries identity and one
 * hostname; the session itself is a direct socket from the browser to this PC.
 *
 * ## Off by default
 *
 * Nothing here runs, connects, starts a timer or reads a credential unless
 * `isEnabled()` is true. That is the same posture `electron/companion-sync.ts`
 * and `electron/mobile-host.ts` keep, and it is load-bearing rather than
 * tidiness: docs/forge-web.md's security posture promises that a Forge with the
 * feature switched off "publishes no hostname, reads no credential", and
 * `scripts/web-check.mjs` is specified to assert it by *inspecting the
 * rendezvous record* rather than by trusting the setting. A `start()` that
 * eagerly asked the host for a `FirebaseRest` would already have broken that
 * promise before the first `if`.
 *
 * ## Electron-free on purpose
 *
 * This module imports nothing but `@shared/web` and the sibling REST client.
 * Everything that varies — the tunnel hostname, the app version, the computer's
 * name, the uid, whether the feature is on, the clock, even the timer — arrives
 * through `WebRendezvousHost` below. That is what lets
 * `scripts/web-rendezvous-check.mjs` drive this exact class against the real
 * Firebase emulator with no Electron in the process, on a clock it controls,
 * instead of testing a mock and hoping. The Electron wiring belongs next door in
 * `electron/web-host.ts`.
 *
 * ## The `onDisconnect` gap — read this before trusting the record
 *
 * shared/web.ts's rendezvous header describes RTDB's `onDisconnect` as "the
 * primary mechanism", clearing the record within about a minute of a power cut,
 * with `HOST_STALE_MS` as a mere backstop. **That is not what happens here, and
 * it cannot be.** `onDisconnect` is a feature of RTDB's *realtime* wire
 * protocol: the server arms it against a live WebSocket and fires it when that
 * socket drops. `electron/companion/rest.ts` is deliberately REST + SSE with no
 * Firebase SDK (see its header for the three reasons), and the `.json` REST
 * endpoints expose no equivalent — there is no socket for the server to watch,
 * so there is nothing for it to hang a disconnect handler on. Implementing it
 * would mean either the SDK or a hand-rolled realtime client, and both are out
 * of scope for this module.
 *
 * So the ordering is inverted from that comment: **the staleness window is the
 * only mechanism, not the backstop.** A graceful quit calls `shutdown()` and
 * the record goes immediately; a power cut, a crash or a yanked network cable
 * leaves the record behind, and the browser stops believing it once `at` is
 * older than `HOST_STALE_MS` — three missed heartbeats, about three minutes.
 * `isHostLive()` already implements exactly that and needs no help from us.
 * The user-visible cost is the difference between "roughly a minute" and "up to
 * three minutes" of a browser offering to dial a machine that is off, which is
 * why this is a documented limitation rather than a blocker. If it ever needs
 * to be shorter, the fix is a smaller `HOST_HEARTBEAT_MS`, not a second client.
 */

import {
  HOST_HEARTBEAT_MS,
  normaliseHost,
  WEB_PROTO,
  webHostPath,
  wireString,
  type WebHostRecord
} from '@shared/web'
import { describe, OfflineError, RevokedError } from '../companion/rest'

/* ------------------------------------------------------------------- host */

/**
 * The slice of `FirebaseRest` this service actually uses.
 *
 * Three methods and a uid. `FirebaseRest` satisfies it structurally, so the
 * Electron host passes the real client straight in — but naming the narrow
 * surface is what lets the check substitute a client that fails on demand, and
 * it documents that rendezvous neither streams nor reads anything. It only
 * writes its own one node.
 */
export interface RendezvousRest {
  readonly uid: string
  put(path: string, value: unknown): Promise<unknown>
  patch(path: string, value: unknown): Promise<unknown>
  remove(path: string): Promise<void>
}

/** Whatever the injected timer hands back. Never inspected, only handed back. */
export type RendezvousTimer = unknown

/**
 * Everything the service needs from the outside world.
 *
 * Thunks rather than values, because every one of these changes underneath us
 * while the service is running: the tunnel reconnects on a new hostname, Steve
 * signs in, the setting is toggled. A constructor argument would be a snapshot
 * of the moment the desktop booted.
 */
export interface WebRendezvousHost {
  /** Is Forge Web switched on? Checked before anything else, every time. */
  isEnabled(): boolean
  /**
   * The Firebase client, or null when there is no session yet.
   *
   * Only ever called when `isEnabled()` is true — see the "Off by default"
   * note above. Returning null is not an error; it is "not signed in yet", and
   * the service simply waits.
   */
  rest(): RendezvousRest | null
  /** The tunnel's current public hostname. '' when there is no tunnel. */
  hostname(): string
  /** Forge's version on this desktop, for the line under the name. */
  appVersion(): string
  /** The computer's own name, for "connected to STEVE-PC". */
  computerName(): string
  now?(): number
  log?(line: string, ...rest: unknown[]): void
  /** Injectable so the check can drive the heartbeat without waiting a minute. */
  setTimer?(fn: () => void, ms: number): RendezvousTimer
  clearTimer?(handle: RendezvousTimer): void
}

/** What the desktop can show about its own rendezvous, for settings and logs. */
export interface WebRendezvousState {
  enabled: boolean
  /** The hostname currently believed to be published, or '' when none is. */
  published: string
  /** ms epoch of the last successful write, publish or heartbeat. */
  at: number
  /** The last failure as a sentence, or '' while things are working. */
  detail: string
}

/* -------------------------------------------------------------- the timings */

/**
 * How soon to try again after a failed write, and how far that backs off.
 *
 * The failure this exists for is a flapping tunnel on a domestic connection:
 * `cloudflared` reconnects, `hostname()` changes, the write fails because the
 * wifi is still settling. Retrying immediately in that state is a write per
 * second against a metered database for as long as the flap lasts. Two seconds
 * doubling to a minute means a brief blip costs three writes and a genuinely
 * dead network costs one a minute — and one a minute is already the heartbeat
 * rate, so a long outage is not more expensive than being healthy.
 */
const RETRY_BASE_MS = 2_000
const RETRY_MAX_MS = HOST_HEARTBEAT_MS

/**
 * The floor between two hostname-driven republishes.
 *
 * `refresh()` is meant to be called the moment the tunnel reports a new address,
 * because waiting up to a heartbeat to become reachable again is a minute of a
 * browser dialling a hostname that has moved. But "the moment it reports" is
 * exactly when a flapping tunnel reports six times, so a republish that arrives
 * inside this window is deferred to the end of it rather than sent. The record
 * still converges on the truth; it just cannot be made to write per second.
 */
const MIN_REPUBLISH_MS = 5_000

/* ------------------------------------------------------------- the service */

export class WebRendezvous {
  private readonly host: WebRendezvousHost

  private running = false
  private timer: RendezvousTimer = null
  /** Serialises writes: a heartbeat must not overlap the publish it follows. */
  private writing = false

  /** The hostname of the record we last successfully wrote, or ''. */
  private published = ''
  private publishedAt = 0
  private lastWriteAt = 0
  private detail = ''
  /** Deduplicates the log line, so a week offline is one message, not 10,000. */
  private loggedDetail = ''
  private backoff = RETRY_BASE_MS
  /** A `refresh()` that arrived mid-write and still has to be honoured. */
  private refreshWanted = false

  constructor(host: WebRendezvousHost) {
    this.host = host
  }

  private get now(): number {
    return this.host.now?.() ?? Date.now()
  }

  private log(line: string, ...rest: unknown[]): void {
    if (this.host.log) this.host.log(line, ...rest)
    else console.log(`[web-rendezvous] ${line}`, ...rest)
  }

  getState(): WebRendezvousState {
    return { enabled: this.running, published: this.published, at: this.publishedAt, detail: this.detail }
  }

  /* ------------------------------------------------------------ lifecycle */

  /**
   * Start publishing, if — and only if — the feature is switched on.
   *
   * Safe to call repeatedly: it cancels whatever was scheduled first, which is
   * what makes "the settings changed" or "the tunnel came up" a one-line handler
   * in the Electron host rather than a state machine.
   *
   * Note the order. `isEnabled()` is asked before `rest()`, before `hostname()`,
   * before any timer is armed — so a disabled Forge leaves this method having
   * touched nothing at all.
   */
  start(): void {
    this.cancelTimer()
    if (!this.host.isEnabled()) {
      this.running = false
      return
    }
    this.running = true
    this.backoff = RETRY_BASE_MS
    void this.tick()
  }

  /**
   * Stop publishing without touching the network.
   *
   * The record is deliberately left where it is: this is the path for "the
   * settings were toggled off" only in the sense of stopping the timer, and
   * `shutdown()` is what actually retracts the record. Leaving it means a Forge
   * that stops heartbeating fades out over `HOST_STALE_MS` exactly like one that
   * lost power, which is the behaviour the browser already understands.
   */
  stop(): void {
    this.cancelTimer()
    this.running = false
  }

  /**
   * Retract the record and stop. The graceful half of "the desktop went away".
   *
   * Best-effort by construction: quitting is not a moment to retry, and a browser
   * that reads a record we failed to delete simply falls back to the staleness
   * window. So a failure here is logged and swallowed rather than thrown — a
   * rendezvous problem must never be the reason Forge will not close.
   */
  async shutdown(): Promise<void> {
    this.cancelTimer()
    this.running = false
    // Keyed on "did we publish", not on "were we running". A service that was
    // already stopped still owns whatever it last wrote, and this is the last
    // chance anybody gets to take it back. It is also what keeps the disabled
    // case silent: nothing was published, so nothing is retracted, so no
    // credential is read and no request is made.
    if (!this.published) return
    await this.clear()
  }

  /**
   * The tunnel's address may have changed — look again now rather than at the
   * next heartbeat.
   *
   * Cheap and idempotent: if the hostname has not actually moved this does
   * nothing but reschedule, so the Electron host can wire it to a noisy tunnel
   * event without thinking about it.
   */
  refresh(): void {
    if (!this.running) return
    // A refresh that lands *during* a write would otherwise be lost: it would
    // arm a timer that `write()` then cancels when it schedules the next
    // heartbeat, and the new address would wait a full minute. Same shape as
    // companion-sync.ts's `sweepAgain`, and the same reason — the window is
    // narrow, but a tunnel reconnecting while a heartbeat is in flight is
    // exactly when it opens.
    if (this.writing) {
      this.refreshWanted = true
      return
    }
    this.schedule(Math.max(0, MIN_REPUBLISH_MS - (this.now - this.lastWriteAt)))
  }

  /* -------------------------------------------------------------- the loop */

  private cancelTimer(): void {
    if (this.timer === null) return
    const clear = this.host.clearTimer ?? ((h: RendezvousTimer) => clearTimeout(h as NodeJS.Timeout))
    clear(this.timer)
    this.timer = null
  }

  /**
   * Exactly one timer is ever pending.
   *
   * A single self-rescheduling one-shot rather than a repeating interval plus a
   * retry timer, because the two would race: an interval that fires while a
   * backed-off retry is also pending produces the write-per-second this is meant
   * to prevent, and it is the kind of bug that only shows up on a bad line.
   */
  private schedule(ms: number): void {
    this.cancelTimer()
    if (!this.running) return
    const set = this.host.setTimer ?? ((fn: () => void, delay: number) => setTimeout(fn, delay))
    this.timer = set(() => {
      this.timer = null
      void this.tick()
    }, ms)
  }

  /**
   * One pass: publish if the address moved, otherwise just refresh `at`.
   *
   * The re-check of `isEnabled()` is not paranoia. The setting can be turned off
   * between one tick and the next, and a timer that was armed while it was on
   * would otherwise get one more write in after the feature was supposed to be
   * silent.
   */
  private async tick(): Promise<void> {
    if (!this.running || this.writing) return
    if (!this.host.isEnabled()) {
      this.stop()
      return
    }

    const rest = this.host.rest()
    const uid = rest?.uid ?? ''
    const path = webHostPath(uid)
    if (!rest || !path) {
      // Enabled but not signed in yet. Not a failure and not worth a log line —
      // sign-in calls start() anyway, so this is only the slow path.
      this.schedule(HOST_HEARTBEAT_MS)
      return
    }

    // Everything that reaches the database goes through `normaliseHost` first.
    // "It came off our own tunnel" is not a reason to trust a string that is
    // about to become the address a browser opens a socket to, and publishing a
    // half-hostname only moves the failure to dial time, where it reads as a
    // network fault instead of as a misconfiguration.
    const host = normaliseHost(this.host.hostname())
    if (!host) {
      await this.hostWentAway(rest, path)
      return
    }

    if (host === this.published) await this.heartbeat(rest, path)
    else await this.publish(rest, path, host)
  }

  /**
   * There is no usable tunnel address any more.
   *
   * Retract rather than let it go stale. We *know* we are unreachable, and the
   * three minutes `HOST_STALE_MS` would otherwise take are three minutes of a
   * browser opening a socket to a hostname that has been handed back to
   * Cloudflare. Staleness is the mechanism for the case where we cannot say
   * anything; this is not that case.
   */
  private async hostWentAway(rest: RendezvousRest, path: string): Promise<void> {
    if (this.published) {
      const gone = this.published
      await this.clear(rest, path)
      if (!this.published) this.log(`tunnel hostname went away (${gone}) — rendezvous record cleared`)
    }
    this.schedule(HOST_HEARTBEAT_MS)
  }

  /** Write the whole record. A PUT, because this node is authored in one go. */
  private async publish(rest: RendezvousRest, path: string, host: string): Promise<void> {
    // Clamped with the same helper and the same widths `parseHostRecord` uses on
    // the way back in, so what the browser draws is what we meant to say rather
    // than a version string silently truncated at the far end.
    const record: WebHostRecord = {
      host,
      proto: WEB_PROTO,
      app: wireString(this.host.appVersion(), 24),
      name: wireString(this.host.computerName(), 64),
      at: this.now
    }
    await this.write(() => rest.put(path, record), () => {
      this.published = host
      this.publishedAt = record.at
    })
  }

  /**
   * Refresh `at` and nothing else.
   *
   * A PATCH of the single field, not a PUT of the record. The difference is the
   * whole point of a heartbeat: it says "still here" without re-asserting a
   * hostname, a version or a name, so a heartbeat can never be the thing that
   * quietly changes what the browser dials.
   */
  private async heartbeat(rest: RendezvousRest, path: string): Promise<void> {
    const at = this.now
    await this.write(() => rest.patch(path, { at }), () => {
      this.publishedAt = at
    })
  }

  /** Delete the record. Used by `shutdown()` and by the tunnel going away. */
  private async clear(rest?: RendezvousRest, path?: string): Promise<void> {
    const client = rest ?? this.host.rest()
    const target = path ?? webHostPath(client?.uid ?? '')
    if (!client || !target) return
    try {
      await client.remove(target)
      this.published = ''
      this.publishedAt = 0
    } catch (err) {
      // Swallowed on purpose — see `shutdown()`. The staleness window covers it.
      this.log(`could not clear the rendezvous record: ${describe(err)}`)
    }
  }

  /* -------------------------------------------------------------- plumbing */

  /**
   * Run one write, absorb the two failures that are expected rather than
   * exceptional, and schedule whatever comes next.
   *
   * `OfflineError` and `RevokedError` exist in rest.ts precisely so callers can
   * tell "try again later" from "stop, the credential is gone", and rendezvous
   * wants opposite handling for each. Offline backs off and keeps trying,
   * because a home connection comes back. Revoked stops the loop entirely: every
   * further attempt would fail the same way, and hammering a database with a
   * credential it has already refused is how an account gets rate-limited.
   * Re-arming is sign-in's job, which calls `start()`.
   *
   * Either way the desktop stays up. A failure to publish a hostname is a browser
   * that has to wait, not a reason to take Forge down or fill the log.
   */
  private async write(attempt: () => Promise<unknown>, onOk: () => void): Promise<void> {
    this.writing = true
    try {
      await attempt()
      onOk()
      this.lastWriteAt = this.now
      this.detail = ''
      this.loggedDetail = ''
      this.backoff = RETRY_BASE_MS
      // A deferred refresh comes back at the republish floor rather than at the
      // heartbeat: `tick()` re-reads `hostname()` every time, so all this
      // decides is how soon the new address is noticed.
      const wanted = this.refreshWanted
      this.refreshWanted = false
      this.schedule(wanted ? MIN_REPUBLISH_MS : HOST_HEARTBEAT_MS)
    } catch (err) {
      this.noteError(err)
      // The retry re-reads the hostname anyway, so a pending refresh is already
      // satisfied by the backed-off attempt.
      this.refreshWanted = false
      if (err instanceof RevokedError) {
        this.stop()
        return
      }
      this.schedule(this.backoff)
      this.backoff = Math.min(this.backoff * 2, RETRY_MAX_MS)
    } finally {
      this.writing = false
    }
  }

  private noteError(err: unknown): void {
    this.detail =
      err instanceof RevokedError
        ? 'Sign in again — the session was revoked'
        : err instanceof OfflineError
          ? 'Offline'
          : describe(err)
    // Once per distinct problem. A desktop that spends the night offline should
    // leave one line in the log, not one line a minute.
    if (this.detail !== this.loggedDetail) {
      this.loggedDetail = this.detail
      this.log(`rendezvous publish failed: ${this.detail}`)
    }
  }
}
