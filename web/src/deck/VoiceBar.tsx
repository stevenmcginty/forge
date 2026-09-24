import { useEffect, useRef, type CSSProperties, type ReactNode } from 'react'
import { Icon } from '@/components/Icon'
import '@/components/hub/VoicePill.css'
import { Rail } from '../components/Rail'
import { useActiveProject, useForge } from '../state'
import { useDeckAgents } from './agents'
import { composerField, composerOpen, focusedField, openComposer } from './composer'
import { useDictationSeat } from '../lib/dictation-seat'
import {
  cancelDeckDictation,
  deckDictationPhase,
  deckDictationSupported,
  toggleDeckDictation,
  undoDeckDictation,
  useDeckDictation,
  type DeckDictationPhase
} from './dictation'
import { DeckSheet, deckSheet, useDeckSheet } from './sheet'
import type { BarPlace, DeckView } from './view'
import { holdWebVoiceMic, setVoiceLink, stopWebVoice, toggleWebVoice, useWebVoice, webVoiceSupported } from './voiceAgent'
import { voicePhaseWord, type WebVoicePhase } from './voice-words'

/**
 * The voice bar: the project you are in, Listen, D — and, in the top bar,
 * Type. One group, drawn in the top bar or leading the dock at the bottom edge
 * (the default); the "…" menu says where it is in a word and moves it.
 */
