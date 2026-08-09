import { useCallback, useEffect, useReducer, useRef, useState } from 'react'
import { Terminal } from '@xterm/xterm'
import type { ClaudePermissionMode, PaneLeaf, TerminalTab, Workspace } from '@shared/types'
import type { MobileSession } from '@shared/mobile'
import type { Link, LinkPicture, LinkState } from '../lib/link'
import { mirrorListeners, startMirrorViewer } from '../lib/mirror'
import { leavesOf } from './Browser'
import { paneListeners } from './PaneView'
import { TvMenu } from './TvMenu'
import '../tv.css'

/**
 * The TV.
 *
 * Forge on a Fire Stick is a monitor with a remote, not a phone: Steve is on
 * the sofa, and this screen's first job is to show the work landing — which
 * projects exist, which panes are alive, and which are producing output
 * *right now*. Readable from three metres in two seconds. The remote adds one
 * verb on top: the D-pad walks a volt ring across the live panes, OK opens
 * one full-screen to *watch*, Back returns to the wall.
 *
 * Watching is the resting state, not the whole story any more. Two doors out
 * of it, both deliberate: a zoomed pane enters *typing mode* on OK — a real
 * input summons the Fire keyboard and the line goes down the Link's existing
 * write path (TvPaneView) — and the burger in the header opens the management
 * menu (TvMenu): new tab, new terminal, close terminal, close tab, all as the
 * same `op` frames the phone sends. Nothing reaches a shell or the layout
 * without an explicit press to get there, and destruction pays a confirm.
 *
 * The remote reaches this WebView as ordinary keyboard events — arrows,
 * Enter, and Back as Escape (the APK packaging job wires the native back
 * button to the same meaning) — so navigation is a window keydown listener
 * and a roving focus id, not a focus library.
 *
 * The wall holds one destination that is not a pane: the desktop's own screen,
 * opened as WebRTC video (TvMirrorView, lib/mirror.ts). Same ring, same OK,
 * same Back — and the same bargain, because that peer is receive-only and no
 * press of the remote has anywhere to go even if it wanted one.
 *
 * Activity is *felt* through a two-line tail of each live pane's output —
 * ANSI stripped, box-drawing shaved, wordless lines dropped — because eight
 * full terminals on one screen is noise, and a bare "working" dot is not
 * enough to feel what the work is.
 *
 * The honesty rule: a wall that freezes must say so. The clock ticks as proof
 * of life, and the moment the link drops the wall dims behind a banner naming
 * the time the picture stopped being live. From the sofa nobody can debug, so
 * a stale dashboard pretending to be live is worse than no dashboard at all.
 */

/** Output younger than this counts as "working". */
const WORKING_MS = 5_000
/** Raw bytes kept per session — a few redrawn TUI frames, no more. */
const TAIL_RAW = 4_096
/** Tail lines shown per live pane. Fixed, so rows never change height. */
const TAIL_LINES = 2
/** Session rows per card before "+ n more panes". */
const MAX_ROWS = 5
/** Air kept between the focus ring and the edge of the wall, as a share of
 *  the wall's height — a fraction rather than pixels, because the wall is
 *  sized in screen-heights too (see tv.css). */
const FOCUS_MARGIN = 0.06
/** How often tails and working-flags are re-read. */
const TICK_MS = 500

/** One session's rolling output, owned by a ref — never state per chunk. */
interface Feed {
  raw: string
  lastDataAt: number
  lines: string[]
  dirty: boolean
}

/** The zoomed pane's inlet: the same (data, replay) shape the Link speaks. */
type Tap = (data: string, replay: boolean) => void

/**
 * The control bytes the type row sends — KeyBar.tsx's encodings, spelled as
 * code rather than string escapes so they stay visible in a diff.
 */
const ESC = String.fromCharCode(27)
const CTRL_C = String.fromCharCode(3)

/**
 * What is open full screen.
 *
 * A union rather than a second piece of state beside it, because the remote
 * has exactly one Back and it must mean exactly one thing: whatever is on top
 * closes, and the wall comes back. Two independent "is something open" flags
 * is how a television ends up with a video playing behind a terminal.
 */
type Zoom =
  /** A pane, named well enough to caption it. */
  | { at: 'pane'; id: string; title: string; context: string }
  /** The desktop's own screen, as video. See TvMirrorView. */
  | { at: 'mirror' }

/**
 * The wall's one destination that is not a pane.
 *
 * A reserved id rather than a flag through `stepFocus` and `rowEls`: the walk
 * is a set of ids and rectangles, and the cheapest way to add a place the
 * remote can go is to give it an id. NUL leads it because a session id is a
 * hex string from the desktop — this cannot collide with one, ever.
 */
const MIRROR_ID = '\u0000mirror'

/**
 * The burger at the top of the wall — the walk's other reserved id, with the
 * same NUL guarantee as MIRROR_ID: walking up past the screen tile lands on
 * it, and OK opens the management menu (TvMenu).
 */
const MENU_ID = String.fromCharCode(0) + 'menu'

/**
 * How long a mirror attempt may sit at "connecting" before the screen says, in
 * words, that nobody answered. The desktop's half of the mirror only exists
 * after a Forge restart, and until then `mirror-start` gets no reply at all —
 * a spinner with no deadline would spin over that forever.
 *
 * Generous, because the thing it must not cut short is a *working* desktop:
 * `desktopCapturer` plus `getUserMedia` plus an offer is comfortably a second
 * and on a busy machine several, and the deadline is dropped the moment the
 * desktop says anything at all (see `heard` in TvMirrorView). What is left is
 * the honest case — a Forge that will never reply — and ten seconds of waiting
 * before saying so is cheaper than declaring a live desktop dead.
 */
const MIRROR_WAIT_MS = 10_000

/**
 * PTY bytes → words. CSI, OSC, the DCS family and lone escapes go first, then
 * every control character except `\n` and `\r`, which the line logic needs.
 * Applied to the whole kept tail on read rather than chunk-by-chunk, so an
 * escape split across two frames still dies — the buffer holds both halves.
 */
