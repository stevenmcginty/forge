import { Component, useEffect, type ErrorInfo, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import '@xterm/xterm/css/xterm.css'
import './theme/global.css'
import { App } from './App'
import { HandoffProvider } from './hooks/useHandoffFlow'
import { OverlayApp } from './overlay/OverlayApp'
import { AppStateProvider } from './state/AppState'
import { DictationProvider } from './state/Dictation'
import { ForemanProvider } from './state/Foreman'
import { VoiceAgentProvider } from './state/VoiceAgent'

const host = document.getElementById('root')
if (!host) throw new Error('#root missing from index.html')

const root = createRoot(host)

/* ------------------------------------------------------------- the pulse
 *
 * Two components, thirty lines, and they are the only reason the main process
 * can tell a working Forge from a window-shaped hole where one used to be.
 *
 * The failure they exist for looks like nothing at all. React unmounts the tree
 * — a provider throwing in an effect on a stale preload is how it happened —
 * and what is left is a renderer that is alive, responsive and correctly
 * painted, containing nothing. Every terminal keeps scrolling, because that
 * output is pushed from the main process and never touched this tree. Steve, on
 * a phone somewhere else, taps a tab and nothing happens, and nothing happens,
 * and there is no way for him to learn why. See electron/renderer-watchdog.ts.
 *
 * So the tree reports its own pulse, and the two rules that make it worth
 * anything are both about *not stopping*.
 */

/**
 * What the next beat will say. Module-level and mutable on purpose.
 *
 * `Heartbeat` is mounted outside the boundary — it has to be, or a crash would
 * take the alarm down with the building — which means the boundary cannot pass
 * it a prop. This is how the news gets across the gap: one variable, written
 * once by a component that has just caught a fatal error, read every two
 * seconds by one that cannot fail.
 */
let health: { healthy: boolean; error?: string } = { healthy: true }

/**
 * The last thing standing.
 *
 * No provider, no context, no store, no hook beyond `useEffect` — it renders
 * null and owns one interval. Anything it depended on would be one more thing
 * whose failure it could not report.
 *
 * `window.forge?.renderer?.heartbeat?.()` is optional-chained down every link,
 * and not from habit: the *running* Forge's preload was built before this
 * channel existed, so on the launch that first loads this bundle into an old
 * preload, `renderer` is simply not there. An unguarded call would throw here,
 * at the top of the tree, out of a timer — which is this exact bug, shipped by
 * the fix for it.
 */
function Heartbeat(): null {
  useEffect(() => {
    const beat = (): void => window.forge?.renderer?.heartbeat?.(health)
    // Once immediately: the watchdog's patience is eight seconds and a reload
    // should not have to spend a quarter of it waiting for the first tick.
    beat()
    const timer = setInterval(beat, 2000)
    return () => clearInterval(timer)
  }, [])
  return null
}

/**
 * Catches what would otherwise be an empty window, and says so out loud.
 *
 * Two jobs, and the second is the one that matters. The visible one is the
 * fallback: a sentence, in inline styles, owing nothing to the theme system
 * that may be part of what just broke — because a window that says what
 * happened beats a black rectangle even when nobody is sitting at it.
 *
 * The real job is `health`. A tree that has thrown still runs its timers, so
 * without this the heartbeat would keep insisting everything was fine from
 * inside the wreckage, and the watchdog — reasonably — would believe it. Saying
 * `healthy: false` instead turns the quietest failure Forge has into the
 * loudest, and it carries the error text with it, so the reason reaches the
 * main log and the phone rather than a DevTools window nobody has open.
 */
class RootBoundary extends Component<{ children: ReactNode }, { error: string }> {
  override state = { error: '' }

  static getDerivedStateFromError(error: unknown): { error: string } {
    return { error: error instanceof Error ? error.message : String(error) }
  }

  override componentDidCatch(error: unknown, info: ErrorInfo): void {
    const message = error instanceof Error ? error.message : String(error)
    health = { healthy: false, error: message }
    // Also down the diagnostics channel the preload already opened, so the
    // component stack lands in the terminal running `npm run dev`.
    console.error('[root] the React tree threw:', message, info.componentStack)
  }

  override render(): ReactNode {
    if (!this.state.error) return this.props.children
    return (
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          height: '100vh',
          padding: '24px',
          textAlign: 'center',
          font: '13px system-ui, sans-serif',
          color: '#E8EAED',
          background: '#0B0C0E'
        }}
      >
        <div>
          <p style={{ margin: '0 0 6px' }}>Forge hit an error and is restarting itself.</p>
          <p style={{ margin: 0, opacity: 0.55 }}>{this.state.error}</p>
        </div>
      </div>
    )
  }
}

/**
 * Two windows, one bundle, and only one of them is Forge.
 *
 * The undocked voice hub is a real always-on-top window now (see
 * electron/overlay-window.ts) and it loads this same entry with `#overlay` on
 * the URL. It gets a completely different tree: no AppStateProvider, no
 * DictationProvider, no VoiceAgentProvider.
 *
 * That is not an optimisation, it is the whole safety property. Those three
 * providers own the store, the microphone and the agent respectively; a second
 * copy of them in a second renderer would mean two writers racing on
 * settings.json, two sidecar re-arm loops fighting over one microphone, and two
 * voices answering the same sentence a beat apart. The overlay is a *view* — it
 * mirrors the agent over IPC and owns nothing. See src/overlay/OverlayApp.tsx.
 *
 * The branch is on the URL rather than on anything asynchronous because the
 * decision has to be made before the first render: awaiting an IPC round trip
 * would mount the entire terminal grid, for a frame, inside a 180×56 pill.
 */
if (window.forge.overlay.isOverlay()) {
  root.render(<OverlayApp />)
} else {
  // Note: deliberately no <StrictMode>. Its double-invoked effects would
  // mount/unmount/remount every xterm instance, which reparents live canvases
  // and makes first-paint sizing flaky. Terminal lifecycles are managed
  // explicitly by src/lib/terminals.ts instead.
  // One engine each for the two microphones, above the whole tree: the voice
  // agent's conversation and dictation's phrase routing are each subscribed to
  // exactly once, and every surface that shows them — the status-bar pill, the
  // floating hub, the overlay window — is a view of that one instance. Two
  // copies would mean two answers to every sentence and two voices saying them.
  root.render(
    <>
      {/* Outside the boundary, and above every provider, because its whole
          value is being the thing that survives them. A heartbeat mounted
          inside the tree it reports on stops exactly when the news starts. */}
      <Heartbeat />
      <RootBoundary>
        <AppStateProvider>
          <DictationProvider>
            <VoiceAgentProvider>
              {/* Foreman is mounted here for the same reason the two above it are:
                  it holds one map of driven panes and answers main's hiring
                  requests exactly once. Two copies would answer every request
                  twice and disagree about what each pane is doing. */}
              <ForemanProvider>
                {/* And Handoff for the third time over: main keeps exactly one
                    `handoff:watch`, so one subscription above the grid is what
                    stops every pane's menu restarting every other pane's. */}
                <HandoffProvider>
                  <App />
                </HandoffProvider>
              </ForemanProvider>
            </VoiceAgentProvider>
          </DictationProvider>
        </AppStateProvider>
      </RootBoundary>
    </>
  )
}
