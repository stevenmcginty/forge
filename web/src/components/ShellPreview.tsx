import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { agentModels, BUILTIN_AGENT_PROFILES } from '@shared/agents'
import type { LayoutNode, PaneLeaf, Project, TerminalTab, Workspace } from '@shared/types'
import { collectLeaves } from '@/lib/splitTree'
import { useDeckTheme } from '../deck/theme'
import { publishScreenPane } from '../lib/pane-screen'
import { publishPaneStatus } from '../lib/pane-status'
import { publishUsage } from '../lib/usage'
import { ForgeContext, type ForgeActions, type ForgeState, type Picture } from '../state'
import { MOCK_TURNS } from './chat-preview-data'
import { ChatView } from './ChatView'
import { Composer } from './Composer'
import { PaneChips } from './MobilePanes'
import { PREVIEW_VOICE, PreviewFan, PreviewLine, PreviewListen } from './Preview'
import { TabStrip } from './TabStrip'
import { TopBar } from './TopBar'

/**
 * `?preview=shell&phone` on the dev server: the phone's shell as the app draws
 * it — the real TopBar and TabStrip over a fixture pane and the real composer
 * row — on a fixture `ForgeContext`, so the head can be looked at with no
 * desktop on the other end. Compiled out of every `vite build` by the
 * `__DEV_SERVER__` gate in main.tsx. No harness bar: the page is the phone.
 *
 * URL params:
 *  `tabs=1|3|7`        how many tabs (default 3; 7 makes the strip scroll)
 *  `active=<n>`        which tab is open, 1-based (default 1)
 *  `waiting=0|1`       a pane asking (Mara) and the waiting pill (default 1)
 *  `name=long`         a long project name
 *  `link=live|quiet|connecting|reconnecting|asleep`   the link (default live)
 *  `pct=<0-100>`       the context reading on the dial (default 42)
 *  `theme=<id>`        one of the eight themes
 *
 * Tabs, in order: 1 Zeb (Claude, working) · 2 Mara (Codex, asking) · 3 Review
 * (a split, Claude + Codex, finished unseen) · 4 Shell · 5 Grok (working) ·
 * 6 Kimi · 7 ChatGPT (a chat tab). A tap on a tab switches after 250ms, as the
 * desk's push would; a long-press opens the real tab sheet.
 */

function param(name: string): string | null {
  return new URLSearchParams(location.search).get(name)
}

const leaf = (id: string, profileId: string): PaneLeaf => ({ type: 'leaf', id, profileId, title: '' })

const ALL_TABS: TerminalTab[] = [
  { id: 't1', title: 'Zeb', root: leaf('p1', 'claude'), activePaneId: 'p1' },
  { id: 't2', title: 'Mara', root: leaf('p2', 'codex'), activePaneId: 'p2' },
  {
    id: 't3',
    title: 'Review',
    root: { type: 'split', id: 's3', direction: 'row', ratio: 0.5, a: leaf('p3a', 'claude'), b: leaf('p3b', 'codex') },
    activePaneId: 'p3b'
  },
  { id: 't4', title: 'Shell', root: leaf('p4', 'pwsh'), activePaneId: 'p4' },
  { id: 't5', title: 'Grok', root: leaf('p5', 'grok'), activePaneId: 'p5' },
  { id: 't6', title: 'Kimi', root: leaf('p6', 'kimi'), activePaneId: 'p6' },
  { id: 't7', title: 'ChatGPT', root: { type: 'chat', id: 'c7', bot: 'chatgpt', title: 'ChatGPT' } as LayoutNode, activePaneId: 'c7' }
]

const HOUR = 3600

/*
 * "Finished while you were not looking" is kept by lib/pane-state.ts, which
 * only marks a pane that worked for 8s and then stopped. So the first render
 * runs 10s in the past with the Review pane busy, and the first effect brings
 * the clock back and lets it stop: the strip's own tracker sees eight seconds
 * of work end, exactly as it would live.
 */
