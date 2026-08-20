import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { EmptyState } from '@/components/EmptyState'
import { Icon } from '@/components/Icon'
import { useMobile } from '../lib/mobile'
import { useNarrow } from '../lib/narrow'
import { useActiveProject, useForge, useWorkspace } from '../state'
import { AgentChooser } from './AgentChooser'
import { GitHubMode } from './GitHubMode'
import { ComposeRow, KeyBar } from './KeyBar'
import { MobilePanes } from './MobilePanes'
import { Mirror } from './Mirror'
import { OfflineBanner } from './OfflineBanner'
import { Rail } from './Rail'
import { SplitView } from './Panes'
import { TabStrip } from './TabStrip'
import { TopBar } from './TopBar'

/**
 * Forge, as the browser draws it: the desktop's `.app` shell — titlebar, rail,
 * main — with the terminal grid inside it.
 *
 * The layout classes are the desktop's own, so this is the same application
 * furniture rather than a lookalike. What is missing from it is missing because
 * decision 7 says so: no screenshot tray, no voice hub, no overlay, no tasks
 * board, no settings page. A browser tab has none of the hardware any of those
 * are attached to, and a public URL that could reach them would be a different
 * risk class.
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
   * and the keys a phone keyboard lacks sit along the bottom. A mouse in a
   * narrow window still gets the folded desktop layout below.
   */
  const mobile = useMobile()
  const [drawerOpen, setDrawerOpen] = useState(false)
  // Collapsed by the click, or collapsed by the window. One flag either way, so
  // the rail has one set of markup rather than a full row squeezed into 56px.
  // The drawer is the exception: it is the full rail or nothing.
  const collapsed = mobile ? false : railCollapsed || narrow
  // Picking a project is why the drawer was opened; the pick closes it.
  useEffect(() => setDrawerOpen(false), [state.projectId])
  /** The pane the key bar types into: whichever one is on screen. */
  const [viewingPane, setViewingPane] = useState<string | null>(null)
  const onViewing = useCallback((id: string) => setViewingPane(id), [])
  const [composing, setComposing] = useState(false)
  const newTabRef = useRef<HTMLButtonElement | null>(null)
  const [chooserOpen, setChooserOpen] = useState(false)
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

  // Nothing here listens for a window resize, on purpose: a window resize
  // changes every pane container's box, and each terminal's own ResizeObserver
  // (see lib/term.ts) already fits and reports on exactly that. A second
  // refit-everything path would send a duplicate `resize` per pane per drag.

  return (
    <div className="app" data-ready="true" data-mobile={mobile ? 'true' : undefined}>
      <TopBar
        collapsed={mobile ? !drawerOpen : collapsed}
        onToggleRail={() => (mobile ? setDrawerOpen((v) => !v) : setRailCollapsed((v) => !v))}
        onWatchScreen={live ? () => setWatching(true) : null}
      />
      <OfflineBanner />
      <ReconnectingBanner />
      <div className="app__body">
        {mobile && drawerOpen ? (
          <div className="mdrawer__scrim" onClick={() => setDrawerOpen(false)} aria-hidden="true" />
        ) : null}
        <aside className="app__left" data-collapsed={collapsed} data-drawer={mobile ? (drawerOpen ? 'open' : 'closed') : undefined}>
          <Rail collapsed={collapsed} />
        </aside>
        <main className="app__main">
          {/*
            The one swap in the whole shell. GitHub mode replaces the terminal
            grid and nothing else: the titlebar, the offline strip, the rail and
            the theme are the same objects either way, because decision 9 and
            decision 10 are two halves of "the desktop is off" rather than two
            applications. See OfflineBanner, which holds the switch.
          */}
          {offline && state.offlineMode === 'github' ? (
            <GitHubMode />
          ) : (
          <div className="grid">
            <TabStrip />
            <div className="grid__body">
              {!project ? (
                <EmptyState
                  icon="folder"
                  eyebrow="Forge"
                  title="No project selected"
                  body="Pick one in the rail, or press + there to look through that desktop’s folders and add one."
                />
              ) : activeTabId ? (
                workspace.tabs
                  .filter((t) => drawn.current.has(t.id))
                  .map((t) => (
                    <div className="grid__tab" key={t.id} data-active={t.id === activeTabId}>
                      {mobile ? (
                        <MobilePanes
                          node={t.root}
                          activePaneId={t.activePaneId}
                          onScreen={t.id === activeTabId}
                          onViewing={onViewing}
                        />
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
            </div>
          </div>
          )}
          {/*
            The keys a phone keyboard has not got, aimed at the pane on screen.
            Only with a live pane to type into: against a frozen or reconnecting
            desktop the bar would be a row of buttons that do nothing, which is
            worse than no row.
          */}
          {mobile && live && activeTabId && viewingPane && !(offline && state.offlineMode === 'github') ? (
            composing ? (
              <ComposeRow onSend={(d) => actions.write(viewingPane, d)} onClose={() => setComposing(false)} />
            ) : (
              <KeyBar onSend={(d) => actions.write(viewingPane, d)} onCompose={() => setComposing(true)} />
            )
          ) : null}
        </main>
      </div>

      {state.notice ? (
        <div className="notice" role="status">
          {state.notice}
        </div>
      ) : null}

      {watching ? <Mirror onClose={() => setWatching(false)} /> : null}

      <AgentChooser
        anchor={newTabRef.current}
        open={chooserOpen}
        onClose={() => setChooserOpen(false)}
        onPick={(profileId, permissionMode) => void actions.layout({ op: 'create-tab', profileId, permissionMode })}
        selectedId={project?.defaultProfileId}
      />
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
  if (state.stage.kind !== 'connected' || state.connection.state === 'live') return null

  return (
    <div className="offline" data-link="reconnecting" role="status" data-testid="reconnecting-banner">
      <Icon name="restart" size={13} />
      <span className="offline__text truncate">
        <strong>The link to {state.picture?.desktopName || 'the desktop'} dropped.</strong> This is where the terminals
        had got to; they repaint themselves when it comes back, and nothing can be typed into them until it does.
      </span>
      <button type="button" className="ghost-btn offline__look" onClick={() => actions.retry()}>
        Try now
      </button>
    </div>
  )
}
