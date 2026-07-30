import type { ReactNode } from 'react'
import type { AgentProfile } from '@shared/types'
import { badgeColor, isShellProfile } from '@/lib/agents'
import './AgentBadge.css'

/**
 * The two-letter agent mark. Tinted with the profile's own accent so a wall of
 * panes is scannable at a glance — except for shells, which wear a neutral grey
 * whatever accent they carry. A prompt is furniture; the coloured badges should
 * mean "something is running in here that can act on its own".
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
      data-shell={isShellProfile(profile) ? 'true' : undefined}
      style={{ '--badge-accent': badgeColor(profile) } as React.CSSProperties}
      title={profile.command ? `${profile.name} — runs \`${profile.command}\`` : `${profile.name} — plain shell`}
    >
      {profile.badge.slice(0, 2).toUpperCase()}
    </span>
  )
}
