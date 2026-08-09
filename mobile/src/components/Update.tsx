import { useEffect, useSyncExternalStore } from 'react'
import { formatBytes } from '../lib/manifest'
import {
  CURRENT_VERSION_CODE,
  CURRENT_VERSION_NAME,
  check,
  download,
  install,
  isNativeApp,
  updateStore,
  type UpdateState
} from '../lib/update'

/**
 * The update sheet, opened from the version chip in the status strip.
 *
 * One card, one primary action at a time: Check → Download → Install, with
 * the current phase spelled out in words rather than iconography, because
 * "verifying an executable before offering it to the OS installer" is a flow
 * where the user deserves sentences. The download keeps running if this sheet
 * is closed — the state lives in lib/update.ts, not here — so reopening it
 * mid-download shows honest progress rather than starting over.
 *
 * The sheet renders in the browser build too (that is the debug route), where
 * the primary action degrades to opening the APK URL in a tab.
 */

export function UpdateSheet({ onClose }: { onClose: () => void }): React.JSX.Element {
  const state = useSyncExternalStore(updateStore.subscribe, updateStore.getState)

  // Opening the sheet *is* the check request — a second "check" tap should
  // only be needed after an offline miss, so a button for it only shows then.
  // Mount-only on purpose: re-running on phase changes would turn every state
  // transition into another network fetch.
  useEffect(() => {
    if (updateStore.getState().phase === 'idle') void check()
  }, [])

  return (
    <div className="sheet-scrim" onClick={onClose}>
      <div className="sheet" role="dialog" aria-label="App update" onClick={(e) => e.stopPropagation()}>
        <div className="sheet-head">
          <strong>Forge Mobile</strong>
          <span className="sheet-version">
            v{CURRENT_VERSION_NAME} · build {CURRENT_VERSION_CODE}
            {!isNativeApp() && ' · browser'}
          </span>
        </div>

        <Body state={state} />

        {state.detail && <p className="sheet-detail">{state.detail}</p>}

        <button type="button" className="sheet-close" onClick={onClose}>
          Close
        </button>
      </div>
    </div>
  )
}

function Body({ state }: { state: UpdateState }): React.JSX.Element {
  switch (state.phase) {
    case 'idle':
    case 'checking':
      return <p className="sheet-line">Checking for updates…</p>

    case 'current':
      return (
        <>
          <p className="sheet-line sheet-good">Up to date.</p>
          <button type="button" className="ghost" onClick={() => void check()}>
            Check again
          </button>
        </>
      )

    case 'unreachable':
      // Offline is a normal day for a phone — quiet words, easy retry, and
      // the live terminal behind this sheet was never involved.
      return (
        <>
          <p className="sheet-line">Couldn’t check just now.</p>
          <button type="button" className="ghost" onClick={() => void check()}>
            Try again
          </button>
        </>
      )

    case 'available':
      return (
        <>
          <p className="sheet-line">
            <span className="sheet-new">v{state.manifest?.versionName}</span> is available
            {state.manifest ? ` · ${formatBytes(state.manifest.sizeBytes)}` : ''}
          </p>
          {state.manifest?.notes && <p className="sheet-notes">{state.manifest.notes}</p>}
          <button type="button" className="primary" onClick={() => void download()}>
            {isNativeApp() ? 'Download update' : 'Download in browser'}
          </button>
        </>
      )

    case 'downloading': {
      const fraction = state.total > 0 ? Math.min(1, state.received / state.total) : 0
      return (
        <>
          <p className="sheet-line">
            Downloading… {formatBytes(state.received) || '0 KB'}
            {state.total > 0 ? ` of ${formatBytes(state.total)}` : ''}
          </p>
          <div className="progress">
            <div className="progress-fill" style={{ transform: `scaleX(${fraction})` }} />
          </div>
        </>
      )
    }

    case 'ready':
      return (
        <>
          <p className="sheet-line sheet-good">Downloaded and verified.</p>
          <button type="button" className="primary" onClick={() => void install()}>
            Install v{state.manifest?.versionName}
          </button>
        </>
      )

    case 'failed':
      return (
        <button type="button" className="ghost" onClick={() => void check()}>
          Check again
        </button>
      )
  }
}
