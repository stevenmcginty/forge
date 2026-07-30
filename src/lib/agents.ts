import type { AgentProfile, ClaudePermissionMode, PaneLeaf, ProfileKind } from '@shared/types'
import {
  ACCENT_PALETTE,
  BUILTIN_AGENT_PROFILES,
  DEFAULT_PROFILE_ID,
  PERMISSION_FLAGS,
  PERMISSION_MODES,
  SHELL_BADGE_COLOR,
  commandExe,
  deriveBadge,
  inferKind,
  isClaudeCommand,
  isPermissionMode,
  isShellProfile
} from '@shared/agents'
import { makeId } from './ids'

export {
  ACCENT_PALETTE,
  BUILTIN_AGENT_PROFILES,
  DEFAULT_PROFILE_ID,
  PERMISSION_FLAGS,
  PERMISSION_MODES,
  SHELL_BADGE_COLOR,
  commandExe,
  deriveBadge,
  inferKind,
  isClaudeCommand,
  isPermissionMode,
  isShellProfile
}

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
  const cmd = command.trim()
  return {
    id: makeId('agent'),
    name: trimmed,
    command: cmd,
    accent: accent ?? ACCENT_PALETTE[ACCENT_PALETTE.length - 1]!,
    badge: deriveBadge(trimmed),
    kind: cmd ? 'agent' : 'shell'
  }
}

/** What the pane header shows when the user hasn't renamed it. */
export function paneDisplayTitle(profile: AgentProfile, title: string): string {
  return title.trim() || profile.name
}

/* ------------------------------------------------------------ chooser split */

/**
 * The roster, split the way the chooser shows it. Shells first: when you want a
 * prompt you want it now, not after reading a list of agents.
 */
export function splitProfiles(profiles: AgentProfile[]): { shells: AgentProfile[]; agents: AgentProfile[] } {
  const shells: AgentProfile[] = []
  const agents: AgentProfile[] = []
  for (const p of profiles) (isShellProfile(p) ? shells : agents).push(p)
  return { shells, agents }
}

export function profileKind(profile: AgentProfile): ProfileKind {
  return inferKind(profile)
}

/**
 * The tint a profile's badge wears. A shell is furniture, not a collaborator:
 * it gets the neutral grey whatever accent the profile carries, so a wall of
 * panes reads "three agents and a shell" at a glance.
 */
export function badgeColor(profile: AgentProfile): string {
  return isShellProfile(profile) ? SHELL_BADGE_COLOR : profile.accent
}

/* -------------------------------------------------------- permission modes */

/** Whether this profile can take permission-mode flags at all. */
export function supportsPermissionModes(profile: AgentProfile): boolean {
  return isClaudeCommand(profile.command)
}

/**
 * The mode a pane actually launches with: its own override, else the profile's
 * default, else Claude's own behaviour.
 */
export function effectivePermissionMode(
  profile: AgentProfile,
  override?: ClaudePermissionMode | null
): ClaudePermissionMode {
  if (!supportsPermissionModes(profile)) return 'default'
  if (isPermissionMode(override)) return override
  if (isPermissionMode(profile.permissionMode)) return profile.permissionMode
  return 'default'
}

/**
 * The line typed into the fresh shell.
 *
 * The flag is appended rather than inserted, so a profile whose command already
 * carries arguments (`claude --resume`, `claude -c`) keeps them and simply gains
 * the mode. A profile that is not Claude gets its command back untouched — the
 * flags mean nothing to anything else, and quietly passing
 * `--dangerously-skip-permissions` to a strange binary is not a risk worth
 * taking for a tidier code path.
 */
export function launchCommand(profile: AgentProfile, override?: ClaudePermissionMode | null): string {
  const command = profile.command.trim()
  if (!command || !supportsPermissionModes(profile)) return command
  const mode = effectivePermissionMode(profile, override)
  const flag = PERMISSION_FLAGS[mode]
  if (!flag) return command
  // Already spelled out by hand in the command? Leave it alone.
  if (command.includes('--dangerously-skip-permissions') || command.includes('--permission-mode')) return command
  return `${command} ${flag}`
}

/** The pane-header chip, or null when there is nothing worth shouting about. */
export function permissionChip(
  profile: AgentProfile,
  override?: ClaudePermissionMode | null
): { label: string; danger: boolean } | null {
  const mode = effectivePermissionMode(profile, override)
  if (mode === 'default') return null
  if (mode === 'bypass') return { label: 'BYPASS', danger: true }
  return { label: mode === 'plan' ? 'PLAN' : 'EDITS', danger: false }
}

/** The mode a leaf carries, if any — kept here so callers need not import types. */
export function leafPermissionMode(leaf: Pick<PaneLeaf, 'permissionMode'>): ClaudePermissionMode | null {
  return isPermissionMode(leaf.permissionMode) ? leaf.permissionMode : null
}
