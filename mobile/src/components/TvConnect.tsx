import { useEffect, useMemo, useRef, useState } from 'react'
import { sameAddress, type Homing, type KnownDesktop } from '../lib/homing'
import type { LinkState } from '../lib/link'
import '../tv.css'

/**
 * The television's screen whenever it is not watching a desktop — the first
 * time, and every time afterwards that the desktop is not there.
 *
 * The shared Fire TV app — the one published on GitHub and installed by
 * somebody who has never seen this repository — has no address baked into it,
 * because there is no address that would be right in more than one house. So
 * the first thing it does is ask the network: one UDP broadcast, and every
 * Forge listening on that wifi answers with its name and where to dial it (see
 * the discovery block in shared/mobile.ts, and electron/mobile/discovery.ts on
 * the other end).
 *
 * The whole screen is one column of choices walked with the D-pad, because a
 * remote has four directions and one OK and every layout that pretends
 * otherwise is a layout somebody has to aim at. Found desktops first, then the
 * ways out — search again, type an address, forget this desktop — as rows in
 * the same column rather than buttons somewhere else on the screen.
 *
 * Typing is never removed. A network with broadcast disabled, a guest VLAN, a
 * desktop on ethernet while the TV is on wifi: all real, all invisible from a
 * sofa, and all fixed by typing four numbers. The search is the good path, not
 * the only one.
 *
 * ## The paired case, which is the common one
 *
 * A television that has been paired shows this screen too, and that is the
 * whole point of `known`. The laptop goes to work, the house sleeps, the router
 * hands its address to something else, and it comes home somewhere new. What a
 * paired television must never do at that moment is what this screen used to
 * do — hand the sofa a form asking for an IP address and a pairing code.
 *
 * So: it says who it is waiting for, keeps asking the network, and when it hears
 * that same desktop answering from a different address it dials it *by itself*.
 * The dial carries no token (App.tsx decides that, and refuses to send a
 * credential to an address nothing has confirmed yet), so what happens at the
 * far end is a prompt on the laptop and one press of Allow. From the sofa the
 * whole repair is: the television says the desktop moved, and then it is back.
 *
 * None of that searching happens *here* any more. It happens in lib/homing.ts
 * and arrives as the `homing` prop, because a phone loses its desktop to the
 * same DHCP lease and deserves the same repair, and a phone cannot be handed a
 * screen built for a D-pad. This file is the television's way of showing the
 * search; it is no longer the only place that can run one.
 */

/** One row in the column, in the order the D-pad walks them. */
interface Choice {
  key: string
  name: string
  where: string
  quiet: boolean
  run: () => void
}