const ANSI =
  /\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)?|\u001b[PX^_][\s\S]*?(?:\u001b\\|$)|\u001b[ -/]+[0-~]|\u001b[@-Z\\-_]|[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g

/** What the tail shows for one session: the last lines that carry words. */
function linesOf(raw: string): string[] {
  const lines: string[] = []
  for (const line of raw.replace(ANSI, '').split('\n')) {
    // A TUI redrawing over itself sends the same line many times behind \r;
    // only the last paint is on screen, so only the last paint is shown. The
    // trailing \r of an ordinary CRLF ending is shaved first — it is a line
    // ending, not a repaint, and slicing after it would erase the whole line.
    const body = line.replace(/\r+$/, '')
    const paint = body
      .slice(body.lastIndexOf('\r') + 1)
      .replace(/^[\s│┃╭╰├└┌]+|[\s│┃╮╯┤┘┐]+$/g, '')
    // Borders, rules and spinner frames carry no words. A line earns its
    // place on the TV by containing at least one letter or digit.
    if (/[\p{L}\p{N}]/u.test(paint)) lines.push(paint)
  }
  return lines.slice(-TAIL_LINES)
}

function clockOf(at: number): string {
  const d = new Date(at)
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

/** A card's rows: every leaf with its tab, live panes first. When a busy
 *  project overflows its card, what gets cut must be the dead weight. */
function cardRows(workspace: Workspace, live: Set<string>): Row[] {
  const rows = workspace.tabs.flatMap((tab) => leavesOf(tab.root).map((leaf) => ({ leaf, tab })))
  return [...rows.filter((r) => live.has(r.leaf.id)), ...rows.filter((r) => !live.has(r.leaf.id))]
}

export interface TvDashboardProps {
  link: Link
  picture: LinkPicture
  state: LinkState
  detail: string
  /**
   * The app-level notice line — the desktop's own sentence when an op is
   * refused ("That project already holds its 6 tabs."). The wall shows it as
   * a toast, because a remote press that did nothing must say why.
   */
  notice: string
}

export function TvDashboard({ link, picture, state, detail, notice }: TvDashboardProps): React.JSX.Element {
  const feeds = useRef(new Map<string, Feed>())
  const lastLiveAt = useRef(Date.now())
  const signature = useRef('')
  const [, repaint] = useReducer((n: number) => n + 1, 0)

  const [zoom, setZoom] = useState<Zoom | null>(null)
  const [focusId, setFocusId] = useState<string | null>(null)
  /** The management menu (TvMenu) is up; the wall's remote listener stands down. */
  const [menuOpen, setMenuOpen] = useState(false)
  /**
   * The wall's own one-line answer to a management action — optimistic and
   * honestly worded ("Asked the desktop for…"), because ops are requests and
   * the desktop's refusals arrive separately as `notice`.
   */
  const [toast, setToast] = useState('')
  /**
   * A mirror attempt got no answer. Remembered so the screen tile itself can
   * say so instead of re-offering a watch that is known to hang — reset when a
   * later attempt actually delivers frames.
   */
  const [mirrorSilent, setMirrorSilent] = useState(false)
  /** The zoomed terminal's listener, fed alongside the tail — never instead. */
  const tap = useRef<{ id: string; fn: Tap } | null>(null)
  /** Focusable row elements, for the geometric D-pad walk. */
  const rowEls = useRef(new Map<string, HTMLElement>())
  /** Focusable ids in visual order, rebuilt every render. */
  const order = useRef<string[]>([])
  /** Has the remote been used yet? Until it has, the ring belongs at the top. */
  const walked = useRef(false)
  // Mirrors for the window keydown listener, which is bound once.
  const zoomRef = useRef(zoom)
  zoomRef.current = zoom
  const focusRef = useRef(focusId)
  focusRef.current = focusId
  const menuRef = useRef(menuOpen)
  menuRef.current = menuOpen

  // Follow the live session set: subscribe to arrivals, drop leavers. The
  // Link re-arms every subscription itself after a reconnect, so this effect
  // tracks membership only, not connection weather. paneListeners is safe to
  // borrow wholesale — on a TV no PaneView ever mounts to contend for it.
  useEffect(() => {
    const wanted = new Set(picture.sessions.map((s) => s.id))
    for (const id of wanted) {
      if (feeds.current.has(id)) continue
      const feed: Feed = { raw: '', lastDataAt: 0, lines: [], dirty: false }
      feeds.current.set(id, feed)
      paneListeners.set(id, (data, replay) => {
        // A replay is catch-up, not activity: it repaints the tail without
        // lighting the pane up as freshly working.
        feed.raw = (replay ? data : feed.raw + data).slice(-TAIL_RAW)
        if (!replay) feed.lastDataAt = Date.now()
        feed.dirty = true
        const t = tap.current
        if (t && t.id === id) t.fn(data, replay)
      })
      link.subscribe(id)
    }
    for (const id of [...feeds.current.keys()]) {
      if (wanted.has(id)) continue
      feeds.current.delete(id)
      paneListeners.delete(id)
      link.unsubscribe(id)
    }
  }, [link, picture])

  // Unmount: leave nothing listening. (In practice the TV never unmounts, but
  // a component that only works because it is immortal is a trap.)
  useEffect(() => {
    const held = feeds.current
    return () => {
      for (const id of held.keys()) {
        paneListeners.delete(id)
        link.unsubscribe(id)
      }
      held.clear()
    }
  }, [link])

  // The wall's heartbeat: twice a second, re-read every tail and working
  // flag, and repaint only when something actually changed. Sessions stream
  // tens of frames a second, and a Fire Stick does not want a render for
  // each one — the feeds absorb the firehose, this tick samples it.
  useEffect(() => {
    const tick = (): void => {
      const now = Date.now()
      if (state === 'live') lastLiveAt.current = now
      let sig: string = state
      for (const [id, feed] of feeds.current) {
        if (feed.dirty) {
          feed.lines = linesOf(feed.raw)
          feed.dirty = false
        }
        const working = feed.lastDataAt > 0 && now - feed.lastDataAt < WORKING_MS
        sig += `|${id}:${working ? 'w' : 'q'}:${feed.lines.join('¶')}`
      }
      if (sig !== signature.current) {
        signature.current = sig
        repaint()
      }
    }
    tick()
    const timer = window.setInterval(tick, TICK_MS)
    return () => clearInterval(timer)
  }, [state])

  /* ------------------------------------------------------------ the remote */

  /**
   * Open the zoomed terminal's inlet, then buy it a repaint: re-subscribing
   * makes the desktop resend its 192KB catch-up, so the pane opens on the
   * screen as it *is*, not on a blank box waiting for the next byte. The
   * wall's feed sees the same replay and merely refreshes its tail.
   */
  const attachTap = useCallback(
    (id: string, fn: Tap): void => {
      tap.current = { id, fn }
      link.unsubscribe(id)
      link.subscribe(id)
    },
    [link]
  )
  const detachTap = useCallback((): void => {
    tap.current = null
  }, [])

  // The toast clears itself, exactly like the phone's notice strip.
  useEffect(() => {
    if (!toast) return
    const timer = setTimeout(() => setToast(''), 4000)
    return () => clearTimeout(timer)
  }, [toast])

  // Stable on purpose: TvMirrorView arms its no-answer deadline in an effect
  // that depends on these, and this wall re-renders twice a second — a fresh
  // closure each paint would reset that clock forever and the honest timeout
  // would never come.
  const mirrorWentSilent = useCallback((): void => setMirrorSilent(true), [])
  const mirrorCameAlive = useCallback((): void => setMirrorSilent(false), [])

  const openZoom = (id: string): void => {
    // The burger is a destination like any other; it just opens a menu rather
    // than a window. Handled first because it is not a session either.
    if (id === MENU_ID) {
      setMenuOpen(true)
      return
    }
    // The screen mirror is a destination on the same wall, opened by the same
    // press of OK — it simply is not a pane, so it never reaches the session
    // lookup below. Starting the watch is TvMirrorView's job, not this one's:
    // the frames come back over the socket within milliseconds, and the peer
    // that must answer them does not exist until that component mounts.
    if (id === MIRROR_ID) {
      setZoom({ at: 'mirror' })
      return
    }
    for (const project of picture.projects) {
      const workspace = picture.workspaces[project.id]
      for (const tab of workspace?.tabs ?? []) {
        for (const leaf of leavesOf(tab.root)) {
          if (leaf.id !== id) continue
          const profile = picture.profiles.find((p) => p.id === leaf.profileId)
          setZoom({
            at: 'pane',
            id,
            title: leaf.title || profile?.name || 'Terminal',
            context: `${project.name} · ${tab.title || 'Tab'}`
          })
          return
        }
      }
    }
  }
  const openZoomRef = useRef(openZoom)
  openZoomRef.current = openZoom

  /**
   * One D-pad step, decided by geometry rather than by index arithmetic: from
   * the focused row's centre, the nearest row whose centre lies in the pressed
   * direction wins, with sideways drift taxed so Down means down-this-column
   * before it means down-and-two-cards-over. Works for any card arrangement
   * the grid settles on, which index maths would have to be told about.
   */
  const stepFocus = (from: string | null, key: string): string | null => {
    const ids = order.current
    if (ids.length === 0) return null
    const origin = from ? rowEls.current.get(from) : null
    if (!origin) return ids[0] ?? null
    const a = origin.getBoundingClientRect()
    const dx = key === 'ArrowLeft' ? -1 : key === 'ArrowRight' ? 1 : 0
    const dy = key === 'ArrowUp' ? -1 : key === 'ArrowDown' ? 1 : 0
    let best: string | null = null
    let bestScore = Infinity
    for (const id of ids) {
      if (id === from) continue
      const el = rowEls.current.get(id)
      if (!el) continue
      const b = el.getBoundingClientRect()
      const cx = b.x + b.width / 2 - (a.x + a.width / 2)
      const cy = b.y + b.height / 2 - (a.y + a.height / 2)
      const forward = dx * cx + dy * cy
      if (forward <= 0) continue
      const score = forward + (Math.abs(dx * cy) + Math.abs(dy * cx)) * 2
      if (score < bestScore) {
        bestScore = score
        best = id
      }
    }
    return best
  }
  const stepFocusRef = useRef(stepFocus)
  stepFocusRef.current = stepFocus

  // The remote, bound once. While a pane is zoomed its own listener owns the
  // keys; the wall ignores everything rather than moving a ring nobody sees.
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      // Whatever is on top owns the remote: a zoomed pane's own listener, or
      // the management menu's. The wall must not move a ring nobody can see.
      if (zoomRef.current || menuRef.current) return
      const { key } = event
      if (key === 'Enter') {
        if (focusRef.current) {
          event.preventDefault()
          walked.current = true
          openZoomRef.current(focusRef.current)
        }
        return
      }
      if (key !== 'ArrowUp' && key !== 'ArrowDown' && key !== 'ArrowLeft' && key !== 'ArrowRight') return
      event.preventDefault()
      // The remote has been used: the ring is now the viewer's, not the wall's.
      walked.current = true
      const next = stepFocusRef.current(focusRef.current, key)
      if (next) setFocusId(next)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // First focus goes to the top of the wall — reading order, where the eye
  // already is, and the one place a ring can be predicted from the sofa.
  // "Most recently heard from" is meaningless at launch: every live pane
  // replays its screen within the same second, so it would mean whichever
  // catch-up landed last, and the wall would open with the ring halfway down
  // it for no reason a viewer could see.
  //
  // It stays pinned to the top while the picture is still arriving — the
  // desktop's panes land over the first seconds, and a ring that settled on
  // the first pane to appear is a ring somewhere arbitrary once the rest turn
  // up. The first press of the remote ends that, permanently.
  //
  // Re-focus when the focused pane *dies* is the other case, and there the
  // old rule still holds: the most recently heard-from live pane is the one
  // being watched anyway.
  useEffect(() => {
    if (!walked.current) {
      const top = order.current[0] ?? null
      if (top !== focusId) setFocusId(top)
      return
    }
    if (focusId && order.current.includes(focusId)) return
    let best: string | null = null
    let bestAt = -1
    for (const id of order.current) {
      const at = feeds.current.get(id)?.lastDataAt ?? 0
      if (at > bestAt) {
        bestAt = at
        best = id
      }
    }
    setFocusId(best)
  }, [picture, focusId])

  // Real DOM focus follows the ring — free a11y, and exactly what a Fire TV
  // screen reader expects. preventScroll because the browser's idea of
  // scrolling-into-view is to centre the row in every scrollable ancestor;
  // the wall does its own, below, and only when it has to.
  //
  // The wall is routinely taller than the television — fourteen projects is
  // several screens of cards however they are columned — and it takes no
  // scrollbar (overflow: hidden) because there is no cursor here to drag one.
  // So the ring has to bring the screen with it: a row walked to below the
  // fold is a D-pad press that looks like nothing happened, which is exactly
  // how this read from the sofa. The wall still never scrolls on its own; it
  // scrolls as far as the ring needs, and not a pixel further.
  useEffect(() => {
    if (zoom || menuOpen || !focusId) return
    const el = rowEls.current.get(focusId)
    if (!el) return
    el.focus({ preventScroll: true })
    const wall = el.closest('.tv-wall')
    if (!wall) return
    const row = el.getBoundingClientRect()
    const view = wall.getBoundingClientRect()
    // Air above and below, so the ring never sits welded to an edge with its
    // neighbour sliced in half behind it.
    const air = view.height * FOCUS_MARGIN
    if (row.top < view.top + air) wall.scrollTop -= view.top + air - row.top
    else if (row.bottom > view.bottom - air) wall.scrollTop += row.bottom - (view.bottom - air)
  }, [focusId, zoom, menuOpen])

  // A pane that exits while zoomed folds back to the wall: a dead terminal on
  // a screen with no keyboard is a wall, not a window.
  useEffect(() => {
    if (zoom?.at === 'pane' && !picture.sessions.some((s) => s.id === zoom.id)) setZoom(null)
  }, [picture, zoom])

  /* -------------------------------------------------------------- painting */

  const now = Date.now()
  const live = new Set(picture.sessions.map((s) => s.id))
  const workingOf = (id: string): boolean => {
    const feed = feeds.current.get(id)
    return feed !== undefined && feed.lastDataAt > 0 && now - feed.lastDataAt < WORKING_MS
  }
  const stale = state !== 'live'

  // The walkable rows, in reading order, rebuilt with the picture they match.
  // Live sessions lead — the launch ring belongs on real work, not on the
  // screen tile or the burger, which draw above the cards but queue behind
  // them here: the array's head is only ever consulted for where the ring
  // *rests*; the walk itself is geometric and reaches both by going up.
  order.current = []
  const cards = picture.projects.map((project) => {
    const workspace = picture.workspaces[project.id] ?? { tabs: [], activeTabId: null }
    const rows = cardRows(workspace, live)
    for (const { leaf } of rows.slice(0, MAX_ROWS)) {
      if (live.has(leaf.id)) order.current.push(leaf.id)
    }
    return { project, workspace, rows }
  })
  // With no live session at all, the burger is the most useful place to rest —
  // it is how a first tab gets made — and the silent mirror tile is last.
  order.current.push(MENU_ID, MIRROR_ID)

  const zoomSession = zoom?.at === 'pane' ? picture.sessions.find((s) => s.id === zoom.id) : undefined

  const onRowEl = (id: string, el: HTMLElement | null): void => {
    if (el) rowEls.current.set(id, el)
    else rowEls.current.delete(id)
  }

  /* --------------------------------------------------- the management verbs
   *
   * Each one is the same shape: refuse honestly when the link is down (the
   * Link drops frames on a closed socket without a word, and a remote press
   * that silently did nothing is the worst state a TV can be in), send the
   * ops, then say — optimistically and truthfully — what was *asked*. The
   * desktop's own refusals arrive later as `notice` and take the same toast.
   *
   * Closing is select-tab first, always: the desktop's close-pane acts on the
   * tab it is showing, so the tab being closed into must be the one on screen.
   * Ops travel one socket in order, and the renderer dispatches them in order,
   * which is what makes the pair safe.
   */

  const linkDown = (): boolean => {
    if (state === 'live') return false
    setToast('The link to the desktop is down — nothing was sent.')
    return true
  }
  const nameOfProject = (id: string): string => picture.projects.find((p) => p.id === id)?.name ?? 'that project'
  const nameOfProfile = (id: string): string => picture.profiles.find((p) => p.id === id)?.name ?? 'a terminal'

  const menuNewTab = (projectId: string, profileId: string, mode?: ClaudePermissionMode): void => {
    if (linkDown()) return
    link.op({ op: 'create-tab', projectId, profileId, ...(mode ? { permissionMode: mode } : {}) })
    setToast(`Asked the desktop for a new ${nameOfProfile(profileId)} tab in ${nameOfProject(projectId)}.`)
  }

  const menuNewPane = (
    projectId: string,
    tabId: string,
    paneId: string,
    profileId: string,
    mode?: ClaudePermissionMode
  ): void => {
    if (linkDown()) return
    link.op({ op: 'select-tab', projectId, tabId })
    link.op({ op: 'create-pane', projectId, paneId, profileId, ...(mode ? { permissionMode: mode } : {}) })
    setToast(`Asked for a new ${nameOfProfile(profileId)} terminal in ${nameOfProject(projectId)}.`)
  }

  const menuClosePane = (projectId: string, tabId: string, paneId: string): void => {
    if (linkDown()) return
    link.op({ op: 'select-tab', projectId, tabId })
    link.op({ op: 'close-pane', projectId, paneId })
    setToast('Asked the desktop to close that terminal.')
  }

  const menuCloseTab = (projectId: string, tabId: string, paneIds: string[]): void => {
    if (linkDown()) return
    link.op({ op: 'select-tab', projectId, tabId })
    // No close-tab op exists on this wire; a tab whose last pane closes *is*
    // closed by the desktop (see closePane in src/state/AppState.tsx), so the
    // tab is closed by closing everything it holds, in order.
    for (const paneId of paneIds) link.op({ op: 'close-pane', projectId, paneId })
    setToast(`Asked the desktop to close that tab in ${nameOfProject(projectId)}.`)
  }

  return (
    <div className="tv">
      <header className="tv-head">
        <strong className="tv-mark">Forge</strong>
        <span className="tv-head-meta">
          v{picture.appVersion} · {picture.projects.length}{' '}
          {picture.projects.length === 1 ? 'project' : 'projects'} · {live.size} live
        </span>
        <span className="tv-head-spring" />
        {/* The burger. In the walk like any row — up past the screen tile
            lands here — and absent while something is zoomed, because a verb
            that cannot be reached must not be shown. */}
        {!zoom && (
          <button
            type="button"
            className={`tv-burger${focusId === MENU_ID ? ' is-focus' : ''}`}
            tabIndex={-1}
            ref={(el) => onRowEl(MENU_ID, el)}
            onClick={() => openZoom(MENU_ID)}
          >
            <span className="tv-burger-glyph" aria-hidden="true" />
            Manage
          </button>
        )}
        <LinkBadge state={state} />
        <Clock />
      </header>

      {zoom?.at === 'pane' && zoomSession ? (
        <TvPaneView
          key={zoom.id}
          session={zoomSession}
          title={zoom.title}
          context={zoom.context}
          stale={stale}
          onClose={() => setZoom(null)}
          attach={attachTap}
          detach={detachTap}
          onWrite={(data) => link.write(zoom.id, data)}
        />
      ) : zoom?.at === 'mirror' ? (
        <TvMirrorView
          link={link}
          onClose={() => setZoom(null)}
          onSilent={mirrorWentSilent}
          onAlive={mirrorCameAlive}
        />
      ) : (
        <main className={`tv-wall${stale ? ' is-stale' : ''}`}>
          <ScreenTile
            focused={focusId === MIRROR_ID}
            silent={mirrorSilent}
            onRowEl={onRowEl}
            onOpen={openZoom}
          />
          {cards.map(({ project, workspace, rows }) => (
            <ProjectCard
              key={project.id}
              name={project.name}
              color={project.color}
              manyTabs={workspace.tabs.length > 1}
              rows={rows}
              picture={picture}
              live={live}
              workingOf={workingOf}
              feeds={feeds.current}
              focusId={focusId}
              onRowEl={onRowEl}
              onOpen={openZoom}
            />
          ))}
          {picture.projects.length === 0 && <div className="tv-empty">No projects open on the desktop.</div>}
        </main>
      )}

      {menuOpen && (
        <TvMenu
          picture={picture}
          live={live}
          workingOf={workingOf}
          onNewTab={menuNewTab}
          onNewPane={menuNewPane}
          onClosePane={menuClosePane}
          onCloseTab={menuCloseTab}
          onClose={() => setMenuOpen(false)}
        />
      )}

      {/* The desktop's sentence outranks the wall's optimism: a refusal that
          arrives while "Asked the desktop…" is still up is the truer line. */}
      {(notice || toast) && (
        <div className="tv-toast" role="status">
          {notice || toast}
        </div>
      )}

      {stale && <StaleBanner state={state} detail={detail} since={lastLiveAt.current} />}
    </div>
  )
}

/* ------------------------------------------------------------------- cards */

/**
 * The one destination on this wall that is not a terminal: the desktop's
 * screen, watched as video.
 *
 * Full width at the top rather than a card among the projects, because it is
 * one thing and not one of many — a project-sized tile with no project in it
 * reads, from the sofa, as a card that has lost its name. Ink and dim at rest
 * like everything else here; volt arrives only with the ring.
 */
function ScreenTile({
  focused,
  silent,
  onRowEl,
  onOpen
}: {
  focused: boolean
  /** The last watch attempt got no answer; the tile says so instead of re-inviting. */
  silent: boolean
  onRowEl: (id: string, el: HTMLElement | null) => void
  onOpen: (id: string) => void
}): React.JSX.Element {
  return (
    <div
      className={`tv-screen${focused ? ' is-focus' : ''}${silent ? ' is-down' : ''}`}
      role="button"
      tabIndex={-1}
      ref={(el) => onRowEl(MIRROR_ID, el)}
      onClick={() => onOpen(MIRROR_ID)}
    >
      <span className="tv-screen-glyph" aria-hidden="true" />
      <span className="tv-screen-name">The desktop screen</span>
      {silent ? (
        <span className="tv-screen-hint is-silent">Didn’t answer — Forge on the desktop needs a restart</span>
      ) : (
        <span className="tv-screen-hint">OK to watch it live</span>
      )}
    </div>
  )
}

/** A leaf with the tab it lives in, because the tab's name disambiguates. */
interface Row {
  leaf: PaneLeaf
  tab: TerminalTab
}

function ProjectCard({
  name,
  color,
  manyTabs,
  rows,
  picture,
  live,
  workingOf,
  feeds,
  focusId,
  onRowEl,
  onOpen
}: {
  name: string
  color: string
  manyTabs: boolean
  rows: Row[]
  picture: LinkPicture
  live: Set<string>
  workingOf: (id: string) => boolean
  feeds: Map<string, Feed>
  focusId: string | null
  onRowEl: (id: string, el: HTMLElement | null) => void
  onOpen: (id: string) => void
}): React.JSX.Element {
  const shown = rows.slice(0, MAX_ROWS)
  const liveCount = rows.filter((r) => live.has(r.leaf.id)).length
  const workingCount = rows.filter((r) => workingOf(r.leaf.id)).length

  return (
    <section className="tv-card">
      <div className="tv-card-head">
        <span className="tv-card-dot" style={{ background: color }} />
        <h2 className="tv-card-name">{name}</h2>
        <span className="tv-card-meta">
          {workingCount > 0 && <em className="tv-card-working">{workingCount} working</em>}
          {liveCount > 0 ? `${liveCount} live` : 'idle'}
        </span>
      </div>

      {shown.map(({ leaf, tab }) => {
        const profile = picture.profiles.find((p) => p.id === leaf.profileId)
        const running = live.has(leaf.id)
        const working = running && workingOf(leaf.id)
        const lines = feeds.get(leaf.id)?.lines ?? []
        return (
          <div
            className={`tv-session${focusId === leaf.id ? ' is-focus' : ''}`}
            key={leaf.id}
            // Only a live pane is a place the remote can go: focusable, and
            // openable. A dead row is information, not a destination.
            role={running ? 'button' : undefined}
            tabIndex={running ? -1 : undefined}
            ref={running ? (el) => onRowEl(leaf.id, el) : undefined}
            onClick={running ? () => onOpen(leaf.id) : undefined}
          >
            <div className="tv-session-top">
              <span className="tv-badge" style={{ background: profile?.accent ?? '#444' }}>
                {profile?.badge ?? '··'}
              </span>
              {manyTabs && tab.title && <span className="tv-session-tab">{tab.title}</span>}
              <span className="tv-session-name">{leaf.title || profile?.name || 'Terminal'}</span>
              {/* The word carries the state, the dot only underlines it —
                  volt-vs-grey must never be the only difference at this desk. */}
              <span className={`tv-state ${working ? 'is-working' : running ? 'is-quiet' : 'is-off'}`}>
                {working ? 'working' : running ? 'quiet' : 'not running'}
              </span>
            </div>
            {running && (
              <div className="tv-tail">
                {lines.length > 0 ? (
                  lines.map((line, at) => <div key={at}>{line}</div>)
                ) : (
                  <div className="tv-tail-empty">no output yet</div>
                )}
              </div>
            )}
          </div>
        )
      })}

      {rows.length > MAX_ROWS && <div className="tv-more">+ {rows.length - MAX_ROWS} more panes</div>}
      {rows.length === 0 && <div className="tv-more">No tabs in this project yet.</div>}
    </section>
  )
}

/* -------------------------------------------------------------- the window */

/**
 * One pane, full screen, watched.
 *
 * A real xterm, but held at the *desktop's* geometry: the desktop owns this
 * PTY's cols×rows and the phone may be driving it right now, so the TV never
 * sends a resize — it picks the font size that fits that grid on this screen
 * and centres the result. stdin is disabled for the same reason the wall has
 * no buttons: this surface watches. Up/Down walk the scrollback in a plain
 * shell (a full-screen TUI owns its own screen and ignores them, which is
 * right); Escape — the remote's Back — returns to the wall.
 */
function TvPaneView({
  session,
  title,
  context,
  stale,
  onClose,
  attach,
  detach,
  onWrite
}: {
  session: MobileSession
  title: string
  context: string
  stale: boolean
  onClose: () => void
  attach: (id: string, fn: Tap) => void
  detach: () => void
  /** Raw bytes for this pane's PTY, down the Link's existing write path. */
  onWrite: (data: string) => void
}): React.JSX.Element {
  const holder = useRef<HTMLDivElement | null>(null)
  const termRef = useRef<Terminal | null>(null)
  /**
   * Typing mode. The pane stays the watch surface it always was until OK is
   * pressed; then a real text input appears and takes focus, which is the only
   * way Fire OS summons its on-screen keyboard — there is no API to ask for
   * it, only a focused field. The line goes to the PTY whole, with Enter, on
   * OK — and Back peels the layers in the order they stacked: keyboard, then
   * typing row, then the zoom itself.
   */
  const [typing, setTyping] = useState(false)
  const [draft, setDraft] = useState('')
  const inputEl = useRef<HTMLInputElement | null>(null)
  const keysEl = useRef<HTMLDivElement | null>(null)
  const typingRef = useRef(typing)
  typingRef.current = typing

  useEffect(() => {
    const container = holder.current
    if (!container) return
    // 0.62 and 1.35 are conservative cell-metric estimates for the mono
    // stack; erring small costs a few px of margin, erring big clips rows.
    const font = Math.max(
      10,
      Math.min(
        26,
        Math.floor(container.clientWidth / (session.cols * 0.62)),
        Math.floor(container.clientHeight / (session.rows * 1.35))
      )
    )
    const term = new Terminal({
      cols: session.cols,
      rows: session.rows,
      fontSize: font,
      fontFamily: "'Cascadia Mono', ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
      disableStdin: true,
      cursorBlink: false,
      scrollback: 4000,
      theme: {
        background: '#0B0C0E',
        foreground: '#E8EAED',
        cursor: '#C6FF4A',
        selectionBackground: '#2A3A12'
      }
    })
    term.open(container)
    termRef.current = term
    attach(session.id, (data, replay) => {
      // The replay is the whole screen; without the reset a reconnect stacks
      // a second copy of the scrollback under the first (see PaneView).
      if (replay) term.reset()
      term.write(data)
    })
    return () => {
      detach()
      termRef.current = null
      term.dispose()
    }
    // `typing` is a real dependency: the type row shortens the well, so the
    // terminal is remounted at the size that is actually there. The attach()
    // inside re-subscribes, and the desktop's replay repaints the screen —
    // the same bargain opening the zoom makes.
  }, [session.id, session.cols, session.rows, attach, detach, typing])

  // Entering typing mode is what summons the keyboard: focus must land on the
  // input, and it does not exist until this render has committed.
  useEffect(() => {
    if (typing) inputEl.current?.focus()
  }, [typing])

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (typingRef.current) {
        // While typing, only Back is the window's business — and it closes
        // typing, never the zoom. Every other key belongs to the input and
        // the key row, which have real DOM focus.
        if (event.key === 'Escape') {
          event.preventDefault()
          setTyping(false)
        }
        return
      }
      if (event.key === 'Escape') {
        event.preventDefault()
        onClose()
        return
      }
      if (event.key === 'Enter') {
        event.preventDefault()
        setTyping(true)
        return
      }
      if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
        event.preventDefault()
        termRef.current?.scrollLines(event.key === 'ArrowUp' ? -3 : 3)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  /** The D-pad's route around the type row: input first, then the keys. */
  const keyButtons = (): HTMLButtonElement[] =>
    Array.from(keysEl.current?.querySelectorAll('button') ?? [])

  const onInputKey = (event: React.KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === 'Enter') {
      // The whole line, with its Enter. An empty draft still sends '\r',
      // because answering a prompt with a bare Enter is a real need.
      event.preventDefault()
      onWrite(`${draft}\r`)
      setDraft('')
      return
    }
    const el = event.currentTarget
    const atEnd = el.selectionStart === el.value.length && el.selectionEnd === el.value.length
    if (event.key === 'ArrowDown' || (event.key === 'ArrowRight' && atEnd)) {
      event.preventDefault()
      keyButtons()[0]?.focus()
    }
  }

  const onKeysNav = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight' && event.key !== 'ArrowUp') return
    const buttons = keyButtons()
    const at = buttons.indexOf(event.target as HTMLButtonElement)
    if (at < 0) return
    event.preventDefault()
    if (event.key === 'ArrowUp' || (event.key === 'ArrowLeft' && at === 0)) {
      inputEl.current?.focus()
      return
    }
    buttons[event.key === 'ArrowLeft' ? at - 1 : Math.min(buttons.length - 1, at + 1)]?.focus()
  }

  return (
    <div className="tv-pane">
      <div className="tv-pane-head">
        <span className="tv-pane-context">{context}</span>
        <strong className="tv-pane-title">{title}</strong>
        <span className="tv-head-spring" />
        <span className="tv-pane-geom">
          {session.cols}×{session.rows}
        </span>
      </div>
      <div className={`tv-pane-term${stale ? ' is-stale' : ''}`} ref={holder} />
      {typing && (
        <div className="tv-type">
          <input
            ref={inputEl}
            className="tv-type-input"
            value={draft}
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            placeholder="Type a line — OK sends it"
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={onInputKey}
          />
          {/* The keys a TV prompt actually needs, KeyBar's encodings exactly.
              Words on the caps, as everywhere: a sofa reads labels, not glyphs. */}
          <div className="tv-type-keys" ref={keysEl} onKeyDown={onKeysNav}>
            <button type="button" className="tv-type-key" tabIndex={-1} onClick={() => onWrite(ESC + '[A')}>
              ↑
            </button>
            <button type="button" className="tv-type-key" tabIndex={-1} onClick={() => onWrite(ESC + '[B')}>
              ↓
            </button>
            <button type="button" className="tv-type-key" tabIndex={-1} onClick={() => onWrite(ESC)}>
              Esc
            </button>
            <button type="button" className="tv-type-key" tabIndex={-1} onClick={() => onWrite(CTRL_C)}>
              Ctrl-C
            </button>
          </div>
        </div>
      )}
      <div className="tv-pane-foot">
        {typing ? 'OK sends the line · Back puts the keyboard away' : 'OK to type into this terminal · Back returns to the wall'}
      </div>
    </div>
  )
}

