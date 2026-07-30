import type { AgentProfile } from '@shared/types'
import { ACCENT_PALETTE, BUILTIN_AGENT_PROFILES, DEFAULT_PROFILE_ID, deriveBadge } from '@shared/agents'
import { makeId } from './ids'

export { ACCENT_PALETTE, BUILTIN_AGENT_PROFILES, DEFAULT_PROFILE_ID, deriveBadge }

/** Never return undefined for a pane: fall back to the plain shell. */
export function resolveProfile(profiles: AgentProfile[], id: string | null | undefined): AgentProfile {
  const found = profiles.find((p) => p.id === id)
  if (found) return found
  return (
    profiles.find((p) => p.id === DEFAULT_PROFILE_ID) ??
    profiles[0] ??
    BUILTIN_AGENT_PROFILES[0]!
  )
}

/** Build a custom profile from just a name + command. */
export function makeCustomProfile(name: string, command: string, accent?: string): AgentProfile {
  const trimmed = name.trim() || 'Custom'
  return {
    id: makeId('agent'),
    name: trimmed,
    command: command.trim(),
    accent: accent ?? ACCENT_PALETTE[ACCENT_PALETTE.length - 1]!,
    badge: deriveBadge(trimmed)
  }
}

/** What the pane header shows when the user hasn't renamed it. */
export function paneDisplayTitle(profile: AgentProfile, title: string): string {
  return title.trim() || profile.name
}
