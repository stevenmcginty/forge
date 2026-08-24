import type { BrowserWindow } from 'electron'
import type { RendererHeartbeat } from '@shared/api'

/**
 * The thing that notices when Forge's window has stopped being Forge.
 *
 * A dead renderer is not one failure, it is three, and only one of them is
 * visible from the main process without being told.
 *
 * **The process died.** Chromium OOM, an update pulled under a running app,
 * npm install rewriting node_modules beneath vite. `render-process-gone` fires
 * and Electron keeps the BrowserWindow object, so 'window-all-closed' never
 * comes and none of the shutdown machinery runs. That is the zombie behind
 * every "Forge won't open" evening.
 *
 * **The process hung.** An infinite render loop, a pane doing something
 * enormous on the UI thread. `unresponsive` fires; sometimes it comes back on
 * its own, which is why this waits rather than reloading on the event.
 *
 * **The process is fine and the app is gone.** This is the one nothing catches.
 * React unmounted the tree — a thrown effect, an error boundary with no
 * fallback, a provider that blew up on a stale preload — and what is left is a
 * live, responsive, correctly-painted *empty window*. The OS is happy. Electron
 * is happy. Every terminal keeps streaming, because that output comes from the
 * main process and never touched the renderer. And Steve, who is on a phone in
 * another county, taps a tab and nothing happens, forever, in silence.
 *
 * So the third signal cannot be inferred; it has to be *sent*. The React root
 * beats every 2s from a component mounted outside every provider (see
 * `Heartbeat` in src/main.tsx) — the last thing standing in a collapsing tree —
 * and the absence of that beat, from a window the user can actually see, is the
 * only honest evidence that the app is gone while the process is not.
 *
 * ## What it does about it
 *
 * Reloads, and tells the phone. Both halves matter: a browser or a phone whose
 * socket is still up has no way to tell "the desktop is busy coming back" from
 * "your taps are being ignored", and the second one is what it looked like.
 * `onState` is how a `desktop` frame reaches them (see electron/web-host.ts and
 * electron/mobile-host.ts).
 *
 * ## Why the crash path escalates differently
 *
 * A silent renderer and a *dead* renderer want opposite last resorts, and this
 * is the one place that has to hold both.
 *
 * When the process is alive, destroying the window would take every ConPTY
 * down with it — a build, an install, an agent mid-sentence — to fix a bug in
 * the drawing of them, for a man who is not at the desk to see it happen. So
 * the heartbeat and hang paths give up and *report*, and leave the window and
 * its terminals exactly where they are.
 *
 * When the process is genuinely gone, giving up quietly is what *creates* the
 * zombie: a windowless Forge holding port 5173 and the dev log against every
 * later launch. So the crash path keeps the escalation it has always had — one
 * reload, and a second death without a healthy load in between destroys the
 * window so 'window-all-closed' fires and the quit path takes the process down
 * honestly. That policy moved here from electron/main.ts unchanged; it is not
 * this module's invention and it must not be softened into the rule above it.
 *
 * For the same reason the two failure classes count separately: a crash must
 * never spend the heartbeat budget, and vice versa.
 */

/** How long a visible, loaded window may say nothing before it is presumed dead. */
export const HEARTBEAT_SILENCE_MS = 8_000

/**
 * How long `unresponsive` has to correct itself before it counts.
 *
 * Chromium fires it for any main-thread stall past a few seconds, and plenty of
 * those are a big paste landing in xterm rather than a hang. Waiting for
 * `responsive` to *not* arrive is the difference between a watchdog and a
 * nuisance.
 */
export const UNRESPONSIVE_GRACE_MS = 5_000

/** The soonest another heartbeat/hang reload may follow the last one. */
export const RELOAD_COOLDOWN_MS = 30_000

/** The sliding window the reload budget is counted over. */
export const RELOAD_WINDOW_MS = 5 * 60_000

/**
 * Reloads allowed inside `RELOAD_WINDOW_MS` before this stops trying.
 *
 * A renderer that is broken on the ground — a bad build, a syntax error in the
 * bundle — comes back broken every time, and a watchdog with no ceiling turns
 * that into an infinite reload loop that no one can interrupt. Three is enough
 * to ride out a transient and few enough to be obviously over.
 */
export const RELOAD_LIMIT = 3

/**
 * The pause before reloading after a crash. Inherited from the code this
 * replaces: a crash during a dev-server hiccup usually comes straight back, and
 * reloading into the same half-written bundle just spends a life.
 */
export const CRASH_RELOAD_DELAY_MS = 1_500

/** How often the sweep looks at the clock. Well under the silence it detects. */
export const TICK_MS = 1_000

/**
 * What the renderer says about itself, every 2s.
 *
 * `healthy: false` is not a smaller version of silence, it is a *louder* one:
 * the tree caught its own death and is telling us the name of it. Re-exported
 * from the bridge contract rather than restated — see `RootBoundary` in
 * src/main.tsx for the end that sends it.
 */
