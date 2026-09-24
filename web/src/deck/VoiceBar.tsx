import { useEffect, useRef, type CSSProperties, type ReactNode } from 'react'
import { Icon } from '@/components/Icon'
import { Rail } from '../components/Rail'
import { useActiveProject, useForge } from '../state'
import { useDeckAgents } from './agents'
import { composerField, composerOpen, focusedField, openComposer } from './composer'
import { cancelRawDictation, rawDictationSupported, toggleRawDictation, useRawDictation, type RawTarget } from './dictation'
import { DeckSheet, deckSheet, useDeckSheet } from './sheet'
import type { BarPlace, DeckView } from './view'

/**
 * The voice bar: the project you are in, D — and, in the top bar, Type. One
 * group, drawn in the top bar or leading the dock at the bottom edge (the
 * default); the "…" menu says where it is in a word and moves it.
 */
export function VoiceBar({ place }: { place: BarPlace }): ReactNode {
  return (
    <div className="dk-voicebar" data-voicebar="true" data-place={place}>
      <span className="dk-voicebar__project">
        <ProjectPill place={place} />
        {place === 'top' ? <ProjectsSheet /> : null}
      </span>
      <DictateButton />
      {place === 'top' ? <TypeButton /> : null}
    </div>
  )
}

/* ---------------------------------------------------------------- project */

/** The project you are in, as the bar's first word; opens the projects sheet. */
export function ProjectPill({ place }: { place: BarPlace }): ReactNode {
  const project = useActiveProject()
  const open = useDeckSheet() === 'projects'
  return (
    <button
      type="button"
      className="dk-project"
      data-open={open ? 'true' : undefined}
      data-place={place}
      data-sheet-toggle="projects"
      aria-expanded={open}
      aria-haspopup="dialog"
      title="Projects — switch, add, git"
      style={{ '--project': project?.color ?? 'var(--accent)' } as CSSProperties}
      onMouseDown={(e) => e.preventDefault()}
      onClick={() => deckSheet.toggle('projects')}
    >
      <span className="dk-project__dot" aria-hidden="true" />
      <span className="dk-project__name truncate">{project?.name ?? 'No project'}</span>
      <Icon name="chevronDown" size={11} className="dk-project__chev" />
    </button>
  )
}

/**
 * Every project — Dock.tsx's ProjectSheet, holding this page's own rail
 * (projects, Add project, git) at full width. It drops from the pill in the
 * top bar and rises from it in the dock. Picking a project is the end of the
 * errand: the sheet goes.
 */
export function ProjectsSheet(): ReactNode {
  const { state } = useForge()
  const projectId = state.projectId
  const last = useRef(projectId)
  useEffect(() => {
    if (last.current === projectId) return
    last.current = projectId
    if (deckSheet.get() === 'projects') deckSheet.set(null)
  }, [projectId])
  return (
    <DeckSheet id="projects" className="dk-sheet--projects" label="Projects">
      <div className="dk-sheet__rail">
        <Rail collapsed={false} />
      </div>
    </DeckSheet>
  )
}

/* -------------------------------------------------------------------- D */

/** Who D's words are filed under: the pane the bar talks to, while the link is up. */
function useRawTarget(): RawTarget | null {
  const { state, actions } = useForge()
  const { current } = useDeckAgents()
  const live = state.stage.kind === 'connected' && state.connection.state === 'live'
  if (!live || !current || !rawDictationSupported()) return null
  return { paneId: current.leaf.id, request: actions.request, notice: actions.setNotice }
}

/**
 * Press D. With no text field holding the keyboard, the composer comes up
 * first, so the words have somewhere to be seen arriving.
 */
function pressD(target: RawTarget | null, phase: ReturnType<typeof useRawDictation>): void {
  if (phase === 'idle' && target && !focusedField()) openComposer()
  toggleRawDictation(target)
}

export const D_SHORTCUT = 'Right Ctrl'

/**
 * D: dictation, raw — the words are typed where the caret is (or into the
 * composer), never sent. Its own tint, apart from the accent, and every
 * state in a shape and a word: the letter at rest, a stop square and
 * "Listening" while the microphone is open, a turning arc and "…" while the
 * desktop writes it down.
 */
