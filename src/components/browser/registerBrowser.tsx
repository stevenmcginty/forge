import type { ReactNode } from 'react'
import { useApp } from '@/state/AppState'
import { registerSurface, shellMode, type SurfaceProps } from '@/lib/shellSlots'
import { runShowView } from '@/lib/showView'
import { uiCommands } from '@/lib/uiCommands'
import { startAppKeys } from './appKeys'
import { browserBridge } from './bridge'
import { BrowserSurfaces } from './BrowserSurfaces'

/**
 * Plugs the built-in browser into the shell without editing it: a `browser`
 * canvas surface (a mode in the switcher, `set-mode browser`), and an
 * `open-browser` command — which the keymap registry picks up with its default
 * key, Ctrl+Shift+O, through uiCommands — and `show-browser` (Ctrl+Shift+A),
 * which shows the tabs already open, or goes back to the agents.
 *
 * Call `registerBrowser()` once at startup. It returns the undo.
 */

const HOME_PAGE = 'https://www.google.com'

function BrowserStage({ active }: SurfaceProps): ReactNode {
  const { state } = useApp()
  return (
    <BrowserSurfaces
      projectId={state.activeProjectId ?? ''}
      profiles={state.settings.agentProfiles}
      hidden={!active}
    />
  )
}

export function registerBrowser(): () => void {
  const offSurface = registerSurface({ id: 'browser', title: 'Browser', placement: 'beside', order: 10, render: BrowserStage })
  const offCommand = uiCommands.define({ id: 'open-browser', title: 'Open a browser', group: 'Panes', defaultKey: 'Ctrl+Shift+O' })
  const offHandler = uiCommands.handle('open-browser', () => {
    uiCommands.run('set-mode', 'browser')
    void browserBridge()?.open({ url: HOME_PAGE })
  })
  // Show the browser — the tabs already open, never a new one — or, from the
  // browser, back to the agents. With no tab to show it stays put and says so
  // in a notice (src/lib/showView.ts, the same runner the agents' show_view uses).
  const offShowCommand = uiCommands.define({ id: 'show-browser', title: 'Show the browser', group: 'Modes', defaultKey: 'Ctrl+Shift+A' })
  const offShowHandler = uiCommands.handle('show-browser', () => {
    if (shellMode.get() === 'browser') uiCommands.run('set-mode', 'agents')
    else void runShowView({ view: 'browser' }, { notice: true })
  })
  // Shortcuts and the voice keys keep working while a page has the keyboard.
  const offKeys = startAppKeys()
  return () => {
    offKeys()
    offShowHandler()
    offShowCommand()
    offHandler()
    offCommand()
    offSurface()
  }
}
