import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import '@xterm/xterm/css/xterm.css'
import './styles.css'
import { hydrate } from './lib/secure'
import { registerServiceWorker } from './lib/pwa'
import { simDevice } from './lib/sim'
import { App } from './App'

const host = document.getElementById('root')
if (!host) throw new Error('index.html has no #root')

// The desk's preview of a phone pins its safe areas before anything renders:
// the class carries the fixed `--sa-*` values (see styles.css), and setting it
// after first paint would shift every header that uses them. A real phone has
// no `?sim=` and this is a no-op.
const sim = simDevice()
if (sim) document.body.classList.add(sim === 'ios' ? 'sim-ios' : 'sim-android')

// The offline shell for the iPhone route, started but never waited for: a phone
// that has to reach the desktop anyway gains nothing from delaying first paint
// on a registration, and this call cannot reject. See lib/pwa.ts.
void registerServiceWorker()

// The token store hydrates before anything renders: App reads the token
// synchronously on mount, and painting before Preferences has answered would
// flash the pairing form at a phone that is already paired. In the browser
// hydrate() is a couple of localStorage reads, so nobody waits for anything.
void hydrate().then(() => {
  createRoot(host).render(
    <StrictMode>
      <App />
    </StrictMode>
  )
})
