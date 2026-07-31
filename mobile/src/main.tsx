import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import '@xterm/xterm/css/xterm.css'
import './styles.css'
import { hydrate } from './lib/secure'
import { App } from './App'

const host = document.getElementById('root')
if (!host) throw new Error('index.html has no #root')

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
