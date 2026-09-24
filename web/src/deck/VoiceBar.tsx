import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { AgentBadge } from '@/components/AgentBadge'
import { Icon } from '@/components/Icon'
import '@/components/hub/VoicePill.css'
import { usePresence } from '@/lib/motion'
import { Rail } from '../components/Rail'
import { useActiveProject, useForge } from '../state'
import { AgentStateChip, useDeckAgents } from './agents'
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
import {
  holdWebVoiceMic,
  setVoiceLink,
  stopWebVoice,
  toggleWebVoice,
  useWebVoice,
  webVoiceSupported,
  type WebVoiceState
} from './voiceAgent'
import { actionStatusWord, voiceHint, voicePhaseWord, type WebVoicePhase } from './voice-words'

/**
 * The voice bar: the project you are in, Listen, D — and, in the top bar,
 * Type. One group, drawn in the top bar or leading the dock at the bottom edge
 * (the default); the "…" menu says where it is in a word and moves it.
 *
 * How it looks is ./voicebar.css (imported by ./Deck.tsx after deck.css, so it
 * has the last word): AAA ink, 44px targets, and the voice line.
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
      {place === 'top' ? <VoiceLine place="top" /> : null}
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
      aria-label={`Project: ${project?.name ?? 'none'}. Switch, add, git`}
      title="Projects — switch, add, git"
      style={{ '--project': project?.color ?? 'var(--accent)' } as CSSProperties}
      onMouseDown={(e) => e.preventDefault()}
      onClick={() => deckSheet.toggle('projects')}
    >
      <span className="dk-project__dot" aria-hidden="true" />
      <span className="dk-project__name truncate">{project?.name ?? 'No project'}</span>
      <Icon name="chevronDown" size={12} className="dk-project__chev" />
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

/** The link to the desktop is up. Listen, D and the voice line all ask. */
function useLive(): boolean {
  const { state } = useForge()
  return state.stage.kind === 'connected' && state.connection.state === 'live'
}

/**
 * Listen: the desktop's main voice agent, talking through this browser
 * (./voiceAgent.ts). One press opens a hands-free conversation — a pause sends
 * the turn, the reply is spoken, it listens again by itself — and a second
 * press, "that's all", or quiet closes it. VoicePill.css's switch, imported
 * rather than copied, with the phase as its word. When it cannot start, the
 * word says why ("No link", "Not here") instead of the switch only greying
 * out. A failure's sentence is on the voice line (VoiceLine), not squeezed in
 * beside the switch.
 */
function ListenSwitch(): ReactNode {
  const voice = useWebVoice()
  const live = useLive()
  const supported = webVoiceSupported()
  const on = voice.phase !== 'off' && voice.phase !== 'error'
  const failed = voice.phase === 'error'
  const { look, mark } = lookOf(voice.phase, voice.muted)
  const blocked = !supported ? 'Not here' : !live && !on && !failed ? 'No link' : null
  const word = blocked ?? voicePhaseWord(voice.phase, voice.muted)
  const said = `${BRAIN} · ${word}`
  const title = !supported
    ? 'Listen — this browser cannot run the voice agent here (it needs a secure page and a microphone).'
    : blocked
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
      data-blocked={blocked ? 'true' : undefined}
      data-recording={voice.phase === 'listening' && !voice.muted ? 'true' : undefined}
    >
      <button
        type="button"
        role="switch"
        aria-checked={on}
        className="listen__btn"
        title={title}
        aria-label={`Listen, ${BRAIN}: ${word}`}
        disabled={!!blocked}
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => toggleWebVoice()}
      >
        <span className="listen__track" aria-hidden="true">
          <span className="listen__knob" />
        </span>
        <span className="listen__text">
          <span className="listen__brain">{BRAIN}</span>
          <span className="listen__word">
            {/* Keyed on the word, so a new phase rolls in rather than swapping in place. */}
            <span key={word} className="listen__word-text">
              {word}
            </span>
          </span>
        </span>
        <LiveWave look={look} />
      </button>
    </span>
  )
}

