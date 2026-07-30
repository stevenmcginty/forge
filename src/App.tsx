import { useEffect, type ReactNode } from 'react'
import { AccountChip } from '@/components/AccountChip'
import { Onboarding } from '@/components/Onboarding'
import { ProjectRail } from '@/components/ProjectRail'
import { ScreenshotTray } from '@/components/ScreenshotTray'
import { StatusBar } from '@/components/StatusBar'
import { TerminalGrid } from '@/components/TerminalGrid'
import { SettingsPage } from '@/components/settings/SettingsPage'
import { TitleBar } from '@/components/TitleBar'
import { UpdateBanner } from '@/components/UpdateBanner'
import { VoiceHub } from '@/components/VoiceHub'
import { useShortcuts } from '@/hooks/useShortcuts'
import { terminalHost } from '@/lib/terminals'
import { useApp } from '@/state/AppState'
import './App.css'

export function App(): ReactNode {
  const { state } = useApp()
  useShortcuts()

  // The rail animating open or closed changes every pane's width — and so does
  // coming back from settings, where the grid was unmounted while the window
  // carried on being resized. The voice hub is not in this list and never will
  // be: it floats *over* the terminals rather than taking width from them,
  // which is the whole reason the right-hand panel was deleted.
  useEffect(() => {
    const t = setTimeout(() => terminalHost.fitAll(), 200)
    return () => clearTimeout(t)
  }, [state.settings.railCollapsed, state.view])

  return (
    <div className="app" data-ready={state.ready}>
      <TitleBar />
      {/*
        Directly under the titlebar and above everything else, so it pushes the
        whole app down by 30px rather than covering any of it. It renders
        nothing at all unless there is an update — which, in a dev run, is
        never. See src/components/UpdateBanner.tsx.
      */}
      <UpdateBanner />
      <div className="app__body">
        <aside className="app__left" data-collapsed={state.settings.railCollapsed}>
          <ProjectRail />
          <ScreenshotTray />
          <AccountChip />
        </aside>
        <main className="app__main">
          {state.view === 'settings' ? <SettingsPage /> : <TerminalGrid />}
        </main>
      </div>
      <StatusBar />
      {/*
        The voice hub — the agent's only chrome now that the right-hand panel
        is gone. Last in the tree and `position: fixed`, so it hovers over
        everything the app draws while occupying no layout of its own, and it
        renders nothing at all while docked, when the status-bar pill *is* the
        hub. The agent itself does not live here: it is headless, in
        <VoiceAgentProvider> at the root, and answers the phone whether any of
        this is on screen or not. See src/components/VoiceHub.tsx.
      */}
      <VoiceHub />
      <Onboarding />
    </div>
  )
}
