import { useEffect, useState, type ReactNode } from 'react'
import type { SourceUpdateStatus, StaleBundle, StaleStatus } from '@shared/types'
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
  const [source, setSource] = useState<SourceUpdateStatus | null>(null)
  /**
   * Dismissal is per rebuild, mirroring the update banner's per-version rule:
   * waving off *this* change does not silence the next one. Local state rather
   * than settings on purpose — a dev-run annoyance has no business being
   * written to the user's store, and a fresh window should start honest.
   */
  const [dismissedAt, setDismissedAt] = useState<number | null>(null)
  /** Same rule for the origin update, keyed by what was offered. */
  const [sourceDismissed, setSourceDismissed] = useState<string | null>(null)
  const [confirming, setConfirming] = useState(false)

  useEffect(() => {
    void window.forge.dev.staleStatus().then(setStatus)
    return window.forge.dev.onStale(setStatus)
  }, [])
  useEffect(() => {
    void window.forge.dev.sourceStatus().then(setSource)
    return window.forge.dev.onSourceUpdate(setSource)
  }, [])

  // A newer rebuild or a new offer lands: the strip is a fresh question, so
  // drop the half-finished confirmation rather than leaving an armed button.
  useEffect(() => {
    setConfirming(false)
  }, [status?.at, source?.phase])

  const panes = Object.values(state.workspaces).reduce(
    (total, ws) => total + ws.tabs.reduce((n, tab) => n + countLeaves(tab.root), 0),
    0
  )

  /*
   * The origin update outranks the local rebuild strip: it is the one that
   * moves the app forward, and after it pulls, the rebuild strip's news is
   * stale by definition (the restart is already on its way).
   */
  if (source?.phase === 'updating') {
    return (
      <div className="ubanner" role="status" data-phase="stale">
        <span className="ubanner__mark">
          <Icon name="restart" size={13} />
        </span>
        <span className="ubanner__text">
          Updating Forge{source.version ? <> to <strong>v{source.version}</strong></> : null} —{' '}
          {source.step === 'pull' ? 'pulling the new version…' : 'installing dependencies…'}
        </span>
      </div>
    )
  }

  if (source?.phase === 'error' && sourceDismissed !== source.error) {
    return (
      <div className="ubanner" role="status" data-phase="stale">
        <span className="ubanner__mark">
          <Icon name="restart" size={13} />
        </span>
        <span className="ubanner__text">
          Update failed — <strong>{source.error}</strong>
        </span>
        <div className="ubanner__actions">
          <button
            type="button"
            className="ghost-btn ubanner__close"
            title="Dismiss"
            aria-label="Dismiss update error"
            onClick={() => setSourceDismissed(source.error)}
          >
            <Icon name="close" size={12} />
          </button>
        </div>
      </div>
    )
  }

  if (source?.phase === 'available') {
    const offerKey = `${source.version ?? ''}@${source.behind}`
    if (sourceDismissed !== offerKey) {
      return (
        <div className="ubanner" role="status" data-phase="stale">
          <span className="ubanner__mark">
            <Icon name="restart" size={13} />
          </span>

          <span className="ubanner__text">
            {confirming ? (
              <>
                Updating restarts Forge and closes{' '}
                <strong>{panes === 1 ? '1 pane' : `${panes} panes`}</strong> — carry on?
              </>
            ) : (
              <>
                Update available
                {source.version ? (
                  <>
                    {' '}
                    — Forge <strong>v{source.version}</strong>
                  </>
                ) : null}{' '}
                ({source.behind} commit{source.behind === 1 ? '' : 's'} ahead on GitHub)
              </>
            )}
          </span>

          <div className="ubanner__actions">
            <button
              type="button"
              className="ubanner__btn ubanner__btn--go"
              title={
                confirming
                  ? 'Pull the update, install what changed, and restart Forge'
                  : 'One click: pull, install if needed, restart on the new version'
              }
              onClick={() => {
                if (!confirming && panes > 0) {
                  setConfirming(true)
                  return
                }
                void window.forge.dev.applySourceUpdate()
              }}
            >
              {confirming ? `Update & close ${panes}` : 'Update & restart'}
            </button>
            <button
              type="button"
              className="ghost-btn ubanner__close"
              title={confirming ? 'Leave it running' : 'Not now — hide this until the next push'}
              aria-label={confirming ? 'Cancel update' : 'Dismiss'}
              onClick={() => {
                if (confirming) {
                  setConfirming(false)
                  return
                }
                setSourceDismissed(offerKey)
              }}
            >
              <Icon name="close" size={12} />
            </button>
          </div>
        </div>
      )
    }
  }

  if (!status?.stale) return null
  if (status.at !== null && status.at === dismissedAt) return null

  // Same strip, two dialects. On the stable checkout "the code changed on
  // disk" means an update was pushed from Forge Dev, and it should say so the
  // way any app would: update ready, restart. Only the dev checkout — where
  // the change is your own edit of ten seconds ago — earns the build-speak.
  const stable = status.channel === 'stable'

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
        ) : stable ? (
          <>
            Update available{status.version ? <> — Forge <strong>v{status.version}</strong> is ready</> : null} —
            restart to use it
          </>
        ) : (
          <>
            Forge&rsquo;s <strong>{describe(status.changed)}</strong> changed on disk — this window is
            still running the old build
          </>
        )}
      </span>

      {stable ? null : <span className="ubanner__sim mono">dev</span>}

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
