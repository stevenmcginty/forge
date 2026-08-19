import { useEffect, type ReactNode } from 'react'
import { AccountChip } from '@/components/AccountChip'
import { ApprovalPrompt } from '@/components/ApprovalPrompt'
import { AccountPrompt } from '@/components/AccountPrompt'
import { Onboarding } from '@/components/Onboarding'
import { WhatsNew } from '@/components/WhatsNew'
import { RailStack } from '@/components/rail/RailStack'
import { ScreenshotTray } from '@/components/ScreenshotTray'
import { TasksWorkspace } from '@/components/tasks/TasksWorkspace'
import { StatusBar } from '@/components/StatusBar'
import { TerminalGrid } from '@/components/TerminalGrid'
import { SettingsPage } from '@/components/settings/SettingsPage'
import { DevicePreview } from '@/components/DevicePreview'
import { TitleBar } from '@/components/TitleBar'
import { StaleBanner } from '@/components/StaleBanner'
import { UpdateBanner } from '@/components/UpdateBanner'
import { VoiceHub } from '@/components/VoiceHub'
import { OverlayHost } from '@/state/OverlayHost'
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
  }, [state.settings.railCollapsed, state.view, state.tasksMaximized])

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
      {/*
        Its dev-run twin, and mutually exclusive with it in practice: a packaged
        build can offer an update and can never be stale, a checkout is the
        reverse. Same 30px strip, so the two can never both push the app down.
        See src/components/StaleBanner.tsx.
      */}
      <StaleBanner />
      <div className="app__body">
        <aside className="app__left" data-collapsed={state.settings.railCollapsed}>
          {/*
            The rail's four sections — projects, tasks, git, activity — stacked,
            each collapsible, each switchable off in Appearance. The shelf and
            the account chip stay outside it: neither is scoped to a project,
            and the stack's whole premise is that everything in it is talking
            about the project you have selected.
            See src/components/rail/RailStack.tsx.
          */}
          <RailStack />
          <ScreenshotTray />
          <AccountChip />
        </aside>
        <main className="app__main">
          {/*
            Settings wins outright; under it, the delegation desk (the Tasks
            panel maximized) swaps in for the grid the same way mosaicZoom
            swaps a tile to full bleed — a React flag, and the terminals keep
            running unmounted because terminalHost owns them.
          */}
          {state.view === 'settings' ? (
            <SettingsPage />
          ) : state.view === 'devices' ? (
            <DevicePreview />
          ) : state.tasksMaximized ? (
            <TasksWorkspace />
          ) : (
            <TerminalGrid />
          )}
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
      {/*
        The other half of the same hub: while it is undocked, the thing you
        actually see is an always-on-top Windows window that floats over Chrome
        and stays up when Forge is minimised. This component renders nothing —
        it opens and closes that window and mirrors the one agent into it. The
        agent stays here, in this window, for the reason above.
        See src/state/OverlayHost.tsx.
      */}
      <OverlayHost />
      <Onboarding />
      <AccountPrompt />
      {/*
        What changed in the version that just installed itself. After the welcome,
        because a fresh install has nothing to catch up on and its settings are
        seeded so that this stays quiet on a first run.
      */}
      <WhatsNew />
      {/*
        The Forge Mobile pairing prompt — "a phone calling itself X wants to
        connect". Mounted at the root and last, so an authorisation question is
        asked over whatever else is on screen, settings page included. It
        renders nothing until main raises one.
      */}
      <ApprovalPrompt />
    </div>
  )
}
