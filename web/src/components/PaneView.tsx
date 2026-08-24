import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import type { PaneLeaf } from '@shared/types'
import type { ChatBlock, ChatTurn } from '@shared/chat'
import { isShellProfile, paneDisplayTitle, resolveProfile } from '@/lib/agents'
import { AgentBadge } from '@/components/AgentBadge'
import { transcriptFor } from '../lib/cache'
import { applyChatUpdate, EMPTY_CHAT, type ChatFeed } from '../lib/chat-turns'
import { EMPTY_TRANSCRIPT, mergeTranscript, transcriptFromLines, type FeedBlock } from '@/lib/feed'
import { imageFilesFromDataTransfer, packImage } from '../lib/image'
import { useMobile } from '../lib/mobile'
import { publishPaneStatus, publishPaneView, registerPaneViewSetter, type PaneFace } from '../lib/pane-status'
import type { Transcript } from '@/lib/rich'
import { mountTerm, type TermHost } from '../lib/term'
import { getClaudeView, setClaudeView } from '../lib/view-pref'
import { useForge, useProfiles } from '../state'
import { ChatView } from './ChatView'
import { Feed } from './Feed'

/**
 * How long a burst of output may hold the conversation view still.
 *
 * Roughly twelve reads a second: fast enough that an agent's sentence appears
 * as it is written, slow enough that a phone is not re-cutting the screen for
 * every 20-byte chunk of it. The trailing timer means the *last* chunk of a
 * burst is always read, so a pane never settles showing one line less than it
 * has.
 */
const PARSE_INTERVAL_MS = 80