export type { RendererHeartbeat }

/** What the phone and the browser are told. See the `desktop` frame. */
export type DesktopState = 'recovering' | 'ready'

/**
 * Time, injectable.
 *
 * Not a testing seam bolted on afterwards — a watchdog whose only interesting
 * behaviour is measured in tens of seconds cannot be proved by a check that has
 * to sit through them. scripts/watchdog-check.mjs drives the whole state
 * machine on a clock it owns. See `systemClock` for the real one.
 */
export interface WatchdogClock {
  now(): number
  setInterval(fn: () => void, ms: number): unknown
  clearInterval(handle: unknown): void
  setTimeout(fn: () => void, ms: number): unknown
  clearTimeout(handle: unknown): void
}

export interface WatchdogOptions {
  clock?: WatchdogClock
  /**
   * Called when the desktop starts coming back and when it is well again.
   * Deduplicated: 'recovering' is only announced from a settled state, and
   * 'ready' only after a recovery.
   */
  onState?: (state: DesktopState, reason?: string) => void
  /** Every decision, so a log from a bad evening explains itself. */
  log?: (line: string) => void
}

export interface RendererWatchdog {
  /** One beat from the React root. Main forwards `IPC.rendererHeartbeat` here. */
  heartbeat(beat?: RendererHeartbeat): void
  /** Stop watching. Called from the window's 'closed'. */
  dispose(): void
}

/** The real clock, kept behind the same interface so nothing branches on which. */
export const systemClock: WatchdogClock = {
  now: () => Date.now(),
  setInterval: (fn, ms) => setInterval(fn, ms),
  clearInterval: (handle) => clearInterval(handle as ReturnType<typeof setInterval>),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>)
}

