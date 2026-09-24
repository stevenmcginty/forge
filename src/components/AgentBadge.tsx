import type { CSSProperties, ReactNode } from 'react'
import type { AgentProfile } from '@shared/types'
import { agentLogoFor } from '@shared/agent-logos'
import { badgeColor, isShellProfile } from '@/lib/agents'
import './AgentBadge.css'

/**
 * The agent's mark, top-left of every terminal. A known agent wears its
 * maker's logo (shared/agent-logos.ts) on a plate washed in the brand colour —
 * or in the theme's ink, for a monochrome brand — so the logo reads the same on
 * the dark themes and on Paper. A shell wears a neutral prompt glyph on an
 * outlined, unwashed plate: a prompt is furniture, and the coloured plates
 * should mean "something is running in here that can act on its own".
 *
 * An agent Forge does not recognise keeps the two-letter text badge, tinted
 * with the profile's own accent.
 */
export function AgentBadge({
  profile,
  size = 'md'
}: {
  profile: AgentProfile
  size?: 'sm' | 'md'
}): ReactNode {
  const logo = agentLogoFor(profile)
  const title = profile.command ? `${profile.name} — runs \`${profile.command}\`` : `${profile.name} — plain shell`
  const shell = isShellProfile(profile)

  if (!logo) {
    return (
      <span
        className="agent-badge"
        data-size={size}
        data-shell={shell ? 'true' : undefined}
        style={{ '--badge-accent': badgeColor(profile) } as CSSProperties}
        title={title}
      >
        {profile.badge.slice(0, 2).toUpperCase()}
      </span>
    )
  }

  const style = (
    logo.color ? { '--logo-on-dark': logo.color.dark, '--logo-on-light': logo.color.light } : undefined
  ) as CSSProperties | undefined

  return (
    <span
      className="agent-badge"
      data-size={size}
      data-logo={logo.key}
      data-mono={logo.color ? undefined : 'true'}
      data-shell={shell ? 'true' : undefined}
      style={style}
      title={title}
      role="img"
      aria-label={profile.name}
    >
      <svg className="agent-badge__logo" viewBox={logo.viewBox} aria-hidden="true" focusable="false">
        {logo.paths.map((path, i) => (
          <path
            key={i}
            d={path.d}
            data-ink={path.ink ? 'true' : undefined}
            fillRule={logo.evenOdd ? 'evenodd' : undefined}
          />
        ))}
      </svg>
    </span>
  )
}
