import { useEffect, useRef, useState, type ReactNode } from 'react'
import { shellSheet, tabsHost, useShellSheet, useShellMode, useSurfaces, viewHost } from '@/lib/shellSlots'
import { uiCommands, useUiCommand } from '@/lib/uiCommands'
import { useApp } from '@/state/AppState'
import { AccountChip } from './AccountChip'
import { Icon } from './Icon'
import { Popover } from './Popover'
import { ScreenshotTray } from './ScreenshotTray'
import './shell/DeckBar.css'

/**
 * The deck's one top layer: the mark and the agents' tabs on the left, the
 * mode switcher in the middle, the Tabs/Canvas switch, the tucked-away tools
 * and settings on the right. Transparent over the
 * backdrop — the window is draggable anywhere along it — with the native
 * minimise/maximise/close buttons drawn by Windows into the reserved gap on the
 * far right (titleBarOverlay), never re-implemented here.
 *
 * (Forge Web keeps its own top bar and still reads TitleBar.css; this bar's
 * styles are its own, in shell/DeckBar.css.)
 */
export function TitleBar(): ReactNode {
  const { state, actions } = useApp()
  const [focused, setFocused] = useState(true)
  const inSettings = state.view === 'settings'
  const isDevChannel = state.info?.channel === 'dev'
  const hubOpen = state.settings.voiceHub.mode === 'expanded'

  useEffect(() => window.forge.window.onState((s) => setFocused(s.focused)), [])

  return (
    <header className="deckbar" data-focused={focused}>
      <div className="deckbar__left">
        <span className="deckbar__mark" data-channel={isDevChannel ? 'dev' : undefined}>
          <Icon name="forge" size={15} />
        </span>
        <span className="deckbar__wordmark">Forge</span>
        {isDevChannel ? <span className="deckbar__channel">DEV</span> : null}
        {/* The agents' tabs, portalled in by TerminalGrid (see tabsHost). */}
        <div className="deckbar__tabs" ref={tabsHost.set} />
      </div>

      <ModePill />

      <div className="deckbar__right">
        {/* Tabs / Canvas, portalled in by TerminalGrid (see viewHost). */}
        <div className="deckbar__view" ref={viewHost.set} />
        <ShelfButton />
        <button
          type="button"
          className="deckbar__btn"
          title={hubOpen ? 'Close the voice hub (Ctrl+Shift+G)' : 'Open the voice hub (Ctrl+Shift+G)'}
          aria-label="Voice hub"
          aria-pressed={hubOpen}
          data-on={hubOpen ? 'true' : undefined}
          onClick={() => actions.toggleVoiceHubCard()}
        >
          <Icon name="expand" size={15} />
        </button>
        <button
          type="button"
          className="deckbar__btn"
          title={inSettings ? 'Close settings (Esc)' : 'Settings (Ctrl+,)'}
          aria-label="Settings"
          aria-pressed={inSettings}
          data-on={inSettings ? 'true' : undefined}
          onClick={() => (inSettings ? actions.closeSettings() : actions.openSettings())}
        >
          <Icon name="gear" size={15} />
        </button>
      </div>

      {/* Reserved for the native window controls (3 × 46px on Windows 11). */}
      <div className="deckbar__controls-gap" />
    </header>
  )
}

/* ------------------------------------------------------------- mode pill */

export interface DeckMode {
  id: string
  title: string
}

/** The modes, in switcher order: the three built in, then every registered surface. */
export function useDeckModes(): DeckMode[] {
  const surfaces = useSurfaces()
  return [
    { id: 'agents', title: 'Agents' },
    ...[...surfaces]
      .sort((a, b) => (a.order ?? 50) - (b.order ?? 50))
      .map((s) => ({ id: s.id, title: s.title })),
    { id: 'tasks', title: 'Tasks' },
    { id: 'devices', title: 'Devices' }
  ]
}

/** Which mode is on screen. Settings is a pop-up over a mode, not a mode. */
export function useDeckMode(): string {
  const { state } = useApp()
  const surface = useShellMode()
  if (state.view === 'devices') return 'devices'
  if (state.tasksMaximized) return 'tasks'
  return surface ?? 'agents'
}