export function TvConnect({
  state,
  detail,
  proto,
  known,
  homing,
  onPick,
  onCancel,
  onType,
  onForget
}: {
  state: LinkState
  /** The desktop's sentence, or the two pairing words while 'awaiting'. */
  detail: string
  /** The protocol this app speaks, so a mismatch is said rather than dialled. */
  proto: number
  /** The desktop already paired with, or null on a television's first day. */
  known: KnownDesktop | null
  /**
   * The search, run by App.tsx so that exactly one of them exists on this
   * device. This screen reads it and draws it; the automatic dial that follows
   * from it has already happened by the time anything here re-renders.
   */
  homing: Homing
  /** Connect to this desktop. Whether a token rides along is App.tsx's call. */
  onPick: (origin: string) => void
  /** Give up on a pairing request that is waiting on the desk. */
  onCancel: () => void
  /** Fall back to the typed-address screen. */
  onType: () => void
  /** Throw the pairing away and start over as an unpaired television. */
  onForget: () => void
}): React.JSX.Element {
  const { found, searching, searched, canSearch, search } = homing
  const [at, setAt] = useState(0)
  const rows = useRef(new Map<number, HTMLElement>())

  const choices = useMemo((): Choice[] => {
    const list: Choice[] = found.map((desktop) => ({
      key: desktop.origin,
      name: desktop.name,
      where: [
        desktop.origin.replace(/^https?:\/\//, ''),
        desktop.app ? `Forge ${desktop.app}` : '',
        // A version of the *protocol*, not of the app: two Forges that cannot
        // talk to each other should say so here rather than after a connection
        // that fails at hello.
        desktop.proto !== proto ? 'different Forge version' : '',
        known && desktop.name === known.name && !sameAddress(desktop.origin, known.origin) ? 'this is a new address' : ''
      ]
        .filter(Boolean)
        .join(' · '),
      quiet: false,
      run: () => onPick(desktop.origin)
    }))

    if (canSearch) {
      list.push({
        key: 'search',
        name: searching ? 'Looking…' : 'Look again',
        where: 'Asks every Forge on this wifi to say where it is',
        quiet: true,
        run: search
      })
    }

    list.push({
      key: 'type',
      name: 'Type the address instead',
      where: 'The desktop shows it under Settings › Forge Mobile — something like 192.168.1.20:8420',
      quiet: true,
      run: onType
    })

    // Last, and only when there is something to forget. It is the one row here
    // that throws anything away, so it is the one furthest from the ring's
    // resting place at the top.
    if (known) {
      list.push({
        key: 'forget',
        name: 'Forget this desktop',
        where: 'Clears the saved pairing so this television can be paired again from scratch',
        quiet: true,
        run: onForget
      })
    }

    return list
  }, [canSearch, found, known, onForget, onPick, onType, proto, search, searching])

  // A shrinking list must not leave the ring pointing past the end of it.
  useEffect(() => {
    setAt((current) => Math.max(0, Math.min(choices.length - 1, current)))
  }, [choices.length])

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (state === 'awaiting') {
        if (event.key !== 'Escape') return
        event.preventDefault()
        onCancel()
        return
      }
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault()
        setAt((current) => {
          const next = event.key === 'ArrowDown' ? current + 1 : current - 1
          return Math.max(0, Math.min(choices.length - 1, next))
        })
        return
      }
      if (event.key !== 'Enter') return
      event.preventDefault()
      choices[at]?.run()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [at, choices, onCancel, state])

  // The ring is drawn by a class, but the element is focused too, so the
  // WebView scrolls it into view without this screen owning a scroll model.
  useEffect(() => {
    rows.current.get(at)?.focus({ preventScroll: false })
  }, [at, choices.length])

  if (state === 'awaiting') {
    const words = detail.split(' ')
    return (
      <div className="tv-connect">
        <h1 className="tv-connect-mark">Forge</h1>
        <p className="tv-connect-lead">
          {known
            ? 'The desktop has moved to a new address, so it is checking this is really your television. Look at it — it is showing two words.'
            : 'Look at the desktop. It is asking about this television and showing two words.'}
        </p>
        <div className="tv-connect-words">
          {words.map((word, index) => (
            <span key={index} className="tv-connect-word">
              {word}
            </span>
          ))}
        </div>
        <p className="tv-connect-lead">
          Check they match, then choose <strong>Allow</strong> over there. This screen moves on by itself.
        </p>
        <p className="tv-connect-foot">Back gives up on this attempt</p>
      </div>
    )
  }

  const busy = state === 'connecting' || state === 'retrying'
  const trouble =
    state === 'refused' || state === 'expired'
      ? detail || 'The desktop did not let this television in.'
      : ''

  return (
    <div className="tv-connect">
      <h1 className="tv-connect-mark">Forge</h1>
      <p className="tv-connect-lead">{lead({ known, busy, searching, searched, canSearch, foundCount: found.length })}</p>

      {trouble && <p className="tv-connect-trouble">{trouble}</p>}

      <div className="tv-connect-list">
        {choices.map((choice, index) => (
          <button
            key={choice.key}
            type="button"
            tabIndex={-1}
            ref={(el) => {
              if (el) rows.current.set(index, el)
              else rows.current.delete(index)
            }}
            className={`tv-connect-row${choice.quiet ? ' is-quiet' : ''}${at === index ? ' is-focus' : ''}`}
            onClick={choice.run}
          >
            <span className="tv-connect-name">{choice.name}</span>
            <span className="tv-connect-where">{choice.where}</span>
          </button>
        ))}
      </div>

      <p className="tv-connect-foot">Up and Down to choose · OK to connect</p>
    </div>
  )
}

/**
 * The one sentence at the top, which is the whole difference between a
 * television that looks broken and one that is plainly getting on with it.
 *
 * A paired television says who it is waiting for, because "nothing answered" is
 * a frightening thing to read on a wall at eight in the evening and "waiting for
 * STEVE-PC, which is not on this network yet" is a fact about a laptop that is
 * at the office.
 */
function lead(view: {
  known: KnownDesktop | null
  busy: boolean
  searching: boolean
  searched: boolean
  canSearch: boolean
  foundCount: number
}): string {
  const { known, busy, searching, searched, canSearch, foundCount } = view
  if (busy) return known ? `Reconnecting to ${known.name || 'the desktop'}…` : 'Connecting to the desktop…'

  if (known) {
    const name = known.name || 'the desktop'
    if (foundCount > 0) return `${name} is not answering at its old address. Choose it below if it has moved.`
    if (searching || !searched) return `Waiting for ${name} to come back on this network…`
    // Two causes, one screen: the computer is elsewhere, or it is here with
    // Forge shut. Naming both is the difference between a television that looks
    // broken and one that has told you where to look.
    return `Still waiting for ${name}. It needs to be on this wifi with Forge running and its phone link on. This television keeps looking and reconnects by itself.`
  }

  if (searching) return 'Looking for Forge on this network…'
  if (foundCount > 0) return 'Choose the desktop to watch. It will ask you to allow this television on its own screen.'
  if (!canSearch) return 'This build cannot search the network, so the address has to be typed once.'
  if (!searched) return 'Looking for Forge on this network…'
  return 'Nothing answered. Forge has to be running on a computer on this same wifi, with the phone link switched on in Settings › Forge Mobile.'
}
