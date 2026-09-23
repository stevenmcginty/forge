import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { useKeymap } from '@/hooks/useHub'
import { usePresence } from '@/lib/motion'
import { useApp } from '@/state/AppState'
import { Keys } from './KeyRecorder'
import './CheatSheet.css'

/**
 * Every shortcut on one sheet, grouped by area (Ctrl+Shift+/ — "Ctrl+?").
 * Read straight from the keymap registry, so a key rebound in Settings is the
 * key shown here. Esc, the same keys again, or a click outside closes it.
 */

const GROUP_ORDER = ['Voice', 'App', 'Shell', 'Modes', 'Panes', 'Tabs', 'Projects', 'Board', 'View', 'Clipboard', 'Agents', 'Prompts']

export function CheatSheet({ open, onClose }: { open: boolean; onClose: () => void }): ReactNode {
  const { actions } = useApp()
  const { commands } = useKeymap()
  const { mounted, closing } = usePresence(open, 160)
  const [filter, setFilter] = useState('')

  useEffect(() => {
    if (!open) return undefined
    setFilter('')
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      e.preventDefault()
      e.stopPropagation()
      onClose()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [open, onClose])

  const groups = useMemo(() => {
    const q = filter.trim().toLowerCase()
    const byGroup = new Map<string, typeof commands>()
    for (const c of commands) {
      if (!c.keys.length) continue
      if (q && !`${c.title} ${c.group} ${c.keys.join(' ')}`.toLowerCase().includes(q)) continue
      const list = byGroup.get(c.group) ?? []
      list.push(c)
      byGroup.set(c.group, list)
    }
    const rank = (g: string): number => {
      const i = GROUP_ORDER.indexOf(g)
      return i < 0 ? GROUP_ORDER.length : i
    }
    return [...byGroup.entries()].sort((a, b) => rank(a[0]) - rank(b[0]) || a[0].localeCompare(b[0]))
  }, [commands, filter])

  if (!mounted) return null
  return (
    <div className="cheat" data-state={closing ? 'closing' : 'open'} onMouseDown={onClose}>
      <div className="cheat__panel" role="dialog" aria-label="Keyboard shortcuts" onMouseDown={(e) => e.stopPropagation()}>
        <header className="cheat__head">
          <span className="cheat__eyebrow">Shortcuts</span>
          <input
            className="cheat__filter"
            placeholder="Filter…"
            value={filter}
            autoFocus
            spellCheck={false}
            onChange={(e) => setFilter(e.target.value)}
          />
          <button
            type="button"
            className="cheat__link"
            onClick={() => {
              onClose()
              actions.openSettings('shortcuts')
            }}
          >
            Change keys in Settings
          </button>
          <span className="cheat__close">
            <Keys combo="Esc" size="sm" />
          </span>
        </header>
        <div className="cheat__cols">
          {groups.map(([group, list]) => (
            <section key={group} className="cheat__group">
              <h3 className="cheat__group-title">{group}</h3>
              {list.map((c) => (
                <div key={c.id} className="cheat__row" data-custom={c.customised ? 'true' : undefined}>
                  <span className="cheat__title">{c.title}</span>
                  <span className="cheat__keys">
                    {c.keys.map((k) => (
                      <Keys key={k} combo={k} size="sm" />
                    ))}
                  </span>
                </div>
              ))}
            </section>
          ))}
          {groups.length === 0 ? <p className="cheat__empty">No shortcut matches “{filter}”.</p> : null}
        </div>
      </div>
    </div>
  )
}
