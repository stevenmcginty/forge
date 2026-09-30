import { useState, type ReactNode } from 'react'
import { useDeckTheme } from '../deck/theme'
import { PowerDrawView, type DrumProject } from './PowerDraw'
import './ChatPreview.css'

/**
 * `?preview=powerdraw` on the dev server: the phone's project drum fed fixture
 * projects, so it can be looked at without a desktop on the other end.
 * Compiled out of every `vite build` by the `__DEV_SERVER__` gate in main.tsx,
 * like the chat preview.
 *
 * The bar on top is harness chrome, not product: Volt, Paper and WhatsApp
 * through the real theme path, and "remove" to take the middle project away
 * while the drum is open. `&n=0` or `&n=1` trims the list for the edge cases.
 */

const FIXTURES: DrumProject[] = [
  { id: 'forge', name: 'forge', path: 'C:\\Users\\steve\\Desktop\\forge', color: '#b6f04a', panes: 3, asking: false },
  { id: 'car', name: 'car-harness', path: 'C:\\Users\\steve\\Desktop\\car-harness', color: '#5ab0ff', panes: 1, asking: true },
  { id: 'roma', name: 'cafe-roma', path: 'C:\\Users\\steve\\Documents\\cafe-roma', color: '#ff9f43', panes: 0, asking: false },
  {
    id: 'long',
    name: 'mercedes-xentry-slk-ecu-dumps-and-notes',
    path: 'C:\\Users\\steve\\Desktop\\mercedes\\xentry-slk-ecu-dumps-and-notes',
    color: '#c08bff',
    panes: 2,
    asking: false
  },
  { id: 'land', name: 'land-search', path: 'C:\\Users\\steve\\Documents\\land-search', color: '#f25f8c', panes: 0, asking: false },
  { id: 'watch', name: 'forge-watch', path: 'C:\\Users\\steve\\Desktop\\forge\\watch', color: '#3ad0b5', panes: 0, asking: false },
  { id: 'vat', name: 'kora-vat', path: 'C:\\Users\\steve\\Documents\\kora-vat', color: '#e0c050', panes: 0, asking: false },
  { id: 'jag', name: 'jaguar-xf', path: 'C:\\Users\\steve\\Desktop\\jaguar-xf', color: '#8aa0ff', panes: 0, asking: false },
  { id: 'brain', name: 'forge-brain', path: 'C:\\Users\\steve\\Desktop\\forge-brain', color: '#ff6b5a', panes: 1, asking: false }
]

export function PowerDrawPreview(): ReactNode {
  const { themeId: theme, setTheme } = useDeckTheme(true)
  const n = new URLSearchParams(location.search).get('n')
  const [projects, setProjects] = useState(() => (n === null ? FIXTURES : FIXTURES.slice(0, Number(n))))
  const [current, setCurrent] = useState<string | null>(projects[4]?.id ?? projects[0]?.id ?? null)
  const [open, setOpen] = useState(false)

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
          <button type="button" data-active={theme === 'whatsapp'} onClick={() => setTheme('whatsapp')}>
            WA
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
          {Array.from({ length: 14 }, (_, i) => (
            <p key={i} style={{ margin: '0 0 6px', opacity: 0.6 }}>
              $ terminal line {i + 1}, text under the handle to show it sits over the pane
            </p>
          ))}
        </div>
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
