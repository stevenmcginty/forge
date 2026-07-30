import { createRoot } from 'react-dom/client'
import '@xterm/xterm/css/xterm.css'
import './theme/global.css'
import { App } from './App'
import { AppStateProvider } from './state/AppState'

const host = document.getElementById('root')
if (!host) throw new Error('#root missing from index.html')

// Note: deliberately no <StrictMode>. Its double-invoked effects would
// mount/unmount/remount every xterm instance, which reparents live canvases
// and makes first-paint sizing flaky. Terminal lifecycles are managed
// explicitly by src/lib/terminals.ts instead.
createRoot(host).render(
  <AppStateProvider>
    <App />
  </AppStateProvider>
)
