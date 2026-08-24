import { createRoot } from 'react-dom/client'
import '@xterm/xterm/css/xterm.css'
import './theme/global.css'
import { App } from './App'
import { OverlayApp } from './overlay/OverlayApp'
import { AppStateProvider } from './state/AppState'
import { DictationProvider } from './state/Dictation'
import { ForemanProvider } from './state/Foreman'
import { VoiceAgentProvider } from './state/VoiceAgent'

const host = document.getElementById('root')
if (!host) throw new Error('#root missing from index.html')

const root = createRoot(host)

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
    <AppStateProvider>
      <DictationProvider>
        <VoiceAgentProvider>
          {/* Foreman is mounted here for the same reason the two above it are:
              it holds one map of driven panes and answers main's hiring
              requests exactly once. Two copies would answer every request
              twice and disagree about what each pane is doing. */}
          <ForemanProvider>
            <App />
          </ForemanProvider>
        </VoiceAgentProvider>
      </DictationProvider>
    </AppStateProvider>
  )
}
