import { useCallback, useEffect, useRef, useState } from 'react'
import { MOBILE_PORT, parseDiscoveryReply, type DiscoveryReply } from '@shared/mobile'
import { toOrigin } from './secure'
import { tvBridge } from './tv-bridge'
import type { LinkState } from './link'

/**
 * Finding the desktop again after it has moved.
 *
 * The address a device was paired at is a fact with a shelf life. A router
 * hands out a different one when a lease expires, a laptop that spent the day
 * at the office comes home onto the other wifi band, and none of that is
 * visible from the sofa or from a phone in a pocket. What is visible is a
 * socket that stops opening and a line of text promising to try again in
 * fifteen seconds, forever, because the address it keeps trying belongs to
 * somebody else's washing machine now.
 *
 * The repair for that was written for the television first and lived inside
 * components/TvConnect.tsx, which is the only reason the phone never had it —
 * the phone has no D-pad column to hang it off, not that it needed the repair
 * any less. It lives here now because there is exactly one correct version of
 * it and two surfaces that want it, and two copies of a reconnection rule are
 * two copies that drift.
 *
 * ## What it does, and the one rule it will not break
 *
 * One UDP broadcast every fifteen seconds for as long as the desktop is not
 * answering — the question has to be asked natively, because a WebView cannot
 * send a datagram; see lib/tv-bridge.ts — and, when the desktop this device is
 * *already paired to* answers from an address that is not the remembered one,
 * a dial to the new address without anybody being asked.
 *
 * "Already paired to" is the whole of the safety here, and it is a safety rule
 * rather than a convenience. A stored device token is a credential, and a
 * machine that answers a broadcast has proved nothing whatsoever by answering
 * it. So the automatic dial happens only when the reply's protocol number
 * matches this build's and its `desktopName` matches the name the paired
 * desktop gave at `hello-ok` — and even then the dial carries no token,
 * because App.tsx sends a credential only to the address it was issued at.
 * What a machine that lied about its name gets is a connection request and a
 * prompt on somebody's screen. What it does not get is the token.
 *
 * ## Where there is no native layer, which is most places
 *
 * `ForgeTvNative` is attached to the WebView by MainActivity.kt only on the
 * build whose application id ends `.tv`, so a browser tab, the installed PWA
 * and today's phone APK all report `canSearch: false` and never ask anything.
 * That is a supported state rather than a broken one: everything below still
 * runs, the searching simply never happens, and the sentences say "not
 * answering" instead of pretending to look. A phone build that registered the
 * same interface would gain the whole of this behaviour with no change here.
 */

/** How long the native side listens before answering. Mirrors SEARCH_MS. */
const SEARCH_MS = 1_800

/**
 * How often a paired device re-asks the network while it is waiting.
 *
 * Slow on purpose. This runs for as long as the laptop is out of the house —
 * hours — so it is a patient background question, not a spinner: one small
 * broadcast every fifteen seconds costs nothing and finds a moved desktop
 * within a few seconds of it appearing. The desktop's own rate limit (one reply
 * per source per second) is nowhere near this.
 */
const SEARCH_EVERY_MS = 15_000

/** The desktop this device is already paired to, if there is one. */
export interface KnownDesktop {
  /** Its own name, as it said in `hello-ok`. '' if it never said. */
  name: string
  /** The address that worked last time. May now be somebody else's. */
  origin: string
}

/** What the search knows, for whichever screen is showing it. */
export interface Homing {
  /** The desktops that have answered, merged by address. */
  found: DiscoveryReply[]
  /** A broadcast is out and its answers are still arriving. */
  searching: boolean
  /** At least one search has finished — "nothing answered" is only sayable
   *  after this, and before it the honest word is "looking". */
  searched: boolean
  /** Whether this build can ask the network at all. */
  canSearch: boolean
  /** Ask now, rather than at the next interval. */
  search: () => void
  /** The new address this device dialled on its own, or '' if it has not. */
  movedTo: string
}

/**
 * Are these two the same address?
 *
 * They arrive written differently and always have: discovery answers with
 * `http://host:port` because that is what a browser would fetch, and the store
 * holds whatever last worked, which is `ws://host:port` for anything that has
 * been through `toOrigin`. Compared raw, the remembered desktop would never
 * match the one answering the search — every reply would look like a move, and
 * a device sitting happily beside its desktop would announce every fifteen
 * seconds that it had found it somewhere new.
 */
