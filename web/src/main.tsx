import { createRoot } from 'react-dom/client'
import '@xterm/xterm/css/xterm.css'

/*
 * The desktop's face, imported rather than reproduced.
 *
 * Decision 4 in docs/forge-web.md, in its most literal form: these are the
 * desktop renderer's own stylesheets, and every class this client renders is one
 * of theirs. `global.css` pulls in `tokens.css` (the whole design system — the
 * surfaces, the volt accent, the type scale, the metrics, and the `--term-*`
 * palette lib/term.ts reads back out of the document) and `controls.css` (the
 * ghost button and the CTA). The component sheets below are the ones whose
 * classes this client actually uses.
 *
 * Nothing under src/ is modified to make this work, and nothing here overrides
 * it: web-only chrome — the sign-in card, the connection screens, the offline
 * strip, the link badge — lives in ./styles.css, last, and adds rather than
 * repaints. If a colour is wanted here it comes from a token; a literal in
 * styles.css would be the first place the two Forges started to look different.
 */
import '@/theme/global.css'
import '@/App.css'
import '@/components/TitleBar.css'
import '@/components/ProjectRail.css'
import '@/components/TerminalGrid.css'
import '@/components/TerminalPane.css'
import '@/components/SplitView.css'
import '@/components/AgentBadge.css'
import '@/components/AgentChooser.css'
import '@/components/EmptyState.css'
import '@/components/Popover.css'
import '@/components/SkillsFlyout.css'
import '@/components/CommandsFlyout.css'
import '@/components/rail/RailSection.css'
import '@/components/rail/GitSection.css'
import './styles.css'

import { App } from './App'
import { ForgeProvider } from './state'

const host = document.getElementById('root')
if (!host) throw new Error('index.html has no #root')

/*
 * Deliberately no <StrictMode>, for the same reason src/main.tsx gives: its
 * double-invoked effects would mount, unmount and remount every xterm instance,
 * which reparents live canvases and makes first-paint sizing flaky. Here it
 * would also mean attaching to every pane twice and taking a second replay for
 * each, which is 192KB per pane down a tunnel to prove a point about purity.
 */
createRoot(host).render(
  <ForgeProvider>
    <App />
  </ForgeProvider>
)
