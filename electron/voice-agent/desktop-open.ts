import { launchDesktopApp, listDesktopApps, openDesktopTarget } from '../desktop-control'
import { brainBrowserOpen } from '../browser-panes/brain'
import { refuseAppLaunch, routeOpenTarget } from './launch-guard'

/**
 * list_desktop_apps, open_desktop_app and open_file_or_link, guarded, once:
 * the Claude brain's tools (./host.ts) and the realtime brains' (main's
 * `desktopLinkOp`, ../desktop-hands-ipc.ts) both answer through these, so
 * every brain launches and opens the same way behind the same refusals
 * (./launch-guard.ts). Electron-free, like the host.
 *
 * Every answer is words plus ok, never a throw: the model says it out loud.
 */

export interface OpenReply {
  ok: boolean
  text: string
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** Every app the Start menu can launch, one name per line. */
export async function listAppsReply(): Promise<OpenReply> {
  try {
    const apps = await listDesktopApps()
    return { ok: true, text: apps.map((a) => a.name).join('\n') || 'No launchable apps were found.' }
  } catch (err) {
    return { ok: false, text: `Could not list the installed apps: ${errText(err)}` }
  }
}

/** Launch an installed app by its spoken name. Agents and consoles are refused. */
export async function openAppReply(name: unknown): Promise<OpenReply> {
  const said = String(name ?? '')
  const refused = refuseAppLaunch(said)
  if (refused) return { ok: false, text: refused }
  try {
    const text = await launchDesktopApp(said)
    return { ok: /^Launched /.test(text), text }
  } catch (err) {
    return { ok: false, text: `Could not launch that: ${errText(err)}` }
  }
}

/**
 * Open a file, a folder or a web address. A web address goes to Forge's
 * browser, or Steve's default browser when `where` is 'desktop' or Forge is
 * minimised (`away`) — see `routeOpenTarget`.
 */
export async function openTargetReply(target: unknown, opts: { where?: unknown; away?: boolean } = {}): Promise<OpenReply> {
  const t = String(target ?? '')
  const route = routeOpenTarget(t, opts)
  if (route && 'refuse' in route) return { ok: false, text: route.refuse }
  if (route && 'web' in route) {
    const reply = await brainBrowserOpen(route.web)
    return { ok: reply.ok, text: reply.text }
  }
  try {
    if (route && 'desktop' in route) {
      const text = await openDesktopTarget(route.desktop)
      const ok = /^Opened /.test(text)
      return { ok, text: ok ? `Opened ${route.desktop} in Steve's own browser.` : text }
    }
    const text = await openDesktopTarget(t)
    return { ok: /^Opened /.test(text), text }
  } catch (err) {
    return { ok: false, text: `Could not open that: ${errText(err)}` }
  }
}