export function sameAddress(a: string, b: string): boolean {
  if (!a || !b) return false
  return toOrigin(a, MOBILE_PORT) === toOrigin(b, MOBILE_PORT)
}

/**
 * Search for the paired desktop, and go to it when it turns up elsewhere.
 *
 * `active` is the caller's answer to "is there anything worth finding right
 * now" — a television's connect screen needs the list even unpaired, a paired
 * phone needs it only while the link is down, and a phone that has never been
 * paired has a QR code and a text field and nowhere to put a discovered
 * desktop, so it stays off the air.
 */
export function useDesktopHoming(view: {
  state: LinkState
  /** The desktop already paired with, or null before there is one. */
  known: KnownDesktop | null
  /** The protocol this app speaks, so a mismatched Forge is never dialled. */
  proto: number
  /** Whether to ask the network at all. See above. */
  active: boolean
  /** Dial this address. Whether a token rides along is App.tsx's call. */
  onPick: (origin: string) => void
}): Homing {
  const { state, known, proto, active, onPick } = view
  const [found, setFound] = useState<DiscoveryReply[]>([])
  const [searching, setSearching] = useState(false)
  /** No native layer at all — a browser, the PWA, or a phone APK. */
  const [canSearch] = useState(() => tvBridge.canFindDesktops())
  /** Has a search finished at least once? It is the difference between
   *  "looking" and "nothing answered", which are different sentences. */
  const [searched, setSearched] = useState(false)
  const [movedTo, setMovedTo] = useState('')
  /**
   * Addresses this hook has dialled on its own initiative.
   *
   * A ref, not state: it must not repaint anything, and it must be read by the
   * effect that writes it without that effect depending on its own output. Its
   * job is to make the automatic dial happen once per address — the desktop
   * answers every probe, so without this a moved laptop would be re-dialled
   * every fifteen seconds and a prompt would reappear over the top of the one
   * already on its screen.
   */
  const homed = useRef(new Set<string>())

  const search = useCallback((): void => {
    if (!tvBridge.findDesktops()) {
      setSearched(true)
      return
    }
    setSearching(true)
    window.setTimeout(() => {
      setSearching(false)
      setSearched(true)
    }, SEARCH_MS)
  }, [])

  // Answers can arrive from several desktops and from repeated probes, so they
  // are merged by address rather than replacing the list — a second reply from
  // the same machine must not make it appear twice, and must not make the TV's
  // ring jump because the row under it moved.
  useEffect(() => {
    return tvBridge.onDesktopsFound((replies) => {
      const parsed = replies
        .map(parseDiscoveryReply)
        .filter((reply): reply is DiscoveryReply => reply !== null)
      setFound((current) => {
        const byOrigin = new Map(current.map((desktop) => [desktop.origin, desktop]))
        for (const desktop of parsed) byOrigin.set(desktop.origin, desktop)
        return [...byOrigin.values()]
      })
    })
  }, [])

  /**
   * Searching starts by itself and keeps going: it is running because the
   * desktop is not reachable, so waiting for somebody to press something before
   * looking would be asking the question this exists to answer.
   *
   * It pauses only while a human is being asked, because that is the one moment
   * the answer is already on its way and one more broadcast could only produce a
   * second dial across the top of the first. A dial that is merely in flight
   * does not pause it: a socket opening against an address nothing is listening
   * on can hang for the better part of a minute before Android gives up on it,
   * and a phone that spent that minute not asking where its desktop went is a
   * phone that waits a minute longer than it needed to.
   */
  const looking = active && state !== 'awaiting'
  useEffect(() => {
    if (!looking) return
    search()
    const timer = window.setInterval(search, SEARCH_EVERY_MS)
    return () => window.clearInterval(timer)
  }, [looking, search])

  /**
   * The known desktop, answering from somewhere new: dial it without being told.
   *
   * Matched on the name it gave at pairing time, which is a label and not a
   * credential — it decides which address is worth a connection attempt, and
   * nothing more. The attempt itself proves the address, because App.tsx sends
   * no token to one this device has not reached before; a machine that lied
   * about its name gets a connection request and no secret.
   *
   * Only when nothing has been found at the remembered address, so a desktop
   * that is simply slow to answer is never abandoned mid-reconnect.
   */
  const idle = state !== 'connecting' && state !== 'awaiting'
  useEffect(() => {
    if (!known?.name || !idle) return
    if (found.some((desktop) => sameAddress(desktop.origin, known.origin))) return
    const moved = found.find(
      (desktop) => desktop.name === known.name && !sameAddress(desktop.origin, known.origin) && desktop.proto === proto
    )
    if (!moved || homed.current.has(moved.origin)) return
    homed.current.add(moved.origin)
    setMovedTo(moved.origin)
    onPick(moved.origin)
  }, [found, idle, known, onPick, proto])

  /**
   * A connection that worked wipes the slate.
   *
   * Both halves matter. A move is news only until it lands: once the link is
   * live the remembered address *is* the new one, and keeping the jump would
   * have the banner announce it again the next time the desktop went quiet.
   *
   * And `homed` has to be emptied for the same reason it was never a problem
   * when this lived inside the television's connect screen — that screen was
   * unmounted by its own success, taking the set with it. This runs for the
   * life of the app, so an address left in the set forever would mean a desktop
   * that goes 192.168.1.20 → .30 → .20 → .30 is followed for the first three
   * moves and abandoned on the fourth. The set only ever existed to stop the
   * *same pending prompt* being asked for twice.
   */
  useEffect(() => {
    if (state !== 'live') return
    setMovedTo('')
    homed.current.clear()
  }, [state])

  return { found, searching, searched, canSearch, search, movedTo }
}

