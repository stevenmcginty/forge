import { useEffect, useState, type ReactNode } from 'react'
import { useActiveProject, useApp } from '@/state/AppState'
import { shortPath } from '@/lib/paths'
import { Icon } from './Icon'
import './TitleBar.css'

/**
 * Custom titlebar. The native minimise/maximise/close buttons are drawn by
 * Windows into the reserved area on the right (titleBarOverlay), so we never
 * re-implement them — we just keep our own chrome out of their way.
 */
export function TitleBar(): ReactNode {
  const { state, actions } = useApp()
  const project = useActiveProject()
  const [focused, setFocused] = useState(true)
  const inSettings = state.view === 'settings'
  const inDevices = state.view === 'devices'
  /**
   * Before hydrate there is no info, and a window that might well be the
   * everyday Forge must not flash a DEV chip on the way in.
   */
  const isDevChannel = state.info?.channel === 'dev'
  /** The hub button is a toggle for the *card*, not for the hub's existence. */
  const hubOpen = state.settings.voiceHub.mode === 'expanded'

  useEffect(() => window.forge.window.onState((s) => setFocused(s.focused)), [])

  return (
    <header className="titlebar" data-focused={focused}>
      <div className="titlebar__left">
        <button
          type="button"
          className="ghost-btn titlebar__btn"
          title={state.settings.railCollapsed ? 'Show projects (Ctrl+Shift+B)' : 'Hide projects (Ctrl+Shift+B)'}
          aria-label="Projects rail"
          aria-pressed={!state.settings.railCollapsed}
          onClick={() => actions.toggleRail()}
        >
          <Icon name="panel" size={15} />
        </button>

        <span className="titlebar__mark" data-channel={isDevChannel ? 'dev' : undefined}>
          <Icon name="forge" size={15} />
        </span>
        <span className="titlebar__wordmark">Forge</span>
        {isDevChannel ? <span className="titlebar__channel mono">DEV</span> : null}

        {project ? (
          <>
            <span className="titlebar__sep" />
            <span className="titlebar__project truncate" style={{ '--dot': project.color } as React.CSSProperties}>
              <span className="titlebar__dot" />
              {project.name}
            </span>
            <span className="titlebar__path mono truncate">{shortPath(project.path, 3)}</span>
          </>
        ) : null}
      </div>

      <div className="titlebar__right">
        <button
          type="button"
          className="ghost-btn titlebar__btn"
          title={
            hubOpen ? 'Close the voice hub (Ctrl+Shift+G)' : 'Open the voice hub (Ctrl+Shift+G)'
          }
          aria-label="Voice hub"
          aria-pressed={hubOpen}
          data-on={hubOpen ? 'true' : undefined}
          onClick={() => actions.toggleVoiceHubCard()}
        >
          {/*
            The glyph moved with the thing it opens. It used to be a panel,
            because it opened a panel; the hub is a floating card, so it is the
            card. The waveform still belongs to the dictation pill and the
            microphone to the agent's own circle — three different things must
            never wear the same glyph, which is what made them indistinguishable
            the first time round.
          */}
          <Icon name="expand" size={15} />
        </button>

        {/*
          The Devices preview — the phone-shaped view of Forge Mobile, framed
          in iOS and Android bodies on this desk. A toggle beside the gear
          because it is a view, the same way Settings is, and it takes the
          terminal area over rather than floating over it.
        */}
        <button
          type="button"
          className="ghost-btn titlebar__btn"
          title={inDevices ? 'Back to terminals (Esc)' : 'Devices (Ctrl+Shift+D)'}
          aria-label="Devices preview"
          aria-pressed={inDevices}
          data-on={inDevices ? 'true' : undefined}
          onClick={() => (inDevices ? actions.closeDevices() : actions.openDevices())}
        >
          <Icon name="phone" size={15} />
        </button>

        <button
          type="button"
          className="ghost-btn titlebar__btn"
          title={inSettings ? 'Back to terminals (Esc)' : 'Settings (Ctrl+,)'}
          aria-pressed={inSettings}
          data-on={inSettings ? 'true' : undefined}
          onClick={() => (inSettings ? actions.closeSettings() : actions.openSettings())}
        >
          <Icon name="gear" size={15} />
        </button>
      </div>

      {/* Reserved for the native window controls (3 × 46px on Windows 11). */}
      <div className="titlebar__controls-gap" />
    </header>
  )
}
