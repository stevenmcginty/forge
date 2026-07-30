import type { ReactNode } from 'react'
import type { AgentProfile } from '@shared/types'
import './AgentBadge.css'

/**
 * The two-letter agent mark. Tinted with the profile's own accent so a wall of
 * panes is scannable at a glance.
 */
export function AgentBadge({
  profile,
  size = 'md'
}: {
  profile: AgentProfile
  size?: 'sm' | 'md'
}): ReactNode {
  return (
    <span
      className="agent-badge"
      data-size={size}
      style={{ '--badge-accent': profile.accent } as React.CSSProperties}
      title={profile.command ? `${profile.name} — runs \`${profile.command}\`` : `${profile.name} — plain shell`}
    >
      {profile.badge.slice(0, 2).toUpperCase()}
    </span>
  )
}
