import { useEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { shellSheet, useShellSheet } from '@/lib/shellSlots'
import { useUiCommand } from '@/lib/uiCommands'
import { setVoiceBarPlace, type VoiceBarPlace } from '@/lib/voiceBarPlace'
import { useActiveProject, useApp } from '@/state/AppState'
import { Composer } from '../hub/Composer'
import { Icon } from '../Icon'
import { RailStack } from '../rail/RailStack'
import { Sheet, toggleSheet } from './Sheet'
import './Dock.css'

/**
 * The voice bar: the project you are in, Listen, D (raw dictation) and the
 * text — the only place you talk to Forge (./hub/Composer).
 *
 * It lives in one of two places, a per-machine choice (lib/voiceBarPlace):
 *
 *   top      in the top bar, between the agents and the modes (the default).
 *            Slim — one line — and it drops down over the stage only while
 *            there is something to show (a long message, Forge's reply, the
 *            palette), so the terminals keep the whole height.
 *   bottom   clipped to the deck's bottom edge, floating, as the old dock.
 *
 * The grip at its left end moves it: drag it down to the bottom edge and it
 * clips there, drag it up and it goes back into the top bar. The … menu has
 * the same choice as a switch, and Enter on the grip flips it.
 *
 * The project sheet opens out of it, dropping from the top bar or rising from
 * the bottom edge. The panes switcher is the top bar's Agents menu now.
 */
export function Dock({ place }: { place: VoiceBarPlace }): ReactNode {
  const project = useActiveProject()
  const [drag, setDrag] = useState<{ y: number; armed: boolean } | null>(null)
  const other = place === 'top' ? 'bottom' : 'top'
  return (
    <div
      className="dock"
      data-place={place}
      data-dragging={drag ? 'true' : undefined}
      role="toolbar"
      aria-label="Voice bar"
      style={drag ? ({ '--drag-y': `${drag.y}px` } as React.CSSProperties) : undefined}
    >
      <Grip place={place} onDrag={setDrag} />
      {project ? (
        <Composer lead={<ProjectPill />} compact={place === 'top'} />
      ) : (
        <div className="dock__composer dock__composer--idle">
          <ProjectPill />
          Add a project to start
        </div>
      )}
      <ProjectSheet />
      {/* Where a drop will clip it: a lit slot at the other edge, with a word. */}
      {drag
        ? createPortal(
            <div className="dock__snap" data-to={other} data-armed={drag.armed ? 'true' : undefined} aria-hidden="true">
              {drag.armed ? `Let go — clip to the ${other}` : `Drag to the ${other} edge`}
            </div>,
            document.body
          )
        : null}
    </div>
  )
}

/* -------------------------------------------------------------------- grip */

/** Let go within this share of the window's height from the other edge, and the bar moves there. */
const SNAP_AT = 0.45

/**
 * The bar's handle. A drag follows the pointer (the bar moves with it, as a
 * transform); let go past the middle of the window and it clips to the other
 * edge, anywhere short of that and it springs back. Enter or Space on it flips
 * the edge outright, for the keyboard.
 */
function Grip({
  place,
  onDrag
}: {
  place: VoiceBarPlace
  onDrag: (drag: { y: number; armed: boolean } | null) => void
}): ReactNode {
  const start = useRef<{ id: number; y: number } | null>(null)
  const other: VoiceBarPlace = place === 'top' ? 'bottom' : 'top'
  const passed = (clientY: number): boolean =>
    place === 'top' ? clientY > window.innerHeight * (1 - SNAP_AT) : clientY < window.innerHeight * SNAP_AT

  return (
    <button
      type="button"
      className="dock__grip"
      title={place === 'top' ? 'Drag down to clip the voice bar to the bottom edge' : 'Drag up to put the voice bar back in the top bar'}
      aria-label={place === 'top' ? 'Move the voice bar to the bottom' : 'Move the voice bar to the top'}
      onMouseDown={(e) => e.preventDefault()}
      onPointerDown={(e) => {
        if (e.button !== 0) return
        e.currentTarget.setPointerCapture(e.pointerId)
        start.current = { id: e.pointerId, y: e.clientY }
      }}
      onPointerMove={(e) => {
        const s = start.current
        if (!s || s.id !== e.pointerId) return
        const dy = e.clientY - s.y
        // Only toward the other edge: the bar is already against its own.
        onDrag({ y: place === 'top' ? Math.max(0, dy) : Math.min(0, dy), armed: passed(e.clientY) })
      }}
      onPointerUp={(e) => {
        const s = start.current
        start.current = null
        onDrag(null)
        if (!s || s.id !== e.pointerId) return
        if (passed(e.clientY)) setVoiceBarPlace(other)
      }}
      onPointerCancel={() => {
        start.current = null
        onDrag(null)
      }}
      onKeyDown={(e) => {
        if (e.key !== 'Enter' && e.key !== ' ') return
        e.preventDefault()
        setVoiceBarPlace(other)
      }}
    >
      <Icon name="grip" size={12} />
    </button>
  )
}

/* ------------------------------------------------------------ project pill */

/** The project you are in, as the bar's first word; opens the project sheet. */
function ProjectPill(): ReactNode {
  const project = useActiveProject()
  const open = useShellSheet() === 'projects'
  useUiCommand('open-project-sheet', () => shellSheet.set('projects'))
  useUiCommand('close-project-sheet', () => {
    if (shellSheet.get() === 'projects') shellSheet.set(null)
  })
  useUiCommand('toggle-project-sheet', () => toggleSheet('projects'))

  return (
    <button
      type="button"
      className="dock__project comp__project"
      data-open={open ? 'true' : undefined}
      data-sheet-toggle="projects"
      aria-expanded={open}
      title="Projects (Ctrl+Shift+B)"
      style={{ '--project': project?.color ?? 'var(--accent)' } as React.CSSProperties}
      onMouseDown={(e) => e.preventDefault()}
      onClick={() => toggleSheet('projects')}
    >
      <span className="dock__project-dot" aria-hidden="true" />
      <span className="dock__project-name truncate">{project?.name ?? 'No project'}</span>
      <Icon name="chevronDown" size={11} className="dock__chev" />
    </button>
  )
}

function ProjectSheet(): ReactNode {
  const { state } = useApp()
  // Picking a project is the end of the errand: the sheet goes, the way a menu
  // does, and the deck changes under it.
  const projectId = state.activeProjectId
  const lastProject = useRef(projectId)
  useEffect(() => {
    if (lastProject.current === projectId) return
    lastProject.current = projectId
    if (shellSheet.get() === 'projects') shellSheet.set(null)
  }, [projectId])
  // The rail's own sections carry their headers and add buttons; the sheet
  // adds nothing above them.
  return (
    <Sheet id="projects" className="sheet--projects" label="Projects" keepOpen={state.railExpanded !== null}>
      <div className="sheet__rail">
        <RailStack />
      </div>
    </Sheet>
  )
}

