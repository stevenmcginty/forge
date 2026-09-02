import type { AgentProfile, ClaudePermissionMode, PaneLeaf, ProfileKind, TabSettings } from '@shared/types'
import {
  ACCENT_PALETTE,
  BUILTIN_AGENT_PROFILES,
  DEFAULT_PROFILE_ID,
  PERMISSION_FAMILIES,
  SHELL_BADGE_COLOR,
  TAB_TEXT_PALETTE,
  commandExe,
  deriveBadge,
  hasExplicitPermissionFlag,
  inferKind,
  isClaudeCommand,
  isPermissionMode,
  isShellProfile,
  paneDisplayTitle,
  permissionFamily,
  permissionModes,
  permissionSpec,
  resolveProfile
} from '@shared/agents'
import { makeId } from './ids'

export {
  ACCENT_PALETTE,
  BUILTIN_AGENT_PROFILES,
  DEFAULT_PROFILE_ID,
  PERMISSION_FAMILIES,
  SHELL_BADGE_COLOR,
  TAB_TEXT_PALETTE,
  commandExe,
  deriveBadge,
  inferKind,
  isClaudeCommand,
  isPermissionMode,
  isShellProfile,
  paneDisplayTitle,
  permissionFamily,
  permissionModes,
  permissionSpec,
  resolveProfile
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

/**
 * The profile a new pane inside `tab` should open on: the tab's own answer if
 * it still has one, else the caller's fallback (the project's default).
 *
 * The existence check is the point. A tab keeps the id of a profile the user
 * may later delete or rename away, and a pane opened onto a dead id would fall
 * all the way back to a bare shell — a tab quietly losing its agent months
 * after somebody tidied the roster. One rule, used everywhere a pane is born
 * inside a tab, so the split button and a phone's layout op cannot disagree.
 */
export function tabDefaultProfileId(
  tab: { settings?: TabSettings } | null | undefined,
  profiles: AgentProfile[],
  fallback: string
): string {
  const wanted = tab?.settings?.defaultProfileId
  if (wanted && profiles.some((p) => p.id === wanted)) return wanted
  return fallback
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
  return permissionFamily(profile.command) !== null
}

/** The rungs this profile offers, in chooser order. Empty when it has none. */
export function profilePermissionModes(profile: AgentProfile): ReturnType<typeof permissionModes> {
  return permissionModes(profile.command)
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
 * carries arguments (`claude --resume`, `codex resume --last`) keeps them and
 * simply gains the mode. A profile whose command Forge has no ladder for gets
 * it back untouched — the flags mean nothing to anything else, and quietly
 * passing `--dangerously-skip-permissions` to a strange binary is not a risk
 * worth taking for a tidier code path.
 */
export function launchCommand(profile: AgentProfile, override?: ClaudePermissionMode | null): string {
  const command = profile.command.trim()
  if (!command || !supportsPermissionModes(profile)) return command
  const spec = permissionSpec(command, effectivePermissionMode(profile, override))
  if (!spec?.flag) return command
  // Already spelled out by hand in the command? Leave it alone — a hand-written
  // `--sandbox workspace-write` beats anything the chooser thinks it wants.
  if (hasExplicitPermissionFlag(command)) return command
  return `${command} ${spec.flag}`
}

/** The pane-header chip, or null when there is nothing worth shouting about. */
export function permissionChip(
  profile: AgentProfile,
  override?: ClaudePermissionMode | null
): { label: string; danger: boolean } | null {
  const spec = permissionSpec(profile.command, effectivePermissionMode(profile, override))
  if (!spec || !spec.chip) return null
  return { label: spec.chip, danger: spec.danger === true }
}

/** The mode a leaf carries, if any — kept here so callers need not import types. */
export function leafPermissionMode(leaf: Pick<PaneLeaf, 'permissionMode'>): ClaudePermissionMode | null {
  return isPermissionMode(leaf.permissionMode) ? leaf.permissionMode : null
}
