import { useCallback, useEffect, useReducer, useRef, useState, useSyncExternalStore } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import type { ClaudePermissionMode, PaneLeaf, TerminalTab, Workspace } from '@shared/types'
import { MAX_TEXT_CHARS } from '@shared/mobile'
import type { MirrorKey, MobileSession } from '@shared/mobile'
import type { Link, LinkPicture, LinkState } from '../lib/link'
import { mirrorListeners, startMirrorViewer } from '../lib/mirror'
import type { DesktopStats, MirrorViewer, ScreenStats } from '../lib/mirror'
import { startPointer } from '../lib/pointer'
import type { PointerHandle, PointerMode } from '../lib/pointer'
import { tvBridge } from '../lib/tv-bridge'
import { formatBytes } from '../lib/manifest'
import { CURRENT_VERSION_NAME, download as downloadUpdate, install as installUpdate, updateStore } from '../lib/update'
import type { UpdateState } from '../lib/update'
import { leavesOf } from './Browser'
import { ARROWS, BACK_TAB, SYMBOLS, useStickyKeys } from './KeyBar'
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
/**
 * How much of the wall one pan moves, when the ring has run out of rows but
 * the wall has not run out of picture. A little over half a screen, so the
 * band that was at the bottom is still on it afterwards to read the new
 * position against.
 */
const PAN = 0.6
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
 * code rather than string escapes so they stay visible in a diff. Everything
 * with more than one byte to it (the arrows, the symbols, Shift+Tab, the
 * Ctrl+letter rule) is imported from KeyBar rather than written again here.
 */
const ESC = String.fromCharCode(27)
const CTRL_C = String.fromCharCode(3)
const TAB = String.fromCharCode(9)
const BACKSPACE = String.fromCharCode(127)

/** Every cap in a key row, in the order the D-pad walks them. */
function capsOf(row: HTMLElement | null): HTMLButtonElement[] {
  return Array.from(row?.querySelectorAll('button') ?? [])
}

/**
 * The D-pad's walk along a row of caps, and the way back off it.
 *
 * Left and Right move the ring; Up — and Left from the first cap, which is the
 * same gesture as running out of row — hands focus back to whatever the row
 * hangs under, when there is one. Shared by the zoomed terminal's row and the
 * mirror's, because two rows that walked differently on the same remote would
 * be two grammars to learn for one gesture.
 *
 * Nothing here moves focus vertically *into* the row: the caps are the leaves
 * of this walk and every surface that has one puts it at the bottom.
 */
function walkCaps(event: React.KeyboardEvent, row: HTMLElement | null, back: HTMLElement | null): void {
  if (event.key === 'ArrowUp') {
    if (!back) return
    event.preventDefault()
    back.focus()
    return
  }
  if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
  const caps = capsOf(row)
  const at = caps.indexOf(event.target as HTMLButtonElement)
  if (at < 0) return
  event.preventDefault()
  if (event.key === 'ArrowLeft' && at === 0) {
    back?.focus()
    return
  }
  caps[event.key === 'ArrowLeft' ? at - 1 : Math.min(caps.length - 1, at + 1)]?.focus()
}

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
 * The third reserved id: a revision of this app is waiting to be installed.
 *
 * Only ever in the walk while there is genuinely something to press — see
 * `updateActs`. A television that grew a permanent extra row at the top would
 * be a television whose wall starts one press further away forever, in
 * exchange for a sentence that is true about twice a month.
 */
const UPDATE_ID = String.fromCharCode(0) + 'update'

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
 * How long the line explaining the pointer's buttons stays up.
 *
 * The same bargain the native layer's mode label makes (see `LABEL_MS` in
 * MainActivity.kt), and a little longer because there is more of it to read:
 * long enough to learn a grammar nobody has been told, short enough that it is
 * gone before it becomes a bar across somebody's desktop.
 */
const HINT_MS = 6_000

/**
 * The gap between the frames of one dictated paragraph.
 *
 * A sentence spoken into a remote can run past MAX_TEXT_CHARS, and one frame
 * cannot carry it — so it goes as several, and this is how far apart. Long
 * enough that a burst of them cannot walk into the desktop's own input ceiling
 * (MAX_INPUT_PER_SECOND) or outrun the helper typing the last lot, short enough
 * that the whole paragraph is on the desk before anybody has finished reading
 * the confirmation of it.
 */
const TEXT_CHUNK_MS = 150

/**
 * Is this WebView half a television?
 *
 * The native layer (TvPanels in MainActivity.kt) puts YouTube beside this page
 * in a horizontal split, and tells the web layer nothing — the WebView simply
 * *is* half as wide. So the fact is read from shape: the window's width
 * against the *display's*, which `screen` reports whatever slice of it this
 * WebView occupies. Full screen the two are equal; split, the window is half.
 *
 * Width against the screen rather than an aspect ratio on purpose: the soft
 * keyboard resizes this window's *height* (there is no windowSoftInputMode in
 * the manifest to say otherwise), and an aspect test would flip the whole
 * layout to full-screen rules at the exact moment somebody starts typing.
 * Width is the one dimension only the panel arrangement moves.
 *
 * The verdict is worn as a class (`tv is-split`) that every split rule in
 * tv.css hangs off — one judge, so the chrome can never compact while the
 * terminal still renders the desktop's grid.
 */
function useSplit(): boolean {
  return useSyncExternalStore(
    (onChange) => {
      window.addEventListener('resize', onChange)
      return () => window.removeEventListener('resize', onChange)
    },
    () => window.innerWidth <= window.screen.width * 0.75
  )
}

/**
 * The zoomed terminal's type size while this app owns half the television.
 *
 * Fixed rather than fitted, because in split view the fitting runs the other
 * way: the font is chosen for the sofa and the *grid* is asked to fit around it
 * (see the split branch in TvPaneView). 14 CSS px is 28 real pixels on the Fire
 * Stick's 1080p output — two steps above the wall's own 22px floor, because
 * terminal output is read, not glanced at. The slight extra leading is for the
 * same distance; xterm's own glyphs keep box-drawing joined across it.
 */
