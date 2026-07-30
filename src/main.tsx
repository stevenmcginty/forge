import { createRoot } from 'react-dom/client'
import '@xterm/xterm/css/xterm.css'
import './theme/global.css'
import { App } from './App'
import { AppStateProvider } from './state/AppState'
import { DictationProvider } from './state/Dictation'
import { VoiceAgentProvider } from './state/VoiceAgent'

const host = document.getElementById('root')
if (!host) throw new Error('#root missing from index.html')

// Note: deliberately no <StrictMode>. Its double-invoked effects would
// mount/unmount/remount every xterm instance, which reparents live canvases
// and makes first-paint sizing flaky. Terminal lifecycles are managed
// explicitly by src/lib/terminals.ts instead.
// One engine each for the two microphones, above the whole tree: the voice
// agent's conversation and dictation's phrase routing are each subscribed to
// exactly once, and every surface that shows them — the status-bar pill, the
// right-hand panel, the floating hub — is a view of that one instance. Two
// copies would mean two answers to every sentence and two voices saying them.
createRoot(host).render(
  <AppStateProvider>
    <DictationProvider>
      <VoiceAgentProvider>
        <App />
      </VoiceAgentProvider>
    </DictationProvider>
  </AppStateProvider>
)
