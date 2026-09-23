import { useEffect, useLayoutEffect, useRef, type ReactNode } from 'react'
import { ApprovalPrompt } from '@/components/ApprovalPrompt'
import { AccountPrompt } from '@/components/AccountPrompt'
import { Onboarding } from '@/components/Onboarding'
import { WhatsNew } from '@/components/WhatsNew'
import { TerminalGrid } from '@/components/TerminalGrid'
import { TitleBar, useDeckMode, useDeckModes } from '@/components/TitleBar'
import { StaleBanner } from '@/components/StaleBanner'
import { UpdateBanner } from '@/components/UpdateBanner'
import { WebProjectRemoveBridge } from '@/components/WebProjectRemoveBridge'
import { HubLayer } from '@/components/hub/HubLayer'
import { Backdrop } from '@/components/shell/Backdrop'
import { DeckToast } from '@/components/shell/DeckToast'
import { Dock } from '@/components/shell/Dock'
import { SettingsPopup } from '@/components/shell/SettingsPopup'
import { useBranchReader } from '@/components/shell/useBranch'
import { useShortcuts } from '@/hooks/useShortcuts'
import { HUB_FOCUS_EVENT, type HubFocusDetail } from '@/lib/hubnav'
import { fadeIn, useFlipChildren } from '@/lib/motion'
import { shellMode, shellSheet, useShellMode, useSurfaces } from '@/lib/shellSlots'
import { terminalHost } from '@/lib/terminals'
import { uiCommands, useUiCommand } from '@/lib/uiCommands'
import { useActiveProject, useApp, type SettingsSection } from '@/state/AppState'
import '@/components/shell/deck-tokens.css'
import '@/components/shell/Shell.css'
import '@/components/shell/deck.css'
import './App.css'

/**
 * The desktop shell: a command deck.
 *
 * One backdrop (the room), a slim top bar (the mark, the mode switcher, the
 * tools), the stage (whatever mode is on — the agents' panes, or a registered
 * surface such as the browser beside them), and the dock along the bottom
 * (project, type-or-speak, panes, the voice socket). Settings is a pop-up over all of it: the panes stay live
 * behind it and Esc puts you back.
 *
 * The terminals never notice any of this. terminalHost owns every xterm, so a
 * mode switch that unmounts the grid costs nothing and coming back is instant —
 * the only thing the shell owes them is a refit once a layout has settled.
 */
