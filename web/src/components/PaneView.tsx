import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import type { PaneLeaf } from '@shared/types'
import { paneDisplayTitle, resolveProfile } from '@/lib/agents'
import { AgentBadge } from '@/components/AgentBadge'
import { Icon } from '@/components/Icon'
import { transcriptFor } from '../lib/cache'
import { useMobile } from '../lib/mobile'
import { mountTerm, type TermHost } from '../lib/term'
import { useForge, useProfiles } from '../state'
import { AgentChooser } from './AgentChooser'

/**
 * One terminal: the desktop's slim `.pane` header over a live xterm fed relayed
 * PTY bytes.
 *
 * ## Geometry, which is the part that is easy to get wrong
 *
 * A PTY has one geometry and this link gives it another viewer. It belongs to
 * whichever device somebody last typed into the pane on — see
 * electron/pty/grid-owner.ts — so this tab has it natively while somebody is
 * working here, and follows somebody else's the moment they take it back. Either
 * way this component does both halves, and neither half knows which case it is
 * in:
 *
 *  - It still fits its container and still attaches with the result. That is
 *    the *wish*, granted whenever this browser is the device being typed on. It
 *    is sent first for the reason it always was: attaching first and resizing
 *    afterwards paints the replay buffer at the wrong width and then reflows it.
 *  - It follows the session's real `cols`/`rows` out of the picture — the
 *    desktop's answer, pushed on every change — and hands them to `follow`,
 *    which draws that grid at a font small enough to fit this box. When the
 *    grid is this browser's own, that is nothing to do.
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
 *
 * ## A dropped socket is not the frozen twin
 *
 * These are two different states and this component used to run them together,
 * which was expensive in a way nobody could see. A reconnect is not a new
 * terminal: the xterm on screen is the one the person was reading, it holds
 * their scrollback, and the catch-up buffer repaints it when the link comes
 * back. So `cached` — the frozen twin — keys the mount effects, and `live`
 * merely decides whether the pane takes input. Rebuilding on every blip cost a
 * detach, a re-attach and up to MAX_REPLAY_BYTES per pane, and it happened
 * whenever a socket so much as flinched.
 */
