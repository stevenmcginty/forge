import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { BUILTIN_AGENT_PROFILES } from '@shared/agents'
import type { HandoffTarget } from '@shared/handoffview'
import type { Project } from '@shared/types'
import type { WebFolder } from '@shared/web'
import { useDeckTheme } from '../deck/theme'
import { publishThemeChoice } from '../lib/theme-choice'
import { ForgeContext, type ForgeActions, type ForgeState, type Picture } from '../state'
import { usePaneSetup } from '../lib/pane-setup'
import { AgentChooser } from './AgentChooser'
import { cloudProjects, CloudLaunchSheet } from './CloudLaunch'
import { ContextChip } from './ContextChip'
import { FolderPicker } from './FolderPicker'
import { HandoffMenu } from './HandoffMenu'
import { ModelChip } from './ModelChip'
import { MoreSheet } from './MoreSheet'
import { PaneSheet } from './StatusLine'
import './ChatPreview.css'

/**
 * `?preview=cloud` on the dev server: the "Work in the cloud" sheet over a
 * stand-in screen, fed three fixture projects, so it can be looked at without
 * a desktop. Compiled out of every `vite build` by the `__DEV_SERVER__` gate
 * in main.tsx, like the chat preview.
 *
 * `&sheet=` shows one of the phone's other sheets on the same fixtures, for the
 * ones no other preview reaches: `agents` (the New tab chooser), `handoff`
 * (`&busy=1`, `&error=1`), `folder` (Add a project), `more` (the More sheet,
 * with its Theme row), `both` (the dial and the model pill on one pane) and
 * `pane` (the pane's
 * details). `&theme=<id>` starts in a theme.
 *
 * The bar on top is harness chrome, not product: Volt and WhatsApp dark and
 * light through the real theme path, and "open" to bring the sheet back.
 */

const PROJECTS: Project[] = [
  {
    id: 'forge',
    name: 'forge',
    path: 'C:\\Users\\steve\\Desktop\\forge',
    color: '#c6f432',
    defaultProfileId: 'claude',
    createdAt: 0,
    repoUrl: 'https://github.com/stevenmcginty/forge.git'
  },
  {
    id: 'coffee',
    name: 'coffee-shop-claude',
    path: 'C:\\Users\\steve\\Desktop\\coffee-shop-claude',
    color: '#f4a432',
    defaultProfileId: 'claude',
    createdAt: 0,
    repoUrl: 'git@github.com:stevenmcginty/coffee-shop-claude.git'
  },
  {
    id: 'notes',
    name: 'notes',
    path: 'C:\\Users\\steve\\Desktop\\notes',
    color: '#32a4f4',
    defaultProfileId: 'claude',
    createdAt: 0
  }
]

const FOLDER: WebFolder = {
  path: 'C:\\Users\\steve\\Desktop',
  sep: '\\',
  crumbs: [
    { name: 'C:\\', path: 'C:\\' },
    { name: 'Users', path: 'C:\\Users' },
    { name: 'steve', path: 'C:\\Users\\steve' },
    { name: 'Desktop', path: 'C:\\Users\\steve\\Desktop' }
  ],
  entries: [
    { name: 'car-harness', dir: true, repo: true },
    { name: 'coffee-shop-claude', dir: true, repo: true },
    { name: 'forge', dir: true, repo: true },
    { name: 'mercedes', dir: true, repo: false },
    { name: 'notes', dir: true, repo: false },
    { name: 'Receipts 2026', dir: true, repo: false },
    { name: 'budget.xlsx', dir: false, repo: false },
    { name: 'todo.txt', dir: false, repo: false }
  ],
  truncated: false
}

const TARGETS: HandoffTarget[] = [
  { key: 'back', kind: 'back', paneId: 'p2', profileId: 'codex', label: 'Codex', agent: 'Codex', note: 'hand back', origin: '' },
  { key: 'p3', kind: 'pane', paneId: 'p3', profileId: 'claude', label: 'Review', agent: 'Claude Code', note: '', origin: '' },
  { key: 'new-claude', kind: 'new', paneId: '', profileId: 'claude', label: 'New Claude Code', agent: 'Claude Code', note: 'tab default', origin: '' },
  { key: 'new-grok', kind: 'new', paneId: '', profileId: 'grok', label: 'New Grok', agent: 'Grok', note: '', origin: '' }
] as HandoffTarget[]

const ACTIONS = new Proxy(
  {},
  {
    get: (_target, key) => {
      const name = String(key)
      if (name === 'request')
        return (req: { kind: string; commands?: string[] }) =>
          Promise.resolve(
            req.kind === 'fs-list'
              ? { kind: 'folder', folder: FOLDER }
              : req.kind === 'agents'
                ? { kind: 'agents', commands: (req.commands ?? []).map((command) => ({ command, found: command !== 'grok' })) }
                : { kind: 'failed', message: 'This is the preview.' }
          )
      if (name.startsWith('on')) return () => () => undefined
      return () => undefined
    }
  }
) as ForgeActions

function param(name: string): string | null {
  return new URLSearchParams(location.search).get(name)
}

