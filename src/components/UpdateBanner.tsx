import { useEffect, useState, type ReactNode } from 'react'
import { formatRate, shouldShowBanner } from '@shared/tools'
import type { UpdateStatus } from '@shared/types'
import { useApp } from '@/state/AppState'
import { Icon } from './Icon'
import './UpdateBanner.css'

/**
 * "Forge 0.2.0 is available." One slim strip under the titlebar, and nothing
 * else in the app changes.
 *
 * It sits *below* the titlebar rather than inside it because the titlebar is a
 * drag region with three native Windows buttons welded into its right-hand end;
 * a strip that has to hold a progress bar and two buttons does not belong in
 * 38 pixels it does not own. Visually it reads as part of the same chrome —
 * same background, one hairline between them.
 *
 * The flow is deliberately three clicks, not none:
 *
 *   available   → "Update & restart" starts the *download*, nothing else
 *   downloading → a progress bar in the strip itself
 *   ready       → "Restart to finish", which is the first moment anything on
 *                 disk changes
 *
 * Dismissal is per version (see shouldShowBanner) so declining 0.2.0 does not
 * silence 0.3.0. And the banner cannot appear at all in a dev run: the main
 * process reports `unsupported` there and never anything else, unless
 * FORGE_FAKE_UPDATE was set on purpose to look at this component.
 */
export function UpdateBanner(): ReactNode {
  const { state, actions } = useApp()
  const [status, setStatus] = useState<UpdateStatus | null>(null)

  useEffect(() => {
    void window.forge.updates.status().then(setStatus)
    return window.forge.updates.onStatus(setStatus)
  }, [])

  const phase = status?.phase
  if (!status || phase === 'unsupported' || phase === 'idle' || phase === 'checking' || phase === 'error') return null

  const version = status.version ?? ''
  // Once the download has started, dismissing is no longer the question — the
  // strip is showing progress on something that was already agreed to.
  const dismissible = phase === 'available'
  if (dismissible && !shouldShowBanner(version, state.settings.updateDismissedVersion)) return null

  const downloading = phase === 'downloading'
  const percent = Math.max(0, Math.min(100, status.percent ?? 0))
  const rate = formatRate(status.bytesPerSecond ?? 0)

  return (
    <div className="ubanner" role="status" data-phase={phase}>
      {downloading ? <div className="ubanner__fill" style={{ width: `${percent}%` }} /> : null}

      <span className="ubanner__mark">
        <Icon name="forge" size={13} />
      </span>

      <span className="ubanner__text">
        {phase === 'available' ? (
          <>
            <strong>Forge {version}</strong> is available
          </>
        ) : null}
        {downloading ? (
          <>
            Downloading <strong>{version}</strong> — {percent}%{rate ? ` · ${rate}` : ''}
          </>
        ) : null}
        {phase === 'ready' ? (
          <>
            <strong>Forge {version}</strong> is ready to install
          </>
        ) : null}
      </span>

      {status.simulated ? <span className="ubanner__sim mono">simulated</span> : null}

      <div className="ubanner__actions">
        {phase === 'available' ? (
          <button
            type="button"
            className="ubanner__btn ubanner__btn--go"
            onClick={() => void window.forge.updates.download()}
          >
            Update &amp; restart
          </button>
        ) : null}
        {phase === 'ready' ? (
          <button
            type="button"
            className="ubanner__btn ubanner__btn--go"
            title={
              status.simulated
                ? 'Simulated — there is no real installer to restart into'
                : 'Quit Forge and run the installer'
            }
            disabled={status.simulated === true}
            onClick={() => void window.forge.updates.install()}
          >
            Restart to finish
          </button>
        ) : null}
        {dismissible ? (
          <button
            type="button"
            className="ghost-btn ubanner__close"
            title={`Not now — hide this until after ${version}`}
            aria-label="Dismiss this update"
            onClick={() => actions.patchSettings({ updateDismissedVersion: version })}
          >
            <Icon name="close" size={12} />
          </button>
        ) : null}
      </div>
    </div>
  )
}