/**
 * Four bars beside the phase word while the conversation is live: breathing
 * while it listens, a light running across them while it thinks, lively while
 * it speaks. Absent at rest. Under reduced motion the bars keep their shape and
 * lose the movement.
 */
function LiveWave({ look }: { look: Look }): ReactNode {
  if (look !== 'listening' && look !== 'thinking' && look !== 'speaking') return null
  return (
    <span className="dk-wave" data-look={look} aria-hidden="true">
      <i />
      <i />
      <i />
      <i />
    </span>
  )
}

/* -------------------------------------------------------------- voice line */

/** How long "Conversation ended — …" stays on the line before it settles back. */
const ENDED_SHOW_MS = 6000
/** The longest caption tail the line carries: the newest words matter most. */
const CAPTION_TAIL = 160

type LineTone = 'live' | 'failed' | 'ended'
type LineGlyph = 'you' | 'agent' | 'wait' | 'failed' | 'ended'

interface LineContent {
  tone: LineTone
  glyph: LineGlyph
  word: string
  text: string
  action: WebVoiceState['lastAction']
  /** What a screen reader is told, politely: the phase, or the failure. */
  announce: string
}

function tail(text: string): string {
  return text.length > CAPTION_TAIL ? `…${text.slice(-CAPTION_TAIL).trimStart()}` : text
}

function lineOf(voice: WebVoiceState, endedShown: boolean): LineContent | null {
  const phaseWord = voicePhaseWord(voice.phase, voice.muted)
  const action = voice.lastAction
  if (voice.phase === 'error') {
    const reason = voice.error ?? 'The voice agent stopped.'
    return { tone: 'failed', glyph: 'failed', word: 'Failed', text: reason, action, announce: `${BRAIN} failed: ${reason}` }
  }
  if (voice.phase === 'off') {
    if (!endedShown || !voice.ended) return null
    const why = voice.ended.replace(/^Conversation ended\s*[—-]\s*/, '')
    return { tone: 'ended', glyph: 'ended', word: 'Ended', text: why, action, announce: voice.ended }
  }
  const announce = `${BRAIN}: ${phaseWord}`
  if (voice.caption && voice.phase !== 'connecting') {
    const you = voice.caption.role === 'user'
    return { tone: 'live', glyph: you ? 'you' : 'agent', word: you ? 'You' : 'Gemini', text: tail(voice.caption.text), action, announce }
  }
  const waiting = voice.phase === 'connecting' || voice.phase === 'thinking'
  return {
    tone: 'live',
    glyph: waiting ? 'wait' : voice.phase === 'speaking' ? 'agent' : 'you',
    word: phaseWord,
    text: voiceHint(voice.phase, voice.muted),
    action,
    announce
  }
}

/** The lead's shape: a dot is you, a play mark the agent, a diamond waiting, a triangle a failure, a square the end. */
function LineGlyphMark({ glyph }: { glyph: LineGlyph }): ReactNode {
  return (
    <svg className="dk-vline__glyph" width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
      {glyph === 'you' ? <circle cx="5" cy="5" r="3.2" fill="currentColor" /> : null}
      {glyph === 'agent' ? <path d="M2.6 1.6 L8.4 5 L2.6 8.4 Z" fill="currentColor" /> : null}
      {glyph === 'wait' ? <path d="M5 1 L9 5 L5 9 L1 5 Z" fill="none" stroke="currentColor" strokeWidth="1.4" /> : null}
      {glyph === 'ended' ? (
        <rect x="1.8" y="1.8" width="6.4" height="6.4" rx="1.2" fill="none" stroke="currentColor" strokeWidth="1.4" />
      ) : null}
      {glyph === 'failed' ? (
        <>
          <path d="M5 0.9 L9.3 8.7 H0.7 Z" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
          <path d="M5 3.8 V5.9" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
          <circle cx="5" cy="7.3" r="0.7" fill="currentColor" />
        </>
      ) : null}
    </svg>
  )
}

