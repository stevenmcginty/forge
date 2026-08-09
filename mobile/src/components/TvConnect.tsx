import { useCallback, useEffect, useRef, useState } from 'react'
import { parseDiscoveryReply, type DiscoveryReply } from '@shared/mobile'
import { tvBridge } from '../lib/tv-bridge'
import type { LinkState } from '../lib/link'
import '../tv.css'

/**
 * The television's first screen, when it has no idea where the desktop is.
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
 * two ways out — search again, or type an address — as rows in the same column
 * rather than buttons somewhere else on the screen.
 *
 * Typing is last on purpose and never removed. A network with broadcast
 * disabled, a guest VLAN, a desktop on ethernet while the TV is on wifi: all
 * real, all invisible from a sofa, and all fixed by typing four numbers. The
 * search is the good path, not the only one.
 */

/** How long the native side listens before answering. Mirrors SEARCH_MS. */
const SEARCH_MS = 1_800

/** A desktop that answered, plus the address it answered from. */
type Found = DiscoveryReply

export function TvConnect({
  state,
  detail,
  proto,
  onPick,
  onCancel,
  onType
}: {
  state: LinkState
  /** The desktop's sentence, or the two pairing words while 'awaiting'. */
  detail: string
  /** The protocol this app speaks, so a mismatch is said rather than dialled. */
  proto: number
  /** Connect to this desktop and ask it to pair. */
  onPick: (origin: string) => void
  /** Give up on a pairing request that is waiting on the desk. */
  onCancel: () => void
  /** Fall back to the typed-address screen. */
  onType: () => void
}): React.JSX.Element {
  const [found, setFound] = useState<Found[]>([])
  const [searching, setSearching] = useState(false)
  /** No native layer at all — a browser preview, or an older APK. */
  const [canSearch] = useState(() => tvBridge.canFindDesktops())
  /** Has a search finished at least once? It is the difference between
   *  "looking" and "nothing answered", which are different sentences. */
  const [searched, setSearched] = useState(false)
  const [at, setAt] = useState(0)
  const rows = useRef(new Map<number, HTMLElement>())

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
  // the same machine must not make it appear twice, and must not make the ring
  // jump because the row under it moved.
  useEffect(() => {
    return tvBridge.onDesktopsFound((replies) => {
      const parsed = replies.map(parseDiscoveryReply).filter((reply): reply is Found => reply !== null)
      setFound((current) => {
        const byOrigin = new Map(current.map((desktop) => [desktop.origin, desktop]))
        for (const desktop of parsed) byOrigin.set(desktop.origin, desktop)
        return [...byOrigin.values()]
      })
    })
  }, [])

  // Searching starts by itself: the screen exists because nobody knows the
  // address, so waiting for a press to begin looking would be asking the
  // question the screen is here to answer.
  useEffect(() => {
    search()
  }, [search])

  const choices = found.length + (canSearch ? 1 : 0) + 1

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
          return Math.max(0, Math.min(choices - 1, next))
        })
        return
      }
      if (event.key !== 'Enter') return
      event.preventDefault()
      if (at < found.length) {
        const desktop = found[at]
        if (desktop) onPick(desktop.origin)
        return
      }
      if (canSearch && at === found.length) {
        search()
        return
      }
      onType()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [at, canSearch, choices, found, onCancel, onPick, onType, search, state])

  // The ring is drawn by a class, but the element is focused too, so the
  // WebView scrolls it into view without this screen owning a scroll model.
  useEffect(() => {
    rows.current.get(at)?.focus({ preventScroll: false })
  }, [at, found.length])

  if (state === 'awaiting') {
    const words = detail.split(' ')
    return (
      <div className="tv-connect">
        <h1 className="tv-connect-mark">Forge</h1>
        <p className="tv-connect-lead">Look at the desktop. It is asking about this television and showing two words.</p>
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
      <p className="tv-connect-lead">
        {busy
          ? 'Connecting to the desktop…'
          : searching
            ? 'Looking for Forge on this network…'
            : found.length > 0
              ? 'Choose the desktop to watch. It will ask you to allow this television on its own screen.'
              : canSearch
                ? searched
                  ? 'Nothing answered. Forge has to be running on a computer on this same wifi, with the phone link switched on in Settings › Forge Mobile.'
                  : 'Looking for Forge on this network…'
                : 'This build cannot search the network, so the address has to be typed once.'}
      </p>

      {trouble && <p className="tv-connect-trouble">{trouble}</p>}

      <div className="tv-connect-list">
        {found.map((desktop, index) => (
          <button
            key={desktop.origin}
            type="button"
            tabIndex={-1}
            ref={(el) => {
              if (el) rows.current.set(index, el)
              else rows.current.delete(index)
            }}
            className={`tv-connect-row${at === index ? ' is-focus' : ''}`}
            onClick={() => onPick(desktop.origin)}
          >
            <span className="tv-connect-name">{desktop.name}</span>
            <span className="tv-connect-where">
              {desktop.origin.replace(/^https?:\/\//, '')}
              {desktop.app ? ` · Forge ${desktop.app}` : ''}
              {/* A version of the *protocol*, not of the app: two Forges that
                  cannot talk to each other should say so here rather than
                  after a connection that fails at hello. */}
              {desktop.proto !== proto ? ' · different Forge version' : ''}
            </span>
          </button>
        ))}

        {canSearch && (
          <button
            type="button"
            tabIndex={-1}
            ref={(el) => {
              if (el) rows.current.set(found.length, el)
              else rows.current.delete(found.length)
            }}
            className={`tv-connect-row is-quiet${at === found.length ? ' is-focus' : ''}`}
            onClick={search}
          >
            <span className="tv-connect-name">{searching ? 'Looking…' : 'Look again'}</span>
            <span className="tv-connect-where">Asks every Forge on this wifi to say where it is</span>
          </button>
        )}

        <button
          type="button"
          tabIndex={-1}
          ref={(el) => {
            if (el) rows.current.set(choices - 1, el)
            else rows.current.delete(choices - 1)
          }}
          className={`tv-connect-row is-quiet${at === choices - 1 ? ' is-focus' : ''}`}
          onClick={onType}
        >
          <span className="tv-connect-name">Type the address instead</span>
          <span className="tv-connect-where">
            The desktop shows it under Settings › Forge Mobile — something like 192.168.1.20:8420
          </span>
        </button>
      </div>

      <p className="tv-connect-foot">Up and Down to choose · OK to connect</p>
    </div>
  )
}
