import { useEffect, useRef, type ReactNode } from 'react'
import { shellSheet, useShellSheet } from '@/lib/shellSlots'
import { useUiCommand } from '@/lib/uiCommands'
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
 * It lives in one place: clipped to the deck's bottom edge, floating. (It used
 * to be able to sit in the top bar too; the top bar is Forge Brain's now, and
 * Steve wants the voice bar fixed at the bottom.) The project sheet rises out
 * of it. The panes switcher is the top bar's Agents menu.
 */
export function Dock(): ReactNode {
  const project = useActiveProject()
  return (
    <div className="dock" role="toolbar" aria-label="Voice bar">
      {project ? (
        <Composer lead={<ProjectPill />} />
      ) : (
        <div className="dock__composer dock__composer--idle">
          <ProjectPill />
          Add a project to start
        </div>
      )}
      <ProjectSheet />
    </div>
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

