import { useMemo, useState, type ReactNode } from 'react'
import '@/components/shell/deck-tokens.css'
import '@/components/shell/deck.css'
import { BUILTIN_AGENT_PROFILES } from '@shared/agents'
import type { Project, Workspace } from '@shared/types'
import { ForgeContext, type ForgeActions, type ForgeState, type Picture } from '../state'
import { DeckTopBar, type DeckMenuRow } from './DeckTopBar'
import { DECK_THEMES, useDeckTheme } from './theme'
import { useBarPlace, useDeckView } from './view'
import './deck.css'
import './voicebar.css'

/**
 * `?preview=decktop` on the dev server: the deck face's top bar and every menu
 * that drops from it, over a stand-in stage, fed a fixture project so it can be
 * looked at (and screenshotted) with no desktop on the other end. Compiled out
 * of every `vite build` by the `__DEV_SERVER__` gate in main.tsx, like the
 * other previews.
 *
 * The real DeckTopBar, on a fixture `ForgeContext`: four agents (one of them
 * asking), a chat tab, every menu row TopBar would hand it. Nothing it does
 * reaches a desktop — every action answers "nothing happened". The strip at
 * the foot is harness chrome, not product: the eight themes through the real
 * theme path, and the link's four states.
 *
 * `&theme=<id>` picks the theme, `&link=live|quiet|connecting|offline` the
 * link, `&agents=0` an empty project.
 */

const PROJECT: Project = {
  id: 'forge',
  name: 'forge',
  path: 'C:\\Users\\steve\\Desktop\\forge',
  color: '#c6f432',
  defaultProfileId: 'claude',
  createdAt: 0
}

const leaf = (id: string, profileId: string): { type: 'leaf'; id: string; profileId: string; title: string } => ({
  type: 'leaf',
  id,
  profileId,
  title: ''
})

const WORKSPACE: Workspace = {
  activeTabId: 't1',
  tabs: [
    { id: 't1', title: 'Zeb', root: leaf('p1', 'claude'), activePaneId: 'p1' },
    { id: 't2', title: 'Mara', root: leaf('p2', 'codex'), activePaneId: 'p2' },
    { id: 't3', title: 'Otis', root: leaf('p3', 'grok'), activePaneId: 'p3' },
    { id: 't4', title: 'Shell', root: leaf('p4', 'pwsh'), activePaneId: 'p4' },
    { id: 't5', title: 'ChatGPT', root: { type: 'chat', id: 'c1', bot: 'chatgpt', title: 'ChatGPT' }, activePaneId: 'c1' }
  ]
}

const EMPTY: Workspace = { tabs: [], activeTabId: null }

type LinkWord = 'live' | 'quiet' | 'connecting' | 'offline'

function param(name: string): string | null {
  return new URLSearchParams(location.search).get(name)
}

/** Every action answers "nothing happened": a listener gets an unsubscribe, a request a refusal-free nothing. */
const ACTIONS = new Proxy(
  {},
  {
    get: (_target, key) => {
      const name = String(key)
      if (name === 'request') return () => Promise.resolve({ kind: 'failed', message: 'This is the preview.' })
      if (name.startsWith('on')) return () => () => undefined
      if (name === 'setNotice') return () => undefined
      return () => Promise.resolve(null)
    }
  }
) as ForgeActions

