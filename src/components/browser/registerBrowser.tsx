import type { ReactNode } from 'react'
import { useApp } from '@/state/AppState'
import { registerSurface, type SurfaceProps } from '@/lib/shellSlots'
import { uiCommands } from '@/lib/uiCommands'
import { browserBridge } from './bridge'
import { BrowserSurfaces } from './BrowserSurfaces'

/**
 * Plugs the built-in browser into the shell without editing it: a `browser`
 * canvas surface (a mode in the switcher, `set-mode browser`), and an
 * `open-browser` command — which the keymap registry picks up with its default
 * key, Ctrl+Shift+O, through uiCommands.
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
  return () => {
    offHandler()
    offCommand()
    offSurface()
  }
}
