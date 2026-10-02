import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { BUILTIN_AGENT_PROFILES } from '@shared/agents'
import type { Project, Workspace } from '@shared/types'
import { useDeckTheme } from '../deck/theme'
import { publishScreenPane, type ScreenPane } from '../lib/pane-screen'
import { pickEffort } from '../lib/pane-setup'
import { publishPaneStatus } from '../lib/pane-status'
import { publishUsage } from '../lib/usage'
import { ForgeContext, type ForgeActions, type ForgeState, type Picture } from '../state'
import { setChipFace, type ChipFace } from './ContextChip'
import { TopBar } from './TopBar'
import './ChatPreview.css'

/**
 * `?preview=phonetop` on the dev server: the phone's real top bar (TopBar's
 * `mobile` branch) on a fixture `ForgeContext`, with a demo pane and usage
 * published into the same module stores the live client feeds — so the
 * context chip and the panel it drops can be looked at with no desktop on the
 * other end. Compiled out of every `vite build` by the `__DEV_SERVER__` gate
 * in main.tsx, like the other previews.
 *
 * The strip on top is harness chrome, not product: the four phone themes,
 * the context reading, the tab on screen and the pane's condition.
 * URL: `&theme=<id>`, `&pct=<0-100|none>`, `&tab=claude|codex|shell`,
 * `&cond=waiting|reconnecting|frozen`, `&waiting=0` (nobody asking),
 * `&mode=default|plan|accept-edits|bypass|auto` (the Claude pane's mode),
 * `&model=<what its status line prints>`, `&effort=low|medium|high|xhigh|max`,
 * `&face=a|b|c` (the context chip's dial, medallion or lockup).
 */

const PROJECT: Project = {
  id: 'forge',
  name: 'forge',
  path: 'C:\\Users\\steve\\Desktop\\forge',
  color: '#ff5f6d',
  defaultProfileId: 'claude',
  createdAt: 0
}

type TabKey = 'claude' | 'codex' | 'shell'
const PANES: Record<TabKey, { id: string; tab: string; profileId: string }> = {
  claude: { id: 'p1', tab: 't1', profileId: 'claude' },
  codex: { id: 'p2', tab: 't2', profileId: 'codex' },
  shell: { id: 'p4', tab: 't4', profileId: 'pwsh' }
}

const leaf = (id: string, profileId: string): { type: 'leaf'; id: string; profileId: string; title: string } => ({
  type: 'leaf',
  id,
  profileId,
  title: ''
})

const ACTIONS = new Proxy(
  {},
  {
    get: (_target, key) => {
      const name = String(key)
      if (name === 'request') return () => Promise.resolve({ kind: 'failed', message: 'This is the preview.' })
      if (name.startsWith('on')) return () => () => undefined
      if (name === 'setNotice' || name === 'signOut' || name === 'nextWaiting') return () => undefined
      return () => Promise.resolve(null)
    }
  }
) as ForgeActions

type Cond = ScreenPane['condition']
type Mode = 'default' | 'plan' | 'accept-edits' | 'bypass' | 'auto'

function param(name: string): string | null {
  return new URLSearchParams(location.search).get(name)
}

const HOUR = 3600

const FACES: Record<string, ChipFace> = { a: 'dial', b: 'medallion', c: 'lockup' }

