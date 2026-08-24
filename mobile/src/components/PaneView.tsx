import { useEffect, useRef, useState } from 'react'
import type { MobileSession } from '@shared/mobile'
import { FOREMAN_SEED_MAX, type ForemanState } from '@shared/foreman'
import type { Link } from '../lib/link'
import { mountTerm, onViewportSettled, type TermHost } from '../lib/term'
import { KeyBar } from './KeyBar'

/**
 * One terminal, full screen.
 *
 * The pane owns its xterm and its subscription, and tears both down when it
 * unmounts — so switching panes is genuinely switching, not stacking hidden
 * terminals up until the phone runs out of memory.
 *
 * Replay is why this works away from the desk: the desktop answers every `sub`
 * with its 192KB catch-up buffer, so the first thing painted is the screen as
 * it actually is, not an empty box waiting for the next keystroke.
 *
 * ## Geometry, which is the part that is easy to get wrong
 *
 * A PTY has one geometry and this link gives it another viewer. It belongs to
 * whichever device somebody last typed into the pane on — see
 * electron/pty/grid-owner.ts — so this phone has it natively while somebody is
 * working here, and follows somebody else's the moment they take it back. Either
 * way this component does both halves, and neither half knows which case it is
 * in:
 *
 *  - It still fits its holder and still reports the result up the link. That is
 *    the *wish*, granted whenever this phone is the device being typed on.
 *  - It follows the session's real `cols`/`rows` out of the desktop's `state`
 *    pushes and hands them to `follow`, which draws that grid at a font small
 *    enough to fit this screen. When the grid is this phone's own, that is
 *    nothing to do.
 *
 * The key bar is raised from the header rather than always present — see
 * KEYBAR_PREF below. The compose row still lives inside it, so opening the keys
 * is also how you reach "type a line and send it".
 */

export interface PaneViewProps {
  link: Link
  session: MobileSession
  title: string
  fontSize: number
  onBack: () => void
  /** Foreman's state for this pane, when the desktop has one for it. */
  foreman: ForemanState | undefined
  /** The switch is a Claude-pane thing: Foreman drives a Claude session. */
  drivable: boolean
  /**
   * A pane that already holds a Claude session can be taken over with no seed
   * at all — the sheet's blank answer means exactly that, so it is only
   * offered where it means something.
   */
  canTakeOver: boolean
  /** Switch Foreman on (with the seed) or off. Resolved by App, which knows the project. */
  onForeman: (on: boolean, seed: string) => void
}

/**
 * Whether the key bar is up, remembered across screens and launches.
 *
 * Off by default. The bar exists because a phone keyboard has no Esc, Tab, Ctrl
 * or arrows — but most of the time you are reading an agent's output, not
 * sending control codes, and two rows of keys is a third of a phone screen spent
 * on something you are not using. So it is a thing you raise when you need it.
 */
const KEYBAR_PREF = 'forge.keybar'

/**
 * How tall the seed sheet's textarea grows before it scrolls instead — about
 * eight lines of `.seed-sheet-input`'s own font/line-height/padding.
 */
const SEED_MAX_GROW_PX = 190

function keybarWanted(): boolean {
  try {
    return localStorage.getItem(KEYBAR_PREF) === 'on'
  } catch {
    // Private mode / storage disabled. The default is the honest answer.
    return false
  }
}

