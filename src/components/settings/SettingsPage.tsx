import { useEffect, useRef, type ReactNode } from 'react'
import { useApp, type SettingsSection } from '@/state/AppState'
import { Icon, type IconName } from '../Icon'
import { AccountSection } from './AccountSection'
import { AdvancedSection } from './AdvancedSection'
import { AgentsSection } from './AgentsSection'
import { AppearanceSection } from './AppearanceSection'
import { ModelsSection } from './ModelsSection'
import { ShotsSection } from './ShotsSection'
import { MobileSection } from './MobileSection'
import { WebSection } from './WebSection'
import { TerminalSection } from './TerminalSection'
import { UpdatesSection } from './UpdatesSection'
import { VoiceSection } from './VoiceSection'
import './SettingsPage.css'

/**
 * Settings, as a place rather than a popover.
 *
 * It takes over the terminal area — the rail, the shelf and the floating voice hub stay
 * exactly where they were, because you are still in the same project and often
 * come here *because* of something a pane just did. The terminals themselves
 * keep running: terminalHost owns them, not React, so unmounting the grid costs
 * nothing and coming back is instant.
 *
 * Escape or the back arrow returns you to what you were looking at.
 */

const SECTIONS: Array<{ id: SettingsSection; label: string; icon: IconName; blurb: string }> = [
  { id: 'account', label: 'Account', icon: 'user', blurb: 'Forge account, name, connections' },
  { id: 'agents', label: 'Agents', icon: 'terminal', blurb: 'launch profiles' },
  { id: 'terminal', label: 'Terminal', icon: 'panel', blurb: 'how panes behave' },
  { id: 'models', label: 'Models & APIs', icon: 'key', blurb: 'keys and brains' },
  { id: 'voice', label: 'Voice', icon: 'voice', blurb: 'dictation and relay' },
  { id: 'appearance', label: 'Appearance', icon: 'palette', blurb: 'themes and type' },
  { id: 'screenshots', label: 'Screenshots', icon: 'camera', blurb: 'the shelf' },
  { id: 'mobile', label: 'Forge Mobile', icon: 'phone', blurb: 'your terminals, on your phone' },
  { id: 'web', label: 'Forge Web', icon: 'globe', blurb: 'your terminals, in a browser' },
  { id: 'updates', label: 'Updates & tools', icon: 'restart', blurb: 'CLIs, and Forge itself' },
  { id: 'advanced', label: 'Advanced', icon: 'gear', blurb: 'paths and versions' }
]

export function SettingsPage(): ReactNode {
  const { state, actions } = useApp()
  const section = state.settingsSection
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const navRef = useRef<HTMLElement | null>(null)

  // A new section starts at the top; nobody wants to arrive in Appearance
  // scrolled halfway down because Agents was.
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: 0 })
  }, [section])

  // Escape leaves — unless a popover or a native colour picker has it first,
  // which is why this listens in the bubble phase rather than capture.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape' || e.defaultPrevented) return
      const el = document.activeElement
      if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement) return
      actions.closeSettings()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [actions])

  /** Up/down the sidebar with the arrow keys, the way a list should behave. */
  const onNavKey = (e: React.KeyboardEvent): void => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return
    e.preventDefault()
    e.stopPropagation()
    const i = SECTIONS.findIndex((s) => s.id === section)
    const next = e.key === 'ArrowDown' ? (i + 1) % SECTIONS.length : (i - 1 + SECTIONS.length) % SECTIONS.length
    actions.setSettingsSection(SECTIONS[next]!.id)
    const buttons = navRef.current?.querySelectorAll<HTMLButtonElement>('.spage__navbtn')
    buttons?.[next]?.focus()
  }

  return (
    <div className="spage">
      <header className="spage__head">
        <button
          type="button"
          className="ghost-btn spage__back"
          title="Back to terminals (Esc)"
          onClick={() => actions.closeSettings()}
        >
          <Icon name="chevronLeft" size={14} />
          Back
        </button>
        <h1 className="spage__title">Settings</h1>
        <span className="spage__hint eyebrow">esc to close</span>
      </header>

      <div className="spage__body">
        <nav className="spage__nav" ref={navRef} aria-label="Settings sections" onKeyDown={onNavKey}>
          {SECTIONS.map((s) => (
            <button
              key={s.id}
              type="button"
              className="spage__navbtn"
              data-active={s.id === section ? 'true' : undefined}
              aria-current={s.id === section ? 'page' : undefined}
              onClick={() => actions.setSettingsSection(s.id)}
            >
              <Icon name={s.icon} size={14} className="spage__navicon" />
              <span className="spage__navtext">
                <span className="spage__navlabel">{s.label}</span>
                <span className="spage__navblurb">{s.blurb}</span>
              </span>
            </button>
          ))}
        </nav>

        <div className="spage__content" ref={scrollRef}>
          <div className="spage__column">
            {section === 'account' ? <AccountSection /> : null}
            {section === 'agents' ? <AgentsSection /> : null}
            {section === 'terminal' ? <TerminalSection /> : null}
            {section === 'models' ? <ModelsSection /> : null}
            {section === 'voice' ? <VoiceSection /> : null}
            {section === 'appearance' ? <AppearanceSection /> : null}
            {section === 'screenshots' ? <ShotsSection /> : null}
            {section === 'mobile' ? <MobileSection /> : null}
            {section === 'web' ? <WebSection /> : null}
            {section === 'updates' ? <UpdatesSection /> : null}
            {section === 'advanced' ? <AdvancedSection /> : null}
          </div>
        </div>
      </div>
    </div>
  )
}