export function TopBarPreview(): ReactNode {
  const first = param('theme')
  const { themeId, setTheme } = useDeckTheme(true)
  const [seeded, setSeeded] = useState(false)
  if (!seeded) {
    setSeeded(true)
    if (first && first !== themeId) setTheme(first)
  }
  const [view, setView] = useDeckView()
  const [place, setPlace] = useBarPlace()
  const [link, setLink] = useState<LinkWord>(() => (param('link') as LinkWord | null) ?? 'live')
  const [foreman, setForeman] = useState(false)
  const empty = param('agents') === '0'

  const state = useMemo(() => {
    const picture: Picture = {
      desktopName: 'STEVE-LAPTOP',
      appVersion: '0.0.0',
      projects: [PROJECT],
      profiles: BUILTIN_AGENT_PROFILES,
      workspaces: { [PROJECT.id]: empty ? EMPTY : WORKSPACE },
      sessions: empty ? [] : ['p1', 'p2', 'p3', 'p4'].map((id) => ({ id, cwd: PROJECT.path, cols: 120, rows: 30, bootstrapCommand: '', startedAt: 0 })),
      projectsRoot: '',
      foreman: {},
      handoff: {},
      brain: null
    }
    const fixture = {
      stage: link === 'offline' ? { kind: 'offline', message: '', record: null } : { kind: 'connected' },
      connection: link === 'connecting' ? { state: 'connecting', attempt: 1 } : { state: 'live' },
      session: { email: 'steve@example.com' },
      config: null,
      picture,
      cached: null,
      projectId: PROJECT.id,
      git: {},
      asking: new Set(empty ? [] : ['p2']),
      busy: new Set(empty ? [] : ['p1']),
      prompts: {},
      waiting: empty ? [] : ['p2'],
      notice: '',
      desktopRecovering: '',
      remoteYes: { enabled: false, uac: false, address: '', port: 21118 },
      warm: link === 'live',
      offlineMode: 'frozen',
      notifyPermission: 'default',
      pushActive: false,
      askBanner: null,
      brainConfirms: []
    }
    return fixture as unknown as ForgeState
  }, [link, empty])

  const value = useMemo(() => ({ state, actions: ACTIONS }), [state])

  const rows: DeckMenuRow[] = [
    {
      id: 'foreman',
      icon: 'foreman',
      label: foreman ? 'Foreman — switch off' : 'Foreman — drive this pane',
      detail: foreman ? 'watching' : 'off',
      on: foreman,
      onSelect: () => setForeman((v) => !v)
    },
    { id: 'handoff', icon: 'send', label: 'Hand off…', detail: '2 packs' },
    { id: 'screen', icon: 'screen', label: 'Watch STEVE-LAPTOP’s screen' },
    { id: 'rustdesk', icon: 'key', label: 'Open RustDesk', detail: 'Remote Yes ready', href: '#rustdesk' },
    { id: 'notify', icon: 'check', label: 'Notifications', detail: 'on · push', on: true, disabled: true },
    {
      id: 'voicebar',
      icon: 'voice',
      label: place === 'top' ? 'Voice bar: Top' : 'Voice bar: Bottom',
      detail: place === 'top' ? 'move to bottom' : 'move to top',
      onSelect: () => setPlace(place === 'top' ? 'bottom' : 'top')
    },
    { id: 'signout', icon: 'user', label: 'Sign out', detail: 'steve@example.com' }
  ]

  const title =
    link === 'offline'
      ? 'The desktop is not answering — this is the last picture it sent.'
      : link === 'live'
        ? 'Mirroring STEVE-LAPTOP'
        : link === 'quiet'
          ? 'Connected to STEVE-LAPTOP, but the link has gone quiet'
          : 'Not connected'

  return (
    <ForgeContext.Provider value={value}>
      <div className="app deck" data-ready="true" data-shell="deck" data-face="deck" data-bar="bottom" style={{ height: '100%' }}>
        <DeckTopBar
          link={{
            state: link === 'offline' ? 'offline' : link === 'connecting' ? 'connecting' : 'live',
            warm: link === 'live',
            name: 'STEVE-LAPTOP',
            title
          }}
          view={view}
          onView={setView}
          place="bottom"
          rows={rows}
          themeId={themeId}
          onTheme={setTheme}
          everySurface
        />
        <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', padding: 8, gap: 8 }}>
          <div
            style={{
              flex: 1,
              minHeight: 0,
              overflow: 'hidden',
              padding: '14px 18px',
              borderRadius: 'var(--r-pane)',
              border: '1px solid var(--line-hairline)',
              background: 'var(--bg-terminal)',
              fontFamily: 'var(--font-mono)',
              fontSize: 12.5,
              lineHeight: 1.6,
              color: 'var(--term-fg)'
            }}
          >
            {Array.from({ length: 26 }, (_, i) => (
              <div key={i} style={{ opacity: i % 5 === 0 ? 0.9 : 0.5 }}>
                {i % 5 === 0 ? '⏺ ' : '  '}the pane on screen under the bar, line {i + 1}
              </div>
            ))}
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center', font: '10.5px var(--font-mono)', color: 'var(--text-dim)' }}>
            <span>preview ·</span>
            {DECK_THEMES.map((t) => (
              <button
                key={t.id}
                type="button"
                data-preview-theme={t.id}
                onClick={() => setTheme(t.id)}
                style={{
                  padding: '2px 8px',
                  borderRadius: 999,
                  border: '1px solid var(--line-hairline)',
                  color: t.id === themeId ? 'var(--text-primary)' : 'var(--text-muted)'
                }}
              >
                {t.name}
              </button>
            ))}
            <span>· link</span>
            {(['live', 'quiet', 'connecting', 'offline'] as LinkWord[]).map((w) => (
              <button
                key={w}
                type="button"
                data-preview-link={w}
                onClick={() => setLink(w)}
                style={{
                  padding: '2px 8px',
                  borderRadius: 999,
                  border: '1px solid var(--line-hairline)',
                  color: w === link ? 'var(--text-primary)' : 'var(--text-muted)'
                }}
              >
                {w}
              </button>
            ))}
          </div>
        </div>
      </div>
    </ForgeContext.Provider>
  )
}
