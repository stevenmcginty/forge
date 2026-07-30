import { useRef, useState, type ReactNode } from 'react'
import { allThemes, findTheme } from '@/theme/themes'
import { useApp } from '@/state/AppState'
import { Icon } from './Icon'
import { Popover, PopoverDivider, PopoverRow, PopoverSection } from './Popover'
import { StateChip } from './settings/parts'
import { useAgentProbe, useConnections } from './settings/useConnections'
import './AccountChip.css'

/**
 * The account chip: bottom-left, under the shelf, where a status light belongs.
 *
 * It answers one question at a glance — is everything Forge depends on actually
 * wired up — and one more on click: which bit is not. The dot is volt when every
 * configurable service is set, amber when one is degraded; the placeholders
 * ("coming soon") never count against it, because a feature that does not exist
 * is not a fault.
 */
export function AccountChip(): ReactNode {
  const { state, actions } = useApp()
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLButtonElement | null>(null)
  // The probe only stats files on PATH, and asks for a version at most once per
  // mount — this sits in the chrome of every window, so it must not be the kind
  // of thing that spawns a process on every render.
  const probe = useAgentProbe()
  const { connections, healthy } = useConnections(probe)

  const name = state.settings.accountName || 'You'
  const colour = state.settings.accountColor
  const collapsed = state.settings.railCollapsed
  const themes = allThemes(state.settings.customThemes)
  const current = findTheme(state.settings.themeId, state.settings.customThemes)

  const initials = name
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((w) => w[0]!)
    .join('')
    .toUpperCase()

  return (
    <>
      <button
        ref={ref}
        type="button"
        className="achip"
        data-collapsed={collapsed ? 'true' : undefined}
        data-open={open ? 'true' : undefined}
        aria-haspopup="menu"
        aria-expanded={open}
        title={`${name} — ${healthy ? 'everything configured' : 'something needs a look'}`}
        style={{ '--avatar': colour } as React.CSSProperties}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="achip__avatar">{initials || '?'}</span>
        {!collapsed ? (
          <>
            <span className="achip__name truncate">{name}</span>
            <span className="achip__status" data-ok={healthy ? 'true' : 'false'} />
          </>
        ) : (
          <span className="achip__status achip__status--pip" data-ok={healthy ? 'true' : 'false'} />
        )}
      </button>

      <Popover anchor={ref.current} open={open} onClose={() => setOpen(false)} side="top" width={272} label={name}>
        <div className="achip__header">
          <span className="achip__avatar achip__avatar--lg" style={{ '--avatar': colour } as React.CSSProperties}>
            {initials || '?'}
          </span>
          <div className="achip__header-text">
            <span className="achip__header-name truncate">{name}</span>
            <span className="achip__header-sub">{healthy ? 'all services configured' : 'one service needs a key'}</span>
          </div>
        </div>

        <PopoverDivider />

        <PopoverSection title="Connected">
          {connections.map((c) => (
            <button
              key={c.id}
              type="button"
              className="achip__conn"
              disabled={!c.section}
              onClick={() => {
                if (!c.section) return
                actions.openSettings(c.section)
                setOpen(false)
              }}
            >
              <span className="achip__conn-name truncate">{c.name}</span>
              <StateChip tone={c.tone}>{c.chip}</StateChip>
            </button>
          ))}
        </PopoverSection>

        <PopoverDivider />

        <PopoverSection title="Theme">
          <div className="achip__themes">
            {themes.map((theme) => (
              <button
                key={theme.id}
                type="button"
                className="achip__theme"
                data-selected={theme.id === current.id ? 'true' : undefined}
                title={theme.name}
                aria-label={`Use the ${theme.name} theme`}
                onClick={() => actions.setTheme(theme.id)}
                style={{ background: theme.bg, borderColor: theme.id === current.id ? theme.accent : undefined }}
              >
                <span style={{ background: theme.accent }} />
              </button>
            ))}
          </div>
        </PopoverSection>

        <PopoverDivider />

        <PopoverRow
          onClick={() => {
            actions.openSettings()
            setOpen(false)
          }}
        >
          <Icon name="gear" size={14} />
          <span className="achip__row-name">Settings</span>
          <span className="achip__row-keys mono">Ctrl+,</span>
        </PopoverRow>
      </Popover>
    </>
  )
}