const SPLIT_FONT = 14
const SPLIT_LEADING = 1.1

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
  /** Half the television (YouTube beside us), read from the viewport's shape. */
  const split = useSplit()
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
  /** The scrolling wall itself, for the pan at the end of the walk. */
  const wallEl = useRef<HTMLElement | null>(null)
  /**
   * This app updating itself, watched rather than driven.
   *
   * lib/update.ts is already checking, downloading and verifying on its own
   * (startAutoUpdate, called once in App.tsx) whether or not anybody is
   * looking at this wall. What is left for a television to show is the part
   * Android will not let any app do by itself: the "install unknown apps"
   * grant, and the confirmation dialog. So this is a reader, and the tile it
   * feeds appears only when one of those is actually waiting.
   */
  const update = useSyncExternalStore(updateStore.subscribe, updateStore.getState)
  const updateRef = useRef(update)
  updateRef.current = update
  const updateAct = updateActs(update)
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

  /**
   * The zoomed pane's geometry requests, on their way to the desktop.
   *
   * Stable (useCallback on the link alone) because TvPaneView's restore fires
   * from an effect teardown, and a callback that changed identity every paint
   * would run that teardown twice a second. The guard exists for the restore
   * too: a pane that died while zoomed still owes nothing, and a resize for it
   * would come back as an 'unknown-session' toast over a wall that already
   * moved on.
   */
  const resizePane = useCallback(
    (id: string, cols: number, rows: number): void => {
      if (!link.sessions.some((s) => s.id === id)) return
      link.resize(id, cols, rows)
    },
    [link]
  )

  // Stable on purpose: TvMirrorView arms its no-answer deadline in an effect
  // that depends on these, and this wall re-renders twice a second — a fresh
  // closure each paint would reset that clock forever and the honest timeout
  // would never come.
  const mirrorWentSilent = useCallback((): void => setMirrorSilent(true), [])
  const mirrorCameAlive = useCallback((): void => setMirrorSilent(false), [])
  /**
   * The mirror's own sentences, on the wall's toast — what the keyboard over
   * the picture just sent to the desk. Stable for the same reason as the two
   * above: every prop that screen builds an effect out of has to survive this
   * wall repainting twice a second.
   */
  const mirrorSaid = useCallback((line: string): void => setToast(line), [])

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
    // The update tile. Nothing opens: the press *is* the action, and which
    // action it is depends on how far the automatic flow has already got —
    // see `updateActs`. install() handles a missing "install unknown apps"
    // grant by opening that settings screen itself, so this press is the only
    // one this app can offer for either half of the job.
    if (id === UPDATE_ID) {
      const act = updateActs(updateRef.current)
      if (act === 'download') void downloadUpdate()
      else if (act === 'install') void installUpdate()
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

  /**
   * The end of the walk is not the end of the wall.
   *
   * Only a live pane is a place the ring can go, and the rows that are not —
   * a terminal that has exited, the "+2 more panes" line, the tail of a card
   * that ran past the bottom of the television — are still picture. When the
   * ring is on the last walkable row and there is unread wall below it, Down
   * used to do nothing at all: a press that looks from the sofa exactly like
   * a remote that has stopped working, on the one screen where nothing else
   * moves to prove otherwise.
   *
   * So the walk falls through to a pan. Not a jump to the end: a screenful at
   * a time is how somebody reads a wall they cannot see all of, and it keeps
   * the press meaning roughly the same thing whether or not there happened to
   * be a row to land on.
   *
   * True when the wall actually moved, which is what makes the key handler's
   * choice between "moved the ring", "moved the picture" and "did neither" a
   * decision this function can be asked rather than one it has to predict.
   */
  const panWall = (down: boolean): boolean => {
    const wall = wallEl.current
    if (!wall) return false
    const room = down ? wall.scrollHeight - wall.clientHeight - wall.scrollTop : wall.scrollTop
    // A pixel of slack: a scroll container that has arrived is routinely a
    // fraction of a pixel short of its own arithmetic.
    if (room <= 1) return false
    wall.scrollTop += (down ? 1 : -1) * Math.min(room, wall.clientHeight * PAN)
    return true
  }
  const panWallRef = useRef(panWall)
  panWallRef.current = panWall

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
      if (next) {
        setFocusId(next)
        return
      }
      // Nowhere left to put the ring. Vertically that is not necessarily the
      // end of the wall — see panWall.
      if (key === 'ArrowUp' || key === 'ArrowDown') panWallRef.current(key === 'ArrowDown')
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
  // Last in the resting order however loud it looks: an app update is never
  // the reason somebody turned the television on, and a ring that opened on it
  // would be a ring in front of the work.
  if (updateAct !== 'none') order.current.push(UPDATE_ID)

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
    <div className={`tv${split ? ' is-split' : ''}`}>
      <header className="tv-head">
        <strong className="tv-mark">Forge</strong>
        {/* Two versions, each labelled, because an unlabelled one is the
            desktop's and the question people actually have is about this
            television. "Is the app on the Fire Stick the one that updates
            itself?" had no answer on this screen at all — the header showed
            the desktop's number, which reads exactly like the TV's until it
            matters. Nothing else on the wall can settle it: an app too old to
            update itself and an app already up to date both show no update
            row, for opposite reasons. */}
        <span className="tv-head-meta">
          Desktop v{picture.appVersion} · TV {CURRENT_VERSION_NAME} · {picture.projects.length}{' '}
          {picture.projects.length === 1 ? 'project' : 'projects'} · {live.size} live
        </span>
        {/* In split view the zoomed pane's own header row is given up to the
            terminal (see tv.css), so the one header line left has to say which
            pane this is. Only rendered when both facts are true — full screen
            keeps its two-row arrangement untouched. */}
        {split && zoom?.at === 'pane' && (
          <span className="tv-head-pane">
            <span className="tv-head-pane-context">{zoom.context} · </span>
            {zoom.title}
          </span>
        )}
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
          split={split}
          onClose={() => setZoom(null)}
          attach={attachTap}
          detach={detachTap}
          onWrite={(data) => link.write(zoom.id, data)}
          onResize={resizePane}
        />
      ) : zoom?.at === 'mirror' ? (
        <TvMirrorView
          link={link}
          canControl={picture.canControl}
          onClose={() => setZoom(null)}
          onSilent={mirrorWentSilent}
          onAlive={mirrorCameAlive}
          onSaid={mirrorSaid}
        />
      ) : (
        <main className={`tv-wall${stale ? ' is-stale' : ''}`} ref={wallEl}>
          {updateAct !== 'none' && (
            <UpdateTile
              state={update}
              act={updateAct}
              focused={focusId === UPDATE_ID}
              onRowEl={onRowEl}
              onOpen={openZoom}
            />
          )}
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

/* ------------------------------------------------------------- the update */

/** What one press of OK on the update tile would do, if anything. */
type UpdateAct = 'none' | 'download' | 'install' | 'watch'

/**
 * The phase, as the one question this wall asks of it: is there anything a
 * person on a sofa can usefully press?
 *
 * Pure and separate from the tile so the walk can ask it too — a row that is
 * drawn and a row that is in `order` have to agree, and the cheapest way to
 * guarantee that is for both to call this.
 *
 * `checking`, `current` and `unreachable` are all 'none'. An app that told a
 * television it had looked for an update and found nothing would be an app
 * interrupting a wall of terminals to say that nothing happened.
 */
function updateActs(state: UpdateState): UpdateAct {
  switch (state.phase) {
    case 'available':
      // Normally the automatic flow is already on this and the tile is a
      // progress report a beat later. It is still a press, because the flow
      // stops for an hour after a declined install and for a whole session
      // after a failed download, and "wait an hour" is not an instruction.
      return 'download'
    case 'downloading':
      return 'watch'
    case 'ready':
      return 'install'
    case 'failed':
      // Something concrete broke and `detail` says what. Offered as a retry
      // rather than hidden: a television that quietly gave up is the state
      // this whole feature exists to end.
      return 'download'
    default:
      return 'none'
  }
}

/**
 * The one thing on this wall that is about the television itself.
 *
 * It exists because of a hard limit rather than a design preference: Android
 * hands a sideloaded package to its own confirmation dialog, and it will not
 * raise that dialog at all until this app has been granted "install unknown
 * apps". Neither can be automated by any app that is not the device owner. So
 * everything up to that point happens without anybody being told — check,
 * download, verify the SHA-256 — and this tile is only what is left: one press,
 * for the step Android reserves for a human.
 *
 * Volt, and above the screen tile, for the length of time it is there. It is
 * the one row on this wall that stops being true once it has been used.
 */
function UpdateTile({
  state,
  act,
  focused,
  onRowEl,
  onOpen
}: {
  state: UpdateState
  act: UpdateAct
  focused: boolean
  onRowEl: (id: string, el: HTMLElement | null) => void
  onOpen: (id: string) => void
}): React.JSX.Element {
  const version = state.manifest?.versionName ?? ''
  const size = formatBytes(state.manifest?.sizeBytes ?? 0)
  const percent =
    state.total > 0 ? Math.min(100, Math.round((state.received / state.total) * 100)) : 0
  const hint =
    act === 'watch'
      ? `Downloading — ${percent}%`
      : act === 'install'
        ? 'OK installs it · the television asks once more'
        : state.phase === 'failed'
          ? 'OK tries again'
          : 'OK downloads it'

  return (
    <div
      className={`tv-newver${focused ? ' is-focus' : ''}`}
      role="button"
      tabIndex={-1}
      ref={(el) => onRowEl(UPDATE_ID, el)}
      onClick={() => onOpen(UPDATE_ID)}
    >
      <span className="tv-newver-glyph" aria-hidden="true" />
      <span className="tv-newver-name">
        Forge TV {version || 'update'} is waiting{size ? ` · ${size}` : ''}
      </span>
      {/* The detail is the sentence lib/update.ts wrote about whatever went
          wrong or is still needed — the install grant, a refused download. It
          outranks the hint whenever there is one, because a generic invitation
          over a specific problem is how a television stops being believed. */}
      <span className="tv-newver-hint">{state.detail || hint}</span>
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
 * A real xterm, and *whose* geometry it draws depends on how much television
 * there is. Full screen, it is held at the desktop's: the desktop owns this
 * PTY's cols×rows and the phone may be driving it right now, so the TV picks
 * the font size that fits that grid on this screen and centres the result.
 *
 * In split view that bargain collapses. Half a 1080p panel cannot show a
 * 130-column grid at any size a sofa can read — fitting it means a 6px font,
 * and holding the font means clipping, which is how this screen once showed
 * only the right-hand ends of every line. So while the window is both zoomed
 * *and* split, the TV does what the phone has always done: it fits the grid to
 * its own box at a readable size and asks the desktop for that shape over the
 * existing `resize` frame, handing it back when the window closes (the restore
 * effect below).
 *
 * That ask is now a *wish* rather than a contract, and this screen has not been
 * reworked for it. The desktop grants a viewer's geometry only while that viewer
 * is the one somebody last typed into the pane on (electron/pty/grid-owner.ts),
 * and a television is a screen driven by a remote control: it is watched far
 * more often than it is typed into, so in practice this split view holds
 * somebody else's grid in half a panel, which is the clipping it was written to
 * end. The phone answers that by scaling its font to whatever the real grid is
 * (`follow` in mobile/src/lib/term.ts); a sofa cannot read the result at half
 * width, which is exactly why that route was rejected here in the first place.
 * Deciding what a television should do instead is unfinished work — the new rule
 * narrows the gap (type on the TV and it does get its shape) without closing it,
 * because a television that has to be typed into to be readable is not a
 * television.
 *
 * stdin is disabled for the same reason the wall has no buttons: this surface
 * watches. Up/Down walk the scrollback in a plain shell (a full-screen TUI
 * owns its own screen and ignores them, which is right); Escape — the
 * remote's Back — returns to the wall.
 */
function TvPaneView({
  session,
  title,
  context,
  stale,
  split,
  onClose,
  attach,
  detach,
  onWrite,
  onResize
}: {
  session: MobileSession
  title: string
  context: string
  stale: boolean
  /** Half the television. Decides who owns the PTY's shape — see above. */
  split: boolean
  onClose: () => void
  attach: (id: string, fn: Tap) => void
  detach: () => void
  /** Raw bytes for this pane's PTY, down the Link's existing write path. */
  onWrite: (data: string) => void
  /** A geometry request for the desktop, guarded there against dead panes. */
  onResize: (id: string, cols: number, rows: number) => void
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
  /**
   * The same sticky Ctrl and Alt the phone's key bar has, from the same hook.
   *
   * A television needs them for the same reason a phone does and one more: the
   * remote has no modifier at all, so "hold Ctrl" is not a gesture that exists
   * here. Armed by a press, spent by the next key — see `onDraft` for what
   * being armed does to the field.
   */
  const { ctrl, alt, cycleCtrl, cycleAlt, sendChar, sendRaw } = useStickyKeys(onWrite)
  /**
   * The desktop's shape when this window opened, held for the hand-back.
   * Captured once — by the time the window closes, `session.cols` is whatever
   * this television last asked for, which is exactly the wrong thing to
   * restore to.
   */
  const original = useRef({ cols: session.cols, rows: session.rows })
  /** Whether this window ever reshaped the PTY, so only a debt is repaid. */
  const reshaped = useRef(false)

  useEffect(() => {
    const container = holder.current
    if (!container) return
    const shared = {
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
    } as const
    let term: Terminal
    if (split) {
      // Half a television: the font is fixed at sofa size and the grid fits
      // around it, then the desktop is asked for that shape — the reflow that
      // turns "the right-hand ends of long lines" back into sentences. The
      // under-8px guard is term.ts's: a box mid-layout makes FitAddon compute
      // a nonsense geometry, and a nonsense geometry must never reach a PTY.
      term = new Terminal({ ...shared, fontSize: SPLIT_FONT, lineHeight: SPLIT_LEADING })
      const fit = new FitAddon()
      term.loadAddon(fit)
      term.open(container)
      if (container.clientWidth >= 8 && container.clientHeight >= 8) {
        try {
          fit.fit()
        } catch {
          /* the desktop's shape stands until the box is real */
        }
      }
      if (term.cols >= 2 && term.rows >= 2 && (term.cols !== session.cols || term.rows !== session.rows)) {
        reshaped.current = true
        onResize(session.id, term.cols, term.rows)
      }
    } else {
      // The whole television: the desktop owns this PTY's cols×rows and the
      // phone may be driving it right now, so no resize is ever sent — the
      // font that fits that grid is picked instead. 0.62 and 1.35 are
      // conservative cell-metric estimates for the mono stack; erring small
      // costs a few px of margin, erring big clips rows.
      const font = Math.max(
        10,
        Math.min(
          26,
          Math.floor(container.clientWidth / (session.cols * 0.62)),
          Math.floor(container.clientHeight / (session.rows * 1.35))
        )
      )
      term = new Terminal({ ...shared, cols: session.cols, rows: session.rows, fontSize: font })
      term.open(container)
    }
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
    // the same bargain opening the zoom makes. `split` is one for the same
    // reason with the panels: crossing between half and whole television
    // rebuilds the terminal under the geometry rule that now applies.
  }, [session.id, session.cols, session.rows, attach, detach, typing, split, onResize])

  // The hand-back. Leaving the split window — Back to the wall, the pane
  // dying, or the panels folding to full screen — returns the PTY to the shape
  // the desktop had before this television reshaped it. An effect of its own,
  // keyed on `split` rather than riding the mount effect above, because that
  // one also tears down for a typing toggle and the desk must not watch its
  // pane snap wide and narrow again every time the keyboard comes up.
  useEffect(() => {
    if (!split) return
    const id = session.id
    return () => {
      if (!reshaped.current) return
      reshaped.current = false
      onResize(id, original.current.cols, original.current.rows)
    }
  }, [split, session.id, onResize])

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
      capsOf(keysEl.current)[0]?.focus()
    }
  }

  /**
   * A letter, while a modifier is armed.
   *
   * The phone's Ctrl works because every keystroke on that screen is its own
   * event; here the field is a *line* that leaves on Enter, so Ctrl+C typed
   * into it would arrive as the two characters "^C" long after the moment it
   * meant anything. So while Ctrl or Alt is armed this field stops being a line
   * and becomes one key at a time: the character that was just added is sent
   * modified and taken straight back out of the box.
   *
   * Only while something is armed, which is a press somebody made a moment ago
   * and can see on the cap. With nothing armed this is an ordinary text field
   * and dictation into it behaves exactly as it always has.
   */
  const onDraft = (value: string): void => {
    if ((ctrl === 'off' && alt === 'off') || value.length !== draft.length + 1 || !value.startsWith(draft)) {
      setDraft(value)
      return
    }
    sendChar(value.slice(draft.length))
    setDraft(draft)
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
            placeholder={
              ctrl !== 'off' || alt !== 'off'
                ? 'One letter at a time while a modifier is held'
                : 'Type a line — OK sends it'
            }
            onChange={(e) => onDraft(e.target.value)}
            onKeyDown={onInputKey}
          />
          {/* The keys a terminal needs and a remote does not have, in KeyBar's
              encodings — imported from it rather than spelled again, so the
              television and the phone cannot drift apart on what Ctrl-C is.

              The set is the phone's, reordered for a walk instead of a thumb:
              what a Claude Code session is answered with (Escape, Tab and
              Shift+Tab, which is how its permission mode cycles) comes first,
              because every cap after the first costs a press of Right to
              reach. Words on the caps where a word exists, as everywhere on
              this wall: a sofa reads labels, not glyphs. */}
          <div className="tv-type-keys" ref={keysEl} onKeyDown={(e) => walkCaps(e, keysEl.current, inputEl.current)}>
            <button type="button" className="tv-type-key" tabIndex={-1} onClick={() => sendRaw(ESC)}>
              Esc
            </button>
            <button type="button" className="tv-type-key" tabIndex={-1} onClick={() => sendRaw(TAB)}>
              Tab
            </button>
            <button type="button" className="tv-type-key" tabIndex={-1} onClick={() => sendRaw(BACK_TAB)}>
              ⇧Tab
            </button>
            <button type="button" className="tv-type-key" tabIndex={-1} onClick={() => sendRaw(CTRL_C)}>
              Ctrl-C
            </button>
            <button type="button" className="tv-type-key" tabIndex={-1} onClick={() => sendRaw(BACKSPACE)}>
              ⌫
            </button>
            {ARROWS.map(([label, code]) => (
              <button
                type="button"
                key={label}
                className="tv-type-key"
                tabIndex={-1}
                onClick={() => sendRaw(code)}
              >
                {label}
              </button>
            ))}
            {/* Sticky, exactly as on the phone: one press arms them for the
                next key, a second locks them, a third puts them away. The state
                is on the cap because a modifier nobody can see the state of is
                a modifier that sends the wrong thing once an evening. */}
            <button
              type="button"
              className={`tv-type-key is-mod is-mod-${ctrl}`}
              tabIndex={-1}
              aria-pressed={ctrl !== 'off'}
              onClick={cycleCtrl}
            >
              Ctrl
            </button>
            <button
              type="button"
              className={`tv-type-key is-mod is-mod-${alt}`}
              tabIndex={-1}
              aria-pressed={alt !== 'off'}
              onClick={cycleAlt}
            >
              Alt
            </button>
            {SYMBOLS.map((symbol) => (
              <button
                type="button"
                key={symbol}
                className="tv-type-key is-sym"
                tabIndex={-1}
                onClick={() => sendChar(symbol)}
              >
                {symbol}
              </button>
            ))}
          </div>
        </div>
      )}
      {/* Keyed on what it says: in split view this line is a pill that fades
          out (tv.css), and a changed sentence should get its six seconds too —
          remounting is what restarts a one-shot CSS animation. */}
      <div className="tv-pane-foot" key={typing ? 'typing' : 'watching'}>
        {typing
          ? 'OK sends the line · Down for Esc, Tab and the rest · Back puts the keyboard away'
          : 'OK to type into this terminal · Back returns to the wall'}
      </div>
    </div>
  )
}

