import { type ReactNode } from 'react'
import { Icon } from '@/components/Icon'
import { useForge } from '../state'

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
 * ## Phase 4 goes here
 *
 * This is the seam. When GitHub mode is built (docs/forge-web.md, Phase 4) the
 * offline screen gains a second half — the repository read straight from the
 * GitHub REST API, with edits committed to a `forge-web/*` branch — and this
 * banner is where the switch between "the desktop's last picture" and "the
 * files, live from GitHub" belongs. Nothing in Phase 3 builds any of it: there
 * is no GitHub auth, no tree, no editor and no commit path anywhere in `web/`,
 * deliberately, because a half-built one would be a second source of truth for
 * files the desktop still owns whenever it is awake.
 */
export function OfflineBanner(): ReactNode {
  const { state, actions } = useForge()
  if (state.stage.kind !== 'offline') return null

  const when = state.cached?.at ?? 0
  const name = state.stage.record?.name || state.cached?.desktopName || 'That desktop'

  return (
    <div className="offline" role="status" data-testid="offline-banner">
      <Icon name="restart" size={13} />
      <span className="offline__text truncate">
        <strong>{name} is asleep.</strong> {state.stage.message}
        {when ? ` This is the picture it last sent, ${ago(when)}.` : ''}
      </span>
      <button type="button" className="ghost-btn offline__look" onClick={() => actions.refind()}>
        Look again
      </button>
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
