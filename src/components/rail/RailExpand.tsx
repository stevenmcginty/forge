import { useEffect, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import type { RailSectionId } from '@shared/types'
import { shortPath } from '@/lib/paths'
import { useActiveProject, useApp } from '@/state/AppState'
import { Icon } from '../Icon'
import './RailExpand.css'

/**
 * A rail section, blown up into a panel over the app.
 *
 * The panel deliberately owns no data of its own. Git and Activity render this
 * and portal *their own body* into it, so there is exactly one instance of each
 * section alive at any moment — one git watch, one activity watch, one snapshot,
 * one set of hooks. Expanding is a change of where the body is drawn and nothing
 * else, which is why it cannot drift out of step with the rail and why closing
 * it costs no refetch.
 *
 * The header names the project on purpose. The whole premise of the rail stack
 * is "this is about the project you have selected", and that premise is easy to
 * read in a 240px rail sitting under the project list and easy to lose in a
 * panel floating over ten projects' worth of terminals. So the panel says whose
 * files these are, every time, and follows the selection if it changes while it
 * is open.
 *
 * Escape closes, and so does the scrim. Neither is destructive — there is
 * nothing to lose here but a view — so no confirmation, and the section is
 * exactly where it was when it goes back to the rail.
 */
export function RailExpand({
  id,
  title,
  hint,
  status,
  actions,
  children
}: {
  id: RailSectionId
  title: string
  /** One quiet line under the title saying what the panel is for. */
  hint?: string
  /** The section's live signal — a branch name, a count. */
  status?: ReactNode
  /** The section's own header buttons, moved here while it is expanded. */
  actions?: ReactNode
  children: ReactNode
}): ReactNode {
  const { actions: appActions } = useApp()
  const project = useActiveProject()

  const close = (): void => appActions.setRailExpanded(null)

  /*
   * Escape closes the panel — but only when it is not the terminal's Escape or a
   * popover's. A section's popover (the git hand-off menu) is opened from inside
   * this panel and registers its own handler after ours, so stepping aside when
   * one is on screen is what keeps the two from closing together.
   */
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape' || e.ctrlKey || e.altKey || e.metaKey) return
      if (document.querySelector('.popover')) return
      e.preventDefault()
      e.stopPropagation()
      close()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  return createPortal(
    <div className="rexp" data-id={id} onPointerDown={(e) => e.target === e.currentTarget && close()}>
      <section
        className="rexp__panel"
        role="dialog"
        aria-modal="true"
        aria-label={`${title}${project ? ` — ${project.name}` : ''}`}
      >
        <header className="rexp__head">
          <div className="rexp__what">
            <h2 className="rexp__title">{title}</h2>
            {/*
              Not decoration: this is the answer to "which of my ten projects am
              I looking at". The path is the tooltip rather than a second line —
              two folders can share a name, and that is exactly when you need it.
            */}
            {project ? (
              <span className="rexp__project truncate" title={project.path}>
                {project.name}
                <span className="rexp__path mono">{shortPath(project.path)}</span>
              </span>
            ) : (
              <span className="rexp__project">No project selected</span>
            )}
          </div>

          {status ? <div className="rexp__status">{status}</div> : null}

          <div className="rexp__actions">
            {actions}
            <button type="button" className="ghost-btn" title="Back to the rail (Esc)" onClick={close}>
              <Icon name="close" size={14} />
            </button>
          </div>
        </header>

        {hint ? <p className="rexp__hint">{hint}</p> : null}

        <div className="rexp__body">{children}</div>
      </section>
    </div>,
    document.body
  )
}
