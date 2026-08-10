import { type CSSProperties, type ReactNode } from 'react'
import { Icon } from '@/components/Icon'
import { shortPath } from '../lib/paths'
import { useActiveProject, useForge } from '../state'

/**
 * The desktop's titlebar, minus the two things a browser tab does not have: the
 * reserved strip for Windows' native window controls, and the voice hub button
 * (decision 7 — no voice in the browser).
 *
 * The same `.titlebar` classes as src/components/TitleBar.tsx, so it is the same
 * bar rather than one that resembles it. What replaces the window controls is
 * the connection badge, which on the desktop has no equivalent because there is
 * no link to be honest about.
 */
export function TopBar({ collapsed, onToggleRail }: { collapsed: boolean; onToggleRail: () => void }): ReactNode {
  const { state, actions } = useForge()
  const project = useActiveProject()
  const offline = state.stage.kind === 'offline'
  const desktopName =
    state.picture?.desktopName || (state.stage.kind === 'offline' ? (state.stage.record?.name ?? state.cached?.desktopName ?? '') : '')

  return (
    <header className="titlebar" data-focused="true">
      <div className="titlebar__left">
        <button
          type="button"
          className="ghost-btn titlebar__btn"
          title={collapsed ? 'Show projects' : 'Hide projects'}
          aria-label="Projects rail"
          aria-pressed={!collapsed}
          onClick={onToggleRail}
        >
          <Icon name="panel" size={15} />
        </button>

        <span className="titlebar__mark">
          <Icon name="forge" size={15} />
        </span>
        <span className="titlebar__wordmark">Forge</span>

        {project ? (
          <>
            <span className="titlebar__sep" />
            <span className="titlebar__project truncate" style={{ '--dot': project.color } as CSSProperties}>
              <span className="titlebar__dot" />
              {project.name}
            </span>
            <span className="titlebar__path mono truncate">{shortPath(project.path, 3)}</span>
          </>
        ) : null}
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