export function PaneView({
  link,
  session,
  title,
  fontSize,
  onBack,
  foreman,
  drivable,
  canTakeOver,
  onForeman
}: PaneViewProps): React.JSX.Element {
  const holder = useRef<HTMLDivElement | null>(null)
  const host = useRef<TermHost | null>(null)
  const [composing, setComposing] = useState(false)
  const [draft, setDraft] = useState('')
  const [keys, setKeys] = useState(keybarWanted)

  /* -------------------------------------------------------------- foreman
   *
   * The same switch, seed sheet, footer and log the browser pane header has.
   * The state is never local — every draw of it comes off the picture, so a
   * switch flipped at the desk or in a browser shows its true shape here.
   */
  const foremanOn = !!foreman && foreman.status !== 'off'
  const [seeding, setSeeding] = useState(false)
  const [seedDraft, setSeedDraft] = useState('')
  const [logOpen, setLogOpen] = useState(false)
  const seedField = useRef<HTMLTextAreaElement | null>(null)

  /** The sheet closes itself the moment Foreman is on, whichever surface flipped it. */
  useEffect(() => {
    if (foremanOn) setSeeding(false)
  }, [foremanOn])

  // Rows 1 through ~8 grow with the text, past that it scrolls in place — a
  // seed can be a whole pasted brief, not just the one line the placeholder
  // suggests.
  useEffect(() => {
    const el = seedField.current
    if (!el) return
    el.style.height = '0px'
    const next = Math.min(el.scrollHeight, SEED_MAX_GROW_PX)
    el.style.height = `${next}px`
    el.style.overflowY = el.scrollHeight > SEED_MAX_GROW_PX ? 'auto' : 'hidden'
  }, [seedDraft, seeding])

  const startForeman = (): void => {
    const seed = seedDraft.trim().slice(0, FOREMAN_SEED_MAX)
    // A blank seed means "take over what is here", which only means something
    // for a pane already holding a conversation — otherwise Start waits.
    if (!seed && !canTakeOver) return
    setSeeding(false)
    setSeedDraft('')
    onForeman(true, seed)
  }

  useEffect(() => {
    const container = holder.current
    if (!container) return

    const term = mountTerm(container, {
      fontSize,
      onData: (data) => link.write(session.id, data),
      onResize: (cols, rows) => link.resize(session.id, cols, rows)
    })
    host.current = term
    term.fit()

    // A replay frame is the whole screen, so the terminal is cleared before it
    // is painted. Without that, a reconnect stacks a second copy of the
    // scrollback underneath the first. One `repaint` rather than a `reset`
    // followed by a `write`, because the wipe has to be *ordered* against the
    // live bytes still sitting unparsed in xterm's write queue — a bare reset
    // clears only what has already been painted and lets the rest paint after
    // it, which is the same duplicate copy by a slower route. See `repaint` in
    // lib/term.ts.
    const off = linkSubscribe(link, session.id, (data, replay) => {
      if (replay) {
        term.repaint(data)
        return
      }
      term.write(data)
    })

    // The soft keyboard is the most common resize this app will ever see.
    const offViewport = onViewportSettled(() => term.fit())

    return () => {
      off()
      offViewport()
      term.dispose()
      host.current = null
    }
  }, [link, session.id, fontSize])

  // Raising or dropping the bar changes the terminal's height by two rows'
  // worth, so the PTY has to be told — otherwise the shell keeps drawing to a
  // geometry that is no longer on screen.
  useEffect(() => {
    host.current?.fit()
  }, [keys, composing])

  /**
   * Draw what the pane actually is, at whatever type size that takes.
   *
   * The two numbers rather than the session object, because this has to run on
   * a change of *geometry* and the desktop hands out a fresh session list for
   * every `state` push there is — a project renamed, a tab opened, a pane
   * dying. `follow` is a no-op when the grid it is given is the one it is
   * already drawing, but an effect that ran on every push would still be an
   * effect that ran on every push.
   *
   * An ordinary effect declared after the mount effect, so it runs after it in
   * the same flush: a terminal is built and fitted, and then put to the
   * desktop's grid. A `useLayoutEffect` would be *worse* here rather than
   * better — React runs every layout effect before any passive one, so it would
   * fire before the terminal above exists and find nothing to follow.
   */
  const cols = session.cols
  const rows = session.rows
  useEffect(() => {
    host.current?.follow(cols > 0 && rows > 0 ? { cols, rows } : null)
    // `session.id` and `fontSize` because they are what rebuilds the terminal
    // above, and a rebuilt terminal has forgotten the grid it was following.
  }, [cols, rows, session.id, fontSize])

  const toggleKeys = (): void => {
    setKeys((on) => {
      const next = !on
      try {
        localStorage.setItem(KEYBAR_PREF, next ? 'on' : 'off')
      } catch {
        /* the preference is a convenience, not a requirement */
      }
      return next
    })
  }

  const send = (data: string): void => {
    link.write(session.id, data)
    host.current?.focus()
  }

  const sendDraft = (): void => {
    if (!draft) return
    link.write(session.id, `${draft}\r`)
    setDraft('')
  }

  return (
    <div className="pane">
      <header className="bar">
        <button type="button" className="bar-back" onClick={onBack} aria-label="Back">
          ‹
        </button>
        <div className="bar-title">
          <strong>{title}</strong>
          <span className="bar-sub">
            {session.cols}×{session.rows}
          </span>
        </div>
        {/*
          Foreman's switch — Claude panes only, lit while it drives. Tap-off
          stops at once on every surface; tap-on opens the seed sheet below
          rather than starting blind.
        */}
        {drivable ? (
          <button
            type="button"
            className="bar-foreman"
            data-on={foremanOn ? 'true' : undefined}
            aria-pressed={foremanOn}
            title={
              foremanOn
                ? 'Foreman is driving this pane. Tap to take the keyboard back.'
                : 'Let Foreman drive this pane end to end from one line.'
            }
            onClick={() => {
              if (foremanOn) onForeman(false, '')
              else setSeeding(true)
            }}
          >
            FOREMAN
          </button>
        ) : null}
        <button
          type="button"
          className="bar-keys"
          aria-pressed={keys}
          title={keys ? 'Hide the terminal keys' : 'Show Ctrl, Esc, Tab and arrows'}
          onClick={toggleKeys}
        >
          ⌨︎
        </button>
      </header>

      {/*
        The seed sheet. A line or a whole pasted brief, one question — the
        same words the browser asks — and the blank answer is a real one only
        where the pane already holds a session: "take over what is here".
      */}
      {seeding ? (
        <div className="seed-sheet">
          <textarea
            ref={seedField}
            className="seed-sheet-input"
            value={seedDraft}
            rows={1}
            maxLength={FOREMAN_SEED_MAX}
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            placeholder="What's the job? A line or a whole brief — both work."
            autoFocus
            onChange={(e) => setSeedDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                startForeman()
              }
              if (e.key === 'Escape') {
                e.preventDefault()
                setSeeding(false)
              }
            }}
          />
          <button
            type="button"
            className="seed-sheet-start"
            onClick={startForeman}
            disabled={!seedDraft.trim() && !canTakeOver}
          >
            Start
          </button>
          <button
            type="button"
            className="seed-sheet-cancel"
            aria-label="Cancel"
            onClick={() => {
              setSeeding(false)
              setSeedDraft('')
            }}
          >
            ✕
          </button>
        </div>
      ) : null}

      <div className="term-holder" ref={holder} onClick={() => host.current?.focus()} />

      {/*
        Foreman's status line, while there is a job to describe — the same
        sentence the desktop's footer and the browser's footer show. Tapping it
        opens the decision log.
      */}
      {foreman && foreman.status !== 'off' ? (
        <button type="button" className="foreman-line" data-status={foreman.status} onClick={() => setLogOpen(true)}>
          <span className="foreman-line-tag">{foreman.status.toUpperCase()}</span>
          <span className="foreman-line-text">{foreman.line || 'Working'}</span>
        </button>
      ) : null}

      {/*
        The decision log: the only record of why a driven pane got the answer
        it got. Bottom sheet over the terminal, newest at the bottom, closed
        with the one control in its head.
      */}
      {logOpen && foreman ? (
        <div className="foreman-log" role="dialog" aria-label="Foreman's decision log">
          <div className="foreman-log-head">
            <span className="foreman-log-title">Foreman</span>
            <button type="button" className="foreman-log-close" aria-label="Close" onClick={() => setLogOpen(false)}>
              ✕
            </button>
          </div>
          <div className="foreman-log-list">
            {foreman.log.length === 0 ? <p className="foreman-log-empty">Nothing decided yet.</p> : null}
            {foreman.log.map((entry, i) => (
              <div className="foreman-log-entry" data-kind={entry.kind} key={`${entry.at}-${i}`}>
                <span className="foreman-log-kind">{entry.kind}</span>
                <span className="foreman-log-at">{clockOf(entry.at)}</span>
                <span className="foreman-log-text">{entry.text}</span>
              </div>
            ))}
          </div>
        </div>
      ) : null}

      {composing ? (
        <div className="compose">
          <input
            className="compose-input"
            value={draft}
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            placeholder="Type a line, then send"
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                sendDraft()
              }
            }}
          />
          <button type="button" className="compose-send" onClick={sendDraft}>
            Send
          </button>
          <button type="button" className="compose-close" onClick={() => setComposing(false)} aria-label="Close">
            ✕
          </button>
        </div>
      ) : keys ? (
        <KeyBar onSend={send} onCompose={() => setComposing(true)} />
      ) : null}
    </div>
  )
}

/** HH:MM off a Foreman log entry's epoch, the way the decision log shows it. */
function clockOf(at: number): string {
  const date = new Date(at)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/**
 * Subscribe to one session's output for as long as this component lives.
 *
 * A tiny adapter rather than a method on Link, because Link is shared by every
 * screen and must not know which one is currently on top.
 */
function linkSubscribe(
  link: Link,
  id: string,
  onChunk: (data: string, replay: boolean) => void
): () => void {
  paneListeners.set(id, onChunk)
  link.subscribe(id)
  return () => {
    paneListeners.delete(id)
    link.unsubscribe(id)
  }
}

/**
 * Live pane listeners, keyed by session id.
 *
 * Module-level because App wires Link's single `onData` callback once, at
 * construction, and routes here — a phone shows one terminal at a time, so a
 * map with at most one entry is the honest shape rather than a subscription
 * system pretending otherwise.
 */
export const paneListeners = new Map<string, (data: string, replay: boolean) => void>()
