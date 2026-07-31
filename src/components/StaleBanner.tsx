import { useEffect, useState, type ReactNode } from 'react'
import type { StaleBundle, StaleStatus } from '@shared/types'
import { countLeaves } from '@/lib/splitTree'
import { useApp } from '@/state/AppState'
import { Icon } from './Icon'
import './UpdateBanner.css'

/**
 * "Forge changed on disk." The dev-run twin of UpdateBanner, wearing the same
 * chrome on purpose: one slim strip under the titlebar, one accent, one button
 * that does the thing. Two strips that meant "this app is not current" and
 * looked unrelated would be two things to learn instead of one.
 *
 * It can only ever appear in a checkout — see electron/stale-watcher.ts, which
 * refuses to run in a packaged build — and only for the two bundles hot module
 * replacement cannot reach. Renderer edits are on screen by themselves and this
 * strip deliberately stays silent for them; if it lit up for every component
 * save it would be wallpaper inside a minute, and nobody reads wallpaper.
 *
 * The click is two-step whenever panes are running, because a restart is not a
 * refresh: it takes every Claude session and every shell in the window with it.
 * The second step says how many, so the number is in front of you rather than
 * in your memory.
 */

const LABELS: Record<StaleBundle, string> = {
  main: 'main process',
  preload: 'preload'
}

/** "main process", or "main process and preload" — never a bare array. */
function describe(changed: StaleBundle[]): string {
  const parts = changed.map((c) => LABELS[c])
  if (parts.length === 0) return 'code'
  if (parts.length === 1) return parts[0]!
  return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]!}`
}

export function StaleBanner(): ReactNode {
  const { state } = useApp()
  const [status, setStatus] = useState<StaleStatus | null>(null)
  /**
   * Dismissal is per rebuild, mirroring the update banner's per-version rule:
   * waving off *this* change does not silence the next one. Local state rather
   * than settings on purpose — a dev-run annoyance has no business being
   * written to the user's store, and a fresh window should start honest.
   */
  const [dismissedAt, setDismissedAt] = useState<number | null>(null)
  const [confirming, setConfirming] = useState(false)

  useEffect(() => {
    void window.forge.dev.staleStatus().then(setStatus)
    return window.forge.dev.onStale(setStatus)
  }, [])

  // A newer rebuild lands: the strip is a fresh question, so drop the half-
  // finished confirmation rather than leaving an armed button on screen.
  useEffect(() => {
    setConfirming(false)
  }, [status?.at])

  if (!status?.stale) return null
  if (status.at !== null && status.at === dismissedAt) return null

  const panes = Object.values(state.workspaces).reduce(
    (total, ws) => total + ws.tabs.reduce((n, tab) => n + countLeaves(tab.root), 0),
    0
  )

  return (
    <div className="ubanner" role="status" data-phase="stale">
      <span className="ubanner__mark">
        <Icon name="restart" size={13} />
      </span>

      <span className="ubanner__text">
        {confirming ? (
          <>
            Restarting closes <strong>{panes === 1 ? '1 pane' : `${panes} panes`}</strong> — carry on?
          </>
        ) : (
          <>
            Forge&rsquo;s <strong>{describe(status.changed)}</strong> changed on disk — this window is
            still running the old build
          </>
        )}
      </span>

      <span className="ubanner__sim mono">dev</span>

      <div className="ubanner__actions">
        <button
          type="button"
          className="ubanner__btn ubanner__btn--go"
          title={
            confirming
              ? 'Quit Forge and start again on the new bundle'
              : 'Hot reload cannot reach this code — only a restart picks it up'
          }
          onClick={() => {
            // No panes to lose means no question worth asking.
            if (!confirming && panes > 0) {
              setConfirming(true)
              return
            }
            void window.forge.dev.restart()
          }}
        >
          {confirming ? `Restart & close ${panes}` : 'Restart Forge'}
        </button>

        <button
          type="button"
          className="ghost-btn ubanner__close"
          title={confirming ? 'Leave it running' : 'Not now — hide this until the next rebuild'}
          aria-label={confirming ? 'Cancel restart' : 'Dismiss'}
          onClick={() => {
            if (confirming) {
              setConfirming(false)
              return
            }
            setDismissedAt(status.at)
          }}
        >
          <Icon name="close" size={12} />
        </button>
      </div>
    </div>
  )
}
