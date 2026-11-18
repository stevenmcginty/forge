import { useState, type ComponentProps, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { agentModels, BUILTIN_AGENT_PROFILES, effortLevels, permissionModes } from '@shared/agents'
import type { ClaudePermissionMode } from '@shared/types'
import { useDeckTheme } from '../deck/theme'
import { useDrawerSlot } from '../lib/drawer-slot'
import type { PaneFace } from '../lib/pane-status'
import { ForgeContext } from '../state'
import { ModelChip } from './ModelChip'
import { PowerDrawView, type DrumProject } from './PowerDraw'
import { ProjectSheet } from './ProjectSheet'
import { StatusLine } from './StatusLine'
import './ChatPreview.css'

/**
 * `?preview=powerdraw` on the dev server: the phone's project drum fed fixture
 * projects, so it can be looked at without a desktop on the other end.
 * Compiled out of every `vite build` by the `__DEV_SERVER__` gate in main.tsx,
 * like the chat preview.
 *
 * The fixtures are in the order the real picker gives (shared/project-order):
 * a pinned project first, then the open one, then the working ones, then the
 * rest. So by default the open project is second, as on a real phone.
 *
 * The bar on top is harness chrome, not product: Volt, Paper and WhatsApp dark
 * and light through the real theme path; "1st", "mid" and "end" move the open
 * project; "remove" takes the last project away, even while the drum is open.
 * URL: `&n=<count>` trims the list, `&current=<index>` picks the open project,
 * `&open=1` starts with the drum out, `&ask=0` has nobody asking, `&view=`
 * (chat, feed, term) the face the demo pane in the drawer shows, `&bg=chat`
 * puts chat bubbles under it instead of terminal lines, and `&sheet=1` shows
 * the projects drawer (ProjectSheet) on a stand-in Forge state.
 */

/** The open pane's controls, as the session composer portals them into the drawer. */
function DemoPane(): ReactNode {
  const slot = useDrawerSlot()
  const [view, setView] = useState<PaneFace>(() => (new URLSearchParams(location.search).get('view') as PaneFace) || 'chat')
  const [keys, setKeys] = useState(false)
  const [mode, setMode] = useState<ClaudePermissionMode>(() =>
    new URLSearchParams(location.search).get('bypass') === '1' ? 'bypass' : 'plan'
  )
  if (!slot) return null
  const profile = BUILTIN_AGENT_PROFILES.find((p) => /claude/i.test(p.name)) ?? BUILTIN_AGENT_PROFILES[0]!
  return createPortal(
    <StatusLine
      variant="drawer"
      profile={profile}
      status={{ model: 'Opus 4.1', mode: 'plan', context: '42%', busy: true, activity: 'Working', footer: [] }}
      live
      view={view}
      onFlipView={() => {}}
      onPickView={setView}
      onPicked={slot.close}
      keysShown={keys}
      onToggleKeys={() => setKeys((k) => !k)}
      chip={
        <ModelChip
          paneId="demo"
          agentName={profile.name}
          models={agentModels(profile.command)}
          currentModelId={agentModels(profile.command)[0]?.id ?? null}
          onModel={() => undefined}
          effortLevels={effortLevels(profile.command)}
          onEffort={() => undefined}
          modes={permissionModes(profile.command)}
          currentModeId={mode}
          onMode={setMode}
          disabled={false}
          variant="pill"
        />
      }
    />,
    slot.el
  )
}

/** `&bg=chat`: a few chat bubbles, so the drum can be judged over bright bubbles as well as terminal text. */
function DemoChat(): ReactNode {
  const lines = [
    'The feed loses the terminal colour. Can you build a real chat view from the session transcript?',
    'Yes. I will parse each record into a turn: words, tools by name, thinking folded.',
    'ship it',
    'Committed. The wiring job connects it to the transcript watcher next.',
    'and the drawer?',
    'The drum keeps its engine; only the look changes. Shots are in after-W2b.'
  ]
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10, padding: '16px 16px 120px' }}>
      {lines.map((text, i) => {
        const mine = i % 2 === 0
        return (
          <p
            key={text}
            style={{
              alignSelf: mine ? 'flex-end' : 'flex-start',
              maxWidth: '82%',
              margin: 0,
              padding: '10px 14px',
              borderRadius: 14,
              font: '400 16px/1.45 var(--p-font)',
              color: 'var(--p-ink)',
              background: mine ? 'color-mix(in srgb, var(--p-act) 38%, var(--p-bg))' : 'var(--p-surface)'
            }}
          >
            {text}
          </p>
        )
      })}
    </div>
  )
}

type ForgeValue = NonNullable<ComponentProps<typeof ForgeContext.Provider>['value']>

