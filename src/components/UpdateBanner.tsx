import { useEffect, useState, useSyncExternalStore, type ReactNode } from 'react'
import { formatRate, shouldShowBanner } from '@shared/tools'
import type { UpdateStatus } from '@shared/types'
import { Icon } from './Icon'
import './UpdateBanner.css'

/**
 * "Forge v0.2.0 is available." One slim strip under the titlebar, and nothing
 * else in the app changes.
 *
 * It sits *below* the titlebar rather than inside it because the titlebar is a
 * drag region with three native Windows buttons welded into its right-hand end;
 * a strip that has to hold a progress bar and two buttons does not belong in
 * 38 pixels it does not own. Visually it reads as part of the same chrome —
 * same background, one hairline between them.
 *
 * The flow is deliberately several clicks, not none:
 *
 *   available   → "Download" starts the *download*, nothing else
 *   downloading → a progress bar in the strip itself
 *   ready       → "Restart and update" asks first: Forge will close, and every
 *                 terminal and agent with it
 *   confirm     → "Update now" hands the installer to the apply helper — the
 *                 first moment anything on disk changes. No cancel after this.
 *   installing  → "Closing Forge to install vX…"
 *   updated     → only from a helper that saw the new version start
 *   failed      → why, what Forge is still on, and the log
 *
 * Every state carries words and its own mark (Forge, a tick, an "!"), never
 * colour alone. "Later" hides the strip for that version until next launch;
 * Settings → Updates still offers it. The banner cannot appear at all in a dev
 * run: the main process reports `unsupported` there and never anything else,
 * unless FORGE_FAKE_UPDATE was set on purpose to look at this component.
 */

/* ------------------------------------------------- "Later" and the confirm */

/**
 * Module state, not component state: "Later" lasts until Forge restarts, and
 * Settings → Updates has to be able to bring the strip (and its confirm) back.
 */
type BarState = { later: string | null; confirming: boolean }
let bar: BarState = { later: null, confirming: false }
const barListeners = new Set<() => void>()

function setBar(next: Partial<BarState>): void {
  bar = { ...bar, ...next }
  for (const listener of barListeners) listener()
}

function subscribeBar(listener: () => void): () => void {
  barListeners.add(listener)
  return () => barListeners.delete(listener)
}

function getBar(): BarState {
  return bar
}

/** Bring the strip back (Settings → Updates); `confirm` opens the install confirm. */
export function showUpdateBar(confirm = false): void {
  setBar({ later: null, confirming: confirm })
}

export function UpdateBanner(): ReactNode {
  const [status, setStatus] = useState<UpdateStatus | null>(null)
  const { later, confirming } = useSyncExternalStore(subscribeBar, getBar)
  /** Why the last click did not do what it said, when main did not say so itself. */
  const [notice, setNotice] = useState<string | null>(null)

  useEffect(() => {
    void window.forge.updates.status().then(setStatus)
    return window.forge.updates.onStatus((s) => {
      setStatus(s)
      setNotice(null)
    })
  }, [])

  const phase = status?.phase
  if (!status || phase === 'unsupported' || phase === 'idle' || phase === 'checking') return null

  const version = status.to ?? status.version ?? ''
  const offer = phase === 'available' || phase === 'downloading' || phase === 'ready'
  if (offer && !shouldShowBanner(version, later)) return null

  const retryInstall = phase === 'failed' || (phase === 'error' && status.step === 'install')
  const showConfirm = confirming && (phase === 'ready' || retryInstall)
  const bad = phase === 'error' || phase === 'failed'

  const install = async (): Promise<void> => {
    setBar({ confirming: false })
    const result = await window.forge.updates.install()
    // An older preload answered with a bare boolean.
    if (result && typeof result === 'object' && !result.ok && result.reason) setNotice(result.reason)
  }

  const tryAgain = (): void => {
    if (retryInstall) {
      setBar({ confirming: true })
      return
    }
    if (status.step === 'download') void window.forge.updates.download()
    else void window.forge.updates.check()
  }

  const openLog = (): void => {
    void window.forge.updates.openLog?.()
  }

  const dismiss = (): void => {
    void window.forge.updates.dismissResult?.()
  }

  const installerLink = phase === 'error' && (status.error ?? '').includes('releases/latest')

  return (
    <div
      className="ubanner"
      role="status"
      data-phase={showConfirm ? 'confirm' : phase}
      data-tone={bad ? 'bad' : phase === 'updated' ? 'good' : undefined}
    >
      {phase === 'downloading' ? (
        <div className="ubanner__fill" style={{ width: `${clampPercent(status.percent)}%` }} />
      ) : null}

      <span className="ubanner__mark" aria-hidden="true">
        {bad ? (
          <span className="ubanner__bang">!</span>
        ) : phase === 'updated' ? (
          <Icon name="check" size={13} />
        ) : (
          <Icon name="forge" size={13} />
        )}
      </span>

      <span className="ubanner__text" title={plainText(status, showConfirm)}>
        {showConfirm ? (
          <>
            Forge will close, install <strong>v{version}</strong> and reopen. Open terminals and agents will stop.
          </>
        ) : (
          <StatusText status={status} version={version} />
        )}
        {notice && !showConfirm ? <span className="ubanner__notice"> — {notice}</span> : null}
      </span>

      {status.simulated ? <span className="ubanner__sim mono">simulated</span> : null}

      <div className="ubanner__actions">
        {showConfirm ? (
          <>
            <button type="button" className="ubanner__btn ubanner__btn--go" onClick={() => void install()}>
              Update now
            </button>
            <button type="button" className="ubanner__btn" onClick={() => setBar({ confirming: false })}>
              Not now
            </button>
          </>
        ) : (
          <>
            {/*
              What you would be getting, before you agree to get it. A link to
              the release page rather than the notes themselves: electron-updater
              does hand over GitHub's rendered release body, but it is HTML, and
              rendering somebody else's HTML inside a 30px strip is not worth a
              sanitiser. The card that appears *after* the update carries the
              notes properly — see src/components/WhatsNew.tsx.
            */}
            {version && (phase === 'available' || phase === 'ready') ? (
              <button
                type="button"
                className="ubanner__what"
                title={`See what changed in ${version}, on GitHub`}
                onClick={() => void window.forge.openExternal(releaseUrl(version))}
              >
                What&apos;s new
              </button>
            ) : null}
            {phase === 'available' ? (
              <button
                type="button"
                className="ubanner__btn ubanner__btn--go"
                onClick={() => void window.forge.updates.download()}
              >
                Download
              </button>
            ) : null}
            {phase === 'ready' ? (
              <button
                type="button"
                className="ubanner__btn ubanner__btn--go"
                title="Forge closes, installs the update and reopens — you are asked first"
                onClick={() => setBar({ confirming: true })}
              >
                Restart and update
              </button>
            ) : null}
            {phase === 'available' || phase === 'ready' ? (
              <button
                type="button"
                className="ubanner__btn"
                title={`Hide this until Forge next starts — Settings → Updates still has ${version}`}
                onClick={() => setBar({ later: version, confirming: false })}
              >
                Later
              </button>
            ) : null}
            {bad ? (
              <button type="button" className="ubanner__btn ubanner__btn--go" onClick={tryAgain}>
                Try again
              </button>
            ) : null}
            {installerLink ? (
              <button
                type="button"
                className="ubanner__btn"
                onClick={() => void window.forge.openExternal(RELEASES_URL)}
              >
                Download installer
              </button>
            ) : null}
            {bad ? (
              <button type="button" className="ubanner__btn" onClick={openLog}>
                Open log
              </button>
            ) : null}
            {phase === 'failed' ? (
              <button type="button" className="ubanner__btn" onClick={dismiss}>
                Dismiss
              </button>
            ) : null}
            {phase === 'updated' ? (
              <button type="button" className="ubanner__btn ubanner__btn--go" onClick={dismiss}>
                OK
              </button>
            ) : null}
          </>
        )}
      </div>
    </div>
  )
}