export function App(): ReactNode {
  const { state, actions } = useApp()
  useShortcuts()
  const project = useActiveProject()
  useBranchReader(project?.id ?? null)

  const surfaces = useSurfaces()
  const surfaceId = useShellMode()
  const surface = surfaces.find((s) => s.id === surfaceId) ?? null
  const modes = useDeckModes()
  const mode = useDeckMode()

  // Every layout change that moves pane edges gets a refit once it settles —
  // the same 200ms beat the app has always used, now also after a mode glide.
  useEffect(() => {
    const t = setTimeout(() => terminalHost.fitAll(), 380)
    return () => clearTimeout(t)
  }, [state.view, surfaceId])

  /* ------------------------------------------------------------ modes */

  const setMode = (id: string | undefined): void => {
    if (!id) return
    // There is no Talk page: the bar is where you talk to Forge.
    if (id === 'talk') {
      uiCommands.run('focus-composer')
      return
    }
    shellSheet.set(null)
    // Tasks and Devices are gone (round 2): an old "tasks" or "devices" id —
    // a voice command, a stale shortcut — lands on the agents, like any id
    // with no surface behind it.
    shellMode.set(id === 'agents' || !surfaces.some((s) => s.id === id) ? null : id)
  }

  const stepMode = (step: number): void => {
    const i = modes.findIndex((m) => m.id === mode)
    const next = modes[(i + step + modes.length) % modes.length]
    if (next) setMode(next.id)
  }

  useUiCommand('set-mode', setMode)
  useUiCommand('next-mode', () => stepMode(1))
  useUiCommand('previous-mode', () => stepMode(-1))
  useUiCommand('open-settings', (section) => actions.openSettings(section as SettingsSection | undefined))
  useUiCommand('close-settings', () => {
    if (state.view === 'settings') actions.closeSettings()
  })
  useUiCommand('toggle-settings', () => (state.view === 'settings' ? actions.closeSettings() : actions.openSettings()))
  useUiCommand('toggle-canvas-view', () => actions.toggleViewMode())
  useUiCommand('close-overlays', () => {
    shellSheet.set(null)
    if (state.view === 'settings') actions.closeSettings()
  })

  // "Go to the canvas" (voice, Ctrl+Shift+K): the image board, once a surface
  // called `board` has registered. Until then it is only a pane-focus event.
  // A pane picked by name while the agents are off screen brings them back; a
  // surface that shares the stage with them (the browser) stays put.
  const setModeRef = useRef(setMode)
  setModeRef.current = setMode
  const agentsVisible = mode === 'agents' || surface?.placement === 'beside'
  const agentsVisibleRef = useRef(agentsVisible)
  agentsVisibleRef.current = agentsVisible
  useEffect(() => {
    const on = (e: Event): void => {
      const detail = (e as CustomEvent<HubFocusDetail>).detail
      if (detail?.kind === 'canvas') setModeRef.current('board')
      else if (detail?.kind === 'pane' && !agentsVisibleRef.current) setModeRef.current('agents')
    }
    window.addEventListener(HUB_FOCUS_EVENT, on)
    return () => window.removeEventListener(HUB_FOCUS_EVENT, on)
  }, [])

  /*
   * The rail is gone; its shortcut is not. Ctrl+Shift+B (and the voice agent's
   * "toggle the rail") flip `railCollapsed`, and every flip now opens or closes
   * the project sheet instead. The flag is put straight back to false so the
   * rail's own components — reseated in the sheet — always draw their full
   * form, and so a flip is always the same edge.
   */
  const railCollapsed = state.settings.railCollapsed
  const railSeen = useRef(false)
  useEffect(() => {
    if (!state.ready) return
    if (!railSeen.current) {
      railSeen.current = true
      if (railCollapsed) actions.patchSettings({ railCollapsed: false })
      return
    }
    if (!railCollapsed) return
    shellSheet.set(shellSheet.get() === 'projects' ? null : 'projects')
    actions.patchSettings({ railCollapsed: false })
  }, [actions, railCollapsed, state.ready])

  /* ------------------------------------------------------------ glides */

  const stageRef = useRef<HTMLElement | null>(null)
  // A surface arriving beside the agents: the agents' column slides and narrows
  // into place rather than jumping.
  useFlipChildren(stageRef, surface?.placement === 'beside' ? surface.id : mode, 'flipStage')
  const lastMode = useRef(mode)
  useLayoutEffect(() => {
    if (lastMode.current === mode) return
    const was = lastMode.current
    lastMode.current = mode
    // Beside-surfaces glide (above); everything else crossfades in.
    const beside = (id: string): boolean => surfaces.some((s) => s.id === id && s.placement === 'beside')
    if ((was === 'agents' || beside(was)) && (mode === 'agents' || beside(mode))) return
    const first = stageRef.current?.firstElementChild
    if (first instanceof HTMLElement) fadeIn(first, { duration: 260, from: 0.985 })
  }, [mode, surfaces])

  const Surface = surface?.render ?? null

  return (
    <div className="app deck" data-ready={state.ready} data-mode={mode}>
      <Backdrop />
      <TitleBar />
      {/*
        Directly under the title bar, pushing the stage down rather than
        covering it. They render nothing unless there is an update (a packaged
        build) or the checkout is stale (a dev run) — see each component.
      */}
      <UpdateBanner />
      <StaleBanner />
      <main className="deck__stage" ref={stageRef}>
        {Surface && surface?.placement === 'full' ? (
          <div className="deck__full">
            <Surface active />
          </div>
        ) : (
          <div className="deck__split" data-beside={Surface ? 'true' : undefined}>
            {Surface ? (
              <section className="deck__surface" data-flip-stage="surface" aria-label={surface?.title}>
                <Surface active />
              </section>
            ) : null}
            <div className="deck__agents" data-flip-stage="agents">
              <TerminalGrid />
            </div>
          </div>
        )}
      </main>
      <Dock />
      <DeckToast />
      <SettingsPopup />
      {/*
        The voice hub's UI: the dock's voice pill, the Board surface,
        the arrival beacon and the cheat sheet. It replaces the old floating
        VoiceHub card and the always-on-top overlay orb, which are no longer
        mounted. The engine itself is headless, in the providers at the root.
      */}
      <HubLayer />
      <Onboarding />
      <AccountPrompt />
      <WhatsNew />
      {/* The Forge Mobile pairing prompt — asked over whatever else is up. */}
      <ApprovalPrompt />
      <WebProjectRemoveBridge />
    </div>
  )
}