export function PaneView({
  leaf,
  focused,
  onlyPane,
  onScreen
}: {
  leaf: PaneLeaf
  focused: boolean
  onlyPane: boolean
  /** Whether this pane's tab is the one on screen. See `SplitView`. */
  onScreen: boolean
}): ReactNode {
  const { state, actions } = useForge()
  const profile = resolveProfile(useProfiles(), leaf.profileId)
  /**
   * A phone. Two things change and nothing else: the type is set larger, because
   * 12px at arm's length on a 6-inch screen is not reading; and a pane that is
   * on screen *claims its grid* (see `claim` in shared/web.ts) — the desk's
   * 150 columns font-fitted into 390px is the alternative, and that is the
   * screenshot this exists because of. Typing at the desk takes it back.
   */
  const mobile = useMobile()
  const fontSize = mobile ? 14 : 12
  /** No desktop at all: decision 10's read-only twin, drawn from the cache. */
  const cached = state.stage.kind === 'offline'
  /** Is the socket answering this second? Only input and the badge read this. */
  const live = !cached && state.connection.state === 'live'
  const asking = state.asking.has(leaf.id)
  /** The desktop's own row for this pane, which is where its real grid is. */
  const session = (state.picture?.sessions ?? []).find((s) => s.id === leaf.id)
  const alive = session !== undefined

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
    if (!holder || cached) return

    let attached = false
    const host = mountTerm(holder, {
      fontSize,
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
    // Keyed on the session and on `cached`, and on nothing else on purpose.
    // `profile.accent` is a construction-time input read once when the emulator
    // is built: re-running this effect would tear down a live terminal and
    // re-attach it, which costs a full replay and a screen flash. The desktop's
    // own pane keeps its spec in a ref for exactly the same reason. `live` is
    // deliberately *not* here — a dropped socket keeps this terminal, and the
    // effect below is what makes it stop taking input instead. `fontSize` is a
    // construction-time input in the same way, and changes only with the layout.
  }, [leaf.id, cached, fontSize])

  /* ----------------------------------------------------- the frozen twin */

  useLayoutEffect(() => {
    const holder = holderRef.current
    if (!holder || !cached) return
    const host = mountTerm(holder, {
      fontSize,
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
  }, [leaf.id, cached, state.cached, fontSize])

  /* ------------------------------------------------- input follows the link */

  /**
   * A terminal that cannot reach its shell must not look like one that can.
   *
   * Declared after both mount effects so it runs after them in the same commit,
   * which is what lets a terminal built during a reconnect come up read-only
   * rather than blinking a caret for a frame first. Nothing is torn down here —
   * that is the whole point of it being a separate effect.
   */
  useLayoutEffect(() => {
    hostRef.current?.setReadOnly(!live)
    // `leaf.id` and `cached` are here because they are what builds a new host
    // above; without them a terminal rebuilt while the link was down would come
    // up taking keys for a socket that is not there.
  }, [live, cached, leaf.id])

  /* --------------------------------------------- and the desktop's own grid */

  /**
   * Draw what the pane actually is, at whatever type size that takes.
   *
   * The two numbers rather than the session object, because this has to run on
   * a change of *geometry* and the picture hands out a fresh array of sessions
   * for every push there is — a git status, a pane opening, somebody clicking a
   * project. `follow` is a no-op when the grid it is given is the one it is
   * already drawing, but an effect that ran on every push would still be an
   * effect that ran on every push.
   *
   * Declared after both mount effects so it runs after them in the same commit:
   * a terminal is built and fitted, and then — before anything is painted — put
   * to the desktop's grid, rather than showing this browser's fit for a frame.
   */
  const cols = session?.cols ?? 0
  const rows = session?.rows ?? 0
  useLayoutEffect(() => {
    hostRef.current?.follow(cols > 0 && rows > 0 ? { cols, rows } : null)
  }, [cols, rows, cached, leaf.id])

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
    if (!became || !live) return
    const host = hostRef.current
    if (host) actions.attach(leaf.id, host.size())
  }, [alive, live, leaf.id, actions])

  /**
   * On a phone, the pane on screen is the pane being used: take its grid.
   *
   * Re-sent on the edges that matter — this pane coming on screen, its shell
   * starting, the link coming back — and on nothing else, so a busy pane is not
   * claiming itself on every push. The desk's own next keystroke undoes it,
   * which is the rule working as designed rather than a fight: whoever is
   * actually at a pane has it.
   */
  useEffect(() => {
    if (mobile && onScreen && live && alive) actions.claim(leaf.id)
  }, [mobile, onScreen, live, alive, leaf.id, actions])

  /**
   * The desktop focuses the caret when the pane is the active one; so do we.
   *
   * `onScreen` is load-bearing rather than defensive: every tab of the active
   * project stays mounted, so without it each tab's own active pane would take
   * the caret as it mounted and the last one to do so — a tab nobody is looking
   * at — would win.
   */
  useEffect(() => {
    if (focused && live && onScreen) hostRef.current?.focus()
  }, [focused, live, onScreen])

  return (
    <section
      className="pane"
      data-pane-id={leaf.id}
      data-focused={focused}
      data-status={!live ? 'frozen' : alive ? 'live' : 'dead'}
      style={{ '--pane-accent': profile.accent } as CSSProperties}
      onPointerDownCapture={() => {
        if (!focused && live) void actions.layout({ op: 'focus-pane', paneId: leaf.id })
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
        {cached ? (
          <span className="pane__perm mono" data-frozen="true" title="The last transcript this browser was sent">
            FROZEN
          </span>
        ) : null}
        {/*
          Not the same chip and not the same news. FROZEN says there is no
          desktop; this says there is one and the link to it dropped, so what is
          on screen is where the pane had got to and the catch-up buffer will
          repaint it the moment the socket is back.
        */}
        {!cached && !live ? (
          <span
            className="pane__perm mono"
            data-reconnecting="true"
            title="The link dropped — this is where the pane had got to, and it repaints when it comes back"
          >
            RECONNECTING
          </span>
        ) : null}

        <div className="pane__actions">
          <button
            ref={splitRef}
            type="button"
            className="ghost-btn pane__action"
            title="Split right"
            disabled={!live}
            onClick={() => setChooser('row')}
          >
            <Icon name="splitRight" size={13} />
          </button>
          <button
            type="button"
            className="ghost-btn pane__action"
            title="Split down"
            disabled={!live}
            onClick={() => setChooser('column')}
          >
            <Icon name="splitDown" size={13} />
          </button>
          <button
            type="button"
            className="ghost-btn pane__action"
            data-danger="true"
            title={onlyPane ? 'Close tab' : 'Close pane'}
            disabled={!live}
            onClick={() => void actions.layout({ op: 'close-pane', paneId: leaf.id })}
          >
            <Icon name="close" size={13} />
          </button>
        </div>
      </header>

      {/*
        A tap takes the caret; a swipe does not.

        Pressing focuses on a mouse, exactly as it did — but a finger's
        `pointerdown` arrives at the *start* of every gesture, including the drag
        that scrolls the scrollback (`enableTouchScroll` in lib/term.ts), so
        keeping it for touch would pop Android's keyboard on every swipe and
        resize the pane out from under the gesture that asked for it. `click` is
        the event a touch drag does not produce — the drag calls preventDefault,
        and a moved finger raises no click either way — so it is the one that
        means "tapped". The phone client focuses from `click` for the same
        reason.
      */}
      <div
        className="pane__terminal"
        ref={holderRef}
        onPointerDown={(event) => {
          if (event.pointerType !== 'touch') hostRef.current?.focus()
        }}
        onClick={() => {
          hostRef.current?.focus()
          // A tap is the clearest statement of intent there is. Somebody at the
          // desk may have typed since this pane came on screen; the thumb that
          // taps it now wants it back.
          if (mobile && live && alive) actions.claim(leaf.id)
        }}
      />

      <AgentChooser
        anchor={splitRef.current}
        open={chooser !== null}
        align="end"
        title={chooser === 'column' ? 'Split down with' : 'Split right with'}
        onClose={() => setChooser(null)}
        onPick={(profileId, permissionMode) => {
          if (chooser)
            void actions.layout({ op: 'create-pane', paneId: leaf.id, direction: chooser, profileId, permissionMode })
        }}
      />
    </section>
  )
}