/* ------------------------------------------------------------ the mirror */

/** Where the watch has got to. 'ended' always carries its sentence. */
type Phase = { at: 'connecting' } | { at: 'live' } | { at: 'ended'; reason: string }

/**
 * The desktop's own screen, full bleed, watched.
 *
 * The sibling of TvPaneView and the same bargain: one thing on screen, Back
 * returns to the wall, and no other key does anything. Nothing at all travels
 * the other way — this peer is recvonly (see lib/mirror.ts), so there is no
 * mechanism by which a press of the remote could reach the desk even if this
 * component wanted one.
 *
 * The whole lifetime of the watch lives in one effect rather than starting at
 * the press of OK: the desktop's offer comes back over the socket within
 * milliseconds, and the peer that has to answer it does not exist until this
 * mounts. Starting it anywhere earlier is a window in which the offer arrives
 * with nowhere to go — and the same effect's cleanup is the only place that
 * can promise the matching stop, whatever closed the screen.
 *
 * The honesty rule from the wall applies here hardest. A television showing a
 * frozen last frame *looks* exactly like a television showing a still desktop,
 * so the moment the peer dies this says so, in words, over the picture. There
 * is no state in which this screen is silent about being dead.
 */
function TvMirrorView({
  link,
  onClose,
  onSilent,
  onAlive
}: {
  link: Link
  onClose: () => void
  /** Nobody answered the watch request — the wall's tile should say so too. */
  onSilent: () => void
  /** Frames actually arrived; any remembered silence is stale. */
  onAlive: () => void
}): React.JSX.Element {
  const video = useRef<HTMLVideoElement | null>(null)
  const [phase, setPhase] = useState<Phase>({ at: 'connecting' })
  /**
   * Which attempt this is. Bumping it is the retry: the watch lives in an
   * effect keyed on this number, so one press of OK on a dead screen tears the
   * old peer down, tells the desktop to stop, and asks again from scratch —
   * without a trip back to the wall and back in again.
   */
  const [attempt, setAttempt] = useState(0)
  /**
   * The desktop has said *something* about this attempt — an offer, a
   * candidate, anything. It is the difference between a Forge that cannot
   * mirror and one that is merely slow to open a capture, and only the first
   * deserves the deadline below.
   */
  const [heard, setHeard] = useState(false)

  // The honest deadline. `mirror-start` is answered within milliseconds by a
  // desktop that can mirror, and by *nothing at all* when Forge there predates
  // the mirror — the case this wall lives in until Steve restarts it. So a
  // connect that has heard nothing after MIRROR_WAIT_MS is declared dead in
  // words, rather than left spinning over a promise nobody is keeping.
  //
  // Dropped the moment the desktop speaks: negotiation has its own endings
  // (a peer that fails, an answer neither side can read) and they say something
  // truer than a stopwatch. Declaring silence over a desktop that is talking is
  // how a slow capture used to become a dead screen.
  useEffect(() => {
    if (phase.at !== 'connecting' || heard) return
    const timer = window.setTimeout(() => {
      setPhase({
        at: 'ended',
        reason: 'The desktop didn’t answer. Forge there needs a restart before it can share its screen.'
      })
      onSilent()
    }, MIRROR_WAIT_MS)
    return () => clearTimeout(timer)
  }, [phase, heard, onSilent])

  useEffect(() => {
    // A retry starts where the first attempt did, or the words on screen would
    // still be the last attempt's obituary while this one is connecting.
    setPhase({ at: 'connecting' })
    setHeard(false)
    const viewer = startMirrorViewer(
      (data) => link.sendMirrorSignal(data),
      (stream) => {
        const el = video.current
        if (!el) return
        // srcObject, never src: a MediaStream has no URL, and the old
        // createObjectURL route is removed from every engine this runs on.
        el.srcObject = stream
        // A WebView refuses to autoplay until a gesture, and there is no
        // gesture to give from a sofa — mobile/native/MainActivity.kt turns
        // that off for the TV build. If it ever comes back, this is where it
        // lands, so the rejection is caught and *reported* rather than left as
        // an unhandled promise and a black screen with no explanation.
        void el.play().catch(() => {
          setPhase({ at: 'ended', reason: 'This screen would not start the video.' })
        })
      },
      (reason) => setPhase({ at: 'ended', reason: reason || 'The mirror ended.' })
    )
    mirrorListeners.signal = (data) => {
      setHeard(true)
      viewer.handleSignal(data)
    }
    mirrorListeners.stop = (reason) => {
      viewer.close()
      setPhase({ at: 'ended', reason: reason || 'The desktop stopped mirroring.' })
    }
    link.startMirror()
    return () => {
      mirrorListeners.signal = null
      mirrorListeners.stop = null
      viewer.close()
      link.stopMirror()
    }
  }, [link, attempt])

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      // Back returns to the wall, and OK asks again once there is nothing left
      // to watch — the only two verbs this surface has. While the picture is
      // live or still connecting, OK does nothing: a press that restarted a
      // working mirror would be a screen that flickers for no reason.
      if (event.key === 'Escape') {
        event.preventDefault()
        onClose()
        return
      }
      if (event.key !== 'Enter') return
      if (phase.at !== 'ended') return
      event.preventDefault()
      setAttempt((n) => n + 1)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose, phase])

  const dead = phase.at === 'ended'
  // Frames are moving, so the picture takes the whole television. Everything
  // this surface has to say — which desktop, how to leave — is said while it is
  // connecting and again if it dies; saying it *over* a live desktop costs the
  // screen a header, a footer and a border, and a mirror inside a box on a
  // 55-inch wall is a postcard of a screen rather than the screen.
  const live = phase.at === 'live'
  return (
    <div className={`tv-mirror${live ? ' is-live' : ''}`}>
      <div className="tv-pane-head">
        <span className="tv-pane-context">Desktop</span>
        <strong className="tv-pane-title">The screen</strong>
        <span className="tv-head-spring" />
        <span className="tv-pane-geom">{phase.at === 'live' ? 'live' : phase.at}</span>
      </div>

      <div className="tv-mirror-stage">
        <video
          className={`tv-mirror-video${dead ? ' is-dead' : ''}`}
          ref={video}
          autoPlay
          muted
          playsInline
          // 'live' is claimed when frames are actually moving, not when a track
          // arrives: a negotiated stream that never paints is the one thing
          // this screen must not describe as live.
          onPlaying={() => {
            onAlive()
            setPhase((current) => (current.at === 'ended' ? current : { at: 'live' }))
          }}
        />
        {phase.at !== 'live' && (
          <div className={`tv-mirror-say${dead ? ' is-ended' : ''}`} role="status">
            <strong>{dead ? 'The mirror ended' : 'Opening the desktop screen'}</strong>
            <span>{dead ? phase.reason : 'Asking the desktop to share what is on it.'}</span>
          </div>
        )}
      </div>

      {/* The same shell as the zoomed pane, on purpose: one head, one well,
          one line at the bottom naming the exits. Two full-screen things that
          framed themselves differently would read as two apps. */}
      <div className="tv-pane-foot">{dead ? 'OK tries again · Back returns to the wall' : 'Back returns to the wall'}</div>
    </div>
  )
}

