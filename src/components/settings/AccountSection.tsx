import { useEffect, useState, type ReactNode } from 'react'
import { ACCENT_PALETTE } from '@/lib/agents'
import { useApp } from '@/state/AppState'
import { Icon } from '../Icon'
import { ForgeAccountForm } from './ForgeAccountForm'
import { Card, ColorPicker, Row, Section, StateChip, TextField } from './parts'
import { useAgentProbe, useConnections } from './useConnections'

/**
 * Who you are to Forge, and what Forge is connected to.
 *
 * Display name and colour are local decoration. The Forge account below is
 * the real identity: email + password in Firebase, used by the website to
 * find this PC. Terminals do not need it.
 */
export function AccountSection(): ReactNode {
  const { state, actions } = useApp()
  const probe = useAgentProbe()
  const { connections } = useConnections(probe)
  const [suggested, setSuggested] = useState<string | null>(null)

  // Offer the Windows account name when the stored one has been emptied.
  useEffect(() => {
    void window.forge.system.userName().then((name) => setSuggested(name.trim() || null))
  }, [])

  const name = state.settings.accountName
  const colour = state.settings.accountColor
  const initials = (name.trim() || '?')
    .split(/\s+/)
    .slice(0, 2)
    .map((w) => w[0]!)
    .join('')
    .toUpperCase()

  return (
    <Section title="Account" blurb="Your name on the chip, the Forge account a browser uses to find this PC, and everything else Forge is wired into.">
      <Card
        title="Forge account"
        hint="Email plus password. A new email creates the account. The password is sent once and never stored — a refresh token is what stays on this PC. Same email on https://forge-web-aadafc.web.app is how a browser finds THIS machine."
      >
        <ForgeAccountForm />
        <p className="scard__hint">
          After this is saved, turn on browser access under Settings → Forge Web. That publishes a tunnel under this
          email. Signing in here does not open the door on its own.
        </p>
      </Card>

      <Card>
        <div className="sacct">
          <span className="sacct__avatar" style={{ '--avatar': colour } as React.CSSProperties}>
            {initials}
          </span>
          <div className="sacct__fields">
            <Row label="Display name" htmlFor="acct-name">
              <TextField
                id="acct-name"
                value={name}
                onCommit={(next) => actions.setAccountName(next || suggested || 'You')}
                placeholder={suggested ?? 'You'}
              />
            </Row>
            <Row label="Avatar colour">
              <ColorPicker
                value={colour}
                palette={ACCENT_PALETTE}
                onChange={actions.setAccountColor}
                label="Avatar colour"
              />
            </Row>
          </div>
        </div>
        {suggested && suggested.toLowerCase() !== name.toLowerCase() ? (
          <p className="scard__hint">
            Windows knows you as <span className="mono">{suggested}</span>.{' '}
            <button type="button" className="slink" onClick={() => actions.setAccountName(suggested)}>
              Use that
            </button>
          </p>
        ) : null}
      </Card>

      <Card
        title="Connected accounts"
        actions={
          <button type="button" className="ghost-btn sbtn" onClick={probe.recheck} title="Check again">
            <Icon name="restart" size={12} />
            Re-check
          </button>
        }
        hint="Forge only ever talks to Gemini, and only when Gemini is the voice brain. Everything else on this list is local."
      >
        <ul className="sconn">
          {connections.map((c) => (
            <li className="sconn__row" key={c.id} data-placeholder={c.placeholder ? 'true' : undefined}>
              <div className="sconn__text">
                <span className="sconn__name">{c.name}</span>
                <span className="sconn__detail">{c.detail}</span>
              </div>
              <StateChip tone={c.tone}>{c.chip}</StateChip>
              {c.section ? (
                <button
                  type="button"
                  className="ghost-btn sconn__go"
                  title={`Open ${c.section}`}
                  onClick={() => actions.setSettingsSection(c.section!)}
                >
                  <Icon name="chevronDown" size={12} className="sconn__go-icon" />
                </button>
              ) : (
                <span className="sconn__go" />
              )}
            </li>
          ))}
        </ul>
      </Card>
    </Section>
  )
}