/* ------------------------------------------------------------ the mirror */

/** Where the watch has got to. 'ended' always carries its sentence. */
type Phase = { at: 'connecting' } | { at: 'live' } | { at: 'ended'; reason: string }

/**
 * The caps on the mirror's key row, and the whole of it.
 *
 * A subset of `MIRROR_KEYS` (shared/mobile.ts) with a word on each — the two
 * arrows this row does not carry are Up and Down, which the D-pad sends
 * directly. Order is frequency, not the vocabulary's: every cap after the first
 * costs a press of Right to reach, and the first one is Enter because
 * submitting the thing just dictated is what the whole row is for.
 */
const MIRROR_CAPS: Array<[string, MirrorKey]> = [
  ['Enter', 'enter'],
  ['Esc', 'escape'],
  ['Tab', 'tab'],
  ['⌫', 'backspace'],
  ['Space', 'space'],
  ['←', 'left'],
  ['→', 'right'],
  ['Del', 'delete'],
  ['Home', 'home'],
  ['End', 'end'],
  ['PgUp', 'pageup'],
  ['PgDn', 'pagedown'],
  ['⊞ Win', 'win']
]

/**
 * One phrase, cut into the frames the wire will actually carry.
 *
 * `readMirrorInput` on the desktop takes the first MAX_TEXT_CHARS of a `text`
 * frame and silently drops the rest, which is the right answer to a single
 * over-long frame and the wrong answer to a dictated paragraph — and a
 * paragraph is exactly what a remote's microphone produces when somebody keeps
 * talking. So the cut happens here, where the whole of it is still known, and
 * the pieces go as successive frames.
 *
 * Cut anywhere, including mid-word: the desktop types the pieces one after
 * another into the same field with nothing between them, so the characters that
 * land are the characters that were said whatever the boundaries were. Code
 * points rather than UTF-16 units only so that a surrogate pair is never split
 * in half — half an emoji is a character the desktop's layout cannot type and
 * would drop, which would be the one way this could change what was said.
 */
