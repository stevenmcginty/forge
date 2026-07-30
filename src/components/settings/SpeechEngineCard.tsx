import { useCallback, useEffect, useState, type ReactNode } from 'react'
import type { EngineProgress, EngineState } from '@shared/types'
import { useApp } from '@/state/AppState'
import { Icon } from '../Icon'
import { Card, StateChip } from './parts'

/**
 * The speech engine's state card.
 *
 * Dictation needs a 660 MB Parakeet model. Most of the time Steve already has
 * one — DictationMic downloaded it years ago — and the right answer is to point
 * at it and say nothing more. This card exists for the case where there is no
 * model at all, which is otherwise a dead end: the pill goes amber, the setup
 * form asks for a folder, and there is no folder to give it.
 *
 * So it reports one of three states honestly, and only the third offers to
 * download anything.
 */
export function SpeechEngineCard(): ReactNode {
  const { state, actions } = useApp()
  const [engine, setEngine] = useState<EngineState | null>(null)
  const [progress, setProgress] = useState<EngineProgress | null>(null)
  const [busy, setBusy] = useState(false)

  const refresh = useCallback(async () => {
    setEngine(await window.forge.models.engineState())
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh, state.settings.sttModelDir])

  useEffect(
    () =>
      window.forge.models.onEngineProgress((p) => {
        setProgress(p)
        if (p.done) {
          setBusy(false)
          void refresh()
        }
      }),
    [refresh]
  )

  const install = (): void => {
    setBusy(true)
    setProgress({ fraction: null, file: '', receivedBytes: 0, totalBytes: 0 })
    void window.forge.models.engineInstall().then((p) => {
      setProgress(p)
      setBusy(false)
      void refresh()
      // The download points sttModelDir at Forge's own folder; mirror that into
      // the live settings so the form above updates without a reload.
      if (p.done === 'ok') {
        void window.forge.store.snapshot().then((snap) => actions.patchSettings({ sttModelDir: snap.settings.sttModelDir }))
      }
    })
  }

  if (!engine) {
    return (
      <Card title="Speech engine">
        <p className="scard__hint">Checking…</p>
      </Card>
    )
  }

  const missing = engine.source === 'missing'
  const downloading = busy || engine.downloading

  return (
    <Card
      title="Speech engine"
      tone={missing && !downloading ? 'warn' : 'plain'}
      actions={
        <StateChip tone={missing ? 'warn' : 'ok'}>
          {engine.source === 'forge' ? 'installed' : engine.source === 'dictationmic' ? "DictationMic's" : 'not installed'}
        </StateChip>
      }
    >
      {engine.source === 'dictationmic' ? (
        <>
          <p className="sengine__lead">
            Found DictationMic&rsquo;s engine — using it. Nothing to install, and no second copy of the model on your
            disk.
          </p>
          <dl className="sengine__facts">
            <div>
              <dt>Model</dt>
              <dd className="mono truncate">{engine.dir}</dd>
            </div>
            <div>
              <dt>On disk</dt>
              <dd className="mono">{formatBytes(engine.bytes)}</dd>
            </div>
          </dl>
        </>
      ) : null}

      {engine.source === 'forge' ? (
        <>
          <p className="sengine__lead">Parakeet TDT 0.6B is installed. Dictation runs entirely on this machine.</p>
          <dl className="sengine__facts">
            <div>
              <dt>Model</dt>
              <dd className="mono truncate">{engine.dir}</dd>
            </div>
            <div>
              <dt>On disk</dt>
              <dd className="mono">{formatBytes(engine.bytes)}</dd>
            </div>
          </dl>
        </>
      ) : null}

      {missing ? (
        <>
          <p className="sengine__lead">
            No usable model at{' '}
            <span className="mono">{engine.dir || '(no folder set)'}</span>. Dictation cannot start without one.
          </p>
          <ul className="sengine__files">
            {engine.files.map((f) => (
              <li key={f.name} data-ok={f.ok ? 'true' : undefined}>
                <Icon name={f.ok ? 'check' : 'close'} size={11} />
                <span className="mono truncate">{f.name}</span>
                <span className="sengine__size mono">{f.bytes > 0 ? formatBytes(f.bytes) : 'missing'}</span>
              </li>
            ))}
          </ul>
        </>
      ) : null}

      {downloading || progress?.done === 'error' ? (
        <div className="sengine__progress">
          <div className="sengine__bar" role="progressbar" aria-valuenow={Math.round((progress?.fraction ?? 0) * 100)}>
            <span
              className="sengine__bar-fill"
              data-indeterminate={progress?.fraction === null ? 'true' : undefined}
              style={{ width: `${Math.round((progress?.fraction ?? 0) * 100)}%` }}
            />
          </div>
          <div className="sengine__progress-text">
            <span className="mono">
              {progress?.done === 'error'
                ? (progress.error ?? 'failed')
                : progress?.fraction === null
                  ? 'connecting…'
                  : `${Math.round((progress?.fraction ?? 0) * 100)}% · ${formatBytes(progress?.receivedBytes ?? 0)} of ${formatBytes(progress?.totalBytes ?? 0)}`}
            </span>
            {downloading ? (
              <button type="button" className="ghost-btn sbtn" onClick={() => void window.forge.models.engineCancel()}>
                Cancel
              </button>
            ) : null}
          </div>
        </div>
      ) : null}

      {missing && !downloading ? (
        <div className="sengine__install">
          <button type="button" className="cta-btn" onClick={install}>
            <Icon name="voice" size={13} />
            Install speech engine
          </button>
          <span className="sengine__hint">
            ~660 MB, once. It resumes if the connection drops, and lands in{' '}
            <span className="mono">{engine.forgeDir}</span>.
          </span>
        </div>
      ) : null}
    </Card>
  )
}

function formatBytes(n: number): string {
  if (n <= 0) return '0 B'
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(n < 10 * 1024 * 1024 ? 1 : 0)} MB`
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`
}