export function VoiceBar({ place }: { place: BarPlace }): ReactNode {
  return (
    <div className="dk-voicebar" data-voicebar="true" data-place={place}>
      <span className="dk-voicebar__project">
        <ProjectPill place={place} />
        {place === 'top' ? <ProjectsSheet /> : null}
      </span>
      <ListenSwitch />
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

/* ---------------------------------------------------------------- Listen */

const BRAIN = 'Gemini Live'

type Look = 'offline' | 'connecting' | 'listening' | 'thinking' | 'speaking' | 'muted' | 'error'

/** VoicePill.css's looks and knob marks, one per phase: a shape and a word, colour only agreeing. */
function lookOf(phase: WebVoicePhase, muted: boolean): { look: Look; mark: string } {
  switch (phase) {
    case 'off':
      return { look: 'offline', mark: 'offline' }
    case 'connecting':
      return { look: 'connecting', mark: 'connecting' }
    case 'listening':
      return muted ? { look: 'muted', mark: 'muted' } : { look: 'listening', mark: 'listening' }
    case 'thinking':
      return { look: 'thinking', mark: 'thinking' }
    case 'speaking':
      return { look: 'speaking', mark: 'speaking' }
    case 'error':
      return { look: 'error', mark: 'error' }
  }
}

/**
 * Listen: the desktop's main voice agent, talking through this browser
 * (./voiceAgent.ts). One press opens a hands-free conversation — a pause sends
 * the turn, the reply is spoken, it listens again by itself — and a second
 * press, "that's all", or quiet closes it. VoicePill.css's switch, imported
 * rather than copied, with the phase as its word and a failure as one line
 * beside it.
 */
function ListenSwitch(): ReactNode {
  const voice = useWebVoice()
  const { state } = useForge()
  const live = state.stage.kind === 'connected' && state.connection.state === 'live'
  const supported = webVoiceSupported()
  const on = voice.phase !== 'off' && voice.phase !== 'error'
  const { look, mark } = lookOf(voice.phase, voice.muted)
  const word = voicePhaseWord(voice.phase, voice.muted)
  const failed = voice.phase === 'error'
  const said = `${BRAIN} · ${word}`
  const title = !supported
    ? 'Listen — this browser cannot run the voice agent here (it needs a secure page and a microphone).'
    : !live && !on
      ? 'Listen — needs a live link to the desktop.'
      : failed
        ? `${said}: ${voice.error ?? 'no more detail'}. Click to try again.`
        : on
          ? `${said}. Talk; a pause sends it. Click (or say "that's all") to stop.`
          : `${said}${voice.ended ? ` — ${voice.ended}` : ''}. Click to talk to the voice agent, hands-free.`
  return (
    <span
      className="listen dk-listen"
      data-on={on ? 'true' : undefined}
      data-look={look}
      data-mark={mark}
      data-recording={voice.phase === 'listening' && !voice.muted ? 'true' : undefined}
    >
      <button
        type="button"
        role="switch"
        aria-checked={on}
        className="listen__btn"
        title={title}
        aria-label={`Listen: ${on ? 'on' : 'off'} — ${said}`}
        disabled={!supported || (!live && !on && !failed)}
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => toggleWebVoice()}
      >
        <span className="listen__track" aria-hidden="true">
          <span className="listen__knob" />
        </span>
        <span className="listen__text">
          <span className="listen__brain">{BRAIN}</span>
          <span className="listen__word">
            <span className="listen__word-text">{word}</span>
          </span>
        </span>
      </button>
      {failed && voice.error ? (
        <span className="dk-listen__error" role="status" title={voice.error}>
          {voice.error}
        </span>
      ) : null}
    </span>
  )
}

/* -------------------------------------------------------------------- D */

/**
 * Whether D may start: a live link, an agent on screen for the words to go to
 * (the pane the bar talks to), and the composer that runs the dictation.
 */
function useCanDictate(): boolean {
  const { state } = useForge()
  const { current } = useDeckAgents()
  const seat = useDictationSeat()
  const live = state.stage.kind === 'connected' && state.connection.state === 'live'
  return live && !!current && !!seat && deckDictationSupported()
}

/**
 * Press D. The composer comes up first — the words, the countdown and Undo
 * are seen there — and takes the keyboard when no other text field has it.
 */
function pressD(canStart: boolean, phase: DeckDictationPhase): void {
  if ((phase === 'idle' || phase === 'review') && canStart) {
    if (focusedField()) composerOpen.set(true)
    else openComposer()
  }
  toggleDeckDictation(canStart)
}

export const D_SHORTCUT = 'Right Ctrl'

/**
 * D: the phone's dictation — the words go to the agent on screen: spoken
 * commands act, anything else waits in the composer with a countdown and
 * Undo, then sends. Its own tint, apart from the accent, and every state in a
 * shape and a word: the letter at rest, a stop square and "Listening" while
 * the microphone is open, a turning arc and "…" while the desktop writes it
 * down, an arrow and "Sending" while the words wait to go.
 */
function DictateButton(): ReactNode {
  const phase = useDeckDictation()
  const canStart = useCanDictate()
  const supported = deckDictationSupported()
  const busy = phase !== 'idle' && phase !== 'review'
  const title = !supported
    ? 'Dictate — this browser cannot record audio here (it needs a secure page and a microphone).'
    : !canStart && !busy
      ? 'Dictate — needs a live link and an agent to send the words to.'
      : phase === 'recording'
        ? `Listening. Press again (or tap ${D_SHORTCUT}) to stop — then the words wait a moment with Undo, and send.`
        : phase === 'starting'
          ? 'Opening the microphone…'
          : phase === 'transcribing'
            ? 'The desktop is writing it down…'
            : phase === 'review'
              ? 'Sending in a moment — Undo (or Esc) keeps the words to edit. Press to add more.'
              : `Dictate (${D_SHORTCUT}) — talk, press again; commands like "stop" act, other words send after a moment with Undo.`
  return (
    <button
      type="button"
      className="dk-dictate"
      data-phase={phase}
      aria-label={
        phase === 'recording'
          ? 'Dictate: listening. Stop'
          : phase === 'idle'
            ? 'Dictate'
            : phase === 'review'
              ? 'Dictate: sending in a moment. Add more'
              : 'Dictate: writing it down'
      }
      aria-pressed={phase === 'recording'}
      title={title}
      disabled={!busy && !canStart}
      onMouseDown={(e) => e.preventDefault()}
      onClick={() => pressD(canStart, phase)}
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
      ) : phase === 'review' ? (
        <>
          <svg width="11" height="11" viewBox="0 0 12 12" aria-hidden="true">
            <path d="M2 6h7.5M6.5 3l3 3-3 3" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          <span className="dk-dictate__word" aria-hidden="true">
            Sending
          </span>
        </>
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
 *   Esc, while words wait      Undo the dictation's send
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
  const canStart = useCanDictate()
  const phase = useDeckDictation()
  const latest = useRef({ canStart, phase, view, onView, place })
  latest.current = { canStart, phase, view, onView, place }

  // Listen's link to the desktop, handed over whenever it changes (a reconnect
  // may replace it), and its mic held shut while D records and the desktop
  // writes it down (V5).
  const { actions } = useForge()
  const request = actions.request
  useEffect(() => setVoiceLink({ request }), [request])
  const dictating = phase === 'starting' || phase === 'recording' || phase === 'transcribing'
  useEffect(() => holdWebVoiceMic(dictating), [dictating])

  useEffect(() => {
    let armed = false
    const onDown = (e: KeyboardEvent): void => {
      if (e.code === 'ControlRight') {
        armed = !e.repeat && !e.shiftKey && !e.altKey && !e.metaKey
        return
      }
      armed = false
      // Esc, from anywhere, while dictated words wait to send: Undo.
      if (e.key === 'Escape' && deckDictationPhase() === 'review') {
        e.preventDefault()
        e.stopPropagation()
        undoDeckDictation()
        return
      }
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
      pressD(now.canStart, now.phase)
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
  useEffect(
    () => () => {
      cancelDeckDictation()
      stopWebVoice()
      setVoiceLink(null)
    },
    []
  )

  return null
}
