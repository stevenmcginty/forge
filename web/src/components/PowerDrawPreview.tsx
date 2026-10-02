import { useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { agentModels, BUILTIN_AGENT_PROFILES, effortLevels, permissionModes } from '@shared/agents'
import type { ClaudePermissionMode } from '@shared/types'
import { useDeckTheme } from '../deck/theme'
import { useDrawerSlot } from '../lib/drawer-slot'
import type { PaneFace } from '../lib/pane-status'
import { ModelChip } from './ModelChip'
import { PowerDrawView, type DrumProject } from './PowerDraw'
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
 * (chat, feed, term) the face the demo pane in the drawer shows.
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

const FIXTURES: DrumProject[] = [
  { id: 'chat', name: 'Chat', path: 'C:\\Users\\steve\\Desktop\\chat', color: '#8a94a6', panes: 1, asking: false },
  { id: 'forge', name: 'forge', path: 'C:\\Users\\steve\\Desktop\\forge', color: '#ff5f6d', panes: 1, asking: false },
  { id: 'car', name: 'car-harness', path: 'C:\\Users\\steve\\Desktop\\car-harness', color: '#5ab0ff', panes: 2, asking: true },
  { id: 'ac', name: 'ac sprayers', path: 'C:\\Users\\steve\\Documents\\ac sprayers', color: '#c9b458', panes: 1, asking: false },
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
