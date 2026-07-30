import { useEffect, useRef, useState, type ReactNode } from 'react'
import { useActiveProject, useApp } from '@/state/AppState'
import { shortPath } from '@/lib/paths'
import { Icon } from './Icon'
import { SettingsPopover } from './SettingsPopover'
import './TitleBar.css'

/**
 * Custom titlebar. The native minimise/maximise/close buttons are drawn by
 * Windows into the reserved area on the right (titleBarOverlay), so we never
 * re-implement them — we just keep our own chrome out of their way.
 */
export function TitleBar(): ReactNode {
  const { state, actions } = useApp()
  const project = useActiveProject()
  const gearRef = useRef<HTMLButtonElement | null>(null)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [focused, setFocused] = useState(true)

  useEffect(() => window.forge.window.onState((s) => setFocused(s.focused)), [])

  return (
    <header className="titlebar" data-focused={focused}>
      <div className="titlebar__left">
        <button
          type="button"
          className="ghost-btn titlebar__btn"
          title={state.settings.railCollapsed ? 'Show projects (Ctrl+Shift+B)' : 'Hide projects (Ctrl+Shift+B)'}
          aria-pressed={!state.settings.railCollapsed}
          onClick={() => actions.toggleRail()}
        >
          <Icon name="panel" size={15} />
        </button>

        <span className="titlebar__mark">
          <Icon name="forge" size={15} />
        </span>
        <span className="titlebar__wordmark">Forge</span>

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
            state.settings.voicePanelOpen ? 'Hide voice agent (Ctrl+Shift+G)' : 'Show voice agent (Ctrl+Shift+G)'
          }
          aria-pressed={state.settings.voicePanelOpen}
          data-on={state.settings.voicePanelOpen ? 'true' : undefined}
          onClick={() => actions.toggleVoicePanel()}
        >
          <Icon name="voice" size={15} />
        </button>

        <button
          ref={gearRef}
          type="button"
          className="ghost-btn titlebar__btn"
          title="Settings"
          onClick={() => setSettingsOpen(true)}
        >
          <Icon name="gear" size={15} />
        </button>
      </div>

      {/* Reserved for the native window controls (3 × 46px on Windows 11). */}
      <div className="titlebar__controls-gap" />

      <SettingsPopover anchor={gearRef.current} open={settingsOpen} onClose={() => setSettingsOpen(false)} />
    </header>
  )
}
