import { useCallback, useEffect, useState, type ReactNode } from 'react'
import type { SttModelState } from '@shared/types'
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
 * So it reports where the model is coming from honestly, and only offers to
 * download when there is nothing to point at.
 *
 * The download itself belongs to the main process (electron/stt-model.ts), not
 * to this component: leaving Settings mid-download must not abandon 600 MB, and
 * the first-run welcome watches the same three events. All this card does is
 * ask, start, cancel and listen.
 */
export function SpeechEngineCard(): ReactNode {
  const { state, actions } = useApp()
  const [model, setModel] = useState<SttModelState | null>(null)

  const refresh = useCallback(async () => {
    setModel(await window.forge.stt.modelState())
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh, state.settings.sttModelDir])

  // Progress, completion and failure all carry the whole state, so there is
  // nothing to merge — the last message wins.
  useEffect(() => {
    const offs = [
      window.forge.stt.onDownloadProgress(setModel),
      window.forge.stt.onDownloadError(setModel),
      window.forge.stt.onDownloadDone((s) => {
        setModel(s)
        // The download nails sttModelDir to Forge's own folder; mirror that into
        // the live settings so the paths form below updates without a reload.
        void window.forge.store
          .snapshot()
          .then((snap) => actions.patchSettings({ sttModelDir: snap.settings.sttModelDir }))
      })
    ]
    return () => offs.forEach((off) => off())
  }, [actions])

  if (!model || model.status === 'unknown') {
    return (
      <Card title="Speech engine">
        <p className="scard__hint">Checking…</p>
      </Card>
    )
  }

  const downloading = model.status === 'downloading'
  const ready = model.status === 'ready'
  const percent = Math.round(model.fraction * 100)
  // A folder the user typed in themselves is theirs to fix — quietly
  // downloading a second copy elsewhere would be Forge overruling them.
  const canInstall = !downloading && !ready && model.source !== 'external'

  return (
    <Card
      title="Speech engine"
      tone={!ready && !downloading ? 'warn' : 'plain'}
      actions={<StateChip tone={ready ? 'ok' : downloading ? 'off' : 'warn'}>{chipLabel(model)}</StateChip>}
    >
      {ready ? (
        <>
          <p className="sengine__lead">
            {model.source === 'dictationmic'
              ? 'Found DictationMic’s model — using it. Nothing to install, and no second copy of the 660 MB on your disk.'
              : model.source === 'external'
                ? 'Using the model folder you pointed Forge at. Dictation runs entirely on this machine.'
                : 'Parakeet TDT 0.6B is installed. Dictation runs entirely on this machine.'}
          </p>
          <dl className="sengine__facts">
            <div>
              <dt>Model</dt>
              <dd className="mono truncate">{model.dir}</dd>
            </div>
            <div>
              <dt>On disk</dt>
              <dd className="mono">{formatBytes(model.bytes)}</dd>
            </div>
          </dl>
        </>
      ) : null}

      {!ready && !downloading ? (
        <>
          <p className="sengine__lead">
            {model.status === 'partial' ? (
              <>
                A partly downloaded model is in <span className="mono">{model.dir}</span> — installing again picks up
                where it stopped rather than starting over.
              </>
            ) : (
              <>
                No usable model at <span className="mono">{model.dir || '(no folder set)'}</span>. Dictation cannot
                start without one.
              </>
            )}
          </p>
          {model.files.length > 0 ? (
            <ul className="sengine__files">
              {model.files.map((f) => (
                <li key={f.name} data-ok={f.ok ? 'true' : undefined}>
                  <Icon name={f.ok ? 'check' : 'close'} size={11} />
                  <span className="mono truncate">{f.name}</span>
                  <span className="sengine__size mono">{f.bytes > 0 ? formatBytes(f.bytes) : 'missing'}</span>
                </li>
              ))}
            </ul>
          ) : null}
        </>
      ) : null}

      {downloading || model.error ? (
        <div className="sengine__progress">
          <div
            className="sengine__bar"
            role="progressbar"
            aria-valuenow={percent}
            aria-valuemin={0}
            aria-valuemax={100}
          >
            <span
              className="sengine__bar-fill"
              data-indeterminate={downloading && model.fraction === 0 ? 'true' : undefined}
              style={{ width: `${percent}%` }}
            />
          </div>
          <div className="sengine__progress-text">
            <span className="mono">
              {model.error
                ? model.error
                : model.fraction === 0
                  ? 'connecting…'
                  : `${percent}% · ${formatBytes(model.bytes)} of ${formatBytes(model.totalBytes)}${model.file ? ` · ${model.file}` : ''}`}
            </span>
            {downloading ? (
              <button type="button" className="ghost-btn sbtn" onClick={() => void window.forge.stt.cancelDownload()}>
                Cancel
              </button>
            ) : null}
          </div>
        </div>
      ) : null}

      {canInstall ? (
        <div className="sengine__install">
          <button type="button" className="cta-btn" onClick={() => void window.forge.stt.downloadModel()}>
            <Icon name="voice" size={13} />
            {model.status === 'partial' ? 'Resume download' : 'Install speech engine'}
          </button>
          <span className="sengine__hint">
            {model.sizeHint}, once. It resumes if the connection drops, and lands in{' '}
            <span className="mono">{model.forgeDir}</span>.
          </span>
        </div>
      ) : null}

      {!canInstall && !downloading && !ready ? (
        <span className="sengine__hint">
          Forge will not download over a folder you chose yourself. Clear the model path below and Forge will fetch its
          own copy.
        </span>
      ) : null}
    </Card>
  )
}

/** The one-word verdict on the chip. */
function chipLabel(model: SttModelState): string {
  if (model.status === 'downloading') return 'downloading'
  if (model.status === 'ready') return model.source === 'dictationmic' ? "DictationMic's" : 'installed'
  if (model.status === 'partial') return 'partly downloaded'
  return 'not installed'
}

function formatBytes(n: number): string {
  if (n <= 0) return '0 B'
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(n < 10 * 1024 * 1024 ? 1 : 0)} MB`
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`
}