/** `&sheet=1`: the projects drawer on a stand-in Forge, fed the same fixtures as the drum. */
function DemoSheet({ projects, current }: { projects: DrumProject[]; current: string | null }): ReactNode {
  const [open, setOpen] = useState(true)
  const [value] = useState<ForgeValue>(() => {
    const leaves = (p: DrumProject): string[] => Array.from({ length: p.panes }, (_, k) => `${p.id}-pane-${k}`)
    const workspaces = Object.fromEntries(
      projects.map((p) => [
        p.id,
        {
          activeTabId: null,
          tabs: leaves(p).map((id) => ({
            id: `${id}-tab`,
            title: id,
            activePaneId: id,
            root: { type: 'leaf', id, profileId: 'claude', title: '' }
          }))
        }
      ])
    )
    const snapshot = {
      projectId: current ?? 'forge',
      seq: 1,
      at: Date.now(),
      presence: 'ok',
      repoRoot: null,
      branch: 'phone-polish',
      detached: false,
      unborn: false,
      head: '25d2d7b',
      upstream: 'origin/phone-polish',
      ahead: 2,
      behind: 0,
      state: 'ahead',
      remoteUrl: 'https://github.com/example/forge.git',
      slug: null,
      files: [],
      filesTruncated: false,
      changed: 3,
      staged: 0,
      conflicted: 0,
      branches: [],
      fetchedAt: Date.now() - 6 * 60_000,
      slow: false
    }
    const state = {
      picture: {
        projects: projects.map((p) => ({
          id: p.id,
          name: p.name,
          path: p.path,
          color: p.color,
          defaultProfileId: 'claude',
          createdAt: 0,
          pinned: p.id === 'chat'
        })),
        workspaces,
        sessions: projects.flatMap((p) => leaves(p).map((id) => ({ id }))),
        desktopName: 'STEVE-LAPTOP',
        foreman: {}
      },
      cached: null,
      stage: { kind: 'connected' },
      connection: { state: 'live' },
      projectId: current,
      asking: new Set(projects.filter((p) => p.asking).flatMap(leaves)),
      busy: new Set(projects.filter((p) => p.working).flatMap(leaves)),
      git: { [snapshot.projectId]: snapshot }
    }
    const actions = new Proxy(
      {},
      {
        get: (_target, key) =>
          key === 'request'
            ? (req: { kind: string }) =>
                Promise.resolve(
                  req.kind === 'git-status'
                    ? { kind: 'git', snapshot }
                    : { kind: 'failed', code: 'unsupported', message: 'Not in the preview' }
                )
            : () => undefined
      }
    )
    return { state, actions } as unknown as ForgeValue
  })
  return (
    <ForgeContext.Provider value={value}>
      <ProjectSheet open={open} onClose={() => setOpen(false)} onNewAgent={() => setOpen(false)} />
      {!open ? (
        <button
          type="button"
          onClick={() => setOpen(true)}
          style={{ position: 'fixed', left: 16, bottom: 24, zIndex: 1 }}
          className="pu-btn"
        >
          Open the drawer
        </button>
      ) : null}
    </ForgeContext.Provider>
  )
}

const FIXTURES: DrumProject[] = [
  { id: 'chat', name: 'Chat', path: 'C:\\Users\\steve\\Desktop\\chat', color: '#8a94a6', panes: 1, asking: false },
  { id: 'forge', name: 'forge', path: 'C:\\Users\\steve\\Desktop\\forge', color: '#ff5f6d', panes: 1, asking: false },
  { id: 'car', name: 'car-harness', path: 'C:\\Users\\steve\\Desktop\\car-harness', color: '#5ab0ff', panes: 2, asking: true },
  {
    id: 'ac',
    name: 'ac sprayers',
    path: 'C:\\Users\\steve\\Documents\\ac sprayers',
    color: '#c9b458',
    panes: 1,
    asking: false,
    working: true
  },
  { id: 'kora', name: 'koraos', path: 'C:\\Users\\steve\\Desktop\\koraos', color: '#3ad0b5', panes: 0, asking: false },
  {
    id: 'roma',
    name: 'cafe-roma-homepage',
    path: 'C:\\Users\\steve\\Documents\\cafe-roma-homepage',
    color: '#ff9f43',
    panes: 0,
    asking: false
  },
  { id: 'trading', name: 'Trading', path: 'C:\\Users\\steve\\Documents\\Trading', color: '#b6f04a', panes: 0, asking: false },
  {
    id: 'mercedes',
    name: 'mercedes-xentry-slk-ecu-dumps-and-notes',
    path: 'C:\\Users\\steve\\Desktop\\mercedes\\xentry-slk-ecu-dumps-and-notes',
    color: '#c08bff',
    panes: 0,
    asking: false
  },
  { id: 'land', name: 'land-search', path: 'C:\\Users\\steve\\Documents\\land-search', color: '#f25f8c', panes: 0, asking: false },
  { id: 'watch', name: 'forge-watch', path: 'C:\\Users\\steve\\Desktop\\forge\\watch', color: '#4fd1ff', panes: 0, asking: false },
  { id: 'vat', name: 'kora-vat', path: 'C:\\Users\\steve\\Documents\\kora-vat', color: '#e0c050', panes: 0, asking: false },
  { id: 'jag', name: 'jaguar-xf', path: 'C:\\Users\\steve\\Desktop\\jaguar-xf', color: '#8aa0ff', panes: 0, asking: false },
  { id: 'brain', name: 'forge-brain', path: 'C:\\Users\\steve\\Desktop\\forge-brain', color: '#ff6b5a', panes: 0, asking: false },
  {
    id: 'ssd',
    name: 'car SSD migration',
    path: 'C:\\Users\\steve\\Documents\\cars\\ssd-migration',
    color: '#9ad17a',
    panes: 0,
    asking: false
  },
  { id: 'obd', name: 'obd-bridge', path: 'C:\\Users\\steve\\Desktop\\obd-bridge', color: '#ffb86b', panes: 0, asking: false },
  { id: 'notes', name: 'notes', path: 'C:\\Users\\steve\\Documents\\notes', color: '#a0a8b8', panes: 0, asking: false },
  {
    id: 'selfbuild',
    name: 'self-build plot search St Albans',
    path: 'C:\\Users\\steve\\Documents\\self-build',
    color: '#7cc4a0',
    panes: 0,
    asking: false
  }
]