/* ----------------------------------------------------------------- chrome */

const LINK_WORD: Record<LinkState, string> = {
  live: 'Live',
  connecting: 'Connecting',
  retrying: 'Reconnecting',
  refused: 'Refused',
  idle: 'Closed',
  awaiting: 'Awaiting approval',
  expired: 'Expired'
}

function LinkBadge({ state }: { state: LinkState }): React.JSX.Element {
  return (
    <span className={`tv-link tv-link-${state}`}>
      <span className="tv-link-dot" />
      {LINK_WORD[state]}
    </span>
  )
}

/**
 * Ticking seconds, deliberately. On a wall with no cursor, a moving clock is
 * the one honest sign the render loop is alive — a frozen WebView shows a
 * frozen clock, and that is exactly the tell it should show. Its own
 * component so the tick re-renders a timestamp, not the wall.
 */
function Clock(): React.JSX.Element {
  const [at, setAt] = useState(() => Date.now())
  useEffect(() => {
    const timer = window.setInterval(() => setAt(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [])
  return <span className="tv-clock">{clockOf(at)}</span>
}

function StaleBanner({
  state,
  detail,
  since
}: {
  state: LinkState
  detail: string
  since: number
}): React.JSX.Element {
  const line =
    state === 'refused'
      ? 'The desktop refused the connection'
      : state === 'connecting' || state === 'retrying'
        ? 'The link to the desktop is down'
        : 'The link to the desktop is closed'
  return (
    <div className={`tv-banner${state === 'refused' ? ' is-bad' : ''}`} role="status">
      <strong>{line}</strong>
      <span>
        Showing the picture from {clockOf(since)}
        {detail ? ` · ${detail}` : ''}
      </span>
    </div>
  )
}
