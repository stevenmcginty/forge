import { BRIEF_DEADLINE_MS, BRIEF_READY_BYTES, BRIEF_READY_QUIET_MS } from './briefDelivery'
import { composerRouteNow } from './shellSlots'
import { terminalHost } from './terminals'

/**
 * The bar's send: where a typed line goes when Enter is pressed. Lifted out of
 * Composer so the big bar and the mini bar (src/state/MiniBarHost.tsx) send
 * through one path (docs/MINI-BAR.md, 4.3):
 *
 *   route   a surface that registered a composer route takes it first
 *           (src/lib/shellSlots.ts);
 *   forge   the main agent, through the caller's `ask`;
 *   pane    pasted into the pane, then Enter once the pane has echoed it.
 *
 * The caller keeps what is its own: the text box, the history, the comets and
 * the notice when it fails.
 */

/** The Enter waits for the pane's echo of the words, then this much quiet. */
const ECHO_QUIET_MS = 150
/** The most the Enter waits: a pane that never goes quiet still gets it. */
const ECHO_MAX_MS = 1500
const ECHO_POLL_MS = 30

/**
 * Fire the keys a hand at the prompt would: the text, then Enter once the pane
 * has drawn it.
 *
 * The words go in as a paste, never as typing. Typed raw, a long line reached
 * Claude Code as one fast burst it guesses is a paste — and when the Enter
 * arrived in the same read as the words, it was taken in as part of that
 * paste, a new line rather than a send, so the words sat on the prompt until
 * Steve pressed Enter himself. xterm's paste wraps the words in bracketed-
 * paste markers whenever the agent asked for them (Claude Code, Codex and
 * Gemini CLI all do), so the agent knows exactly where the words end: an
 * Enter after the end marker is an Enter, and one that lands while it is still
 * taking the paste in is held and pressed after it. A shell that never asked
 * for the markers gets the plain words, as before.
 *
 * The Enter still waits for the echo — output after the words went in, then a
 * short quiet — so it follows the words rather than racing them.
 */
export function sendToPane(paneId: string, text: string): boolean {
  if (!terminalHost.has(paneId) || terminalHost.runtime(paneId).status === 'exited') return false
  const before = terminalHost.readiness(paneId).outputBytes
  terminalHost.paste(paneId, text)
  const started = performance.now()
  const tick = (): void => {
    const r = terminalHost.readiness(paneId)
    const echoed = r.outputBytes > before && r.quietForMs >= ECHO_QUIET_MS
    if (echoed || performance.now() - started >= ECHO_MAX_MS) {
      terminalHost.submit(paneId)
      return
    }
    window.setTimeout(tick, ECHO_POLL_MS)
  }
  window.setTimeout(tick, ECHO_POLL_MS)
  return true
}

export interface BarSendTarget {
  /** The pane the bar aims at, or null. */
  paneId: string | null
  /** The bar aims at Forge (or has no pane to aim at). */
  toForge: boolean
  /** Ask the main agent: the bar's `hubAsk(hub, text, 'typed')`. */
  ask: (text: string) => void
}

/** What became of the words: taken by a route, asked of Forge, pasted into the pane, or not sent at all. */
export type BarSendResult = 'routed' | 'forge' | 'pane' | 'failed'

/** The big bar's Enter. `message` is already trimmed at the end and not blank. */
export function barSend(message: string, target: BarSendTarget): BarSendResult {
  const { paneId, toForge } = target
  const route = composerRouteNow()
  if (route?.({ text: message, paneId })) return 'routed'
  if (toForge) {
    target.ask(message)
    return 'forge'
  }
  if (!paneId || !sendToPane(paneId, message)) return 'failed'
  return 'pane'
}

/* ------------------------------------------------------------- readiness */

const READY_POLL_MS = 100
/** A plain shell has no banner: once it has printed its prompt and been this quiet, it is listening. */
const SHELL_QUIET_MS = 300

/**
 * Resolves true once `paneId` can take a paste; false if it never will (it
 * exited, or did not come up within the deadline).
 *
 * A pane that is already up and has printed an agent's banner's worth is ready
 * at once, busy or not: an agent at work takes the words in and queues them. A
 * brand-new agent pane is not: between the echoed bootstrap command and the
 * agent's banner there is a silence while node loads, and a paste into it
 * lands at the PowerShell prompt, which runs it. So a pane that has to be
 * waited for is ready only when it has printed a banner's worth and then gone
 * quiet — the brief drain's rule (src/lib/briefDelivery.ts). A plain shell
 * (`shell`) has no banner; its prompt and a short quiet will do.
 */
export function whenPaneReady(paneId: string, shell: boolean): Promise<boolean> {
  const verdict = (waited: boolean): boolean | null => {
    const status = terminalHost.runtime(paneId).status
    if (status === 'exited' || status === 'error') return false
    if (status !== 'live' || !terminalHost.has(paneId)) return null
    const r = terminalHost.readiness(paneId)
    if (shell) return r.outputBytes > 0 && (!waited || r.quietForMs >= SHELL_QUIET_MS) ? true : null
    if (!waited) return r.outputBytes >= BRIEF_READY_BYTES ? true : null
    return r.outputBytes >= BRIEF_READY_BYTES && r.quietForMs >= BRIEF_READY_QUIET_MS ? true : null
  }
  const now = verdict(false)
  if (now !== null) return Promise.resolve(now)
  const started = Date.now()
  return new Promise((resolve) => {
    const tick = (): void => {
      const v = verdict(true)
      if (v !== null) return resolve(v)
      if (Date.now() - started >= BRIEF_DEADLINE_MS) return resolve(false)
      window.setTimeout(tick, READY_POLL_MS)
    }
    window.setTimeout(tick, READY_POLL_MS)
  })
}