export function PowerDrawPreview(): ReactNode {
  const { themeId: theme, setTheme } = useDeckTheme(true)
  const params = new URLSearchParams(location.search)
  const n = params.get('n')
  const [projects, setProjects] = useState(() => {
    const list = n === null ? FIXTURES : FIXTURES.slice(0, Number(n))
    return params.get('ask') === '0' ? list.map((p) => ({ ...p, asking: false })) : list
  })
  const [current, setCurrent] = useState<string | null>(() => {
    const at = Number(params.get('current') ?? 1)
    return projects[Math.min(projects.length - 1, Math.max(0, at))]?.id ?? null
  })
  const [open, setOpen] = useState(params.get('open') === '1')

  const pick = (index: number): void => setCurrent(projects[Math.max(0, Math.min(projects.length - 1, index))]?.id ?? null)

  return (
    <div className="chatpreview">
      <div className="chatpreview__bar">
        <span className="chatpreview__label">PowerDraw</span>
        <div className="chatpreview__controls">
          <button type="button" data-active={theme === 'volt'} onClick={() => setTheme('volt')}>
            Volt
          </button>
          <button type="button" data-active={theme === 'paper'} onClick={() => setTheme('paper')}>
            Paper
          </button>
          <button type="button" data-active={theme === 'whatsapp-dark'} onClick={() => setTheme('whatsapp-dark')}>
            WA dark
          </button>
          <button type="button" data-active={theme === 'whatsapp-light'} onClick={() => setTheme('whatsapp-light')}>
            WA light
          </button>
          <button type="button" onClick={() => pick(1)}>
            1st
          </button>
          <button type="button" onClick={() => pick(Math.floor(projects.length / 2))}>
            mid
          </button>
          <button type="button" onClick={() => pick(projects.length - 1)}>
            end
          </button>
          <button type="button" onClick={() => setProjects((all) => all.slice(0, -1))}>
            remove
          </button>
        </div>
      </div>
      <div className="app" data-mobile="true" data-ready="true" data-shell="app" style={{ flex: 1, minHeight: 0 }}>
        {params.get('bg') === 'chat' ? (
          <DemoChat />
        ) : (
          <div style={{ padding: 16, fontFamily: 'var(--p-mono)', fontSize: 13, color: 'var(--p-ink-2)' }}>
            <p style={{ margin: '0 0 8px', color: 'var(--p-ink)' }}>
              In {projects.find((p) => p.id === current)?.name ?? 'no project'}
            </p>
            {Array.from({ length: 30 }, (_, i) => (
              <p key={i} style={{ margin: '0 0 6px', opacity: 0.6 }}>
                $ terminal line {i + 1}, text under the handle to show it sits over the pane
              </p>
            ))}
          </div>
        )}
        {params.get('sheet') === '1' ? <DemoSheet projects={projects} current={current} /> : null}
        <DemoPane />
        <PowerDrawView
          projects={projects}
          currentId={current}
          open={open}
          onOpen={() => setOpen(true)}
          onClose={() => setOpen(false)}
          onSelect={(id) => {
            setCurrent(id)
            setOpen(false)
          }}
        />
      </div>
    </div>
  )
}