function phraseChunks(text: string): string[] {
  const chunks: string[] = []
  let chunk = ''
  for (const character of text) {
    if (chunk.length + character.length > MAX_TEXT_CHARS) {
      chunks.push(chunk)
      chunk = ''
    }
    chunk += character
  }
  if (chunk) chunks.push(chunk)
  return chunks
}

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
  canControl,
  onClose,
  onSilent,
  onAlive,
  onSaid
}: {
  link: Link
  /**
   * Whether the desktop will act on a pointer at all — its own switch, read at
   * hello (see LinkPicture). False hides every trace of the cursor rather than
   * offering one that would move here and nowhere else.
   */
  canControl: boolean
  onClose: () => void
  /** Nobody answered the watch request — the wall's tile should say so too. */
  onSilent: () => void
  /** Frames actually arrived; any remembered silence is stale. */
  onAlive: () => void
  /**
   * Something happened that the person on the sofa cannot see: a phrase left
   * for the desktop to type. It goes on the wall's toast, which is drawn over
   * this screen too — a dictated sentence disappears into a field that empties
   * itself, and without a line saying where it went there is nothing at all to
   * tell "sent" from "swallowed".
   */
  onSaid: (line: string) => void
}): React.JSX.Element {
  const video = useRef<HTMLVideoElement | null>(null)
  const [phase, setPhase] = useState<Phase>({ at: 'connecting' })
  /**
   * The measurement overlay, on Down and off again.
   *
   * It exists because "the television looks blurry" is not a fact anybody can
   * act on. A soft picture has four different causes that look identical from a
   * sofa — a starved encoder, a busy desk, a lossy wifi hop, or a stream that is
   * genuinely 1920 wide and simply large — and each wants a different fix. The
   * numbers here name which one it is, on the screen where the problem is,
   * rather than in a devtools window on a machine in another room.
   *
   * Down rather than a menu, because it is the one arrow this surface has never
   * used and the wall ignores every key while a pane is zoomed (see the bound-
   * once listener above).
   */
  const [hud, setHud] = useState(false)
  /**
   * The keyboard, over the picture.
   *
   * A `<input>` in this page and not a native field, which is the correction
   * this replaced: Fire OS raises its own on-screen keyboard for a focused web
   * input perfectly well — it is what the pairing screen's address box and the
   * terminal pane's type row have always used on this hardware — and a native
   * EditText fighting the WebView for focus produced a green row that appeared
   * and vanished in the same frame.
   *
   * Opened by a click on the desktop, because nothing can tell whether the
   * click landed in a text box: Chrome answers the accessibility question with
   * the same "document" node whether an input has focus or nothing does. So
   * every click offers, and Back puts it away again — sending whatever was in
   * it on the way out, which is `commit` below and the reason a phrase cannot
   * be lost by leaving rather than by pressing OK.
   */
  const [typing, setTyping] = useState(false)
  const [draft, setDraft] = useState('')
  const typeEl = useRef<HTMLInputElement | null>(null)
  /** The window listener is bound once; this is how it reads the live value. */
  const typingRef = useRef(typing)
  typingRef.current = typing
  /**
   * The draft, where the fallbacks below can reach it.
   *
   * `commit` is called from an effect's teardown as well as from the field's
   * own handlers, and a teardown runs after the render that caused it — by
   * which point the `draft` captured in that closure is whatever the last paint
   * held. This ref is the live value, and emptying it is what makes one commit
   * unrepeatable by the next.
   */
  const draftRef = useRef(draft)
  draftRef.current = draft

  /**
   * One key on the desktop's own keyboard, pressed and released.
   *
   * Both halves always, in that order and in the same instant: the desktop
   * performs each one as a real `keybd_event`, so a down without its up is a
   * key held on somebody's desk until the mirror ends. Nothing here can name a
   * scancode — `MirrorKey` is a closed list (shared/mobile.ts) and this is a
   * lookup into it, not an encoding.
   */
  const tapKey = (key: MirrorKey): void => {
    link.sendMirrorInput({ t: 'mirror-input', a: 'key', key, down: true })
    link.sendMirrorInput({ t: 'mirror-input', a: 'key', key, down: false })
  }

  /**
   * Send what is in the box to the desktop, once, whatever asked — and press
   * Enter after it, or not.
   *
   * One function because there are now six ways in and they must not be able to
   * disagree: Enter from the remote, the form's implicit submit, the keyboard's
   * own action button, either cap under the field, the field losing focus, and
   * the keyboard closing. The last two exist because of what Fire OS actually
   * does with the voice dialog — it labels its button "Next", and Chromium
   * answers a Next by *moving focus*, not by synthesising an Enter
   * (`ImeAdapterImpl`). A remote that dictated a sentence and pressed the only
   * button on screen would otherwise watch the words vanish, which is exactly
   * what it did.
   *
   * So the field is emptied first and sent second. Anything that arrives after
   * the first route has fired finds an empty box and does nothing, which is the
   * whole of the protection against sending a phrase twice.
   *
   * `submit` is the difference between filling a box and answering a question,
   * and it is never guessed: a dictated prompt for a Claude pane wants its
   * Enter and the second field of a login form very much does not. The presses
   * that mean "I have finished saying it" carry it; the ones that mean "the
   * keyboard is going away" do not. An empty box with `submit` set is still a
   * press of Enter — answering a prompt with a bare Enter is a real need, and
   * the zoomed terminal's row has always read it that way.
   *
   * Answers whether there was anything to send, which is what tells a blur that
   * moved focus off this overlay from one that did not.
   */
  const commit = (submit: boolean): boolean => {
    const text = draftRef.current
    draftRef.current = ''
    setDraft('')
    // Whitespace is not an instruction, but what is sent is the draft itself:
    // a trailing space between two dictated phrases is part of the sentence.
    const words = text.trim() ? text : ''
    if (!words && !submit) return false
    if (phase.at !== 'live') {
      onSaid('The desktop’s picture has ended — nothing was typed.')
      return false
    }
    // Spread out rather than fired together: each frame is a couple of hundred
    // real key strokes at the other end, and the desktop counts frames per
    // second (MAX_INPUT_PER_SECOND) before it performs any of them. The Enter
    // takes the slot after the last of them, because a submit that overtook the
    // sentence it is submitting would send half a prompt.
    const chunks = words ? phraseChunks(words) : []
    chunks.forEach((chunk, index) => {
      const send = (): void => link.sendMirrorInput({ t: 'mirror-input', a: 'text', text: chunk })
      if (index === 0) send()
      else window.setTimeout(send, index * TEXT_CHUNK_MS)
    })
    if (submit) {
      if (chunks.length > 1) window.setTimeout(() => tapKey('enter'), chunks.length * TEXT_CHUNK_MS)
      else tapKey('enter')
    }
    if (!words) {
      onSaid('Pressed Enter on the desktop.')
      return false
    }
    const shown = words.length > 40 ? `${words.slice(0, 40)}…` : words
    onSaid(submit ? `Sent “${shown}” and pressed Enter.` : `Sent “${shown}” — not submitted.`)
    return true
  }
  /** The teardown below calls this, and must call the current one. */
  const commitRef = useRef(commit)
  commitRef.current = commit
  /** What the desktop last said about its sending. See lib/mirror.ts. */
  const desk = useRef<DesktopStats | null>(null)
  /** The same pair, snapshotted for rendering — see the polling effect below. */
  const [shown, setShown] = useState<{ desk: DesktopStats | null; screen: ScreenStats | null } | null>(null)
  /** The live viewer, so the overlay can ask it what it decoded. */
  const viewerRef = useRef<MirrorViewer | null>(null)
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

  /* ----------------------------------------------------- driving the desk
   *
   * Watching and driving are two modes of one screen, and OK is the door
   * between them. Not a permanent state: a remote whose arrows always moved a
   * pointer would have no way left to open the numbers overlay or leave, and a
   * television that is *usually* watched should not silently be a mouse.
   *
   * The cursor itself is drawn by lib/pointer.ts straight into the node below,
   * on an animation frame, without going near React — see the note there about
   * re-rendering a full-screen video sixty times a second.
   */
  const [driving, setDriving] = useState(false)
  /** What the arrows are doing and whether a button is down, for the foot. */
  const [pointerSays, setPointerSays] = useState<{ mode: PointerMode; holding: boolean }>({
    mode: 'move',
    holding: false
  })
  /** The row of desktop keys, while the remote is a keyboard. See `walkCaps`. */
  const keysEl = useRef<HTMLDivElement | null>(null)
  /** Whether the line explaining the remote is up. See its effect below. */
  const [hint, setHint] = useState(false)
  const stage = useRef<HTMLDivElement | null>(null)
  const cursor = useRef<HTMLDivElement | null>(null)
  const pointer = useRef<PointerHandle | null>(null)

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
          // Sound is the one thing that can be refused on its own. Every engine
          // that blocks autoplay blocks *audible* autoplay, so a rejection here
          // is far more likely to be "not without a gesture" than "cannot play
          // this at all". Muting and trying once more turns that into a silent
          // mirror rather than a black screen — and only a second refusal, which
          // no longer has anything to do with the sound, is worth a sentence.
          el.muted = true
          void el.play().catch(() => {
            setPhase({ at: 'ended', reason: 'This screen would not start the video.' })
          })
        })
      },
      (reason) => setPhase({ at: 'ended', reason: reason || 'The mirror ended.' }),
      // Into a ref, not into state. These land once a second for the whole life
      // of the watch, and a set-state here would re-render a full-screen video
      // every second of an evening for numbers nobody has asked to see. The
      // polling effect below reads the ref, and only while the overlay is up.
      (stats) => {
        desk.current = stats
      }
    )
    viewerRef.current = viewer
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
      viewerRef.current = null
      desk.current = null
      viewer.close()
      link.stopMirror()
    }
  }, [link, attempt])

  // The overlay's own clock, and the only thing that re-renders for it. Off
  // when the overlay is down, so a watched desktop is a video element and
  // nothing else. Cleared and re-armed by the effect, so a retry starts its
  // numbers again rather than showing the dead attempt's last reading.
  useEffect(() => {
    if (!hud) return
    let alive = true
    const sample = async (): Promise<void> => {
      const screen = (await viewerRef.current?.readStats()) ?? null
      if (!alive) return
      setShown({ desk: desk.current, screen })
    }
    void sample()
    const timer = window.setInterval(() => void sample(), 1000)
    return () => {
      alive = false
      clearInterval(timer)
    }
  }, [hud, attempt])

  // The pointer's whole lifetime. Built when driving starts, torn down when it
  // stops — and the teardown is what releases a button left held by a
  // television that was switched off mid-drag, so it must not be conditional
  // on anything but this effect running.
  useEffect(() => {
    if (!driving) return
    const stageEl = stage.current
    const cursorEl = cursor.current
    // The video too, and not for playing it: it is the only thing that knows
    // the desktop's own shape, which is what decides where inside the stage the
    // picture actually is. See `frameBox` in lib/pointer.ts.
    const videoEl = video.current
    if (!stageEl || !cursorEl || !videoEl) return
    // A pointer always starts in the middle, pointing rather than scrolling —
    // so the words on screen have to start there too, or a mode picked up
    // again after a scroll would open under last time's sentence.
    setPointerSays({ mode: 'move', holding: false })
    const handle = startPointer({
      stage: stageEl,
      picture: videoEl,
      cursor: cursorEl,
      send: (frame) => link.sendMirrorInput(frame),
      onChange: (mode, holding) => setPointerSays({ mode, holding }),
      // Every click offers the keyboard. It has to be every click, because
      // nothing on this side or the desktop's can tell a text box from a
      // button: Chrome answers the accessibility question with the same
      // "document" whether an input has focus or nothing does. Offering after
      // a click that did not land in a field costs one press of Back;
      // offering after none of them would be the feature not existing.
      onClick: () => setTyping(true)
    })
    pointer.current = handle
    // The native layer has to stop competing for the same keys: a held Left or
    // Right is how the remote crosses to the YouTube panel, which is exactly
    // the press this mode needs for "keep moving left". While the pointer is
    // running the arrows belong to it, and Menu — normally the panel cycle —
    // is handed to this page as the scroll toggle. See MainActivity.
    tvBridge.emit({ kind: 'control', on: true })
    return () => {
      // A keyboard over a picture nobody is driving has nowhere to send what is
      // typed into it, so putting the pointer down puts this away too. What was
      // in it is not cleared here: closing the keyboard sends it (see the focus
      // effect below), and clearing it in this teardown would empty the draft
      // one render before that teardown could read it.
      setTyping(false)
      tvBridge.emit({ kind: 'control', on: false })
      pointer.current = null
      handle.stop()
    }
  }, [driving, link])

  // Entering typing mode is what summons the keyboard: focus has to land on the
  // input, and the input does not exist until this render has committed. The
  // same two lines the terminal pane uses, for the same reason — this is the
  // mechanism that is known to raise the on-screen keyboard on a Fire Stick.
  //
  // Closing it is what sends: whatever put the keyboard away — Back, the
  // pointer being put down, the mirror ending — the sentence in it goes to the
  // desk rather than into the bin. A television has no drafts folder, and the
  // press that closes this is far more often "I have said it" than "forget it".
  useEffect(() => {
    if (!typing) return
    typeEl.current?.focus()
    // Closing is not a submit. Whatever the phrase was for, the press that put
    // the keyboard away said nothing about whether it was finished, so the
    // words go to the desk and the Enter does not.
    return () => {
      commitRef.current(false)
    }
  }, [typing])

  // The key row's ring has to start somewhere, and it starts on Enter — the cap
  // this mode exists for. Re-run when the mode is entered rather than once,
  // because the row is unmounted the rest of the time and a focus call into a
  // node that is not there focuses nothing.
  useEffect(() => {
    if (!driving || typing || pointerSays.mode !== 'keys') return
    capsOf(keysEl.current)[0]?.focus()
  }, [driving, typing, pointerSays.mode])

  // A picture that is no longer live cannot be pointed at. Ending the mode
  // rather than leaving a cursor over a dead frame: the pointer would still be
  // sending, and the desktop would still be moving, against a screen showing a
  // photograph of where things used to be.
  useEffect(() => {
    if (phase.at !== 'live' && driving) setDriving(false)
  }, [phase, driving])

  // The hint's own clock. Re-armed whenever what it says would change — the
  // mode was picked up, or the arrows swapped between pointing and scrolling —
  // so the sentence on screen is always the one that is true right now.
  useEffect(() => {
    if (!driving) {
      setHint(false)
      return
    }
    setHint(true)
    const timer = window.setTimeout(() => setHint(false), HINT_MS)
    return () => clearTimeout(timer)
  }, [driving, pointerSays.mode])

  // Losing the keyboard is losing the remote. On the television that happens
  // when the light crosses to the YouTube panel, which takes the arrows with it
  // — and it can happen mid-press, so the release of whatever was held never
  // arrives here. Ending the mode runs the pointer's teardown, and the teardown
  // is what lifts a mouse button left down on somebody's desk.
  useEffect(() => {
    if (!driving) return
    const stop = (): void => setDriving(false)
    window.addEventListener('blur', stop)
    return () => window.removeEventListener('blur', stop)
  }, [driving])

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      // The keyboard is up, so every key belongs to the input that has real DOM
      // focus — which is what puts the television's own keyboard on screen and
      // what its microphone dictates into. Only Back is this window's business,
      // and it closes the keyboard rather than the mirror: one press, one level.
      // Closing sends what was typed — see the focus effect above.
      //
      // Read before everything, including the pointer, because the pointer
      // claims the arrows and OK and would otherwise eat the presses that are
      // walking a key grid.
      if (typingRef.current) {
        if (event.key === 'Escape') {
          event.preventDefault()
          setTyping(false)
        }
        return
      }

      // Back is the one key that means the same thing in both modes and is
      // read first in both: it steps out. Out of the pointer if it is running,
      // out of the mirror if it is not — one press, one level, never two at
      // once, because a remote with no undo should not skip a floor.
      if (event.key === 'Escape') {
        event.preventDefault()
        if (driving) setDriving(false)
        else onClose()
        return
      }

      // While driving, the arrows, OK and Menu belong to the cursor. Anything
      // it does not claim falls through to the verbs below — and in keyboard
      // mode it claims only Menu, which is the press that gets back out.
      if (driving && pointer.current?.key(event.key, true)) {
        event.preventDefault()
        return
      }

      // The remote *is* a keyboard now. Up and Down are the desktop's own
      // arrow keys — the press that scrolls a page or walks a caret, and the
      // reason this mode is worth a third of the D-pad — while Left and Right
      // walk the row of caps below and OK presses whichever one the ring is on.
      // Both of those have real DOM focus, so they are simply not this
      // listener's business and it gets out of their way.
      if (driving && pointerSays.mode === 'keys') {
        if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
          event.preventDefault()
          tapKey(event.key === 'ArrowUp' ? 'up' : 'down')
        }
        return
      }

      // Down opens the measurement overlay and Down closes it. Available in
      // every phase on purpose: a mirror that died of bandwidth is exactly the
      // one whose last numbers are worth reading.
      if (event.key === 'ArrowDown') {
        event.preventDefault()
        setHud((on) => !on)
        return
      }
      if (event.key !== 'Enter') return
      event.preventDefault()
      // OK on a dead screen asks again; OK on a live one picks up the pointer,
      // when the desktop has said it will accept one. A live mirror on a
      // desktop that has not is the case where OK does nothing at all, and the
      // line along the bottom is where that is explained rather than here.
      if (phase.at === 'ended') {
        setAttempt((n) => n + 1)
        return
      }
      if (phase.at === 'live' && canControl) setDriving(true)
    }
    // Releases matter now: a held arrow is a moving cursor, and the keyup is
    // what stops it. Registered together so neither can outlive the other.
    const onKeyUp = (event: KeyboardEvent): void => {
      if (!driving) return
      if (pointer.current?.key(event.key, false)) event.preventDefault()
    }
    window.addEventListener('keydown', onKey)
    window.addEventListener('keyup', onKeyUp)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('keyup', onKeyUp)
    }
  }, [onClose, phase, driving, canControl, pointerSays.mode])

  const dead = phase.at === 'ended'
  // Frames are moving, so the picture takes the whole television. Everything
  // this surface has to say — which desktop, how to leave — is said while it is
  // connecting and again if it dies; saying it *over* a live desktop costs the
  // screen a header, a footer and a border, and a mirror inside a box on a
  // 55-inch wall is a postcard of a screen rather than the screen.
  const live = phase.at === 'live'
  return (
    <div className={`tv-mirror${live ? ' is-live' : ''}${driving ? ' is-driving' : ''}`}>
      <div className="tv-pane-head">
        <span className="tv-pane-context">Desktop</span>
        <strong className="tv-pane-title">The screen</strong>
        <span className="tv-head-spring" />
        <span className="tv-pane-geom">{phase.at === 'live' ? 'live' : phase.at}</span>
      </div>

      <div className="tv-mirror-stage" ref={stage}>
        <video
          className={`tv-mirror-video${dead ? ' is-dead' : ''}`}
          ref={video}
          autoPlay
          // Not muted. The desktop decides whether the mirror carries sound at
          // all — `mobileMirrorAudio`, read there when this television asks — so
          // muting here would silence a stream the desk deliberately sent. When
          // the setting is off the stream simply has no audio track and this
          // behaves exactly as it did before. The autoplay policy is handled
          // where `play()` is called, not with a permanent mute.
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
        {hud && <TvMirrorStats desk={shown?.desk ?? null} screen={shown?.screen ?? null} />}
        {/* Always mounted while driving, and moved only by transform: the
            pointer writes to this node on an animation frame, and a node React
            might replace under it is a cursor that stops when the picture
            re-renders. The ring is drawn rather than an arrow bitmap so it
            reads at sofa distance over a busy desktop, and it says which
            button is down by changing colour, because there is no second
            cursor to look at. */}
        {driving && (
          <div
            className={`tv-cursor${pointerSays.holding ? ' is-holding' : ''}${
              pointerSays.mode === 'scroll' ? ' is-scrolling' : ''
            }${pointerSays.mode === 'keys' ? ' is-keys' : ''}`}
            ref={cursor}
            aria-hidden="true"
          />
        )}
        {/* The grammar, said over the picture and then taken away.
            A television has no place to put a manual and the wall's own footer
            is hidden while the picture is live (it is the picture's screen, not
            ours) — so this is the only place the six buttons are ever
            explained. A flash rather than a permanent strip, for the reason the
            native layer's mode label gives: by the fourth reading it has
            stopped being help and started being a bar across the desktop. */}
        {/* The keyboard, over the picture. Rendered inside the stage so it sits
            on the desktop it is typing into rather than beside it, and built
            from the same `tv-type` parts as the terminal pane's row because it
            is the same thing doing the same job on the same hardware.

            A form around one field, which is not decoration: a single-input
            form is what gives Chromium something to implicitly submit to, and
            it is half of what decides which button Fire OS puts on its voice
            dialog. `enterKeyHint` is the other half — without both, that dialog
            offers "Next", and a Next is answered by moving focus rather than by
            an Enter anybody here could hear. */}
        {driving && typing && (
          <form
            className="tv-type is-over-mirror"
            onSubmit={(event) => {
              event.preventDefault()
              commit(true)
            }}
            // Focus leaving the *overlay* sends. That is the Next case exactly:
            // the IME moves focus out of the field, no key ever arrives, and
            // the phrase would otherwise sit in a box nobody can press OK in.
            // Leaving the field for one of the caps below is not that — the cap
            // it landed on is the thing about to send it — so the whole form is
            // asked, not the input, and a move inside it is left alone.
            //
            // Having sent, the keyboard goes away and the remote becomes the
            // desktop's keys with the ring on Enter: the words are on the desk
            // and the next press is the one that submits them.
            onBlur={(event) => {
              if (event.currentTarget.contains(event.relatedTarget)) return
              if (!commit(false)) return
              setTyping(false)
              pointer.current?.setMode('keys')
            }}
          >
            <input
              ref={typeEl}
              className="tv-type-input"
              type="text"
              name="phrase"
              value={draft}
              enterKeyHint="send"
              inputMode="text"
              autoCapitalize="sentences"
              autoCorrect="off"
              spellCheck={false}
              placeholder="Talk or type — OK sends it and presses Enter"
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(event) => {
                // Every spelling of the same press. A remote's OK is a plain
                // Enter, an IME's Go/Done/Send is a synthesised one, and the
                // keyCode is there for whatever a Fire OS build sends that
                // matches neither name.
                if (event.key !== 'Enter' && event.key !== 'NumpadEnter' && event.keyCode !== 13) return
                // OK sends what is there *and presses Enter on the desktop*,
                // then leaves the keyboard up: what this screen is for is
                // dictating a prompt into a Claude pane, and a prompt that is
                // not submitted is a walk to the desk. The cap beside it is how
                // to fill a form field instead. An empty box still presses
                // Enter — see `commit`.
                event.preventDefault()
                commit(true)
              }}
            />
            {/* Which one submits, said on the cap rather than in a hint that
                has already faded: these are read from a sofa by somebody who
                has just dictated a sentence and wants to know what happens
                next. Down or Right from the field reaches them. */}
            <div
              className="tv-type-keys"
              ref={keysEl}
              onKeyDown={(event) => walkCaps(event, keysEl.current, typeEl.current)}
            >
              <button type="button" className="tv-type-key" tabIndex={-1} onClick={() => commit(true)}>
                Send + Enter
              </button>
              <button type="button" className="tv-type-key" tabIndex={-1} onClick={() => commit(false)}>
                Send only
              </button>
            </div>
          </form>
        )}
        {/* The desktop's own keys, while the remote is being one.
            Every key `MirrorKey` allows and nothing else — this row is the only
            place in the app that presses one, and until it existed a dictated
            prompt could reach a Claude pane and never be submitted from the
            sofa. Ordered by what a session actually needs: Enter, then the two
            that answer and cycle it, then the rest. Left and Right walk it, OK
            presses, and Up and Down are the desktop's arrows rather than caps
            here, because moving a caret or a page is a hold, not a walk. */}
        {driving && !typing && pointerSays.mode === 'keys' && (
          <div
            className="tv-type tv-keys is-over-mirror"
            ref={keysEl}
            onKeyDown={(event) => walkCaps(event, keysEl.current, null)}
          >
            {MIRROR_CAPS.map(([label, key]) => (
              <button
                type="button"
                key={key}
                className="tv-type-key"
                tabIndex={-1}
                onClick={() => tapKey(key)}
              >
                {label}
              </button>
            ))}
          </div>
        )}
        {driving && hint && !typing && (
          <div className="tv-drive-hint" role="status">
            {pointerSays.mode === 'keys'
              ? 'Up and Down are the desktop’s arrows · Left and Right choose a key · OK presses it · Menu returns to the pointer'
              : pointerSays.mode === 'scroll'
                ? 'Up and Down scroll · Menu again for the desktop’s keys · Back stops driving'
                : 'D-pad points · OK clicks and opens the keyboard · hold OK to drag · Menu scrolls, again for the keys · Back closes the keyboard, then stops driving'}
          </div>
        )}
      </div>

      {/* The same shell as the zoomed pane, on purpose: one head, one well,
          one line at the bottom naming the exits. Two full-screen things that
          framed themselves differently would read as two apps. */}
      <div className="tv-pane-foot">
        {dead ? 'OK tries again · ' : live && canControl ? 'OK drives the desktop · ' : ''}
        {hud ? 'Down hides the numbers' : 'Down shows the numbers'} · Back returns to the wall
      </div>
    </div>
  )
}

