import { useEffect, type CSSProperties, type ReactNode } from 'react'
import { Icon } from '@/components/Icon'
import { useWebUpdate } from '../lib/update'
import { useActiveProject, useForge } from '../state'

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
  const project = useActiveProject()
  const update = useWebUpdate()
  const offline = state.stage.kind === 'offline'
  const desktopName =
    state.picture?.desktopName || (state.stage.kind === 'offline' ? (state.stage.record?.name ?? state.cached?.desktopName ?? '') : '')

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
          A newer Forge Web is deployed. It pulses until pressed and the press
          is a reload — see lib/update.ts for why nothing happens on its own.
        */}
        {update.available ? (
          <button
            type="button"
            className="titlebar__update"
            title="A newer Forge Web has been deployed — press to reload into it"
            onClick={update.apply}
          >
            <Icon name="refresh" size={13} />
            <span>Update</span>
          </button>
        ) : null}

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

        <button
          type="button"
          className="ghost-btn titlebar__btn"
          title={state.session ? `Signed in as ${state.session.email} — sign out` : 'Sign out'}
          aria-label="Sign out"
          onClick={() => actions.signOut()}
        >
          <Icon name="user" size={15} />
        </button>
      </div>
    </header>
  )
}
