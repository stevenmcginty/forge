import { commandExe, composeRemoteControl, remoteControlName } from '@shared/remote'
import { getSettings } from '../store'

/**
 * Remote Control's Forge-side half.
 *
 * A Claude pane launched with `--remote-control "<name>"` keeps running here
 * but becomes drivable from the Claude app on Steve's phone. All Forge has to
 * do is put the flag on the bootstrap command and give the session a name he
 * will recognise in a list — "Forge — Claude Code", not "desktop-3f2a".
 *
 * Shaped exactly like bridge/mcp-config.ts on purpose: the profile flag is
 * resolved *here*, in the main process, by matching the command string against
 * settings, because the PTY host only ever receives that string. The two
 * transforms compose (see electron/pty-host.ts) and are order-dependent —
 * Remote Control first, then `--mcp-config`, whose value is variadic and has to
 * stay last.
 *
 * Nothing here is per-open: the chooser's "open this one with Remote Control
 * on/off" override belongs to the Settings work, and lands by threading a flag
 * into CreateSessionRequest that short-circuits `wantsRemoteControl`.
 */

export interface RemoteControlContext {
  /** Project name — the first half of the session name. */
  projectName?: string
  /** Pane title as shown in its header — the second half. */
  paneTitle?: string
}

/**
 * Does this bootstrap command belong to a Remote-Control-enabled profile?
 *
 * Two gates, both of which have to pass:
 *  - the app-wide `remoteControlDefault` switch, and
 *  - a profile with `remoteControl: true` whose command this is.
 *
 * Matching is by exact command first, then by executable name, so a profile
 * Steve has rewritten to `claude --resume` still gets the flag. A profile
 * pointed at a different tool does not — `composeRemoteControl` refuses
 * anything that is not really `claude`, so a renamed command degrades to a
 * plain launch instead of a broken one.
 */
function wantsRemoteControl(command: string): boolean {
  const settings = getSettings()
  if (!settings.remoteControlDefault) return false
  const cmd = command.trim()
  if (!cmd) return false
  const enabled = settings.agentProfiles.filter((p) => p.remoteControl && p.command.trim())
  if (enabled.some((p) => p.command.trim() === cmd)) return true
  const exe = commandExe(cmd)
  return enabled.some((p) => commandExe(p.command) === exe)
}

/**
 * Append `--remote-control '<project> — <pane>'` when the profile asks for it.
 * Returns the command unchanged in every other case.
 */
export function applyRemoteControl(bootstrapCommand: string, ctx: RemoteControlContext = {}): string {
  const cmd = bootstrapCommand.trim()
  if (!cmd) return bootstrapCommand
  if (!wantsRemoteControl(cmd)) return cmd
  return composeRemoteControl(cmd, remoteControlName(ctx.projectName ?? '', ctx.paneTitle ?? ''))
}
