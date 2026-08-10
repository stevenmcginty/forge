import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import type { PaneLeaf } from '@shared/types'
import { paneDisplayTitle, resolveProfile } from '@/lib/agents'
import { AgentBadge } from '@/components/AgentBadge'
import { Icon } from '@/components/Icon'
import { transcriptFor } from '../lib/cache'
import { mountTerm, type TermHost } from '../lib/term'
import { useForge, useProfiles } from '../state'
import { AgentChooser } from './AgentChooser'

/**
 * One terminal: the desktop's slim `.pane` header over a live xterm fed relayed
 * PTY bytes.
 *
 * ## Geometry, which is the part that is easy to get wrong
 *
 * A PTY has one geometry and this link gives it two viewers. `WebAttachFrame`'s
 * optional `cols`/`rows` mean "and this is the size I am reading it at", and the
 * desktop stands down and follows the browser for as long as the browser is
 * reading — so the *first* thing this component does after mounting a terminal
 * is fit it and attach with the result. Attaching first and resizing afterwards
 * would paint the replay buffer at the wrong width and then reflow it, which is
 * the visible version of the same bug mobile/src/lib/term.ts documents.
 *
 * The fit can legitimately fail on the first pass, because the effect runs
 * before flex has settled and a container under 8px must not be measured. That
 * is why `attach` is allowed to be called with `null` — "I will take whatever
 * size it is" — and why the ResizeObserver inside `mountTerm` is the retry: the
 * first real box it sees sends a `resize`.
 *
 * ## Replay first, then live
 *
 * `attach` is answered with the catch-up buffer before any live `data`, so the
 * replay resets the screen and everything after it is appended. A reconnect
 * re-attaches and gets a fresh buffer, which is what repaints a terminal that
 * was on screen through a dropped socket.
 *
 * ## The frozen twin
 *
 * With the desktop off there is no socket, so the same header and the same
 * emulator are given the cached transcript and marked read-only. Forge asleep
 * must not look like Forge broken (decision 10) — and a read-only xterm still
 * renders a TUI's last frame properly, which a `<pre>` of the same bytes would
 * not.
 */