/**
 * One sentence naming what is actually holding the picture back.
 *
 * The table below it is the evidence; this is the finding. Ordered by how
 * actionable each cause is rather than how likely: a desktop that is not
 * reporting makes every other number half a story, a hardware decoder that
 * turned out to be a software one cannot be fixed with bitrate, and only after
 * those is it worth reading Chromium's own verdict on the encoder.
 */
function verdictOf(desk: DesktopStats | null, screen: ScreenStats | null): string {
  if (!desk) {
    return 'The desktop is sending no numbers. Forge there is older than this overlay — update it and mirror again.'
  }
  if (screen && screen.decoder !== 'unknown' && !/omx|mediacodec|hardware|c2\./i.test(screen.decoder)) {
    return `This screen is decoding in software (${screen.decoder}). That is the whole problem: no bitrate fixes a dongle doing the work on its CPU.`
  }
  if (desk.limit === 'bandwidth') {
    return 'The network is the ceiling. The encoder wants more room than this wifi is giving it — check the Fire Stick is on 5GHz.'
  }
  if (desk.limit === 'cpu') {
    return 'The desk is the ceiling. That machine cannot encode this screen any faster than it already is.'
  }
  if (desk.width > 0 && desk.srcWidth > 0 && desk.width < desk.srcWidth) {
    return `The desk is sending ${desk.width} wide from a ${desk.srcWidth}-wide screen. Something is still scaling it down.`
  }
  if (screen && screen.frozenSecs > 2) {
    return `Full size, but the picture has been frozen for ${screen.frozenSecs}s in total. That is loss, not resolution.`
  }
  return 'Nothing is limiting the encoder. What is on the wall is the full picture the desk can send.'
}

