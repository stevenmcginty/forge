import { useEffect, useRef, type ReactNode } from 'react'
import { useApp, type SettingsSection } from '@/state/AppState'
import { Icon, type IconName } from '../Icon'
import { AccountSection } from './AccountSection'
import { AlwaysOnSection } from './AlwaysOnSection'
import { RemoteYesSection } from './RemoteYesSection'
import { AdvancedSection } from './AdvancedSection'
import { AgentsSection } from './AgentsSection'
import { AppearanceSection } from './AppearanceSection'
import { ForemanSection } from './ForemanSection'
import { ModelsSection } from './ModelsSection'
import { ShortcutsSection } from './ShortcutsSection'
import { ShotsSection } from './ShotsSection'
import { MobileSection } from './MobileSection'
import { WebSection } from './WebSection'
import { TerminalSection } from './TerminalSection'
import { UpdatesSection } from './UpdatesSection'
import { VoiceSection } from './VoiceSection'
import './SettingsPage.css'

/**
 * Settings, as a pop-up over the deck (shell/SettingsPopup.tsx).
 *
 * The panes stay on screen and live behind it — you often come here *because*
 * of something a pane just did, and seeing it while you change the setting is
 * the point. The terminals keep running either way: terminalHost owns them.
 *
 * Escape, the close button or a click outside returns you to what you were
 * looking at.
 */

/**
 * Eight groups in the sidebar, in plain words, with Voice & Agent first. Each
 * group is one scrolling page of one or more parts, and every old section id
 * is a part — so `openSettings('models')` (the voice agent, the hub's "add a
 * key" links, onboarding) still lands on the right card, the Keys part of
 * Agents & CLIs, and nothing that deep-links into Settings had to change.
 */
interface Part {
  id: SettingsSection
  label: string
  Body: () => ReactNode
}

interface Group {
  id: SettingsSection
  label: string
  icon: IconName
  blurb: string
  /** The page's own line, when it holds more than one part. */
  lede?: string
  parts: Part[]
}

const GROUPS: Group[] = [
  {
    id: 'voice',
    label: 'Voice & Agent',
    icon: 'voice',
    blurb: 'the main agent, dictation, its voice',
    parts: [{ id: 'voice', label: 'Voice & Agent', Body: VoiceSection }]
  },
  {
    id: 'agents',
    label: 'Agents & CLIs',
    icon: 'terminal',
    blurb: 'profiles, keys, panes, Foreman',
    lede: 'What runs in the panes: the agents Forge launches, the keys they use, how panes behave, and Foreman.',
    parts: [
      { id: 'agents', label: 'Profiles', Body: AgentsSection },
      { id: 'models', label: 'Keys', Body: ModelsSection },
      { id: 'terminal', label: 'Panes', Body: TerminalSection },
      { id: 'foreman', label: 'Foreman', Body: ForemanSection }
    ]
  },
  {
    id: 'appearance',
    label: 'Appearance',
    icon: 'palette',
    blurb: 'themes, type, the shelf',
    lede: 'How Forge looks, and the screenshot shelf.',
    parts: [
      { id: 'appearance', label: 'Theme & backdrop', Body: AppearanceSection },
      { id: 'screenshots', label: 'Screenshots', Body: ShotsSection }
    ]
  },
  {
    id: 'shortcuts',
    label: 'Shortcuts',
    icon: 'grip',
    blurb: 'every key, rebindable',
    parts: [{ id: 'shortcuts', label: 'Shortcuts', Body: ShortcutsSection }]
  },
  {
    id: 'mobile',
    label: 'Phone & Web',
    icon: 'phone',
    blurb: 'Forge Mobile, Forge Web, remote',
    lede: 'Your terminals away from this desk: the phone app, the browser, pressing Yes from afar, and keeping Forge up for them.',
    parts: [
      { id: 'mobile', label: 'Forge Mobile', Body: MobileSection },
      { id: 'web', label: 'Forge Web', Body: WebSection },
      { id: 'remoteYes', label: 'Remote Yes', Body: RemoteYesSection },
      { id: 'alwaysOn', label: 'Always on', Body: AlwaysOnSection }
    ]
  },
  {
    id: 'account',
    label: 'Account',
    icon: 'user',
    blurb: 'name, Forge account, connections',
    parts: [{ id: 'account', label: 'Account', Body: AccountSection }]
  },
  {
    id: 'updates',
    label: 'Updates',
    icon: 'restart',
    blurb: 'CLIs, and Forge itself',
    parts: [{ id: 'updates', label: 'Updates', Body: UpdatesSection }]
  },
  {
    id: 'advanced',
    label: 'Advanced',
    icon: 'gear',
    blurb: 'paths and versions',
    parts: [{ id: 'advanced', label: 'Advanced', Body: AdvancedSection }]
  }
]

