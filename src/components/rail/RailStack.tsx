import { useEffect, type ReactNode } from 'react'
import { RAIL_SECTION_MIN_H } from '@shared/rail'
import type { RailSectionId } from '@shared/types'
import { isOpen, showsDiscoveryHint, toggleOpen, visibleSections } from '@/lib/railstack'
import { useApp } from '@/state/AppState'
import { Icon, type IconName } from '../Icon'
import { ProjectRail } from '../ProjectRail'
import { TasksPanel } from '../tasks/TasksPanel'
import { RailSection } from './RailSection'
import { GitSection } from './GitSection'
import { ActivitySection } from './ActivitySection'
import { ShareSection } from './ShareSection'
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

  /*
   * A section that has just been switched off in Appearance cannot go on being
   * the expanded one. The panel is drawn by the section itself, so it vanishes
   * with it either way — this is about the flag, which would otherwise re-open
   * the panel the moment the section came back.
   */
  useEffect(() => {
    if (!state.railExpanded) return
    if (sections.includes(state.railExpanded)) return
    actions.setRailExpanded(null)
  }, [state.railExpanded, sections])

  /* ------------------------------------------------------------- collapsed */

  if (collapsed) {
    return (
      <div className="rstack rstack--collapsed">
        {sections.map((id) => (
          <CollapsedSection key={id} id={id} />
        ))}

        {/*
          A panel that is open stays open when the rail is collapsed — collapsing
          the rail is how you make room for the terminals, and taking the thing
          you were reading away as a side effect would be a strange way to
          answer that. The section is mounted hidden purely so it still exists;
          what you see is its body, portalled into the panel, which is in
          document.body and so is not hidden by this.
        */}
        {state.railExpanded ? (
          <div className="rstack__ghost" aria-hidden="true">
            <StackedSection id={state.railExpanded} />
          </div>
        ) : null}
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
        The optional sections are off out of the box, which would otherwise make
        the whole feature invisible to anyone who never opens Appearance. One 24px
        row, and it goes for good the moment any of them is on — a hint that keeps
        hinting after it has been taken is just nagging.
      */}
      {showsDiscoveryHint(state.settings) ? (
        <button
          type="button"
          className="ghost-btn rstack__more"
          title="Add the Git, Activity and Share sections to the rail"
          onClick={() => actions.openSettings('appearance')}
        >
          <Icon name="plus" size={11} />
          <span>Git · Activity · Share</span>
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
    case 'share':
      return <ShareSection />
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
 * and worse. The later ones get a glyph each and follow the same vocabulary.
 */

/**
 * A lookup rather than a pair of ternaries on `id === 'git'`, which is what this
 * was and which quietly drew every section that was not git as "Activity" with a
 * history glyph. An id with no entry here draws no pip at all, which is the right
 * answer for a section that has not chosen one yet.
 */
const COLLAPSED: Partial<Record<RailSectionId, { label: string; icon: IconName }>> = {
  git: { label: 'Git', icon: 'branch' },
  activity: { label: 'Activity', icon: 'history' },
  share: { label: 'Share', icon: 'note' }
}

function CollapsedSection({ id }: { id: RailSectionId }): ReactNode {
  const { state, actions } = useApp()

  /*
   * Projects and Tasks draw their own collapsed forms — ProjectRail's dot column
   * is the rail when it is narrow, and it would be strange for it to become a
   * button that reveals itself. They render as they always have.
   */
  if (id === 'projects') return <ProjectRail />
  if (id === 'tasks') return <TasksPanel />

  const pip = COLLAPSED[id]
  if (!pip) return null

  const open = (): void => {
    actions.patchSettings({
      railCollapsed: false,
      railOpen: isOpen(state.settings, id) ? state.settings.railOpen : toggleOpen(state.settings.railOpen, id)
    })
  }

  return (
    <button
      type="button"
      className="rstack__pip"
      data-id={id}
      title={`${pip.label} — open the rail to see it`}
      aria-label={`Open ${pip.label}`}
      onClick={open}
    >
      <Icon name={pip.icon} size={15} />
    </button>
  )
}

export { RailSection }