/** The sentence for each state. Words carry the meaning; colour only repeats it. */
function StatusText({ status, version }: { status: UpdateStatus; version: string }): ReactNode {
  switch (status.phase) {
    case 'available':
      return (
        <>
          <strong>Forge v{version}</strong> is available
        </>
      )
    case 'downloading': {
      const rate = formatRate(status.bytesPerSecond ?? 0)
      return (
        <>
          Downloading <strong>v{version}</strong> — {clampPercent(status.percent)}%{rate ? ` · ${rate}` : ''}
        </>
      )
    }
    case 'ready':
      return (
        <>
          <strong>Forge v{version}</strong> is ready
        </>
      )
    case 'installing':
      return status.closing ? (
        <>
          Closing Forge to install <strong>v{version}</strong>…
        </>
      ) : (
        <>
          Getting ready to install <strong>v{version}</strong>…
        </>
      )
    case 'updated':
      return (
        <>
          Updated to <strong>v{version}</strong> — it started fine.
        </>
      )
    case 'failed':
      return <FailedText status={status} version={version} />
    case 'error':
      return (
        <>
          <strong>{errorStepWords(status, version)} failed</strong>: {status.error ?? 'unknown error'}
        </>
      )
    default:
      return null
  }
}

function FailedText({ status, version }: { status: UpdateStatus; version: string }): ReactNode {
  if (status.outcome === 'rollback-failed') {
    return (
      <>
        <strong>Update to v{version} failed and the old version could not be put back.</strong> Rename{' '}
        <span className="mono">{status.backupDir ?? 'the .update-backup folder'}</span> to{' '}
        <span className="mono">{status.installDir ?? 'the Forge folder'}</span>
        {status.reason ? ` — ${status.reason}` : ''}
      </>
    )
  }
  const current = status.lastResult?.current ?? status.from ?? ''
  return (
    <>
      <strong>Update to v{version} did not finish.</strong>{' '}
      {current && current === version
        ? `Forge is on v${current}, but the update was not confirmed.`
        : `Forge is still on v${current || '?'}.`}
      {status.reason ? ` ${status.reason}` : ''}
    </>
  )
}

function errorStepWords(status: UpdateStatus, version: string): string {
  const v = version ? ` of v${version}` : ''
  if (status.step === 'check') return 'Update check'
  if (status.step === 'download') return `Download${v}`
  if (status.step === 'install') return `Install${v}`
  return 'Update'
}

/** The whole sentence as a tooltip, for when the strip has to cut it short. */
function plainText(status: UpdateStatus, confirming: boolean): string | undefined {
  if (confirming) return undefined
  if (status.phase === 'error') return status.error
  if (status.phase === 'failed') {
    return [status.reason, status.backupDir ? `Backup: ${status.backupDir}` : '', status.logPath ? `Log: ${status.logPath}` : '']
      .filter(Boolean)
      .join('\n')
  }
  return undefined
}

function clampPercent(percent: number | undefined): number {
  return Math.max(0, Math.min(100, percent ?? 0))
}

const RELEASES_URL = 'https://github.com/stevenmcginty/forge/releases/latest'

/**
 * The release page for a version.
 *
 * Built here rather than read from the update payload, because the payload does
 * not carry one and the URL is entirely predictable — the tag is `v<version>` and
 * the repository is where this app updates itself from.
 */
function releaseUrl(version: string): string {
  return `https://github.com/stevenmcginty/forge/releases/tag/v${version}`
}
