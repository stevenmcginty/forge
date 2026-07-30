import { useState, type ReactNode } from 'react'
import { hotkeyLabel } from '@/hooks/useDictation'
import { useApp } from '@/state/AppState'
import './DictationSetup.css'

/**
 * The dictation settings form: interpreter, model folder, silence timeout and
 * the toggle key. Shared by the pill's setup card (when something is missing)
 * and the Settings popover (when nothing is), so there is exactly one place
 * these fields are described.
 */

const HOTKEYS = [
  'ControlRight',
  'ControlLeft',
  'AltRight',
  'ShiftRight',
  'ScrollLock',
  'Pause',
  'F8',
  'F9'
] as const

export function DictationSetup({
  /** Rendered above the fields when the sidecar has told us what is wrong. */
  problem,
  onRetry,
  compact
}: {
  problem?: string | null
  onRetry?: () => void
  compact?: boolean
}): ReactNode {
  const { state, actions } = useApp()
  const s = state.settings

  const [python, setPython] = useState(s.sttPython)
  const [modelDir, setModelDir] = useState(s.sttModelDir)
  const dirty = python.trim() !== s.sttPython || modelDir.trim() !== s.sttModelDir

  /**
   * Persist the paths. A running sidecar is holding the old ones, so it is
   * dropped either way; only the explicit Retry starts a replacement (see
   * ForgeApi.stt.reload).
   *
   * The store write is awaited rather than left to AppState's debounced
   * persistence: the sidecar reads its paths from the store when it spawns, so
   * respawning first would bring the new process up on the *old* paths and the
   * fix would look like it had not worked.
   */
  const save = (force: boolean): void => {
    if (!dirty && !force) return
    const patch = { sttPython: python.trim(), sttModelDir: modelDir.trim() }
    if (dirty) actions.patchSettings(patch)
    void (async () => {
      if (dirty) await window.forge.store.setSettings(patch)
      await window.forge.stt.reload(force)
    })()
    if (force) onRetry?.()
  }

  const browseModel = async (): Promise<void> => {
    const folder = await window.forge.pickFolder()
    if (folder) setModelDir(folder)
  }

  // Enter commits; nothing above this form should see these keys (the global
  // shortcut map would otherwise treat them as app accelerators).
  const onFieldKey = (e: React.KeyboardEvent): void => {
    e.stopPropagation()
    if (e.key === 'Enter') save(Boolean(onRetry))
  }

  return (
    <div className="dsetup" data-compact={compact ? 'true' : undefined}>
      {problem ? (
        <div className="dsetup__problem">
          <span className="dsetup__problem-title">Dictation can’t start</span>
          <span className="dsetup__problem-msg">{problem}</span>
        </div>
      ) : null}

      <div className="field">
        <label className="field__label" htmlFor="stt-python">
          Python interpreter
        </label>
        <input
          id="stt-python"
          className="field__input mono"
          value={python}
          spellCheck={false}
          placeholder="…\DictationMic\venv\Scripts\python.exe"
          onChange={(e) => setPython(e.target.value)}
          onKeyDown={onFieldKey}
          onBlur={() => save(false)}
        />
      </div>

      <div className="field">
        <label className="field__label" htmlFor="stt-model">
          Parakeet model folder
        </label>
        <div className="dsetup__row">
          <input
            id="stt-model"
            className="field__input mono"
            value={modelDir}
            spellCheck={false}
            placeholder="…\DictationMic\models\parakeet-tdt-0.6b-v2"
            onChange={(e) => setModelDir(e.target.value)}
            onKeyDown={onFieldKey}
            onBlur={() => save(false)}
          />
          <button type="button" className="ghost-btn dsetup__browse" onClick={() => void browseModel()}>
            Browse…
          </button>
        </div>
      </div>

      <div className="setting-row">
        <span className="setting-row__label">Toggle key</span>
        <select
          className="dsetup__select mono"
          value={s.sttHotkey}
          onChange={(e) => actions.patchSettings({ sttHotkey: e.target.value })}
          onKeyDown={(e) => e.stopPropagation()}
        >
          {HOTKEYS.map((code) => (
            <option key={code} value={code}>
              {hotkeyLabel(code)}
            </option>
          ))}
        </select>
      </div>

      <div className="setting-row">
        <span className="setting-row__label">Stop after silence</span>
        <div className="stepper">
          <button
            type="button"
            className="ghost-btn stepper__btn"
            aria-label="Shorter"
            onClick={() => actions.patchSettings({ sttAutoStopSeconds: Math.max(0, s.sttAutoStopSeconds - 1) })}
          >
            −
          </button>
          <span className="stepper__value mono">
            {s.sttAutoStopSeconds === 0 ? 'never' : `${s.sttAutoStopSeconds}s`}
          </span>
          <button
            type="button"
            className="ghost-btn stepper__btn"
            aria-label="Longer"
            onClick={() => actions.patchSettings({ sttAutoStopSeconds: Math.min(600, s.sttAutoStopSeconds + 1) })}
          >
            +
          </button>
        </div>
      </div>

      <div className="dsetup__actions">
        <span className="dsetup__hint">
          Dictation runs entirely on this machine — nothing is uploaded.
          {onRetry ? ' The model takes a few seconds to load the first time.' : ''}
        </span>
        {onRetry ? (
          <button type="button" className="cta-btn dsetup__retry" onClick={() => save(true)}>
            {dirty ? 'Save & retry' : 'Retry'}
          </button>
        ) : null}
      </div>
    </div>
  )
}