export function PhoneTopBarPreview(): ReactNode {
  const { themeId, setTheme } = useDeckTheme(true)
  const [seeded, setSeeded] = useState(false)
  if (!seeded) {
    setSeeded(true)
    const first = param('theme')
    if (first && first !== themeId) setTheme(first)
  }
  const [pct, setPct] = useState<number | null>(() => {
    const raw = param('pct')
    return raw === 'none' ? null : raw === null ? 42 : Number(raw)
  })
  const [tab, setTab] = useState<TabKey>(() => (param('tab') as TabKey | null) ?? 'claude')
  const [cond, setCond] = useState<Cond>(() => (param('cond') as Cond) ?? null)
  const asking = param('waiting') !== '0'
  const [mode, setMode] = useState<Mode>(() => (param('mode') as Mode | null) ?? 'plan')
  const model = param('model') ?? 'Opus 5.5'
  const [effortSeeded, setEffortSeeded] = useState(false)
  if (!effortSeeded) {
    setEffortSeeded(true)
    const effort = param('effort')
    if (effort === 'low' || effort === 'medium' || effort === 'high' || effort === 'xhigh' || effort === 'max') pickEffort('p1', effort)
  }
  const face = FACES[param('face') ?? '']
  if (face) setChipFace(face)
  const pane = PANES[tab]

  const state = useMemo(() => {
    const workspace: Workspace = {
      activeTabId: pane.tab,
      tabs: [
        { id: 't1', title: 'Zeb', root: leaf('p1', 'claude'), activePaneId: 'p1' },
        { id: 't2', title: 'Mara', root: leaf('p2', 'codex'), activePaneId: 'p2' },
        { id: 't4', title: 'Shell', root: leaf('p4', 'pwsh'), activePaneId: 'p4' }
      ]
    }
    const picture: Picture = {
      desktopName: 'STEVE-LAPTOP',
      appVersion: '0.0.0',
      projects: [PROJECT],
      profiles: BUILTIN_AGENT_PROFILES,
      workspaces: { [PROJECT.id]: workspace },
      sessions: ['p1', 'p2', 'p4'].map((id) => ({ id, cwd: PROJECT.path, cols: 60, rows: 30, bootstrapCommand: '', startedAt: 0 })),
      projectsRoot: '',
      foreman: {},
      handoff: {},
      brain: null
    }
    const fixture = {
      stage: cond === 'frozen' ? { kind: 'offline', message: '', record: null } : { kind: 'connected' },
      connection: cond === 'reconnecting' ? { state: 'connecting', attempt: 1 } : { state: 'live' },
      session: { email: 'steve@example.com' },
      config: null,
      picture,
      cached: null,
      projectId: PROJECT.id,
      git: {},
      asking: new Set(cond === 'waiting' ? [pane.id, 'p2'] : asking ? ['p2'] : []),
      busy: new Set(['p1']),
      prompts: {},
      waiting: cond === 'waiting' ? [pane.id, 'p2'] : asking ? ['p2'] : [],
      notice: '',
      desktopRecovering: '',
      remoteYes: { enabled: false, uac: false, address: '', port: 21118 },
      warm: true,
      offlineMode: 'frozen',
      notifyPermission: 'default',
      pushActive: false,
      askBanner: null,
      brainConfirms: []
    }
    return fixture as unknown as ForgeState
  }, [pane, cond, asking])
  const value = useMemo(() => ({ state, actions: ACTIONS }), [state])

  // The demo pane's screen reading and the desktop's usage frame, through the
  // same stores the live client writes.
  useEffect(() => {
    publishPaneStatus('p1', {
      model,
      mode,
      busy: true,
      activity: 'Working',
      cwd: 'C:\\Users\\steve\\Desktop\\forge',
      branch: 'master',
      footer: [`  ⏵⏵ ${mode} mode on (shift+tab to cycle)`, `  ${model} · forge · master · 5h 31% · week 34%`]
    })
    publishPaneStatus('p2', { model: 'gpt-6', mode: 'default', busy: false, cwd: 'C:\\Users\\steve\\Desktop\\forge', footer: [] })
  }, [mode, model])

  useEffect(() => {
    const now = Math.floor(Date.now() / 1000)
    const id = pane.id
    if (pct === null) {
      publishUsage({ type: 'usage', sessionId: id, limits: { fiveHour: { usedPct: 31, resetsAt: now + 2 * HOUR } }, source: 'claude-statusline', at: Date.now() })
      return
    }
    publishUsage({
      type: 'usage',
      sessionId: id,
      context: { usedPct: pct, usedTokens: Math.round(pct * 2000), windowTokens: 200_000 },
      limits: {
        fiveHour: { usedPct: Math.min(100, pct * 0.8), resetsAt: now + 2 * HOUR },
        week: { usedPct: 34, resetsAt: now + 3 * 24 * HOUR }
      },
      source: 'claude-statusline',
      at: Date.now()
    })
  }, [pct, pane])

  useEffect(() => {
    publishScreenPane({
      paneId: pane.id,
      condition: cond,
      showView: () => undefined,
      copyScreen: () => undefined,
      stepTab: () => undefined
    })
  }, [pane, cond])

  const button = (on: boolean, label: string, onClick: () => void): ReactNode => (
    <button key={label} type="button" data-active={on} onClick={onClick}>
      {label}
    </button>
  )

  return (
    <ForgeContext.Provider value={value}>
      <div className="chatpreview">
        <div className="chatpreview__bar">
          <span className="chatpreview__label">Top bar</span>
          <div className="chatpreview__controls">
            {button(themeId === 'volt', 'Volt', () => setTheme('volt'))}
            {button(themeId === 'paper', 'Paper', () => setTheme('paper'))}
            {button(themeId === 'whatsapp-dark', 'WA dark', () => setTheme('whatsapp-dark'))}
            {button(themeId === 'whatsapp-light', 'WA light', () => setTheme('whatsapp-light'))}
            {[null, 9, 42, 84, 95].map((n) => button(pct === n, n === null ? '—' : `${n}%`, () => setPct(n)))}
            {(['claude', 'codex', 'shell'] as TabKey[]).map((k) => button(tab === k, k, () => setTab(k)))}
            {([null, 'waiting', 'reconnecting', 'frozen'] as Cond[]).map((c) => button(cond === c, c ?? 'ok', () => setCond(c)))}
            {(['default', 'plan', 'accept-edits', 'bypass', 'auto'] as Mode[]).map((m) => button(mode === m, m, () => setMode(m)))}
          </div>
        </div>
        <div className="app" data-mobile="true" data-ready="true" data-shell="app" style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
          <TopBar collapsed onToggleRail={() => undefined} onWatchScreen={null} mobile />
          <div style={{ flex: 1, minHeight: 0, overflow: 'hidden', padding: 16, fontFamily: 'var(--p-mono)', fontSize: 13, color: 'var(--p-ink-2)' }}>
            {Array.from({ length: 40 }, (_, i) => (
              <p key={i} style={{ margin: '0 0 6px', opacity: i % 5 === 0 ? 0.9 : 0.55 }}>
                {i % 5 === 0 ? '⏺ ' : '  '}the pane on screen under the bar, line {i + 1}
              </p>
            ))}
          </div>
        </div>
      </div>
    </ForgeContext.Provider>
  )
}