/**
 * Agents, the browser, the board, talk, tasks, devices — one keystroke or one
 * click apart, with a lit capsule that glides between them. The capsule is a
 * single element moved by transform, measured off the button it lands on.
 */
function ModePill(): ReactNode {
  const modes = useDeckModes()
  const active = useDeckMode()
  const ref = useRef<HTMLDivElement | null>(null)
  const lampRef = useRef<HTMLSpanElement | null>(null)
  const placed = useRef(false)

  useEffect(() => {
    const root = ref.current
    const lamp = lampRef.current
    if (!root || !lamp) return
    const btn = root.querySelector<HTMLElement>(`[data-mode='${active}']`)
    if (!btn) return
    lamp.style.width = `${btn.offsetWidth}px`
    lamp.style.transform = `translate3d(${btn.offsetLeft}px, 0, 0)`
    if (!placed.current) {
      placed.current = true
      requestAnimationFrame(() => lamp.setAttribute('data-ready', 'true'))
    }
  }, [active, modes.length])

  return (
    <nav className="deckbar__modes" ref={ref} aria-label="Modes">
      <span className="deckbar__lamp" ref={lampRef} aria-hidden="true" />
      {modes.map((m) => (
        <button
          key={m.id}
          type="button"
          className="deckbar__mode"
          data-mode={m.id}
          data-active={m.id === active ? 'true' : undefined}
          aria-pressed={m.id === active}
          onClick={() => uiCommands.run('set-mode', m.id)}
        >
          {m.title}
        </button>
      ))}
    </nav>
  )
}

/* ----------------------------------------------------------------- shelf */

/**
 * The clipping tool and the account, tucked into one drawer: the screenshot
 * shelf (drag a shot onto a pane, as ever) and the account chip that used to
 * sit at the foot of the rail.
 */
function ShelfButton(): ReactNode {
  const ref = useRef<HTMLButtonElement | null>(null)
  const open = useShellSheet() === 'shelf'
  useUiCommand('open-shelf', () => shellSheet.set('shelf'))
  useUiCommand('close-shelf', () => {
    if (shellSheet.get() === 'shelf') shellSheet.set(null)
  })
  useUiCommand('toggle-shelf', () => shellSheet.set(shellSheet.get() === 'shelf' ? null : 'shelf'))

  // The shelf is folded away, so a fresh screenshot has to announce itself on
  // the button: a count of shots that arrived since it was last opened.
  const [fresh, setFresh] = useState(0)
  const known = useRef<Set<string> | null>(null)
  useEffect(() => {
    const receive = (shots: Array<{ id: string }>): void => {
      const ids = new Set(shots.map((s) => s.id))
      if (known.current === null) {
        known.current = ids
        return
      }
      const added = shots.filter((s) => !known.current!.has(s.id)).length
      known.current = ids
      if (added > 0 && shellSheet.get() !== 'shelf') setFresh((n) => n + added)
    }
    const off = window.forge.shots.onUpdated(receive)
    void window.forge.shots.list().then(receive)
    return off
  }, [])
  useEffect(() => {
    if (open) setFresh(0)
  }, [open])

  return (
    <>
      <button
        ref={ref}
        type="button"
        className="deckbar__btn"
        title={fresh > 0 ? `${fresh} new screenshot${fresh === 1 ? '' : 's'} on the shelf` : 'Screenshot shelf and account'}
        aria-label="Screenshot shelf and account"
        aria-expanded={open}
        data-on={open ? 'true' : undefined}
        onClick={() => shellSheet.set(open ? null : 'shelf')}
      >
        <Icon name="camera" size={15} />
        {fresh > 0 ? <span className="deckbar__badge">{fresh > 9 ? '9+' : fresh}</span> : null}
      </button>
      <Popover
        anchor={ref.current}
        open={open}
        onClose={() => shellSheet.set(null)}
        align="end"
        width={300}
        label="Screenshot shelf and account"
      >
        <div className="deckbar__shelf" data-shell-overlay="">
          <ScreenshotTray />
          <AccountChip />
        </div>
      </Popover>
    </>
  )
}