export function PaneView({
  leaf,
  focused,
  onlyPane
}: {
  leaf: PaneLeaf
  focused: boolean
  onlyPane: boolean
}): ReactNode {
  const { state, actions } = useForge()
  const profile = resolveProfile(useProfiles(), leaf.profileId)
  const frozen = state.stage.kind === 'offline' || state.connection.state !== 'live'
  const asking = state.asking.has(leaf.id)
  const alive = (state.picture?.sessions ?? []).some((s) => s.id === leaf.id)

  /**
   * Whether this pane has a live shell, readable from inside the mount effect
   * without making it a dependency — re-running that effect would tear a live
   * terminal down and cost a full replay.
   */
  const aliveRef = useRef(alive)
  aliveRef.current = alive

  const holderRef = useRef<HTMLDivElement | null>(null)
  const hostRef = useRef<TermHost | null>(null)
  const splitRef = useRef<HTMLButtonElement | null>(null)
  const [chooser, setChooser] = useState<null | 'row' | 'column'>(null)
  const [truncated, setTruncated] = useState(false)

  /* ------------------------------------------------------ the live terminal */

  useLayoutEffect(() => {
    const holder = holderRef.current
    if (!holder || frozen) return

    let attached = false
    const host = mountTerm(holder, {
      fontSize: 12,
      fontFamily: "'Cascadia Mono', 'Cascadia Code', Consolas, 'Courier New', monospace",
      accent: profile.accent,
      // Everything xterm produces goes up the wire, not merely the keystrokes:
      // the DSR reply to `CSI 6 n` travels this way too, and a client that
      // filtered it would put ConPTY back to waiting out a 39-second timeout on
      // every resize. See the header of lib/term.ts.
      onData: (data) => actions.write(leaf.id, data),
      onResize: (cols, rows) => {
        if (attached) actions.resize(leaf.id, cols, rows)
      }
    })
    hostRef.current = host

    const stop = actions.onData(leaf.id, (data, replay, wasTruncated) => {
      if (replay) {
        // The catch-up buffer is a repaint, not a continuation: a reconnect
        // sends it again, and appending it would double the transcript.
        host.reset()
        setTruncated(wasTruncated)
      }
      host.write(data)
    })

    // Fit before attach, so the desktop is handed the width this browser is
    // actually reading at rather than being told a beat later.
    const size = host.fit()
    // Only attach to a pane that has a shell behind it. A workspace can name a
    // pane the desktop has not spawned yet — a tab restored at the desk, a split
    // opened a beat ago — and attaching to one is answered `unknown-session`,
    // whose sentence is "that pane is gone". Saying that about a pane which has
    // simply not started yet is a lie the person cannot act on. The effect below
    // attaches the moment it does start, which is what `session-started` is for.
    if (aliveRef.current) actions.attach(leaf.id, size)
    attached = true

    return () => {
      stop()
      actions.detach(leaf.id)
      host.dispose()
      hostRef.current = null
    }
    // Keyed on the session and on frozen, and on nothing else on purpose.
    // `profile.accent` is a construction-time input read once when the emulator
    // is built: re-running this effect would tear down a live terminal and
    // re-attach it, which costs a full replay and a screen flash. The desktop's
    // own pane keeps its spec in a ref for exactly the same reason.
  }, [leaf.id, frozen])

  /* ----------------------------------------------------- the frozen twin */

  useLayoutEffect(() => {
    const holder = holderRef.current
    if (!holder || !frozen) return
    const host = mountTerm(holder, {
      fontSize: 12,
      fontFamily: "'Cascadia Mono', 'Cascadia Code', Consolas, 'Courier New', monospace",
      accent: profile.accent,
      onData: () => {
        /* nothing to type into */
      },
      onResize: () => {
        /* nothing to resize */
      },
      readOnly: true
    })
    hostRef.current = host
    host.fit()
    const transcript = transcriptFor(state.cached, leaf.id)
    if (transcript) host.write(transcript)
    else host.write('\r\n\x1b[2m  Nothing of this pane was cached before the desktop went away.\x1b[0m\r\n')
    return () => {
      host.dispose()
      hostRef.current = null
    }
    // Same reason as above: the accent is a construction-time input.
  }, [leaf.id, frozen, state.cached])

  /**
   * A pane whose shell started *after* this component mounted has to attach a
   * second time.
   *
   * That is the whole reason `WebSessionStartedFrame` exists as an event rather
   * than only as a row in the next `sessions` list: "this is the single moment a
   * client has to do something — construct an xterm instance and attach — and
   * every client that had to find it by diffing two lists would implement the
   * same diff, with the failure mode being a pane that renders as a dead box."
   * The workspace can name a pane the desktop has not spawned yet (a tab
   * restored on the desk, a split opened a beat ago), and the first `attach` is
   * answered `unknown-session`. Without this, that pane is a dead box for the
   * life of the tab.
   *
   * Only on the false→true edge, so an ordinary `sessions` push does not cost a
   * second 192KB replay.
   */
  const wasAlive = useRef(alive)
  useEffect(() => {
    const became = !wasAlive.current && alive
    wasAlive.current = alive
    if (!became || frozen) return
    const host = hostRef.current
    if (host) actions.attach(leaf.id, host.size())
  }, [alive, frozen, leaf.id, actions])

  /** The desktop focuses the caret when the pane is the active one; so do we. */
  useEffect(() => {
    if (focused && !frozen) hostRef.current?.focus()
  }, [focused, frozen])

  return (
    <section
      className="pane"
      data-pane-id={leaf.id}
      data-focused={focused}
      data-status={frozen ? 'frozen' : alive ? 'live' : 'dead'}
      style={{ '--pane-accent': profile.accent } as CSSProperties}
      onPointerDownCapture={() => {
        if (!focused && !frozen) void actions.layout({ op: 'focus-pane', paneId: leaf.id })
      }}
    >
      <header className="pane__header">
        <AgentBadge profile={profile} size="sm" />
        <span className="pane__title truncate">{paneDisplayTitle(profile, leaf.title)}</span>

        {asking ? (
          <span className="pane__perm mono" title="This pane has settled on a question and is waiting on an answer">
            WAITING
          </span>
        ) : null}
        {truncated ? (
          <span
            className="pane__perm mono"
            title="The catch-up buffer was cut at its ceiling, so this transcript begins mid-sentence"
          >
            CUT
          </span>
        ) : null}
        {frozen ? (
          <span className="pane__perm mono" data-frozen="true" title="The last transcript this browser was sent">
            FROZEN
          </span>
        ) : null}

        <div className="pane__actions">
          <button
            ref={splitRef}
            type="button"
            className="ghost-btn pane__action"
            title="Split right"
            disabled={frozen}
            onClick={() => setChooser('row')}
          >
            <Icon name="splitRight" size={13} />
          </button>
          <button
            type="button"
            className="ghost-btn pane__action"
            title="Split down"
            disabled={frozen}
            onClick={() => setChooser('column')}
          >
            <Icon name="splitDown" size={13} />
          </button>
          <button
            type="button"
            className="ghost-btn pane__action"
            data-danger="true"
            title={onlyPane ? 'Close tab' : 'Close pane'}
            disabled={frozen}
            onClick={() => void actions.layout({ op: 'close-pane', paneId: leaf.id })}
          >
            <Icon name="close" size={13} />
          </button>
        </div>
      </header>

      <div className="pane__terminal" ref={holderRef} onPointerDown={() => hostRef.current?.focus()} />

      <AgentChooser
        anchor={splitRef.current}
        open={chooser !== null}
        align="end"
        title={chooser === 'column' ? 'Split down with' : 'Split right with'}
        onClose={() => setChooser(null)}
        onPick={(profileId) => {
          if (chooser) void actions.layout({ op: 'create-pane', paneId: leaf.id, direction: chooser, profileId })
        }}
      />
    </section>
  )
}