/** HH:MM off a Foreman log entry's epoch, the way the decision log shows it. */
function clockOf(at: number): string {
  const date = new Date(at)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/** Convert screen feed blocks into conversational chat turns when no disk transcript exists. */
function feedBlocksToChatTurns(blocks: FeedBlock[]): ChatTurn[] {
  const turns: ChatTurn[] = []
  for (const block of blocks) {
    const text = (block.text || block.lines.map((l) => l.text || l.runs.map((r) => r.text).join('')).join('\n')).trim()
    if (!text) continue

    if (block.role === 'user') {
      turns.push({
        id: block.id,
        role: 'user',
        at: 0,
        blocks: [{ kind: 'text', text }]
      })
    } else if (block.role === 'tool') {
      const firstLine = block.lines[0]?.text || text.split('\n')[0] || 'tool'
      const toolBlock: ChatBlock = {
        kind: 'tool',
        name: firstLine.slice(0, 30),
        gist: text.slice(0, 120)
      }
      const lastTurn = turns[turns.length - 1]
      if (lastTurn && lastTurn.role === 'assistant') {
        lastTurn.blocks.push(toolBlock)
      } else {
        turns.push({
          id: block.id,
          role: 'assistant',
          at: 0,
          blocks: [toolBlock]
        })
      }
    } else {
      // agent or system prose
      const textBlock: ChatBlock = { kind: 'text', text }
      const lastTurn = turns[turns.length - 1]
      if (lastTurn && lastTurn.role === 'assistant') {
        lastTurn.blocks.push(textBlock)
      } else {
        turns.push({
          id: block.id,
          role: 'assistant',
          at: 0,
          blocks: [textBlock]
        })
      }
    }
  }
  return turns
}

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
 * ## This pane is the terminal display
 *
 * The PTY is still the truth and xterm still paints it — decision 6 stands.
 * Typing does not happen here. The app's one composer lives on the workspace
 * and writes to whichever pane is focused. The header's note icon flips to a
 * cards view if you want it; the default is the coloured terminal.
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
  const prompt = state.prompts[leaf.id] ?? ''
  const agent = !isShellProfile(profile)
  /** The desktop's own row for this pane, which is where its real grid is. */
  const session = (state.picture?.sessions ?? []).find((s) => s.id === leaf.id)
  const alive = session !== undefined

  /* ------------------------------------------------------------ foreman
   *
   * The status line and the decision log — the browser's half of what the
   * desktop's footer does. The switch and its seed box are not here: they sit
   * in the top bar and act on whichever pane is active (see TopBar), because a
   * pane header on a phone floats over the terminal a few characters wide and
   * one control in one place beats the same control in two. What stays is what
   * genuinely belongs to *this* pane — what Foreman is doing in it, and why.
   *
   * The state is never local: every draw of it comes off the `foreman` push,
   * so a switch flipped at the desk (or on the phone) shows its true shape
   * here without anybody saying so.
   */
  const foreman = state.picture?.foreman[leaf.id]
  const [logOpen, setLogOpen] = useState(false)

  /**
   * Whether this pane has a live shell, readable from inside the mount effect
   * without making it a dependency — re-running that effect would tear a live
   * terminal down and cost a full replay.
   */
  const aliveRef = useRef(alive)
  aliveRef.current = alive

  /**
   * The actions, readable from an effect without being one of its dependencies.
   *
   * Same reason as `aliveRef` above, one step further out: an effect that fires
   * on an *edge* — this pane coming on screen, its shell starting — must be
   * keyed on the things that describe that edge and on nothing else, or the
   * edge is not really what it runs on. `actions` is a `useMemo` in state.tsx,
   * and whether it survives a given push is a fact about that file's dependency
   * list rather than about this one's intent; a claim re-sent because the store
   * happened to rebuild is a grid decision nobody made.
   */
  const actionsRef = useRef(actions)
  actionsRef.current = actions

  const holderRef = useRef<HTMLDivElement | null>(null)
  const hostRef = useRef<TermHost | null>(null)

  const sendingImage = useRef(false)
  const [truncated, setTruncated] = useState(false)
  /**
   * Whether a `replay` has ever answered this pane's attach. An *empty* replay
   * is a real answer — a freshly-spawned shell, a buffer blanked by a width
   * change — and a pane that has one must not go on saying "Waiting for the
   * desktop…", which reads as a fault when the desktop has in fact spoken.
   */
  const [painted, setPainted] = useState(false)
  const [transcript, setTranscript] = useState<Transcript>(EMPTY_TRANSCRIPT)
  /**
   * Grok/OpenCode (and any other alt-screen TUI) have no xterm scrollback, so
   * the feed's cards are one frame. The feed pages the TUI itself when this
   * is true; Claude Code writes the normal buffer and stays on native scroll.
   */
  const [tui, setTui] = useState(false)
  /**
   * A Claude pane has a third face, and it is the one it opens on.
   *
  /**
   * An agent pane (Claude, Antigravity, Grok, GPT, etc.) has three faces:
   * 1. Chat view: Conversational reading surface (JSONL transcript or structured feed turns)
   * 2. Cards / Output view: Visual cards parsed from the terminal stream
   * 3. Terminal view: The raw interactive xterm
   *
   * View preference is preserved across agent panes.
   */
  const [view, setView] = useState<PaneFace>(() => (agent ? getClaudeView() : 'term'))
  const feed = view === 'feed'
  const chat = view === 'chat'
  /** Either conversation view: the terminal is behind it and must not be touched. */
  const overlaid = feed || chat

  const showView = useCallback(
    (next: PaneFace) => {
      setView(next)
      if (agent) setClaudeView(next)
    },
    [agent]
  )

  useEffect(() => {
    return registerPaneViewSetter(leaf.id, (next) => {
      showView(next)
    })
  }, [leaf.id, showView])

  /* ------------------------------------------------------- reading the screen */

  /**
   * The conversation is re-read on a schedule, not on every chunk.
   *
   * A streaming agent arrives as dozens of small PTY writes a second, and the
   * previous shape of this — parse the whole screen inside every `write`
   * callback — re-cut hundreds of lines into cards for each of them, then threw
   * all but the last result away. On a phone that is the difference between a
   * feed that scrolls and one that hitches while the agent is typing.
   *
   * So a write only *arms* a parse. The armed frame reads whatever the terminal
   * has by the time it runs, which is every chunk that landed in the meantime,
   * and nothing is lost: the arming is level-triggered, so the last chunk of a
   * burst is always followed by a parse that sees it.
   */
  const parseFrame = useRef(0)
  const parseTimer = useRef(0)
  const parsedAt = useRef(0)

  const parseNow = useCallback(() => {
    parseFrame.current = 0
    parsedAt.current = performance.now()
    const host = hostRef.current
    if (!host) {
      setTranscript(EMPTY_TRANSCRIPT)
      setTui(false)
      return
    }
    setTranscript((prev) => mergeTranscript(prev, transcriptFromLines(host.captureRich())))
    setTui(host.term.buffer.active.type === 'alternate')
  }, [])

  const onTuiScroll = useCallback((deltaY: number, deltaMode?: number) => {
    return hostRef.current?.driveScroll(deltaY, deltaMode) ?? false
  }, [])

  /**
   * Whether this pane is the one being looked at, readable from inside a
   * callback that must not be re-made.
   *
   * `scheduleParse` below is handed to `host.write` from the `onData` handler
   * the mount effect registers, and that effect deliberately runs once per
   * terminal — so the callback it captured is the one it keeps for the life of
   * the pane. Anything it needs to know about a *later* render has to arrive
   * through a ref; a dependency would leave a live terminal arming last
   * render's copy.
   */
  const onScreenRef = useRef(onScreen)

  /**
   * Bytes arrived while nobody was looking. See `scheduleParse`.
   */
  const parseWanted = useRef(false)

  /**
   * Arm a parse: next animation frame, or as soon after PARSE_INTERVAL_MS as
   * there is one. A frame or timer already in flight *is* the dirty flag — it
   * will read the newest screen when it fires, so a second arm would only be a
   * second read of the same thing.
   *
   * A pane nobody is looking at arms nothing at all. Its bytes still went into
   * xterm — the emulator has to stay current or the pane is wrong the moment it
   * is chosen — but that write is comparatively cheap, and cutting the whole
   * screen into cards for a feed no eye is on is not. It matters most exactly
   * where it is least affordable: `MobilePanes` draws one leaf of a tab and
   * hides the rest rather than unmounting them, so a four-way split made at the
   * desk had four parsers running on a phone showing one pane, and every tab
   * this project has ever opened stays mounted behind the active one.
   *
   * The flag is the same level-triggered arming as the timer, one step slower:
   * a frame in flight says "the screen moved and will be read", and this says
   * "the screen moved and will be read when it can be seen". Any number of
   * writes set it and one parse discharges it, so coming back costs a single
   * merge rather than a queue of them.
   */
  const scheduleParse = useCallback(() => {
    if (!onScreenRef.current) {
      parseWanted.current = true
      return
    }
    if (parseFrame.current || parseTimer.current) return
    const wait = PARSE_INTERVAL_MS - (performance.now() - parsedAt.current)
    if (wait <= 0) {
      parseFrame.current = requestAnimationFrame(parseNow)
      return
    }
    parseTimer.current = window.setTimeout(() => {
      parseTimer.current = 0
      parseFrame.current = requestAnimationFrame(parseNow)
    }, wait)
  }, [parseNow])

  /**
   * Coming back on screen: read the screen once, before it is painted.
   *
   * A layout effect rather than an ordinary one because the pane is about to be
   * shown in this very commit — an effect that ran after the paint would put
   * the cards as they were when the pane was hidden on screen for a frame, and
   * a chip tap that flashes a stale answer is the sort of thing that reads as
   * the wrong pane rather than as an old one. `parseNow` and not
   * `scheduleParse`: the interval exists to throttle a *burst*, and this is one
   * read of a screen that has already finished moving.
   */
  useLayoutEffect(() => {
    onScreenRef.current = onScreen
    if (!onScreen || !parseWanted.current) return
    parseWanted.current = false
    parseNow()
  }, [onScreen, parseNow])

  useEffect(
    () => () => {
      if (parseFrame.current) cancelAnimationFrame(parseFrame.current)
      if (parseTimer.current) clearTimeout(parseTimer.current)
    },
    []
  )

  /**
   * The agent's own footer, read off this pane's screen, handed to whoever is
   * drawing the status strip.
   *
   * That strip sits over the app's one composer (`SessionComposer`), which is
   * not in this pane's tree and is several splits away from it — so the route
   * is the small store in lib/pane-status.ts rather than a prop. Cleared on
   * unmount so a closed pane's model and mode do not outlive it.
   */
  useEffect(() => {
    publishPaneStatus(leaf.id, transcript.status)
  }, [leaf.id, transcript.status])
  useEffect(() => {
    publishPaneView(leaf.id, view)
  }, [leaf.id, view])
  useEffect(
    () => () => {
      publishPaneStatus(leaf.id, undefined)
      publishPaneView(leaf.id, undefined)
    },
    [leaf.id]
  )

  /* ---------------------------------------------------- the conversation */

  /**
   * The turns, and whether the desktop began mid-file.
   *
   * Accumulated here rather than in the store because they are this pane's:
   * `applyChatUpdate` is the whole rule (a reset replaces, an append upserts by
   * id) and lib/chat-turns.ts is where it is written down. The ref is what the
   * subscription reads — it is registered once and must not be re-made on every
   * turn — and the state is what renders.
   */
  const chatRef = useRef<ChatFeed>(EMPTY_CHAT)
  const [chatFeed, setChatFeed] = useState<ChatFeed>(EMPTY_CHAT)
  /**
   * The desktop's sentence when there is nothing to read: a pane that has not
   * spoken yet has written no file to tail. Not a failure — it is the first
   * thing a fresh Claude pane says — so it is a note in the view with the
   * terminal one tap away, not a notice over the whole page.
   */
  const [chatRefusal, setChatRefusal] = useState('')
  /**
   * Whether this pane has ever been asked to show its conversation.
   *
   * The watch starts the first time somebody opens the chat and then stays for
   * as long as this component is mounted, including while they read the
   * terminal instead: a tail on the desktop is cheap, the turns are already in
   * hand, and flipping back is then instant rather than a round trip. What it
   * must not do is start on its own — a browser full of panes nobody has asked
   * a question of should cost the desktop nothing at all.
   */
  const [chatArmed, setChatArmed] = useState(chat)
  useEffect(() => {
    if (chat) setChatArmed(true)
  }, [chat])

  /**
   * Read this pane's conversation for as long as it is armed and there is a
   * desktop to read it.
   *
   * Keyed on `live` as well as the pane, so a socket that dropped and came back
   * re-asks: the client re-arms its own watches at `hello-ok`, and this is the
   * same question from the other end for the case where the *answer* changed
   * while the link was down — a pane that had said nothing when the view opened
   * has usually said something by the time the link is back. Asking twice is
   * not an error; the desktop answers the second `ok` and changes nothing.
   *
   * Through `actionsRef` rather than `actions` for the reason that ref exists:
   * the store rebuilding must not be able to stop and restart a tail.
   */
  useEffect(() => {
    if (!chatArmed || cached || !alive || !live) return
    let stopped = false
    const off = actionsRef.current.onTranscript(leaf.id, (update) => {
      chatRef.current = applyChatUpdate(chatRef.current, update)
      setChatFeed(chatRef.current)
    })
    void actionsRef.current.watchTranscript(leaf.id).then((refusal) => {
      if (!stopped) setChatRefusal(refusal ?? '')
    })
    return () => {
      stopped = true
      off()
      actionsRef.current.stopTranscript(leaf.id)
    }
  }, [chatArmed, cached, alive, live, leaf.id])

  /**
   * Ask again, because the answer changes.
   *
   * "It has not said anything yet" is the *first* thing a fresh Claude pane
   * says, and the file it is waiting on is written the moment somebody types
   * into the composer under this very pane — so a note with only a way out of
   * the view would be a dead end at exactly the moment it is most likely to be
   * read. One ask per tap and nothing on a timer: the client deliberately does
   * not retry a refusal by itself, and a person who has just sent a line is a
   * better trigger than any poll. The subscription is already registered by the
   * effect above whether or not the watch was granted, so a watch granted now
   * paints turns without anything else being re-armed.
   */
  const lookAgain = useCallback(() => {
    void actionsRef.current.watchTranscript(leaf.id).then((refusal) => setChatRefusal(refusal ?? ''))
  }, [leaf.id])

  /**
   * The conversational turns to show in ChatView:
   * Uses high-fidelity JSONL disk transcript if available (e.g. Claude),
   * otherwise converts dynamic screen feed blocks into structured turns (e.g. Antigravity, Grok, GPT).
   */
  const effectiveTurns = useMemo(() => {
    if (chatFeed.turns.length > 0) return chatFeed.turns
    return feedBlocksToChatTurns(transcript.blocks)
  }, [chatFeed.turns, transcript.blocks])

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
        // sends it again, and appending it would double the transcript. One
        // call rather than a reset followed by a write, because the wipe has to
        // be *ordered* against the live bytes still sitting unparsed in xterm's
        // write queue — see `repaint` in lib/term.ts for what the naive pair
        // actually paints.
        setTruncated(wasTruncated)
        setPainted(true)
        // Emptying the transcript here is a frame early: the terminal has not
        // been repainted yet, so for a moment the feed is showing nothing while
        // the buffer still holds the old screen. It self-corrects, because the
        // `scheduleParse` handed to `repaint` fires *after* the paint and
        // re-reads the buffer — so the next parse is of the replayed screen,
        // which is the whole of what should be there.
        setTranscript(EMPTY_TRANSCRIPT)
        host.repaint(data, scheduleParse)
        return
      }
      host.write(data, scheduleParse)
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
    const cachedBytes = transcriptFor(state.cached, leaf.id)
    if (cachedBytes) host.write(cachedBytes, scheduleParse)
    else host.write('\r\n\x1b[2m  Nothing of this pane was cached before the desktop went away.\x1b[0m\r\n', scheduleParse)
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
   *
   * The latch is consumed only by the attach itself. An earlier version wrote
   * `wasAlive.current = alive` before its guards, and one of those guards was
   * `!live` — so a session that started while the link was mid-redial burned
   * the edge without attaching, and the pane sat on "Waiting for the desktop…"
   * for the life of the component: not in `subs`, so no reconnect re-attached
   * it, and no error ever said so. There is no `live` guard now for the same
   * reason the mount-path attach has none: `client.attach` records the
   * subscription whether or not a frame can leave, and `hello-ok` re-sends
   * from `subs` — a dead link is the reconnect's problem, not this effect's.
   */
  const wasAlive = useRef(alive)
  useEffect(() => {
    if (!alive) {
      wasAlive.current = false
      return
    }
    if (wasAlive.current) return
    const host = hostRef.current
    if (!host) return
    wasAlive.current = true
    actions.attach(leaf.id, host.size())
  }, [alive, live, leaf.id, actions])

  /**
   * On a phone, the pane on screen is the pane being used: take its grid.
   *
   * Re-sent on the edges that matter — this pane coming on screen, its shell
   * starting, the link coming back — and on nothing else, so a busy pane is not
   * claiming itself on every push. The desk's own next keystroke undoes it,
   * which is the rule working as designed rather than a fight: whoever is
   * actually at a pane has it.
   *
   * Through `actionsRef` rather than `actions` precisely so that "and on
   * nothing else" is true of the code and not only of the sentence above.
   * `GridOwners.claim` is idempotent, so a spurious repeat is wasted traffic
   * today — but the moment a second viewer is watching the same pane, two
   * clients re-claiming on every push is the grid changing hands over and over
   * while nobody is typing at all.
   */
  useEffect(() => {
    if (mobile && onScreen && live && alive) actionsRef.current.claim(leaf.id)
  }, [mobile, onScreen, live, alive, leaf.id])

  /* ----------------------------------------------- pasted / dropped images */

  /**
   * An image in this browser becomes a file on the desktop and a quoted path
   * in the pane — the same gesture as dropping a screenshot on an agent at
   * the desk. xterm only pastes text, which is why Claude Code was answering
   * that it could not take an image: the picture never left this tab.
   */
  const sendImages = useCallback(
    async (files: File[]) => {
      if (!files.length || !live || !alive || sendingImage.current) return
      sendingImage.current = true
      try {
        for (const file of files) {
          try {
            const packed = await packImage(file)
            const result = await actions.request({
              kind: 'paste-image',
              sessionId: leaf.id,
              mime: packed.mime,
              data: packed.data
            })
            if (result.kind === 'failed') actions.setNotice(result.message)
          } catch (err) {
            actions.setNotice(err instanceof Error ? err.message : 'That image could not be sent.')
          }
        }
      } finally {
        sendingImage.current = false
      }
    },
    [actions, alive, leaf.id, live]
  )

  /* ---------------------------------------------------- pasting from outside */

  /**
   * Hand whatever is on the clipboard to the pane, text or image.
   *
   * A desktop browser already pastes with Ctrl+V, because xterm listens on its
   * own textarea. A phone has no such route: the textarea is a 1px box with
   * no long-press menu, so text written in some other app — the whole point of
   * brainstorming somewhere else and bringing it here — had no way in. This
   * goes through xterm's `paste` rather than `write` on the socket so that
   * bracketed-paste mode and the newline translation are xterm's, the same as
   * a Ctrl+V would get.
   *
   * `navigator.clipboard.read` needs a secure context and, on Chrome, a one-off
   * permission; Firefox and some WebViews refuse it outright. Refusal opens a
   * box to paste into by hand instead of a dead button.
   */
  useEffect(() => {
    const holder = holderRef.current
    if (!holder || cached || !live) return

    const onPaste = (event: ClipboardEvent): void => {
      const files = imageFilesFromDataTransfer(event.clipboardData)
      if (!files.length) return
      event.preventDefault()
      event.stopPropagation()
      void sendImages(files)
    }
    const onDragOver = (event: DragEvent): void => {
      const types = event.dataTransfer ? [...event.dataTransfer.types] : []
      if (!types.includes('Files')) return
      event.preventDefault()
      event.dataTransfer!.dropEffect = 'copy'
    }
    const onDrop = (event: DragEvent): void => {
      const files = imageFilesFromDataTransfer(event.dataTransfer)
      if (!files.length) return
      event.preventDefault()
      event.stopPropagation()
      void sendImages(files)
    }

    holder.addEventListener('paste', onPaste, true)
    holder.addEventListener('dragover', onDragOver)
    holder.addEventListener('drop', onDrop)
    return () => {
      holder.removeEventListener('paste', onPaste, true)
      holder.removeEventListener('dragover', onDragOver)
      holder.removeEventListener('drop', onDrop)
    }
  }, [cached, live, sendImages])

  return (
    <section
      className="pane"
      data-pane-id={leaf.id}
      data-focused={focused}
      data-kind={isShellProfile(profile) ? 'shell' : 'agent'}
      data-view={view}
      data-only={onlyPane ? 'true' : undefined}
      data-status={!live ? 'frozen' : alive ? 'live' : 'dead'}
      style={{ '--pane-accent': profile.accent } as CSSProperties}
      onPointerDownCapture={() => {
        if (!focused && live) void actions.layout({ op: 'focus-pane', paneId: leaf.id })
      }}
    >
      <header className="pane__header">
        <div className="pane__leading">
          <AgentBadge profile={profile} size="sm" />
          <span className="pane__title truncate">{paneDisplayTitle(profile, leaf.title)}</span>
        </div>

        {/*
          Chips travel as one trailing cluster. On a phone the
          title hides in cards view.
        */}
        <div className="pane__trailing">
          {asking ? (
            <span className="pane__perm mono" title="This pane has settled on a question and is waiting on an answer">
              WAITING
            </span>
          ) : null}
          {/*
            On a phone the trim is marked where it happened — a seam at the top
            of the feed (`cut` on <Feed/>) — instead of spending thumb-width
            chrome on an internal flag. The chip stays on the wide layout.
          */}
          {truncated && !mobile ? (
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
      <div className="pane__stage">
        {feed ? (
          <Feed
            blocks={transcript.blocks}
            status={transcript.status}
            asking={asking}
            prompt={prompt}
            empty={cached ? 'Nothing of this pane was cached.' : painted ? 'This pane is empty.' : 'Waiting for the desktop…'}
            cut={truncated && mobile}
            pageTui={tui && live}
            onTuiScroll={onTuiScroll}
          />
        ) : null}
        {/*
          Mounted from the first time the chat is opened and kept — hidden
          rather than unmounted, like the terminal beneath it, so flipping back
          is instant and the reader's scroll position survives the trip.
        */}
        {chatArmed ? (
          <div className="pane__chat" aria-hidden={!chat || undefined} data-shown={chat ? 'true' : 'false'}>
            <ChatView turns={effectiveTurns} truncated={chatFeed.truncated} busy={live && transcript.status.busy} />
            {chatRefusal && effectiveTurns.length === 0 ? (
              <div className="pane__chat-note" role="note">
                <p>{chatRefusal}</p>
                <div className="pane__chat-note-actions">
                  <button type="button" className="ghost-btn" onClick={lookAgain} disabled={!live}>
                    Look again
                  </button>
                  <button type="button" className="ghost-btn" onClick={() => showView('term')}>
                    Show the terminal
                  </button>
                </div>
              </div>
            ) : null}
          </div>
        ) : null}
        <div
          className="pane__terminal"
          ref={holderRef}
          aria-hidden={overlaid || undefined}
          onPointerDown={(event) => {
            if (overlaid) return
            if (event.pointerType !== 'touch') hostRef.current?.focus()
          }}
          onClick={() => {
            if (overlaid) return
            hostRef.current?.focus()
            // A tap is the clearest statement of intent there is. Somebody at the
            // desk may have typed since this pane came on screen; the thumb that
            // taps it now wants it back.
            if (mobile && live && alive) actions.claim(leaf.id)
          }}
        />
      </div>

      {/*
        Foreman's status line, while there is a job to describe. One line, in
        words a person reads at a glance — the same sentence the desktop's
        footer shows. Tapping it opens the decision log, because "why did it
        answer that?" is the question the footer always leaves behind.
      */}
      {foreman && foreman.status !== 'off' ? (
        <footer
          className="pane__foreman-line"
          data-status={foreman.status}
          role="button"
          tabIndex={0}
          title="Foreman's decisions — tap to read the log"
          onClick={() => setLogOpen((open) => !open)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault()
              setLogOpen((open) => !open)
            }
          }}
        >
          <span className="pane__foreman-tag mono">{foreman.status.toUpperCase()}</span>
          <span className="pane__foreman-text truncate">{foreman.line || 'Working'}</span>
        </footer>
      ) : null}

      {/*
        The decision log: the only record of *why* a driven pane got the answer
        it got, since the reasoning itself happens in a session nobody watches.
        Newest at the bottom, scrolled there; the pane's terminal keeps running
        untouched underneath.
      */}
      {logOpen && foreman ? (
        <div className="pane__foreman-log" role="dialog" aria-label="Foreman's decision log">
          <div className="pane__foreman-log-head">
            <span className="pane__foreman-log-title">Foreman</span>
            <button type="button" className="pane__foreman-log-close" aria-label="Close" onClick={() => setLogOpen(false)}>
              ✕
            </button>
          </div>
          <div className="pane__foreman-log-list">
            {foreman.log.length === 0 ? <p className="pane__foreman-log-empty">Nothing decided yet.</p> : null}
            {foreman.log.map((entry, i) => (
              <div className="pane__foreman-log-entry" data-kind={entry.kind} key={`${entry.at}-${i}`}>
                <span className="pane__foreman-log-kind mono">{entry.kind}</span>
                <span className="pane__foreman-log-at mono">{clockOf(entry.at)}</span>
                <span className="pane__foreman-log-text">{entry.text}</span>
              </div>
            ))}
          </div>
        </div>
      ) : null}
    </section>
  )
}
