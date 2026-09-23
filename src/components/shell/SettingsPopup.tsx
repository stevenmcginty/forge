import type { ReactNode } from 'react'
import { usePresence } from '@/lib/motion'
import { useApp } from '@/state/AppState'
import { SettingsPage } from '../settings/SettingsPage'

/**
 * Settings, as a pop-up over the deck rather than a page that replaces it.
 *
 * The panes stay mounted and live behind the scrim — terminals keep printing,
 * the agents keep working — so opening settings to change one thing costs no
 * context at all. Esc (SettingsPage listens) or a click on the scrim closes it.
 * The scrim is a plain wash, not a blur: a blur over streaming terminals would
 * be recomputed on every frame they print.
 */
export function SettingsPopup(): ReactNode {
  const { state, actions } = useApp()
  const { mounted, closing } = usePresence(state.view === 'settings', 170)
  if (!mounted) return null
  return (
    <div
      className="spop"
      data-state={closing ? 'closing' : 'open'}
      data-shell-overlay=""
      onPointerDown={(e) => {
        if (e.target === e.currentTarget) actions.closeSettings()
      }}
    >
      <div className="spop__panel" role="dialog" aria-modal="true" aria-label="Settings">
        <SettingsPage />
      </div>
    </div>
  )
}
