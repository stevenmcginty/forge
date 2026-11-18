import { type ReactNode } from 'react'
import { Icon } from '@/components/Icon'
import { useMobile } from '../lib/mobile'
import { useForge } from '../state'
import { SwitchAccount } from './Connection'
import { PhoneIcon } from './PhoneIcon'

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
 * ## On a phone
 *
 * One of the phone's ambient notices (`PhoneStrip`, below): a title that says
 * what is true, one line on what that means, and the actions as pills. The
 * account line is not here — it lives in the connection sheet the link opens.
 *
 * The switch is a switch and not a link away: the rail, the titlebar and the
 * theme do not change, the terminals stay exactly as frozen as they were, and
 * `Workspace` swaps what is inside the grid. GitHub mode is a mode.
 */
export function OfflineBanner(): ReactNode {
  const { state, actions } = useForge()
  const mobile = useMobile()
  if (state.stage.kind !== 'offline') return null

  const when = state.cached?.at ?? 0
  const name = state.stage.record?.name || state.cached?.desktopName || (mobile ? 'Your desktop' : 'That desktop')
  const github = state.offlineMode === 'github'

  if (mobile) {
    return (
      <PhoneStrip
        link="asleep"
        testId="offline-banner"
        mark={github ? <Icon name="branch" size={18} /> : <PhoneIcon name="link-asleep" size={20} />}
        title={`${name} is asleep`}
        body={
          github
            ? 'Terminals need it awake. The repo is still here.'
            : `Showing what it last sent${when ? `, ${shortAgo(when)}` : ''}.`
        }
        actions={
          <>
            <button type="button" className="pstrip__btn offline__look" onClick={() => actions.refind()}>
              Look again
            </button>
            <button
              type="button"
              className="pstrip__btn offline__look"
              data-testid="offline-mode-switch"
              onClick={() => actions.setOfflineMode(github ? 'frozen' : 'github')}
            >
              {github ? 'Show terminals' : 'Open GitHub repo'}
            </button>
          </>
        }
        stack
      />
    )
  }

  return (
    <div className="offline" data-link="asleep" role="status" data-testid="offline-banner">
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
      <span className="offline__actions">
        <button type="button" className="ghost-btn offline__look" onClick={() => actions.refind()}>
          Look again
        </button>
        <button
          type="button"
          className="ghost-btn offline__look"
          data-testid="offline-mode-switch"
          onClick={() => actions.setOfflineMode(github ? 'frozen' : 'github')}
        >
          {github ? 'Show the frozen terminals' : 'Open the repo from GitHub'}
        </button>
        <SwitchAccount email={state.session?.email ?? ''} onSignOut={actions.signOut} compact />
      </span>
    </div>
  )
}

/**
 * The phone's ambient notice: asleep, reconnecting, restarting, admin prompt,
 * new build. In the flow under the top bar (it pushes the app down, never
 * covers it), one at a time by priority (Workspace picks), drawn as the
 * contract's inline notice: a tonal card, a state shape in the mark slot, a
 * title that says what is true and one line on what it means, and pills for
 * what can be done. `stack` puts two or more actions on their own row.
 * `tone="attn"` only for the one that waits on you.
 */
export function PhoneStrip({
  link,
  testId,
  role = 'status',
  tone,
  mark,
  title,
  body,
  actions,
  stack = false
}: {
  link: string
  testId: string
  role?: 'status' | 'alert'
  tone?: 'attn'
  mark: ReactNode
  title: string
  body: string
  actions?: ReactNode
  stack?: boolean
}): ReactNode {
  return (
    <div
      className="pstrip"
      data-link={link}
      data-tone={tone}
      data-stack={stack ? 'true' : undefined}
      role={role}
      data-testid={testId}
    >
      <span className="pstrip__mark" aria-hidden="true">
        {mark}
      </span>
      <span className="pstrip__text">
        <span className="pstrip__title">{title}</span>
        <span className="pstrip__body">{body}</span>
      </span>
      {actions ? <span className="pstrip__actions">{actions}</span> : null}
    </div>
  )
}

/** "just now", "4 min ago", "2 h ago", "3 days ago": the phone's way of saying when. */
function shortAgo(at: number): string {
  const minutes = Math.round(Math.max(0, Date.now() - at) / 60_000)
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes} min ago`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours} h ago`
  const days = Math.round(hours / 24)
  return `${days} day${days === 1 ? '' : 's'} ago`
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