const realNow = Date.now.bind(Date)

export function ShellPreview(): ReactNode {
  const { themeId, setTheme } = useDeckTheme(true)
  const [seeded, setSeeded] = useState(false)
  if (!seeded) {
    setSeeded(true)
    const first = param('theme')
    if (first && first !== themeId) setTheme(first)
  }

  const count = Math.max(1, Math.min(7, Number(param('tabs') ?? 3) || 3))
  const tabs = ALL_TABS.slice(0, count)
  const [activeTabId, setActiveTabId] = useState(() => tabs[Math.max(0, Math.min(count, Number(param('active') ?? 1)) - 1)]?.id ?? 't1')
  const waiting = param('waiting') !== '0'
  const longName = param('name') === 'long'
  const link = param('link') ?? 'live'
  const pct = Number(param('pct') ?? 42)

  const shifted = useRef(false)
  if (!shifted.current) {
    shifted.current = true
    Date.now = () => realNow() - 10_000
  }
  const [busy, setBusy] = useState(() => new Set(['p1', 'p3a', 'p5']))
  useEffect(() => {
    Date.now = realNow
    setBusy(new Set(['p1', 'p5']))
  }, [])

  const project: Project = useMemo(
    () => ({
      id: 'forge',
      name: longName ? 'car-harness-diagnostics-rewrite' : 'forge',
      path: 'C:\\Users\\steve\\Desktop\\forge',
      color: longName ? '#5ab0ff' : '#ff5f6d',
      defaultProfileId: 'claude',
      createdAt: 0
    }),
    [longName]
  )

  /** What the desk would do with a layout request: switch a beat later and say nothing. */
  const layout = useCallback(async (op: { op: string; tabId?: string }): Promise<string | null> => {
    if (op.op === 'select-tab' && op.tabId) {
      const id = op.tabId
      window.setTimeout(() => setActiveTabId(id), 250)
    }
    return null
  }, [])

  const actions = useMemo(
    () =>
      new Proxy({} as ForgeActions, {
        get: (_target, key) => {
          const name = String(key)
          if (name === 'layout') return layout
          if (name === 'request') return () => Promise.resolve({ kind: 'failed', message: 'This is the preview.' })
          if (name.startsWith('on')) return () => () => undefined
          if (name === 'setNotice' || name === 'signOut' || name === 'nextWaiting' || name === 'write' || name === 'claim') return () => undefined
          return () => Promise.resolve(null)
        }
      }),
    [layout]
  )

  const state = useMemo(() => {
    const workspace: Workspace = { activeTabId, tabs }
    const allLeaves = tabs.flatMap((t) => collectLeaves(t.root))
    const picture: Picture = {
      desktopName: 'STEVE-LAPTOP',
      appVersion: '0.0.0',
      projects: [project],
      profiles: BUILTIN_AGENT_PROFILES,
      workspaces: { [project.id]: workspace },
      sessions: allLeaves.map((l) => ({ id: l.id, cwd: project.path, cols: 60, rows: 30, bootstrapCommand: '', startedAt: 0 })),
      projectsRoot: '',
      foreman: {},
      handoff: {},
      brain: null
    }
    const asking = waiting ? ['p2'] : []
    const fixture = {
      stage: link === 'asleep' ? { kind: 'offline', message: '', record: null } : { kind: 'connected' },
      connection: link === 'reconnecting' || link === 'connecting' ? { state: 'connecting', attempt: 1 } : { state: 'live' },
      session: { email: 'steve@example.com' },
      config: null,
      picture,
      cached: null,
      projectId: project.id,
      git: {},
      asking: new Set(asking),
      busy,
      prompts: {},
      waiting: asking,
      notice: '',
      desktopRecovering: '',
      remoteYes: { enabled: false, uac: false, address: '', port: 21118 },
      warm: link !== 'quiet',
      offlineMode: 'frozen',
      notifyPermission: 'default',
      pushActive: false,
      askBanner: null,
      brainConfirms: []
    }
    return fixture as unknown as ForgeState
    // `tabs` is derived from `count`, which never changes on a page.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTabId, project, waiting, link, busy])
  const value = useMemo(() => ({ state, actions }), [state, actions])

  const tab = tabs.find((t) => t.id === activeTabId) ?? tabs[0]!
  const leaves = collectLeaves(tab.root)
  const [shownPane, setShownPane] = useState<string | null>(null)
  const paneId = leaves.some((l) => l.id === shownPane) ? shownPane! : (tab.activePaneId ?? leaves[0]?.id ?? '')
  const profile = BUILTIN_AGENT_PROFILES.find((p) => p.id === leaves.find((l) => l.id === paneId)?.profileId) ?? BUILTIN_AGENT_PROFILES[1]!
  const shell = profile.id === 'pwsh'
  const chat = tab.root.type === 'chat'

  useEffect(() => {
    publishPaneStatus('p1', { model: 'Opus 5.5', mode: 'default', busy: true, activity: 'Working', cwd: project.path, branch: 'master', footer: [] })
  }, [project])

  useEffect(() => {
    const now = Math.floor(realNow() / 1000)
    publishUsage({
      type: 'usage',
      sessionId: paneId,
      context: { usedPct: pct, usedTokens: Math.round(pct * 2000), windowTokens: 200_000 },
      limits: { fiveHour: { usedPct: Math.min(100, pct * 0.8), resetsAt: now + 2 * HOUR }, week: { usedPct: 34, resetsAt: now + 72 * HOUR } },
      source: 'claude-statusline',
      at: realNow()
    })
    publishScreenPane({ paneId, condition: null, showView: () => undefined, copyScreen: () => undefined, stepTab: () => undefined })
  }, [paneId, pct])

  const [draft, setDraft] = useState('')
  const roster = agentModels(profile.command)

  return (
    <ForgeContext.Provider value={value}>
      <div className="app" data-mobile="true" data-ready="true" data-shell="app" style={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
        <TopBar collapsed onToggleRail={() => undefined} onWatchScreen={null} mobile />
        <div className="app__body" style={{ flex: 1, minHeight: 0 }}>
          <main className="app__main">
            <div className="grid">
              <TabStrip mobile />
              <div className="app__display grid__body" data-region="display">
                <div className="grid__tab" data-active="true">
                  <div className="mpanes">
                    {leaves.length > 1 ? <PaneChips leaves={leaves} shown={paneId} onPick={setShownPane} /> : null}
                    <div className="mpanes__body">
                      {chat ? (
                        <div className="shellpv__chat">ChatGPT opens here as its own page.</div>
                      ) : shell ? (
                        <pre className="pane__terminal preview__term shellpv__term">
                          {'PowerShell 7.5.2\n\nPS C:\\Users\\steve\\Desktop\\forge> git status --short\n M web/src/styles.css\n M web/src/components/TopBar.tsx\nPS C:\\Users\\steve\\Desktop\\forge> '}
                        </pre>
                      ) : (
                        <div className="pane" data-kind="agent" data-view="chat" style={{ position: 'absolute', inset: 0 }}>
                          <ChatView turns={MOCK_TURNS} truncated={false} busy={busy.has(paneId)} agentName={profile.name} />
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              </div>
              <div className="session-composer" data-view="chat">
                <Composer
                  draft={draft}
                  disabled={link === 'asleep'}
                  to={`${profile.name} · ${project.name}`}
                  onDraft={setDraft}
                  onSend={() => setDraft('')}
                  onRaw={() => undefined}
                  models={roster}
                  currentModelId={null}
                  autoFocus={false}
                  voice={PREVIEW_VOICE}
                  listen={<PreviewListen />}
                  listenMenu={<PreviewFan />}
                  listenLine={<PreviewLine />}
                />
              </div>
            </div>
          </main>
        </div>
      </div>
    </ForgeContext.Provider>
  )
}