/** A tool call's outcome as a shape beside its word: an arc turning, a tick, a bang. */
function ActionMark({ status }: { status: 'running' | 'ok' | 'failed' }): ReactNode {
  return (
    <svg className="dk-vline__amark" data-status={status} width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
      {status === 'running' ? (
        <path d="M5 1.4 A3.6 3.6 0 1 1 1.4 5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      ) : null}
      {status === 'ok' ? (
        <path d="M1.8 5.2 L4.1 7.4 L8.3 2.8" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
      ) : null}
      {status === 'failed' ? (
        <>
          <path d="M5 1.6 V5.6" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
          <circle cx="5" cy="8" r="0.9" fill="currentColor" />
        </>
      ) : null}
    </svg>
  )
}

/** The link as a word, for the line's right end while it is not live. */
function linkWord(stage: string, connection: string, recovering: string): string {
  if (stage === 'offline') return 'Asleep'
  if (recovering) return 'Recovering'
  if (connection === 'connecting') return 'Connecting'
  if (connection === 'pin') return 'Needs PIN'
  if (connection === 'refused') return 'Refused'
  return 'Offline'
}

/**
 * The voice line: one line of words the bar grows only while voice has
 * something to say, then settles back. Who is speaking and what (the newest
 * caption), or the phase and what to do next; a failure's sentence ("Update
 * the desktop app to use voice here"); why the last conversation ended, for a
 * few seconds. At its right end: the last thing the agent did, and who the
 * next message goes to — the pane on screen, with the same state chip its tile
 * wears — or, while the link is down, the link in a word.
 *
 * In the dock it takes the agent strip's place above the bar at the same
 * height, so nothing moves; up top it hangs under the voice bar as a tag.
 */
export function VoiceLine({ place }: { place: BarPlace }): ReactNode {
  const voice = useWebVoice()
  const { state } = useForge()
  const live = useLive()
  const { current } = useDeckAgents()

  // "Ended" is news for a few seconds, not a resting state.
  const [endedShown, setEndedShown] = useState(false)
  useEffect(() => {
    if (!voice.ended || voice.phase !== 'off') {
      setEndedShown(false)
      return undefined
    }
    setEndedShown(true)
    const t = window.setTimeout(() => setEndedShown(false), ENDED_SHOW_MS)
    return () => window.clearTimeout(t)
  }, [voice.ended, voice.phase])

  const content = lineOf(voice, endedShown)
  // While it settles back it keeps saying what it last said.
  const held = useRef<LineContent | null>(null)
  if (content) held.current = content
  const { mounted, closing } = usePresence(content !== null, 180)
  const shown = content ?? held.current
  if (!mounted || !shown) return null

  return (
    <div className="dk-vline" data-place={place} data-tone={shown.tone} data-state={closing ? 'closing' : 'open'} title={shown.text}>
      <span className="dk-sr" role="status" aria-live="polite">
        {closing ? '' : shown.announce}
      </span>
      <span className="dk-vline__lead">
        <LineGlyphMark glyph={shown.glyph} />
        <span className="dk-vline__word">{shown.word}</span>
      </span>
      <span className="dk-vline__text">{shown.text}</span>
      {shown.action ? (
        <span className="dk-vline__seg dk-vline__act" data-status={shown.action.status} title={shown.action.label}>
          <span className="dk-vline__eyebrow">Last</span>
          <span className="dk-vline__alabel">{shown.action.label}</span>
          <span className="dk-vline__astate">
            <ActionMark status={shown.action.status} />
            {actionStatusWord(shown.action.status)}
          </span>
        </span>
      ) : null}
      {live ? (
        current ? (
          <span className="dk-vline__seg dk-vline__to" title={`Your next message goes to ${current.title}`}>
            <span className="dk-vline__eyebrow">To</span>
            <AgentBadge profile={current.profile} size="sm" />
            <span className="dk-vline__name">{current.title}</span>
            <AgentStateChip paneId={current.leaf.id} compact />
          </span>
        ) : null
      ) : (
        <span className="dk-vline__seg dk-vline__link" title="The link to the desktop">
          <span className="dk-vline__eyebrow">Desktop</span>
          <span className="dk-vline__name">{linkWord(state.stage.kind, state.connection.state, state.desktopRecovering)}</span>
        </span>
      )}
    </div>
  )
}

/* -------------------------------------------------------------------- D */

/**
 * D's key, as words on the button ("D · Right Ctrl") and in its title. One
 * constant on purpose: rebinding D replaces this with the stored binding.
 */
export const D_SHORTCUT = 'Right Ctrl'

/**
 * Whether D may start: a live link, an agent on screen for the words to go to
 * (the pane the bar talks to), and the composer that runs the dictation.
 */
function useCanDictate(): boolean {
  const live = useLive()
  const { current } = useDeckAgents()
  const seat = useDictationSeat()
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

/**
 * D: the phone's dictation — the words go to the agent on screen: spoken
 * commands act, anything else waits in the composer with a countdown and
 * Undo, then sends. Its own tint, apart from the accent, and every state in a
 * shape and a word: a keycap and its key at rest, a stop square and
 * "Listening" while the microphone is open, a turning arc and "Writing" while
 * the desktop writes it down, an arrow and "Sending" while the words wait.
 */
function DictateButton({ shortcut = D_SHORTCUT }: { shortcut?: string }): ReactNode {
  const phase = useDeckDictation()
  const canStart = useCanDictate()
  const supported = deckDictationSupported()
  const busy = phase !== 'idle' && phase !== 'review'
  const title = !supported
    ? 'Dictate — this browser cannot record audio here (it needs a secure page and a microphone).'
    : !canStart && !busy
      ? 'Dictate — needs a live link and an agent to send the words to.'
      : phase === 'recording'
        ? `Listening. Press again (or tap ${shortcut}) to stop — then the words wait a moment with Undo, and send.`
        : phase === 'starting'
          ? 'Opening the microphone…'
          : phase === 'transcribing'
            ? 'The desktop is writing it down…'
            : phase === 'review'
              ? 'Sending in a moment — Undo (or Esc) keeps the words to edit. Press to add more.'
              : `Dictate (${shortcut}) — talk, press again; commands like "stop" act, other words send after a moment with Undo.`
  return (
    <button
      type="button"
      className="dk-dictate"
      data-phase={phase}
      aria-label={
        phase === 'recording'
          ? 'Dictate: listening. Stop'
          : phase === 'idle'
            ? `Dictate (${shortcut})`
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
          <span className="dk-dictate__word" aria-hidden="true">
            Listening
          </span>
        </>
      ) : phase === 'idle' ? (
        <>
          <span className="dk-dictate__letter" aria-hidden="true">
            D
          </span>
          <span className="dk-dictate__key" aria-hidden="true">
            {shortcut}
          </span>
        </>
      ) : phase === 'review' ? (
        <>
          <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
            <path d="M2 6h7.5M6.5 3l3 3-3 3" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          <span className="dk-dictate__word" aria-hidden="true">
            Sending
          </span>
        </>
      ) : (
        <>
          <svg className="dk-dictate__spin" width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
            <path d="M6 1.5 A4.5 4.5 0 1 1 1.5 6" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
          </svg>
          <span className="dk-dictate__word" aria-hidden="true">
            Writing
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
      aria-pressed={open}
      title={`Type to the agent on screen (${COMPOSER_SHORTCUT})`}
      onMouseDown={(e) => e.preventDefault()}
      onClick={() => toggleComposer()}
    >
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden="true">
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
