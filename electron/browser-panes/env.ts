import { commandExe } from '@shared/agents'
import { BROWSER_LINK_FILE_ENV, PANE_AGENT_ENV, PANE_ID_ENV } from '@shared/browser'

/**
 * The three variables every pane gets, so the MCP server its CLI spawns can
 * reach Forge's browser as that pane: its id (whose tabs), its CLI (the logo)
 * and where the link file is. For electron/pty-host.ts's env block.
 *
 * Its own module, importing nothing from the PTY host, so pty-host.ts can import
 * it without a cycle (./ipc.ts imports the PTY host for the pane list).
 */

let linkFile = ''

/** Set by ./ipc.ts once the service exists. */
export function setBrowserLinkFile(path: string): void {
  linkFile = path
}

export function browserPaneEnv(paneId: string, bootstrapCommand: string): Record<string, string> {
  const env: Record<string, string> = {}
  if (paneId) env[PANE_ID_ENV] = paneId
  const agent = commandExe(bootstrapCommand)
  if (agent) env[PANE_AGENT_ENV] = agent
  if (linkFile) env[BROWSER_LINK_FILE_ENV] = linkFile
  return env
}