/**
 * The measurement overlay: what left the desk, and what arrived here.
 *
 * Two columns because the interesting failures live in the gap between them. A
 * desk sending 1920 and a screen decoding 960 is a different fault from both
 * ends agreeing on 960, and a single merged column would hide exactly that.
 *
 * Sized in the wall's own screen-height units like everything else here, and
 * placed over the video rather than beside it: the picture underneath is the
 * thing being judged, and a panel that pushed it out of the way would be
 * measuring a different picture from the one that looked wrong.
 */
function TvMirrorStats({ desk, screen }: { desk: DesktopStats | null; screen: ScreenStats | null }): React.JSX.Element {
  const size = (w: number, h: number): string => (w > 0 && h > 0 ? `${w}×${h}` : '—')
  const limited = desk
    ? [
        desk.limitedBy.bandwidth > 0 ? `${desk.limitedBy.bandwidth}s network` : '',
        desk.limitedBy.cpu > 0 ? `${desk.limitedBy.cpu}s cpu` : '',
        desk.limitedBy.other > 0 ? `${desk.limitedBy.other}s other` : ''
      ]
        .filter(Boolean)
        .join(' · ')
    : ''
  return (
    <div className="tv-mirror-stats" role="status">
      <div className="tv-stats-verdict">{verdictOf(desk, screen)}</div>
      <div className="tv-stats-cols">
        <div className="tv-stats-col">
          <strong>The desk sends</strong>
          {desk ? (
            <dl>
              <dt>Captured</dt>
              <dd>{size(desk.srcWidth, desk.srcHeight)}</dd>
              <dt>Encoded</dt>
              <dd>{size(desk.width, desk.height)}</dd>
              <dt>Rate</dt>
              <dd>
                {desk.fps} fps · {desk.kbps} kbps
              </dd>
              <dt>Codec</dt>
              <dd>{desk.codec.replace(/^video\//i, '')}</dd>
              <dt>Limited by</dt>
              <dd>{desk.limit}</dd>
              {limited !== '' && (
                <>
                  <dt>Spent limited</dt>
                  <dd>{limited}</dd>
                </>
              )}
              <dt>Round trip</dt>
              <dd>{desk.rttMs < 0 ? '—' : `${desk.rttMs} ms`}</dd>
              <dt>Reported lost</dt>
              <dd>
                {desk.lossPct}% · {desk.pli} keyframes asked for
              </dd>
            </dl>
          ) : (
            <p>Nothing yet.</p>
          )}
        </div>
        <div className="tv-stats-col">
          <strong>This screen decodes</strong>
          {screen ? (
            <dl>
              <dt>Decoded</dt>
              <dd>{size(screen.width, screen.height)}</dd>
              <dt>Rate</dt>
              <dd>
                {screen.fps} fps · {screen.kbps} kbps
              </dd>
              <dt>Decoder</dt>
              <dd>{screen.decoder}</dd>
              <dt>Frozen</dt>
              <dd>
                {screen.freezes} times · {screen.frozenSecs}s
              </dd>
              <dt>Lost</dt>
              <dd>{screen.packetsLost} packets</dd>
              <dt>Jitter</dt>
              <dd>{screen.jitterMs} ms</dd>
            </dl>
          ) : (
            <p>Nothing yet.</p>
          )}
        </div>
      </div>
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
