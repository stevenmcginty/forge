import type { AgentProfile } from './types'

/**
 * Built-in agent profiles. These are *seeded into* settings.json on first run
 * so Steve can edit them by hand (rename, recolour, change the command) or add
 * his own. `builtin: true` only means "cannot be deleted".
 */
export const BUILTIN_AGENT_PROFILES: AgentProfile[] = [
  {
    id: 'pwsh',
    name: 'PowerShell',
    command: '',
    accent: '#7FD1FF',
    badge: 'PS',
    builtin: true
  },
  {
    id: 'claude',
    name: 'Claude Code',
    command: 'claude',
    accent: '#C6FF4A',
    badge: 'CC',
    builtin: true
  },
  {
    id: 'kimi',
    name: 'Kimi',
    command: 'kimi',
    accent: '#C08BFF',
    badge: 'KI',
    builtin: true
  }
]

export const DEFAULT_PROFILE_ID = 'claude'

/** Palette offered when creating a custom profile or a project. */
export const ACCENT_PALETTE = [
  '#C6FF4A',
  '#7FD1FF',
  '#C08BFF',
  '#FFB347',
  '#FF6E6E',
  '#5EE6A8',
  '#F2E56B',
  '#9AA3AF'
]

/** Derive a sensible two-letter badge from a profile name. */
export function deriveBadge(name: string): string {
  const words = name.trim().split(/[\s_-]+/).filter(Boolean)
  if (words.length === 0) return '??'
  if (words.length === 1) return words[0]!.slice(0, 2).toUpperCase()
  return (words[0]![0]! + words[1]![0]!).toUpperCase()
}
