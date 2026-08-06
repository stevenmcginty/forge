import { useEffect, type ReactNode } from 'react'
import { RAIL_SECTION_MIN_H } from '@shared/rail'
import type { RailSectionId } from '@shared/types'
import { isOpen, showsDiscoveryHint, toggleOpen, visibleSections } from '@/lib/railstack'
import { useApp } from '@/state/AppState'
import { Icon } from '../Icon'
import { ProjectRail } from '../ProjectRail'
import { TasksPanel } from '../tasks/TasksPanel'
import { RailSection } from './RailSection'
import { GitSection } from './GitSection'
import { ActivitySection } from './ActivitySection'
import './RailStack.css'

/** The tasks dock's old localStorage height, folded into settings once. */
const LEGACY_DOCK_KEY = 'forge:tasksDockHeight'

/**
 * The left rail, as a stack of sections.
 *
 * App.tsx used to hard-code the two things this replaces — `<ProjectRail/>` then
 * `<TasksPanel/>` — which was fine while there were two of them and stopped
 * being fine at four. Order, which sections exist, which are open and how tall
 * each one is are now all answers this component looks up rather than facts
 * spread across four files.
 *
 * `<ScreenshotTray/>` and `<AccountChip/>` deliberately stay outside, below this
 * in App.tsx. The shelf is not scoped to a project and the account chip is not
 * scoped to anything, so neither belongs in a stack whose whole premise is "this
 * is about the project you have selected".
 */
export function RailStack(): ReactNode {
  const { state, actions } = useApp()
  const collapsed = state.settings.railCollapsed
  const sections = visibleSections(state.settings)

  /*
   * -------------------------------------------------------------- migration
   *
   * The dock's height used to live in localStorage under its own key, set by a
   * drag handle TasksPanel owned. It lives in Settings now, with the other three
   * sections' heights. Without this, everyone who has ever dragged the dock
   * taller gets it silently reset to the default on the update that ships this —
   * a small thing, but the kind of small thing that reads as the app forgetting.
   *
   * Runs once, only when Settings has no height of its own to contradict. The
   * old key is left alone rather than deleted: it costs nothing, and removing it
   * would make rolling back to a previous build lose the height a second time.
   */
  useEffect(() => {
    if (!state.ready) return
    if (state.settings.railHeights.tasks !== undefined) return
    const raw = Number(localStorage.getItem(LEGACY_DOCK_KEY))
    if (!Number.isFinite(raw) || raw < RAIL_SECTION_MIN_H) return
    actions.setRailHeight('tasks', raw)
  }, [state.ready])

  /* ------------------------------------------------------------- collapsed */

  if (collapsed) {
    return (
      <div className="rstack rstack--collapsed">
        {sections.map((id) => (
          <CollapsedSection key={id} id={id} />
        ))}
      </div>
    )
  }

  /* ------------------------------------------------------------------ open */

  return (
    <div className="rstack">
      {sections.map((id) => (
        <StackedSection key={id} id={id} />
      ))}

      {/*
        Both new sections are off out of the box, which would otherwise make the
        whole feature invisible to anyone who never opens Appearance. One 24px
        row, and it goes for good the moment either is on — a hint that keeps
        hinting after it has been taken is just nagging.
      */}
      {showsDiscoveryHint(state.settings) ? (
        <button
          type="button"
          className="ghost-btn rstack__more"
          title="Add the Git and Activity sections to the rail"
          onClick={() => actions.openSettings('appearance')}
        >
          <Icon name="plus" size={11} />
          <span>Git · Activity</span>
        </button>
      ) : null}
    </div>
  )
}

/* -------------------------------------------------------------- one section */

function StackedSection({ id }: { id: RailSectionId }): ReactNode {
  switch (id) {
    case 'projects':
      return <ProjectRail />
    case 'tasks':
      return <TasksPanel />
    case 'git':
      return <GitSection />
    case 'activity':
      return <ActivitySection />
    default:
      return null
  }
}

/* ------------------------------------------------------------- the 56px rail
 *
 * Collapsed, a section is one button: it opens the rail and opens itself. The
 * two original sections keep the marks they have always had — the project dots
 * with their working rings, the tasks pip with its count — because those are
 * already learned, and swapping them for a uniform icon strip would be tidier
 * and worse. The two new ones get a glyph each and follow the same vocabulary.
 */

function CollapsedSection({ id }: { id: RailSectionId }): ReactNode {
  const { state, actions } = useApp()

  /*
   * Projects and Tasks draw their own collapsed forms — ProjectRail's dot column
   * is the rail when it is narrow, and it would be strange for it to become a
   * button that reveals itself. They render as they always have.
   */
  if (id === 'projects') return <ProjectRail />
  if (id === 'tasks') return <TasksPanel />

  const open = (): void => {
    actions.patchSettings({
      railCollapsed: false,
      railOpen: isOpen(state.settings, id) ? state.settings.railOpen : toggleOpen(state.settings.railOpen, id)
    })
  }

  const label = id === 'git' ? 'Git' : 'Activity'

  return (
    <button
      type="button"
      className="rstack__pip"
      data-id={id}
      title={`${label} — open the rail to see it`}
      aria-label={`Open ${label}`}
      onClick={open}
    >
      <Icon name={id === 'git' ? 'branch' : 'history'} size={15} />
    </button>
  )
}

export { RailSection }
