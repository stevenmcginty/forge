import { type ReactNode } from 'react'
import { Icon } from '@/components/Icon'
import { useForge } from '../state'
import { SwitchAccount } from './Connection'

/**
 * "Forge is asleep on that machine, and this is what it last looked like."
 *
 * Decision 10 in docs/forge-web.md: the desktop being off must not look like
 * Forge being broken. So the app is drawn from the cached picture rather than
 * blanked, and this strip is what stops that being a lie — it says the picture
 * is frozen, says when it was taken, and offers the one action that can change
 * anything, which is looking again.
 *
 * It sits directly under the titlebar and pushes the whole app down, exactly
 * where `UpdateBanner` and `StaleBanner` sit on the desktop, so the layout below
 * it is unchanged rather than overlapped.
 *
 * ## Phase 4 lives here now
 *
 * This was the seam, and this is what came through it. Offline mode has two
 * halves — the desktop's last picture (decision 10) and the repository read
 * straight from GitHub, with edits committed to a `forge-web/*` branch
 * (decision 9) — and the switch between them is on this strip because this
 * strip is already the sentence that says the picture is frozen. It is the
 * place somebody is standing at the moment they decide they would rather have
 * the files.
 *
 * The switch is a switch and not a link away: the rail, the titlebar and the
 * theme do not change, the terminals stay exactly as frozen as they were, and
 * `Workspace` swaps what is inside the grid. GitHub mode is a mode.
 */
export function OfflineBanner(): ReactNode {
  const { state, actions } = useForge()
  if (state.stage.kind !== 'offline') return null

  const when = state.cached?.at ?? 0
  const name = state.stage.record?.name || state.cached?.desktopName || 'That desktop'
  const github = state.offlineMode === 'github'

  return (
    <div className="offline" role="status" data-testid="offline-banner">
      <Icon name={github ? 'branch' : 'restart'} size={13} />
      <span className="offline__text truncate">
        {github ? (
          <>
            <strong>{name} is asleep.</strong> There is no terminal and no agent — there is no computer to run one. The
            repository is still here.
          </>
        ) : (
          <>
            <strong>{name} is asleep.</strong> {state.stage.message}
            {when ? ` This is the picture it last sent, ${ago(when)}.` : ''}
          </>
        )}
      </span>
      <button
        type="button"
        className="ghost-btn offline__look"
        data-testid="offline-mode-switch"
        onClick={() => actions.setOfflineMode(github ? 'frozen' : 'github')}
      >
        {github ? 'Show the frozen terminals' : 'Open the repo from GitHub'}
      </button>
      <button type="button" className="ghost-btn offline__look" onClick={() => actions.refind()}>
        Look again
      </button>
      <SwitchAccount email={state.session?.email ?? ''} onSignOut={actions.signOut} compact />
    </div>
  )
}

function ago(at: number): string {
  const ms = Math.max(0, Date.now() - at)
  const minutes = Math.round(ms / 60_000)
  if (minutes < 1) return 'moments ago'
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'} ago`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`
  const days = Math.round(hours / 24)
  return `${days} day${days === 1 ? '' : 's'} ago`
}
