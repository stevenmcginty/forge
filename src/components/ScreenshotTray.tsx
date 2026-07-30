import type { ReactNode } from 'react'
import { useApp } from '@/state/AppState'
import { Icon } from './Icon'
import './ScreenshotTray.css'

/**
 * Placeholder for the screenshot tray (a later milestone owns the capture
 * pipeline). It ships now so the layout is honest from day one — and so the
 * empty state is the thing you see first, not a hole.
 */
export function ScreenshotTray(): ReactNode {
  const { state } = useApp()
  const collapsed = state.settings.railCollapsed

  if (collapsed) {
    return (
      <div className="tray tray--collapsed" title="Screenshots you take will land here">
        <Icon name="camera" size={16} />
      </div>
    )
  }

  return (
    <section className="tray" aria-label="Screenshot tray">
      <header className="tray__head">
        <span className="eyebrow">Shots</span>
        <span className="tray__count mono">0</span>
      </header>
      <div className="tray__body">
        <div className="tray__tiles" aria-hidden="true">
          <span className="tray__tile" />
          <span className="tray__tile" />
          <span className="tray__tile" />
        </div>
        <p className="tray__note">Screenshots you take will land here</p>
      </div>
    </section>
  )
}