export function armRendererWatchdog(win: BrowserWindow, options: WatchdogOptions = {}): RendererWatchdog {
  const clock = options.clock ?? systemClock
  const log = options.log ?? ((line: string): void => console.log(line))
  const announce = options.onState ?? ((): void => {})
  const wc = win.webContents

  /** Nothing is judged before the first load: an empty window is not a dead one. */
  let loaded = false
  /** The last beat we were willing to believe. Only healthy beats move it. */
  let lastBeat = clock.now()
  /** A reload is in flight; the sweep holds off until 'did-finish-load'. */
  let reloading = false
  /** True between announcing 'recovering' and the healthy beat that ends it. */
  let recovering = false
  /** Timestamps of heartbeat/hang reloads inside the sliding window. */
  let reloads: number[] = []
  /** The budget is spent. Report, do not reload, until a healthy beat says otherwise. */
  let givenUp = false
  /** Crashes since the last healthy load. Its own counter — see the header. */
  let deaths = 0
  let unresponsiveTimer: unknown = null
  let disposed = false

  function say(line: string): void {
    log(`[watchdog] ${line}`)
  }

  function enterRecovering(reason: string): void {
    if (recovering) return
    recovering = true
    announce('recovering', reason)
  }

  /**
   * The reload path for a renderer that is still *there* — silent or hung.
   *
   * Deliberately not the crash path: this one is rate-limited and gives up,
   * because there is a live window full of live terminals on the other side of
   * a mistake here.
   */
  function requestReload(reason: string): void {
    if (disposed || reloading || win.isDestroyed() || wc.isDestroyed()) return

    const now = clock.now()
    reloads = reloads.filter((at) => now - at < RELOAD_WINDOW_MS)

    if (givenUp) return

    if (reloads.length >= RELOAD_LIMIT) {
      givenUp = true
      say(
        `giving up: ${reloads.length} reloads in the last ${Math.round(RELOAD_WINDOW_MS / 60_000)} min ` +
          `did not fix it (${reason}). Not reloading again until the renderer reports healthy.`
      )
      // Said again rather than left alone: the clients have been showing
      // "recovering", and it is no longer true that it is going to.
      recovering = true
      announce('recovering', 'the desktop window is not coming back on its own')
      return
    }

    if (reloads.length > 0) {
      const since = now - (reloads[reloads.length - 1] ?? 0)
      if (since < RELOAD_COOLDOWN_MS) {
        // Not a refusal, a wait. The sweep is still running and will ask again.
        return
      }
    }

    reloads.push(now)
    reloading = true
    say(`reloading the renderer: ${reason} (reload ${reloads.length} of ${RELOAD_LIMIT} in this window)`)
    enterRecovering(reason)
    wc.reload()
  }

  /**
   * The sweep. Everything it decides comes from the clock and two questions the
   * window can answer, so it is cheap enough to run every second forever.
   */
  function sweep(): void {
    if (disposed || reloading || !loaded) return
    if (win.isDestroyed() || wc.isDestroyed()) return

    /*
     * A window nobody can see is not evidence of anything.
     *
     * Minimised and hidden-to-tray renderers are the two states where the OS
     * itself may stop the beat, and Forge spends real time in both — closing to
     * the tray is how it stays running with Forge Web on. Reloading there would
     * mean the phone's desktop restarted itself every time the window was put
     * away, which is the opposite of the point.
     *
     * A *visible* window that has gone quiet has no such excuse, and that is
     * precisely today's failure: a window on screen, painted, empty.
     */
    if (!win.isVisible() || win.isMinimized()) return

    const silentFor = clock.now() - lastBeat
    if (silentFor < HEARTBEAT_SILENCE_MS) return

    requestReload(`no heartbeat from a visible window for ${Math.round(silentFor / 1000)}s`)
  }

  const tick = clock.setInterval(sweep, TICK_MS)

  /* ------------------------------------------------------ the three signals */

  wc.on('render-process-gone', (_event, details) => {
    if (disposed || details.reason === 'clean-exit' || win.isDestroyed()) return
    deaths += 1
    say(`renderer process gone (${details.reason}), death #${deaths}`)

    if (deaths >= 2) {
      // See the header: quiet resignation here is what builds the zombie.
      say('a second death with no healthy load in between — destroying the window so the quit path runs')
      win.destroy()
      return
    }

    reloading = true
    enterRecovering(`the desktop renderer crashed (${details.reason})`)
    clock.setTimeout(() => {
      if (disposed || win.isDestroyed() || wc.isDestroyed()) return
      say('reloading after the crash')
      wc.reload()
    }, CRASH_RELOAD_DELAY_MS)
  })

  wc.on('unresponsive', () => {
    if (disposed || unresponsiveTimer !== null) return
    say(`renderer reported unresponsive — waiting ${Math.round(UNRESPONSIVE_GRACE_MS / 1000)}s for it to come back`)
    unresponsiveTimer = clock.setTimeout(() => {
      unresponsiveTimer = null
      if (disposed || win.isDestroyed() || wc.isDestroyed()) return
      requestReload(`still unresponsive ${Math.round(UNRESPONSIVE_GRACE_MS / 1000)}s after Chromium said so`)
    }, UNRESPONSIVE_GRACE_MS)
  })

  wc.on('responsive', () => {
    if (unresponsiveTimer === null) return
    clock.clearTimeout(unresponsiveTimer)
    unresponsiveTimer = null
    say('renderer responsive again — no reload needed')
  })

  wc.on('did-finish-load', () => {
    reloading = false
    // The clock starts now, not when the reload was asked for: a fresh document
    // has the full silence budget to get React mounted and beating.
    lastBeat = clock.now()
    loaded = true
    /*
     * Note what does *not* happen here: `deaths` is not cleared. The code this
     * replaces cleared it on this event, because a finished load was the
     * closest thing to "the renderer is well again" that main could observe.
     * It is not the same thing — today's failure loaded perfectly and mounted
     * nothing — and a crash loop whose documents all load would have reset the
     * counter forever. Now that a real answer exists, the crash counter waits
     * for it: see the healthy branch of `heartbeat`.
     */
  })

  /*
   * Coming back into view is a fresh start, not an accusation.
   *
   * While the window was away the beat may have been legitimately throttled by
   * the OS, so `lastBeat` is stale by however long it was gone. Without this,
   * restoring a window that had been minimised for an hour would be judged dead
   * on the first sweep and reloaded in front of the person who just restored it.
   */
  const seen = (): void => {
    lastBeat = clock.now()
  }
  win.on('show', seen)
  win.on('restore', seen)

  /* --------------------------------------------------------- the heartbeat */

  return {
    heartbeat(beat) {
      if (disposed) return
      loaded = true

      if (beat && beat.healthy === false) {
        /*
         * The tree told us it is broken. There is nothing to wait for — the
         * silence timer exists to distinguish "gone" from "busy", and this
         * message has already settled that. `lastBeat` is deliberately not
         * moved: an unhealthy beat is silence that can also name itself.
         */
        say(`renderer reports unhealthy: ${beat.error ?? 'no detail'}`)
        requestReload(`the React root caught: ${beat.error ?? 'an error with no message'}`)
        return
      }

      lastBeat = clock.now()
      deaths = 0
      if (givenUp) {
        /*
         * Lifts the latch, and only the latch. The *budget* is not refunded:
         * `reloads` still holds every recent attempt and still decays on its
         * own five-minute window, so a renderer that beats healthily once
         * between failures cannot buy itself an unlimited supply of reloads.
         * That flapping shape — mount, beat, throw, reload, mount, beat, throw —
         * is exactly what a stale preload produces, and refunding on a single
         * good beat would turn the ceiling into no ceiling at all.
         */
        givenUp = false
        say('renderer is healthy again — watching normally, though recent reloads still count against the ceiling')
      }
      if (recovering) {
        recovering = false
        say('renderer healthy — telling the clients the desktop is back')
        announce('ready')
      }
    },

    dispose() {
      disposed = true
      clock.clearInterval(tick)
      if (unresponsiveTimer !== null) {
        clock.clearTimeout(unresponsiveTimer)
        unresponsiveTimer = null
      }
    }
  }
}
