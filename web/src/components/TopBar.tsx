import { useEffect, type CSSProperties, type ReactNode } from 'react'
import { Icon } from '@/components/Icon'
import { useActiveProject, useForge, useWorkspace } from '../state'

/**
 * The app bar. Same tokens as the desktop, different job: identity, the
 * project, and whether the link is live. No window controls, no voice
 * (decision 7). On a phone it is the project, one row.
 */
export function TopBar({
  collapsed,
  onToggleRail,
  onWatchScreen,
  mobile = false
}: {
  collapsed: boolean
  onToggleRail: () => void
  /** Open the screen mirror. Absent while there is no live desktop to ask. */
  onWatchScreen: (() => void) | null
  /** Phone layout. The project identity takes the top of the page. */
  mobile?: boolean
}): ReactNode {
  const { state, actions } = useForge()
  const workspace = useWorkspace()
  const project = useActiveProject()
  const offline = state.stage.kind === 'offline'
  const desktopName =
    state.picture?.desktopName || (state.stage.kind === 'offline' ? (state.stage.record?.name ?? state.cached?.desktopName ?? '') : '')

  const tab = workspace.tabs.find((t) => t.id === workspace.activeTabId) ?? workspace.tabs[0]
  const activePaneId = tab?.activePaneId ?? null

  const onClosePane = () => {
    if (!activePaneId) return
    void actions.layout({ op: 'close-pane', paneId: activePaneId })
  }

  useEffect(() => {
    document.title = project ? `${project.name} · Forge` : 'Forge'
    return () => {
      document.title = 'Forge'
    }
  }, [project])

  const tint = project ? ({ '--dot': project.color } as CSSProperties) : undefined

  return (
    <header className="titlebar" data-focused="true" style={tint}>
      <div className="titlebar__left">
        <button
          type="button"
          className="ghost-btn titlebar__btn"
          title={collapsed ? 'Show projects' : 'Hide projects'}
          aria-label="Projects rail"
          aria-pressed={!collapsed}
          onClick={onToggleRail}
        >
          <Icon name="panel" size={mobile ? 18 : 15} />
        </button>

        {mobile ? (
          <h1 className="titlebar__project">
            {project ? (
              <>
                <span className="titlebar__dot" />
                <span className="truncate">{project.name}</span>
              </>
            ) : (
              'Forge'
            )}
          </h1>
        ) : (
          <>
            <span className="titlebar__mark">
              <Icon name="forge" size={15} />
            </span>
            <span className="titlebar__wordmark">Forge</span>
            {project ? (
              <>
                <span className="titlebar__sep" />
                <span className="titlebar__project truncate">
                  <span className="titlebar__dot" />
                  {project.name}
                </span>
              </>
            ) : null}
          </>
        )}
      </div>

      <div className="titlebar__right">
        {/*
          The connection badge. Three states and not two: "connected" and
          "connected but the link has gone quiet" are different things to a
          person deciding whether their last keystroke arrived, and the app-level
          ping in shared/web.ts exists for no other reason than to tell them
          apart.
        */}
        <span
          className="linkbadge"
          data-state={offline ? 'offline' : state.connection.state}
          data-warm={state.warm ? 'true' : undefined}
          title={
            offline
              ? 'The desktop is not answering — this is the last picture it sent.'
              : state.connection.state === 'live'
                ? state.warm
                  ? `Mirroring ${desktopName || 'the desktop'}`
                  : `Connected to ${desktopName || 'the desktop'}, but the link has gone quiet`
                : 'Not connected'
          }
        >
          <span className="linkbadge__dot" />
          <span className="linkbadge__text truncate">
            {offline ? 'Asleep' : state.connection.state === 'live' ? desktopName || 'Live' : 'Connecting'}
          </span>
        </span>

        {/*
          The desktop's own screen. Only while the link is live, because it is
          the one control here that cannot mean anything against a cached
          picture: there is no frozen screenshot to show and nothing to ask.
          Everything about whether it is *allowed* is decided on that machine —
          the setting, the second factor, the escalation guard — so this button
          asks and the answer arrives in the overlay.
        */}
        {onWatchScreen ? (
          <button
            type="button"
            className="ghost-btn titlebar__btn"
            title={`Watch ${desktopName || 'this desktop'}’s screen`}
            aria-label="Watch this desktop’s screen"
            onClick={onWatchScreen}
          >
            <Icon name="screen" size={15} />
          </button>
        ) : null}

        {/*
          Desktop notifications, asked for here and nowhere else. A permission
          prompt is only honoured behind a user gesture, so this bell is the
          one place the question is raised — pressed while the answer is still
          "default", merely stating it once it has been given or refused. What
          it buys: a pane that asks a question while this tab is hidden says so
          outside the tab as well.
        */}
        {state.notifyPermission !== 'unsupported' ? (
          <button
            type="button"
            className="ghost-btn titlebar__btn"
            data-permission={state.notifyPermission}
            title={
              state.notifyPermission === 'granted'
                ? state.pushActive
                  ? 'Notifications are on — a pane asking for you will reach this browser even with the tab closed'
                  : 'Notifications are on — a pane asking for you will raise one while this tab is hidden'
                : state.notifyPermission === 'denied'
                  ? 'Desktop notifications were refused — allow them for this site in the browser’s settings if you want them'
                  : 'Allow desktop notifications, so a pane that needs you while this tab is hidden can say so'
            }
            aria-label={`Desktop notifications: ${state.notifyPermission}${state.pushActive ? ', push armed' : ''}`}
            data-push={state.pushActive ? 'true' : undefined}
            onClick={() => {
              if (state.notifyPermission === 'default') void actions.requestNotifyPermission()
            }}
          >
            <Icon name={state.notifyPermission === 'granted' ? 'check' : 'note'} size={15} />
          </button>
        ) : null}

        <button
          type="button"
          className="ghost-btn titlebar__btn"
          title={state.session ? `Signed in as ${state.session.email} — sign out` : 'Sign out'}
          aria-label="Sign out"
          onClick={() => actions.signOut()}
        >
          <Icon name="user" size={15} />
        </button>

        {/* Red X close active tab/terminal button in the top right-hand corner */}
        {activePaneId ? (
          <button
            type="button"
            className="ghost-btn titlebar__btn titlebar__btn--close"
            data-danger="true"
            title="Close active terminal"
            aria-label="Close active terminal"
            onClick={onClosePane}
          >
            <Icon name="close" size={15} />
          </button>
        ) : null}
      </div>
    </header>
  )
}
