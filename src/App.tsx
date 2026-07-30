import { useEffect, type ReactNode } from 'react'
import { Onboarding } from '@/components/Onboarding'
import { ProjectRail } from '@/components/ProjectRail'
import { ScreenshotTray } from '@/components/ScreenshotTray'
import { StatusBar } from '@/components/StatusBar'
import { TerminalGrid } from '@/components/TerminalGrid'
import { TitleBar } from '@/components/TitleBar'
import { VoicePanel } from '@/components/VoicePanel'
import { useShortcuts } from '@/hooks/useShortcuts'
import { terminalHost } from '@/lib/terminals'
import { useApp } from '@/state/AppState'
import './App.css'

export function App(): ReactNode {
  const { state } = useApp()
  useShortcuts()

  // The rail or the voice panel animating open/closed changes every pane's width.
  useEffect(() => {
    const t = setTimeout(() => terminalHost.fitAll(), 200)
    return () => clearTimeout(t)
  }, [state.settings.railCollapsed, state.settings.voicePanelOpen, state.settings.voicePanelWidth])

  return (
    <div className="app" data-ready={state.ready}>
      <TitleBar />
      <div className="app__body">
        <aside className="app__left" data-collapsed={state.settings.railCollapsed}>
          <ProjectRail />
          <ScreenshotTray />
        </aside>
        <main className="app__main">
          <TerminalGrid />
        </main>
        <VoicePanel />
      </div>
      <StatusBar />
      <Onboarding />
    </div>
  )
}
