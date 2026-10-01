import { lazy, Suspense, useCallback, useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { EmptyState } from '@/components/EmptyState'
import { Icon } from '@/components/Icon'
import { useMobile } from '../lib/mobile'
import { useNarrow } from '../lib/narrow'
import { publishThemeChoice } from '../lib/theme-choice'
import { isPhoneFace, phoneFaceFromWindow } from '../lib/viewport'
import { useActiveProject, useForge, useWorkspace } from '../state'
import { useWebUpdate } from '../lib/update'
import { AgentChooser } from './AgentChooser'
import { AskBanner } from './AskBanner'
import { BrainConfirm } from './BrainConfirm'
import { MobilePanes } from './MobilePanes'
import { useTextScale } from './MoreSheet'
import { OfflineBanner } from './OfflineBanner'
import { PowerDraw } from './PowerDraw'
import { ProjectSheet } from './ProjectSheet'
import { Rail } from './Rail'
import { SessionComposer } from './SessionComposer'
import { SplitView } from './Panes'
import { TabStrip } from './TabStrip'
import { TopBar } from './TopBar'
import { UpdateBanner } from './UpdateBanner'
// The deck's sheets stay in the entry, in the order Deck.tsx imports them, so
// the cascade is the same one both faces always had; only its code is split off.
import '@/components/shell/deck-tokens.css'
import '@/components/shell/deck.css'
import '../deck/deck.css'
import '../deck/voicebar.css'
import '../deck/paneface.css'
import { useDeckTheme } from '../deck/theme'
import { useBarPlace, useDeckView } from '../deck/view'
import { DeckKeys } from '../deck/VoiceBar'

// Rarely opened, so it is not worth its own share of every phone's initial
// download: see the xterm WebGL addon in lib/terminals.ts for the same pattern.
const Mirror = lazy(() => import('./Mirror').then((m) => ({ default: m.Mirror })))
// Only with the desktop asleep and GitHub mode picked: same reasoning.
const GitHubMode = lazy(() => import('./GitHubMode').then((m) => ({ default: m.GitHubMode })))

/**
 * The toast is a button now, and a button centres its text; the sentence reads
 * from the start, with the close cross at the end.
 */
const NOTICE_LAYOUT: CSSProperties = { display: 'flex', alignItems: 'center', gap: 10, textAlign: 'start', cursor: 'pointer' }

/**
 * The deck face (desktop browser only), split off so a phone never downloads
 * it. Fetched as this module loads on anything that is not a phone, so it is
 * normally in hand long before the connection lets the Workspace mount.
 */
const loadDeck = (): Promise<typeof import('../deck/Deck')> => import('../deck/Deck')
// A prefetch hint only: `useMobile` still picks the face. (No `?phone` dev
// override here — that just prefetches a chunk the dev preview never draws.)
if (!isPhoneFace(phoneFaceFromWindow(false))) void loadDeck()
const DeckBackdrop = lazy(() => loadDeck().then((m) => ({ default: m.DeckBackdrop })))
const DeckStage = lazy(() => loadDeck().then((m) => ({ default: m.DeckStage })))
const DeckDock = lazy(() => loadDeck().then((m) => ({ default: m.DeckDock })))
const DeckSheetHost = lazy(() => loadDeck().then((m) => ({ default: m.DeckSheetHost })))

/**
 * Forge Web: three regions, two faces, not a copy of the desktop IDE.
 *
 *   1. App chrome — top bar and sidebar.
 *   2. The terminal display.
 *   3. One text box, talking to the focused pane.
 *
 * A wide browser uses the space (sidebar, padded well, centred composer). A
 * phone is a different face: drawer, full-bleed display, thumb-sized dock.
 * Electron Forge is untouched. Decision 7 still keeps voice, tray and settings
 * off this URL.
 *
 * ## Three states, one shell
 *
 * Live, reconnecting and asleep all draw this same furniture, and the difference
 * between them is a strip under the titlebar plus what the panes will accept.
 * That is deliberate and it is decision 10's rule applied one state wider: Forge
 * asleep must not look like Forge broken, and neither must Forge on a socket
 * that hiccupped. Blanking the page for a reconnect used to cost every terminal
 * in it — see `PaneView` — which is a great deal to spend on a spinner.
 */
export function Workspace(): ReactNode {
  const { state, actions } = useForge()
  const project = useActiveProject()
  const workspace = useWorkspace()
  const [railCollapsed, setRailCollapsed] = useState(false)
  const narrow = useNarrow()
  /**
   * A thumb on a phone. See lib/mobile.ts for the test; what it changes here is
   * the arrangement and nothing underneath it — the rail is a drawer over the
   * terminal rather than a column beside it, one pane is on screen at a time,
   * and the pane on screen takes the grid so it is readable (see PaneView). The
   * coloured terminal stays on screen; typing happens in the composer docked
   * over it. A mouse in a narrow window still gets the folded desktop layout below.
   */
  const mobile = useMobile()
  /**
   * Not a phone: the deck face (web/src/deck), the redesigned desktop app's
   * look — top bar, the Wall, the dock, sheets. The theme is applied here, in
   * render, so it is on the root before any terminal reads its palette — on
   * both faces now: the phone picks it in its More sheet (lib/theme-choice.ts),
   * and Volt, the default, is exactly tokens.css, so a phone that never picks
   * one looks as it always has.
   */
  const deck = !mobile
  const { themeId, setTheme } = useDeckTheme(true)
  useEffect(() => publishThemeChoice({ themeId, setTheme }), [themeId, setTheme])
  const [deckView, setDeckView] = useDeckView()
  const [barPlace, setBarPlace] = useBarPlace()
  const [drawerOpen, setDrawerOpen] = useState(false)
  /** PowerDraw, the phone's one-hand project drum on the right edge. */
  const [drumOpen, setDrumOpen] = useState(false)
  // Collapsed by the click, or collapsed by the window. One flag either way, so
  // the rail has one set of markup rather than a full row squeezed into 56px.
  // The drawer is the exception: it is the full rail or nothing.
  const collapsed = mobile ? false : railCollapsed || narrow
  // Picking a project is why the drawer was opened; the pick closes it.
  useEffect(() => {
    setDrawerOpen(false)
    setDrumOpen(false)
  }, [state.projectId])
  const newTabRef = useRef<HTMLButtonElement | null>(null)
  const [chooserOpen, setChooserOpen] = useState(false)
  /**
   * "New agent here" in the project sheet, and the end of adding a project:
   * select it, put the sheet away and open the agent chooser — one step where
   * there used to be three.
   */
  const currentProjectId = state.projectId
  const newAgentIn = useCallback(
    (projectId: string) => {
      if (projectId !== currentProjectId) actions.selectProject(projectId)
      setDrawerOpen(false)
      setChooserOpen(true)
    },
    [actions, currentProjectId]
  )
  const closeDrawer = useCallback(() => setDrawerOpen(false), [])
  const openDrum = useCallback(() => setDrumOpen(true), [])
  const closeDrum = useCallback(() => setDrumOpen(false), [])
  const offline = state.stage.kind === 'offline'
  const live = !offline && state.connection.state === 'live'
  /**
   * Is the screen mirror open?
   *
   * Mounted rather than hidden, because mounting *is* the request: the overlay
   * asks the desktop for its screen when it appears and tells it to stop when it
   * goes away, so a hidden one would leave a capture running — and an OS
   * notification standing — for something nobody can see. See Mirror.tsx.
   */
  const [watching, setWatching] = useState(false)
  /**
   * "A newer Forge Web is deployed." Asked here and handed to the banner, so
   * the question is asked once per page — see UpdateBanner for why it is a
   * strip and not the titlebar chip it replaced.
   */
  const update = useWebUpdate()

  const activeTabId =
    (workspace.tabs.find((t) => t.id === workspace.activeTabId) ?? workspace.tabs[0])?.id ?? null

  /**
   * Which tabs have been looked at, and therefore stay drawn.
   *
   * Mounting only the active tab meant flipping between two tabs disposed every
   * xterm in one and rebuilt every xterm in the other, which is a detach, an
   * attach and a replay per pane for a gesture that moves nothing. So a tab that
   * has been on screen once stays mounted and is hidden with CSS instead — the
   * `fit()` in lib/term.ts refuses to measure a container under 8px, which is
   * what stops a hidden tab resizing its PTYs to nonsense while it waits.
   *
   * Mounted on first *view* rather than all at once, because the alternative is
   * paying for every tab's catch-up buffer on every connection — sixteen panes
   * at up to MAX_REPLAY_BYTES each — to save a wait nobody has asked for yet. A
   * ref rather than state because this is derived from what is already being
   * rendered and adding it to state would cost a second render on every switch.
   */
  const drawn = useRef(new Set<string>())
  if (activeTabId) drawn.current.add(activeTabId)

  /** A− / A+ from the ⋯ sheet, as `--phone-text-scale`. A later change applies it. */
  const [textScale] = useTextScale()

  /**
   * The toast. At the desk it floats at the foot of the window as it always
   * has; on a phone it sits in the display, just above the answer card and the
   * composer — whatever height they are — so it never lands on Send. A tap
   * puts it away, on either: a real button, so a keyboard and a screen reader
   * can put it away too, with the close cross as the shape that says so
   * (`title` never shows on a touch screen).
   */
  const notice = state.notice ? (
    <button
      type="button"
      className="notice"
      aria-live="polite"
      data-testid="notice"
      onClick={actions.dismissNotice}
      style={NOTICE_LAYOUT}
    >
      <span style={{ flex: '1 1 auto', minWidth: 0 }}>{state.notice}</span>
      <Icon name="close" size={14} />
    </button>
  ) : null
  /**
   * One strip at a time on a phone, by priority, rather than up to five
   * stacked over the terminal: admin prompt (a two-minute window), then asleep,
   * then the dropped link, then the desktop's window rebuilding, then a new
   * deploy. Each gate below is the strip's own `return null` test, so the one
   * chosen is always one that draws. The desk keeps its stack.
   */
  const strip: 'remote-yes' | 'offline' | 'reconnecting' | 'recovering' | 'update' | null =
    state.stage.kind === 'connected' && state.remoteYes.enabled && state.remoteYes.uac
      ? 'remote-yes'
      : offline
        ? 'offline'
        : state.stage.kind === 'connected' && state.connection.state !== 'live'
          ? 'reconnecting'
          : state.stage.kind === 'connected' && state.desktopRecovering
            ? 'recovering'
            : update.available
              ? 'update'
              : null
  const stripShown = (which: NonNullable<typeof strip>): boolean => !mobile || strip === which
  const gridShown = !(offline && state.offlineMode === 'github')

  // Nothing here listens for a window resize, on purpose: a window resize
  // changes every pane container's box, and each terminal's own ResizeObserver
  // (see lib/term.ts) already fits and reports on exactly that. A second
  // refit-everything path would send a duplicate `resize` per pane per drag.

  return (
    <div
      className={deck ? 'app deck' : 'app'}
      data-ready="true"
      data-shell={deck ? 'deck' : 'app'}
      data-face={deck ? 'deck' : undefined}
      data-bar={deck ? barPlace : undefined}
      data-mobile={mobile ? 'true' : undefined}
      style={mobile ? ({ '--phone-text-scale': textScale } as CSSProperties) : undefined}
    >
      {/*
        The lazy deck pieces wait with nothing drawn: the deck theme's tokens are
        already on the root (useDeckTheme, above), so the page behind them is the
        theme's own base colour while the chunk lands — normally already in hand.
      */}
      {deck ? (
        <Suspense fallback={null}>
          <DeckBackdrop themeId={themeId} />
        </Suspense>
      ) : null}
      <TopBar
        collapsed={mobile ? !drawerOpen : collapsed}
        onToggleRail={() => (mobile ? setDrawerOpen((v) => !v) : setRailCollapsed((v) => !v))}
        onWatchScreen={live ? () => setWatching(true) : null}
        mobile={mobile}
        deck={
          deck
            ? { view: deckView, onView: setDeckView, place: barPlace, onPlace: setBarPlace, themeId, onTheme: setTheme }
            : undefined
        }
      />
      {/*
        Above everything, including the reconnect strip: a UAC prompt is a
        two-minute window on a machine that is doing nothing until somebody
        answers it, and the person holding this phone may be on a bus.
      */}
      {stripShown('remote-yes') ? <RemoteYesBanner /> : null}
      {stripShown('offline') ? <OfflineBanner /> : null}
      {stripShown('reconnecting') ? <ReconnectingBanner /> : null}
      {/*
        Above the reconnect strip in the source and below it on screen, and the
        ordering is a judgement about which sentence is more useful when both
        are true. A dropped link is the bigger fact — nothing at all is getting
        through — so it keeps the top. This one only ever matters when the link
        is up, which is exactly why it is easy to miss without it.
      */}
      {stripShown('recovering') ? <RecoveringBanner /> : null}
      {/*
        Last of the three strips, deliberately: a deploy you have not reloaded
        into is the least urgent thing on a page that may also be asleep or
        mid-redial, and the strips stack in that order.
      */}
      {stripShown('update') ? <UpdateBanner update={update} /> : null}
      {deck ? (
        <main className="dk-stage">
          {/* GitHub mode swaps in for the stage and nothing else, as it does below. */}
          {offline && state.offlineMode === 'github' ? (
            <Suspense fallback={null}>
              <GitHubMode />
            </Suspense>
          ) : (
            <Suspense fallback={null}>
            <DeckStage
              view={deckView}
              onView={setDeckView}
              drawn={drawn.current}
              empty={
                !project ? (
                  <EmptyState
                    icon="folder"
                    eyebrow="Forge"
                    title="No project selected"
                    body={
                      barPlace === 'top'
                        ? 'Pick one from the project pill in the bar above, or add a folder from that desktop there.'
                        : 'Pick one from the project at the left of the bar below, or add a folder from that desktop there.'
                    }
                  />
                ) : !activeTabId ? (
                  <EmptyState
                    icon="terminal"
                    eyebrow={project.name}
                    title="No terminals open"
                    body={
                      <>
                        Open one in <span className="mono">{project.path}</span>. It opens on the desktop too — this
                        browser mirrors that machine rather than running its own.
                      </>
                    }
                    action={
                      <button
                        ref={newTabRef}
                        type="button"
                        className="cta-btn"
                        disabled={!live}
                        onClick={() => setChooserOpen(true)}
                      >
                        <Icon name="plus" size={14} />
                        Open a terminal
                      </button>
                    }
                  />
                ) : null
              }
            />
            </Suspense>
          )}
        </main>
      ) : (
      <div className="app__body">
        {/*
          On a phone the rail is not drawn at all: the ☰ opens the project
          sheet instead (below, over everything). A tap on any project row
          closes it, the current one included.
        */}
        {mobile ? null : (
          <aside className="app__left" data-collapsed={collapsed}>
            <Rail collapsed={collapsed} />
          </aside>
        )}
        <main className="app__main">
          {/*
            The one swap in the whole shell. GitHub mode replaces the terminal
            grid and nothing else: the titlebar, the offline strip, the rail and
            the theme are the same objects either way, because decision 9 and
            decision 10 are two halves of "the desktop is off" rather than two
            applications. See OfflineBanner, which holds the switch.
          */}
          {offline && state.offlineMode === 'github' ? (
            <Suspense fallback={null}>
              <GitHubMode />
            </Suspense>
          ) : (
          <div className="grid">
            <TabStrip mobile={mobile} />
            <div className="app__display grid__body" data-region="display">
              {!project ? (
                <EmptyState
                  icon="folder"
                  eyebrow="Forge"
                  title="No project selected"
                  body={
                    mobile
                      ? 'Open the project list at the top left to pick one, or to add a folder from that desktop.'
                      : 'Pick one in the rail, or press + there to look through that desktop’s folders and add one.'
                  }
                />
              ) : activeTabId ? (
                workspace.tabs
                  .filter((t) => drawn.current.has(t.id))
                  .map((t) => (
                    <div className="grid__tab" key={t.id} data-active={t.id === activeTabId}>
                      {mobile ? (
                        <MobilePanes node={t.root} activePaneId={t.activePaneId} onScreen={t.id === activeTabId} />
                      ) : (
                        <SplitView node={t.root} activePaneId={t.activePaneId} onScreen={t.id === activeTabId} />
                      )}
                    </div>
                  ))
              ) : (
                <EmptyState
                  icon="terminal"
                  eyebrow={project.name}
                  title="No terminals open"
                  body={
                    <>
                      Open one in <span className="mono">{project.path}</span>. It opens on the desktop too — this
                      browser mirrors that machine rather than running its own.
                    </>
                  }
                  action={
                    <button
                      ref={newTabRef}
                      type="button"
                      className="cta-btn"
                      disabled={!live}
                      onClick={() => setChooserOpen(true)}
                    >
                      <Icon name="plus" size={14} />
                      Open a terminal
                    </button>
                  }
                />
              )}
              {mobile ? notice : null}
              {mobile ? <AskBanner /> : null}
              {/* Forge Brain waiting on a yes: over the display's top, and over the banner. */}
              {mobile && !offline ? <BrainConfirm face="phone" /> : null}
            </div>
            <SessionComposer />
          </div>
          )}
        </main>
      </div>
      )}

      {deck ? (
        <Suspense fallback={null}>
          <DeckDock place={barPlace} />
        </Suspense>
      ) : null}
      {deck ? <DeckKeys view={deckView} onView={setDeckView} place={barPlace} /> : null}
      {/* Forge Brain waiting on a yes: a tile under the bar, whatever the stage shows. */}
      {deck && !offline ? <BrainConfirm face="deck" /> : null}

      {mobile && gridShown ? null : notice}

      {watching ? (
        <Suspense fallback={null}>
          <Mirror onClose={() => setWatching(false)} />
        </Suspense>
      ) : null}

      {mobile ? <ProjectSheet open={drawerOpen} onClose={closeDrawer} onNewAgent={newAgentIn} /> : null}
      {mobile ? (
        <PowerDraw open={drumOpen} onOpen={openDrum} onClose={closeDrum} hidden={drawerOpen || watching} />
      ) : null}

      <AgentChooser
        anchor={newTabRef.current}
        open={chooserOpen}
        onClose={() => setChooserOpen(false)}
        onPick={(profileId, permissionMode) => void actions.layout({ op: 'create-tab', profileId, permissionMode })}
        onChat={(bot) => {
          void actions.layout({ op: 'newChatTab', bot }).then((refused) => {
            if (refused) actions.setNotice(refused)
          })
        }}
        selectedId={project?.defaultProfileId}
      />
      {deck ? (
        <Suspense fallback={null}>
          <DeckSheetHost />
        </Suspense>
      ) : null}
    </div>
  )
}

/**
 * "The link dropped and this page is getting it back."
 *
 * `OfflineBanner`'s strip, in the connecting palette, and that pairing is the
 * whole design of it. The *shape* is shared because the news is the same shape —
 * what is on screen is real but not live right now, here is why, here is the one
 * thing you can do — and the colour differs because the recovery does: asleep
 * needs somebody to wake a machine, this needs nothing but a moment. The link
 * badge in the titlebar has spent `--info` on exactly this state since the day
 * it was written, so the strip is agreeing with it rather than inventing a
 * second vocabulary. Compare `.ghfail[data-reason]`, which is the same band in
 * two palettes for the same reason.
 *
 * Only ever drawn over a picture that has already arrived — `App` sends a first
 * connection to the full-page gate — so it is never the whole of what somebody
 * is looking at.
 */
function ReconnectingBanner(): ReactNode {
  const { state, actions } = useForge()
  const mobile = useMobile()
  if (state.stage.kind !== 'connected' || state.connection.state === 'live') return null
  const name = state.picture?.desktopName || 'the desktop'

  return (
    <div className="offline" data-link="reconnecting" role="status" data-testid="reconnecting-banner">
      <Icon name="restart" size={mobile ? 16 : 13} />
      {mobile ? (
        <span className="offline__text">
          <strong>The link to {name} dropped.</strong> Reconnecting. Nothing you type gets through until it is back.
        </span>
      ) : (
        <span className="offline__text truncate">
          <strong>The link to {name} dropped.</strong> This is where the terminals had got to; they repaint themselves
          when it comes back, and nothing can be typed into them until it does.
        </span>
      )}
      <span className="offline__actions">
        <button type="button" className="ghost-btn offline__look" onClick={() => actions.retry()}>
          Try now
        </button>
      </span>
    </div>
  )
}

/**
 * "The desktop's window is being rebuilt. Nothing you press lands yet."
 *
 * The third of these strips, and the only one that appears while the link is
 * perfectly healthy — which is the entire reason it exists. Every command this
 * page sends is carried out by the desktop's *renderer*; terminal output is
 * not, it comes from the main process. So a renderer that has crashed, hung, or
 * quietly unmounted leaves a page whose panes still scroll, whose badge still
 * says live, and whose every button silently does nothing. Without a sentence
 * here that reads as a bug in this page, and people reload it, and reloading it
 * does not help, because it was never this page.
 *
 * No button. `ReconnectingBanner` offers "Try now" because there is something
 * this browser can do; here there is not — the desktop is already reloading
 * itself and will say so when it is back. Offering an action that changes
 * nothing would be worse than offering none.
 *
 * `OfflineBanner`'s band in the reconnect palette, deliberately borrowed rather
 * than invented: same shape of news (what is on screen is real, this is why it
 * is not answering, it is coming back), same colour as the other wait.
 */
/**
 * "Windows is asking for admin. Open RustDesk and press Yes."
 *
 * The browser's copy of the card Forge Mobile draws (mobile/src/App.tsx). The
 * button is a real link to `rustdesk://`, not a script: Android Chrome hands a
 * custom scheme in an anchor to the app that owns it, and a phone with no
 * RustDesk simply does nothing — so the sentence beside it says where to get
 * it. Warn amber, the strip's own waiting colour, and every bit of the meaning
 * is in the words. See `WebRemoteYesFrame` in shared/web.ts.
 */
function RemoteYesBanner(): ReactNode {
  const { state } = useForge()
  const ry = state.remoteYes
  if (state.stage.kind !== 'connected' || !ry.enabled || !ry.uac) return null

  return (
    <div className="offline remote-yes" data-link="remote-yes" role="alert" data-testid="remote-yes-banner">
      <Icon name="key" size={13} />
      <span className="offline__text truncate">
        <strong>{state.picture?.desktopName || 'The desktop'} is asking for admin.</strong> Open RustDesk and press
        Yes. It waits about two minutes.
      </span>
      <span className="offline__actions">
        <a className="ghost-btn offline__look remote-yes__open" href={rustDeskLink(ry.address)} rel="noopener">
          Open RustDesk
        </a>
      </span>
    </div>
  )
}

/**
 * The deep link RustDesk's Android app answers to: straight into a session
 * with this PC. No password in it — the app remembers one.
 */
export function rustDeskLink(address: string): string {
  return address ? `rustdesk://connection/new/${address}` : 'https://github.com/rustdesk/rustdesk/releases/latest'
}

function RecoveringBanner(): ReactNode {
  const { state } = useForge()
  if (state.stage.kind !== 'connected' || !state.desktopRecovering) return null

  return (
    <div className="offline" data-link="recovering" role="status" data-testid="recovering-banner">
      <Icon name="restart" size={13} />
      <span className="offline__text truncate">
        <strong>{state.picture?.desktopName || 'The desktop'} is restarting its window.</strong> The terminals below are
        still live and still scrolling; tabs, panes and buttons start working again the moment it comes back.
      </span>
    </div>
  )
}