export function CloudLaunchPreview(): ReactNode {
  const { themeId: theme, setTheme } = useDeckTheme(true)
  const [seeded, setSeeded] = useState(false)
  if (!seeded) {
    setSeeded(true)
    const first = param('theme')
    if (first && first !== theme) setTheme(first)
  }
  const [open, setOpen] = useState(true)
  const sheet = param('sheet')
  // The More sheet's Theme row reads the choice Workspace publishes in the app.
  useEffect(() => publishThemeChoice({ themeId: theme, setTheme }), [theme, setTheme])

  const value = useMemo(() => {
    const picture: Picture = {
      desktopName: 'STEVE-LAPTOP',
      appVersion: '0.0.0',
      projects: PROJECTS,
      profiles: BUILTIN_AGENT_PROFILES,
      workspaces: {},
      sessions: [{ id: 'p1', cwd: PROJECTS[0].path, cols: 60, rows: 30, bootstrapCommand: '', startedAt: 0 }],
      projectsRoot: 'C:\\Users\\steve\\Projects',
      foreman: {},
      handoff: {},
      brain: null
    }
    const state = {
      stage: { kind: 'connected' },
      connection: { state: 'live' },
      session: { email: 'steve@example.com' },
      picture,
      cached: null,
      projectId: 'forge',
      busy: new Set<string>(),
      asking: new Set<string>(),
      waiting: [],
      remoteYes: { enabled: false, uac: false, address: '', port: 21118 },
      warm: true,
      notifyPermission: 'default',
      pushActive: false
    }
    return { state: state as unknown as ForgeState, actions: ACTIONS }
  }, [])

  const close = (): void => setOpen(false)
  const body =
    sheet === 'agents' ? (
      <AgentChooser anchor={null} open={open} onClose={close} onPick={() => undefined} onChat={() => undefined} selectedId="claude" />
    ) : sheet === 'handoff' ? (
      <HandoffMenu
        anchor={null}
        open={open}
        onClose={close}
        targets={TARGETS}
        profiles={BUILTIN_AGENT_PROFILES}
        autoSend={false}
        busy={param('busy') === '1'}
        error={param('error') === '1' ? 'Codex is not running any more. Pick another agent.' : ''}
        onPick={() => undefined}
      />
    ) : sheet === 'folder' ? (
      <FolderPicker anchor={null} open={open} onClose={close} />
    ) : sheet === 'both' ? (
      <BothPickers />
    ) : sheet === 'more' ? (
      <MoreSheet
        open={open}
        onClose={close}
        pane={{ label: 'Claude Code', accent: null }}
        foremanOn={false}
        foreman={{ available: true, reason: '', detail: 'Let Foreman drive this pane from one line', onPress: () => undefined }}
        handoff={{ available: true, reason: '', detail: 'Ask this agent to write a handoff pack for another', onPress: () => undefined }}
        screen={{ available: false, reason: 'Needs a live link to STEVE-LAPTOP', detail: '', onPress: () => undefined }}
      />
    ) : sheet === 'pane' ? (
      <PaneSheet
        open={open}
        onClose={close}
        profile={CLAUDE}
        place="…/Desktop/forge · master"
        usage={{
          context: { usedPct: Number(param('pct') ?? 42), usedTokens: Number(param('pct') ?? 42) * 2000, windowTokens: 200_000, from: 'frame' },
          limits: {
            fiveHour: { usedPct: 34, resetsAt: Math.floor(Date.now() / 1000) + 7200 },
            week: { usedPct: 81, resetsAt: Math.floor(Date.now() / 1000) + 3 * 86400 }
          }
        }}
        footer={['  ⏵⏵ plan mode on (shift+tab to cycle)', '  Opus 5.5 · forge · master · 5h 34% · week 81%']}
        screen={null}
      />
    ) : (
      <CloudLaunchSheet open={open} projects={cloudProjects(PROJECTS)} onClose={close} />
    )

  return (
    <ForgeContext.Provider value={value}>
      <div className="chatpreview">
        <div className="chatpreview__bar" style={{ flexWrap: 'wrap', gap: 8 }}>
          <span className="chatpreview__label">{sheet ?? 'CloudLaunch'}</span>
          <div className="chatpreview__controls" style={{ flexWrap: 'wrap' }}>
            <button type="button" data-active={theme === 'volt'} onClick={() => setTheme('volt')}>
              Volt
            </button>
            <button type="button" data-active={theme === 'whatsapp-dark'} onClick={() => setTheme('whatsapp-dark')}>
              WA dark
            </button>
            <button type="button" data-active={theme === 'whatsapp-light'} onClick={() => setTheme('whatsapp-light')}>
              WA light
            </button>
            <button type="button" onClick={() => setOpen(true)}>
              open
            </button>
          </div>
        </div>
        <div className="app" data-mobile="true" data-ready="true" data-shell="app" style={{ flex: 1, minHeight: 0 }}>
          {sheet === 'both' ? body : null}
          <div className="app__display" style={{ flex: 1, minHeight: 0, background: 'var(--bg-terminal)' }} />
          {sheet === 'both' ? null : body}
        </div>
      </div>
    </ForgeContext.Provider>
  )
}

const CLAUDE = BUILTIN_AGENT_PROFILES.find((p) => p.id === 'claude') ?? BUILTIN_AGENT_PROFILES[0]

/**
 * `&sheet=both`: the top bar's dial and the drawer's model pill on one fixture
 * pane, so a pick in one can be seen in the other (they share one pick store).
 */
function BothPickers(): ReactNode {
  const setup = usePaneSetup('p1', CLAUDE)
  return (
    <div className="ptop" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, padding: 8 }}>
      <ModelChip
        paneId="p1"
        agentName={CLAUDE.name}
        models={setup.roster}
        currentModelId={setup.currentModelId}
        effortLevels={setup.levels}
        onModel={() => undefined}
        onEffort={() => undefined}
        modes={setup.ladder}
        currentModeId={setup.currentModeId}
        onMode={() => undefined}
        disabled={false}
        variant="pill"
      />
      <ContextChip paneId="p1" profile={CLAUDE} />
    </div>
  )
}