function DictateButton(): ReactNode {
  const phase = useRawDictation()
  const target = useRawTarget()
  const supported = rawDictationSupported()
  const busy = phase !== 'idle'
  const title = !supported
    ? 'Dictate — this browser cannot record audio here (it needs a secure page and a microphone).'
    : !target && !busy
      ? 'Dictate — needs a live link and an agent to file the words under.'
      : phase === 'recording'
        ? `Listening. Press again (or tap ${D_SHORTCUT}) to stop — the words are typed, never sent.`
        : phase === 'starting'
          ? 'Opening the microphone…'
          : phase === 'transcribing'
            ? 'The desktop is writing it down…'
            : `Dictate (${D_SHORTCUT}) — talk, press again, and the words are typed where the caret is, never sent.`
  return (
    <button
      type="button"
      className="dk-dictate"
      data-phase={phase}
      aria-label={phase === 'recording' ? 'Dictate: listening. Stop' : phase === 'idle' ? 'Dictate' : 'Dictate: writing it down'}
      aria-pressed={phase === 'recording'}
      title={title}
      disabled={!busy && !target}
      onMouseDown={(e) => e.preventDefault()}
      onClick={() => pressD(target, phase)}
    >
      {phase === 'recording' ? (
        <>
          <span className="dk-dictate__stop" aria-hidden="true" />
          <span className="dk-dictate__word">Listening</span>
        </>
      ) : phase === 'idle' ? (
        <span className="dk-dictate__letter" aria-hidden="true">
          D
        </span>
      ) : (
        <>
          <svg className="dk-dictate__spin" width="11" height="11" viewBox="0 0 12 12" aria-hidden="true">
            <path d="M6 1.5 A4.5 4.5 0 1 1 1.5 6" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
          </svg>
          <span className="dk-dictate__word" aria-hidden="true">
            …
          </span>
        </>
      )}
    </button>
  )
}

export const COMPOSER_SHORTCUT = 'Ctrl+Shift+G'

/** Type: bring the floating composer up and put the caret in it. Top bar only. */
function TypeButton(): ReactNode {
  const open = composerOpen.use()
  return (
    <button
      type="button"
      className="dk-bar__icon dk-type"
      data-on={open ? 'true' : undefined}
      aria-label="Type"
      title={`Type to the agent on screen (${COMPOSER_SHORTCUT})`}
      onMouseDown={(e) => e.preventDefault()}
      onClick={() => toggleComposer()}
    >
      <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden="true">
        <rect x="1.8" y="4" width="12.4" height="8" rx="1.6" />
        <path d="M4.4 6.6h.01M6.8 6.6h.01M9.2 6.6h.01M11.6 6.6h.01M5.4 9.4h5.2" strokeLinecap="round" />
      </svg>
    </button>
  )
}

/**
 * The composer, asked for: up and focused; already focused and empty, put
 * away again; up but not focused, focused.
 */
export function toggleComposer(): void {
  const field = composerField()
  const up = composerOpen.get()
  if (up && field && document.activeElement === field && !field.value.trim()) {
    composerOpen.set(false)
    field.blur()
    return
  }
  openComposer()
}

/* ------------------------------------------------------------------- keys */

/**
 * The deck face's keyboard, from anywhere — including a terminal that has the
 * keys, which is the point of each of them:
 *
 *   Right Ctrl, tapped alone   D (the desktop's dictation key)
 *   Ctrl+Shift+G               the composer (the desktop's voice card key)
 *   Ctrl+G                     the Wall, on or off (the desktop's mosaic key)
 *
 * Right Ctrl only counts as a tap: pressed and released with no other key and
 * no click between, so Right Ctrl+C is still Ctrl+C.
 */
export function DeckKeys({
  view,
  onView,
  place
}: {
  view: DeckView
  onView: (view: DeckView) => void
  place: BarPlace
}): ReactNode {
  const target = useRawTarget()
  const phase = useRawDictation()
  const latest = useRef({ target, phase, view, onView, place })
  latest.current = { target, phase, view, onView, place }

  useEffect(() => {
    let armed = false
    const onDown = (e: KeyboardEvent): void => {
      if (e.code === 'ControlRight') {
        armed = !e.repeat && !e.shiftKey && !e.altKey && !e.metaKey
        return
      }
      armed = false
      if (!e.ctrlKey || e.altKey || e.metaKey || e.code !== 'KeyG') return
      e.preventDefault()
      e.stopPropagation()
      if (e.repeat) return
      const now = latest.current
      if (e.shiftKey) {
        if (now.place === 'top') toggleComposer()
        else composerField()?.focus()
      } else {
        now.onView(now.view === 'wall' ? 'focus' : 'wall')
      }
    }
    const onUp = (e: KeyboardEvent): void => {
      if (e.code !== 'ControlRight') return
      const tapped = armed
      armed = false
      if (!tapped) return
      const now = latest.current
      pressD(now.target, now.phase)
    }
    const disarm = (): void => {
      armed = false
    }
    window.addEventListener('keydown', onDown, true)
    window.addEventListener('keyup', onUp, true)
    window.addEventListener('pointerdown', disarm, true)
    window.addEventListener('blur', disarm)
    return () => {
      window.removeEventListener('keydown', onDown, true)
      window.removeEventListener('keyup', onUp, true)
      window.removeEventListener('pointerdown', disarm, true)
      window.removeEventListener('blur', disarm)
    }
  }, [])

  // Leaving the deck face (a window narrowed to a phone's) closes the microphone.
  useEffect(() => () => cancelRawDictation(), [])

  return null
}