/** The group a section id lives in. An id nobody knows opens Voice & Agent. */
function groupOf(section: SettingsSection): Group {
  return GROUPS.find((g) => g.parts.some((p) => p.id === section)) ?? GROUPS[0]!
}

const reducedMotion = (): boolean =>
  document.documentElement.dataset.reducedMotion === 'true' || window.matchMedia('(prefers-reduced-motion: reduce)').matches

const two = (n: number): string => String(n).padStart(2, '0')

export function SettingsPage(): ReactNode {
  const { state, actions } = useApp()
  const section = state.settingsSection
  const group = groupOf(section)
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const navRef = useRef<HTMLElement | null>(null)

  /** Bring one part to the top of the page; a group's first part is the page's top. */
  const reveal = (id: SettingsSection, smooth: boolean): void => {
    const box = scrollRef.current
    if (!box) return
    const g = groupOf(id)
    const el = g.parts[0]?.id === id ? null : box.querySelector<HTMLElement>(`[data-part="${id}"]`)
    const top = el ? box.scrollTop + el.getBoundingClientRect().top - box.getBoundingClientRect().top - 16 : 0
    box.scrollTo({ top: Math.max(0, top), behavior: smooth && !reducedMotion() ? 'smooth' : 'auto' })
  }

  // A new section starts at the top of its part; nobody wants to arrive in
  // Appearance scrolled halfway down because Agents was.
  useEffect(() => {
    reveal(section, false)
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
    const i = GROUPS.indexOf(group)
    const next = e.key === 'ArrowDown' ? (i + 1) % GROUPS.length : (i - 1 + GROUPS.length) % GROUPS.length
    actions.setSettingsSection(GROUPS[next]!.id)
    const buttons = navRef.current?.querySelectorAll<HTMLButtonElement>('.spage__navbtn')
    buttons?.[next]?.focus()
  }

  const many = group.parts.length > 1

  return (
    <div className="spage">
      <header className="spage__head">
        <span className="spage__mark" aria-hidden="true">
          <Icon name="gear" size={14} />
        </span>
        <h1 className="spage__title">Settings</h1>
        <span className="spage__hint eyebrow">esc to close</span>
        <button
          type="button"
          className="ghost-btn spage__close"
          title="Close settings (Esc)"
          aria-label="Close settings"
          onClick={() => actions.closeSettings()}
        >
          <Icon name="close" size={14} />
        </button>
      </header>

      <div className="spage__body">
        <nav className="spage__nav" ref={navRef} aria-label="Settings sections" onKeyDown={onNavKey}>
          {GROUPS.map((g) => (
            <button
              key={g.id}
              type="button"
              className="spage__navbtn"
              data-id={g.id}
              data-active={g === group ? 'true' : undefined}
              aria-current={g === group ? 'page' : undefined}
              onClick={() => actions.setSettingsSection(g.id)}
            >
              <Icon name={g.icon} size={14} className="spage__navicon" />
              <span className="spage__navtext">
                <span className="spage__navlabel">{g.label}</span>
                <span className="spage__navblurb">{g.blurb}</span>
              </span>
            </button>
          ))}
        </nav>

        <div className="spage__content" ref={scrollRef}>
          <div className="spage__column" key={group.id}>
            {many ? (
              <div className="sgroup">
                <header className="sgroup__head">
                  <h2 className="sgroup__title">{group.label}</h2>
                  {group.lede ? <p className="sgroup__lede">{group.lede}</p> : null}
                  <div className="sgroup__jump" role="group" aria-label={`Parts of ${group.label}`}>
                    {group.parts.map((p, i) => (
                      <button
                        key={p.id}
                        type="button"
                        className="sgroup__chip"
                        onClick={() => {
                          if (p.id === section) reveal(p.id, true)
                          else actions.setSettingsSection(p.id)
                        }}
                      >
                        <span className="sgroup__chipnum mono">{two(i + 1)}</span>
                        {p.label}
                      </button>
                    ))}
                  </div>
                </header>
                {group.parts.map((p, i) => (
                  <div key={p.id} className="sgroup__part" data-part={p.id}>
                    <span className="sgroup__num mono" aria-hidden="true">
                      {two(i + 1)} / {two(group.parts.length)}
                    </span>
                    <p.Body />
                  </div>
                ))}
              </div>
            ) : (
              group.parts.map((p) => <p.Body key={p.id} />)
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