/**
 * The one line a phone reads while its desktop is missing.
 *
 * It stands in for "Reconnecting in 15s…", which is true the way a stopped
 * clock is true: a phone whose desktop has changed address says it all
 * afternoon, and every fifteen seconds of it is a retry against a machine that
 * is not there. Somebody holding the phone needs to know which of three things
 * is happening — nothing is answering where I last found it, I am asking the
 * network where it went, or I have found it somewhere else and gone there —
 * because only the first of those is a reason to get up and walk to the desk.
 *
 * '' means "nothing to add here", and the caller keeps whatever it was already
 * showing: the desktop's own sentence on a refusal, the bare word pair for an
 * approval this search did not start, the version once the link is live.
 */
export function homingLine(view: {
  state: LinkState
  /** The Link's own words — the word pair while 'awaiting', a reason on a
   *  refusal. Carried through rather than replaced wherever it is the more
   *  useful sentence. */
  detail: string
  known: KnownDesktop | null
  homing: Homing
}): string {
  const { state, detail, known, homing } = view
  if (!known || state === 'live' || state === 'idle') return ''
  const name = known.name || 'the desktop'

  if (homing.movedTo) {
    // The word pair is carried, never replaced: it is the one thing on this
    // screen somebody has to read and compare against the desktop's prompt.
    // What is added around it is why a prompt appeared at all — nobody asked
    // for this connection, so the sentence has to say who is making it.
    if (state === 'awaiting') {
      const where = `${name} answered from ${host(homing.movedTo)}`
      return detail ? `${where} — approve “${detail}” on its screen.` : `${where}. Approve this phone on its screen.`
    }
    if (state === 'connecting') return `${name} has moved to ${host(homing.movedTo)}. Reconnecting…`
    if (state === 'retrying') return `${name} answered from ${host(homing.movedTo)}, but the link there has not opened yet.`
    return ''
  }

  // A dial that is merely in flight has not failed yet, and neither has a
  // refusal or an expiry — those already carry the desktop's own words.
  if (state !== 'retrying') return ''

  const stale = `${name} is not answering at ${host(known.origin)}`
  if (!homing.canSearch) {
    return `${stale}. If it has moved, pair again using the address it shows under Settings › Forge Mobile.`
  }
  if (homing.searching || !homing.searched) return `${stale}. Looking for it on this wifi…`
  return `${stale}, and nothing answered on this wifi. It needs to be awake, on this network, with its phone link on.`
}

/** `host:port`, because the scheme is noise to somebody reading a status line. */
function host(origin: string): string {
  return origin.replace(/^\w+:\/\//, '')
}
