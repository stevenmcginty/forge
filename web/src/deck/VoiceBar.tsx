import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import type { WebVoiceProvider } from '@shared/web'
import { AgentBadge } from '@/components/AgentBadge'
import { Icon } from '@/components/Icon'
import { isShellProfile } from '@/lib/agents'
import { usePresence } from '@/lib/motion'
import { Rail } from '../components/Rail'
import { useActiveProject, useForge } from '../state'
import { AgentStateChip, useDeckAgents, type DeckAgent } from './agents'
import { composerField, composerOpen, focusedField, openComposer } from './composer'
import { useDictationSeat } from '../lib/dictation-seat'
import { attachTalkKey, type GestureIntent } from '../lib/talk-key'
import {
  cancelDeckDictation,
  deckDictationPhase,
  deckDictationSupported,
  toggleDeckDictation,
  undoDeckDictation,
  useDeckDictation,
  type DeckDictationPhase
} from './dictation'
import { dictationKeySuspended, useDictationKey } from './dictation-key'
import { DeckSheet, deckSheet, useDeckSheet } from './sheet'
import type { BarPlace, DeckView } from './view'
import {
  holdWebVoiceMic,
  setVoiceLink,
  setVoiceNavigator,
  setWebVoiceAgent,
  startWebVoice,
  stopWebVoice,
  toggleWebVoice,
  useWebVoice,
  webVoiceState,
  webVoiceSupported,
  type WebVoiceState
} from './voiceAgent'
import {
  actionStatusWord,
  voiceAgentWord,
  voiceHint,
  voicePhaseWord,
  WEB_VOICE_AGENTS,
  type WebVoicePhase
} from './voice-words'

/**
 * The voice bar: the project you are in and the voice agent — and, in the top
 * bar, Type. One group, drawn in the top bar or leading the dock at the bottom
 * edge (the default); the "…" menu says where it is in a word and moves it.
 * Dictation (D) is the composer's own button now — the mic while the box is
 * empty — and its key; the "…" menu lists every key.
 *
 * Three kinds of thing, three silhouettes, so they never read alike: the
 * project is a pill with a folder and its name (a place); the voice agent is a
 * squared block of symbols (a person speaking, and the agent's mark); the mic
 * is a round disc at the far end of the bar.
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
      <VoiceAgent place={place} />
      {place === 'top' ? <TypeButton /> : null}
      {place === 'top' ? <VoiceLine place="top" /> : null}
    </div>
  )
}

/* ---------------------------------------------------------------- project */

/**
 * The project you are in, as the bar's first word; opens the projects sheet.
 * A place, so it wears a folder (in the project's colour) and its name — the
 * one control in the bar that is words, never a symbol alone.
 */
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
      <svg className="dk-project__folder" width="16" height="14" viewBox="0 0 16 14" aria-hidden="true">
        <path d="M1 3.2C1 2.3 1.7 1.6 2.6 1.6h3.2c.5 0 .9.2 1.2.6l.9 1.1h5.5c.9 0 1.6.7 1.6 1.6v6.5c0 .9-.7 1.6-1.6 1.6H2.6c-.9 0-1.6-.7-1.6-1.6V3.2Z" />
      </svg>
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

/* ------------------------------------------------------- the voice agent */

type Look = 'offline' | 'connecting' | 'listening' | 'thinking' | 'speaking' | 'muted' | 'error'

/** The phase as a look: each one its own shape in the glyph (VoiceAgentGlyph), colour only agreeing. */
function lookOf(phase: WebVoicePhase, muted: boolean): Look {
  switch (phase) {
    case 'off':
      return 'offline'
    case 'listening':
      return muted ? 'muted' : 'listening'
    default:
      return phase
  }
}

/** The link to the desktop is up. The voice agent, D and the voice line all ask. */
function useLive(): boolean {
  const { state } = useForge()
  return state.stage.kind === 'connected' && state.connection.state === 'live'
}

/** Listen's key, as on the desktop (the Listen key's default there). */
export const LISTEN_KEY = 'ShiftRight'
export const LISTEN_KEY_NAME = 'Right Shift'

/**
 * Listen's key, as the desktop's HubLayer reads it: a tap turns Listen on or
 * off; a hold turns it on and its release leaves it listening (hands-free).
 * A hold that turns into Shift+letter takes back the start it made. Needs a
 * live link, like the button.
 */
let listenHoldStarted = false
function applyListenKey(intent: GestureIntent, live: boolean): void {
  if (intent === 'ptt-end') {
    listenHoldStarted = false
    return
  }
  const phase = webVoiceState().phase
  const off = phase === 'off' || phase === 'error'
  if (off) {
    if (!live || !webVoiceSupported()) return
    listenHoldStarted = intent === 'ptt-start'
    startWebVoice()
  } else if (intent === 'toggle') stopWebVoice()
}
function cancelListenHold(): void {
  if (listenHoldStarted) stopWebVoice()
  listenHoldStarted = false
}

/**
 * The voice agent: one squared block, two buttons. The big half is Listen —
 * the desktop's main voice agent, talking through this browser
 * (./voiceAgent.ts): one press opens a hands-free conversation (a pause sends
 * the turn, the reply is spoken, it listens again by itself), a second press,
 * "that's all", or quiet closes it. The small half names the agent by its mark
 * and opens the menu of the three — Gemini, ChatGPT, Claude. The pick is this
 * browser's; made mid-conversation, the live one closes and the new one opens
 * in its place.
 *
 * No words on it: the state is the glyph's shape (VoiceAgentGlyph) and the
 * block's rim (single at rest, doubled while it hears you, dashed when it
 * cannot start); the words are in the title and the accessible name. A
 * failure's sentence is on the voice line (VoiceLine).
 */
function VoiceAgent({ place }: { place: BarPlace }): ReactNode {
  const voice = useWebVoice()
  const live = useLive()
  const supported = webVoiceSupported()
  const open = useDeckSheet() === 'voice'
  const on = voice.phase !== 'off' && voice.phase !== 'error'
  const failed = voice.phase === 'error'
  const look = lookOf(voice.phase, voice.muted)
  const blocked = !supported ? 'Not here' : !live && !on && !failed ? 'No link' : null
  const word = blocked ?? voicePhaseWord(voice.phase, voice.muted)
  const agent = voiceAgentWord(voice.agent)
  const said = `Voice agent, ${agent}: ${word}`
  const title = !supported
    ? 'Voice agent — this browser cannot run it here (it needs a secure page and a microphone).'
    : blocked
      ? `Voice agent, ${agent} — needs a live link to the desktop.`
      : failed
        ? `${said} — ${voice.error ?? 'no more detail'}. Click (or tap ${LISTEN_KEY_NAME}) to try again.`
        : on
          ? `${said}. Talk; a pause sends it. Click, tap ${LISTEN_KEY_NAME}, or say "that's all" to stop.`
          : `${said}${voice.ended ? ` — ${voice.ended}` : ''}. Click (or tap ${LISTEN_KEY_NAME}) to talk to ${agent}, hands-free.`
  return (
    <span
      className="dk-vagent"
      data-place={place}
      data-look={look}
      data-on={on ? 'true' : undefined}
      data-blocked={blocked ? 'true' : undefined}
      data-open={open ? 'true' : undefined}
    >
      <button
        type="button"
        role="switch"
        aria-checked={on}
        className="dk-vagent__listen"
        title={title}
        aria-label={`Voice agent (${LISTEN_KEY_NAME}), ${agent}: ${word}`}
        disabled={!!blocked}
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => toggleWebVoice()}
      >
        <VoiceAgentGlyph look={look} on={on} />
      </button>
      <button
        type="button"
        className="dk-vagent__pick"
        data-sheet-toggle="voice"
        aria-expanded={open}
        aria-haspopup="menu"
        aria-label={`Voice agent in use: ${agent}. Pick Gemini, ChatGPT or Claude`}
        title={`Voice agent: ${agent} — pick Gemini, ChatGPT or Claude`}
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => deckSheet.toggle('voice')}
      >
        <AgentMark agent={voice.agent} />
        <Icon name="chevronDown" size={11} className="dk-vagent__chev" />
      </button>
      <DeckSheet id="voice" className="dk-sheet--voice" label="Voice agent">
        <div className="dk-menu__rows" role="menu">
          {WEB_VOICE_AGENTS.map((id) => {
            const here = id === voice.agent
            return (
              <button
                key={id}
                type="button"
                role="menuitemradio"
                aria-checked={here}
                className="dk-menu__row"
                data-on={here ? 'true' : undefined}
                onClick={() => {
                  deckSheet.set(null)
                  setWebVoiceAgent(id)
                }}
              >
                {here ? <Icon name="check" size={14} /> : <span />}
                <span className="dk-menu__label dk-vagent__row">
                  <AgentMark agent={id} />
                  {voiceAgentWord(id)}
                </span>
                {here ? <span className="dk-menu__detail">in use</span> : <span />}
              </button>
            )
          })}
        </div>
      </DeckSheet>
    </span>
  )
}

/*
 * Sound waves out of the mouth: arcs of circles centred just before it, radii
 * 2.6, 5.2 and 7.8, each from -50 to +50 degrees.
 */
const WAVE_ARCS = [
  'M14.07 5.61A2.6 2.6 0 0 1 14.07 9.59',
  'M15.74 3.62A5.2 5.2 0 0 1 15.74 11.58',
  'M17.41 1.62A7.8 7.8 0 0 1 17.41 13.58'
]

/**
 * The voice agent's symbol: a person, and beside the mouth what the voice is
 * doing — one shape per state, so none rests on colour:
 *
 *   at rest       an outlined person, two quiet waves
 *   connecting    a filled person, an arc turning
 *   listening     four bars, breathing — it hears you
 *   thinking      three dots, a light running across them
 *   speaking      three bold waves, pulsing out
 *   muted         the two waves struck through (the mic is D's for now)
 *   failed        an outlined person and a warning triangle
 *
 * Under reduced motion every shape stays and only the movement goes.
 */
function VoiceAgentGlyph({ look, on }: { look: Look; on: boolean }): ReactNode {
  return (
    <svg className="dk-vglyph" data-look={look} width="24" height="20" viewBox="0 0 22 18" aria-hidden="true">
      <g className="dk-vglyph__person" data-filled={on ? 'true' : undefined}>
        <circle cx="6.4" cy="5.6" r="3" />
        <path d="M1.2 16.6C1.2 12.9 3.5 11 6.4 11s5.2 1.9 5.2 5.6Z" />
      </g>
      {look === 'offline' || look === 'muted' ? (
        <g className="dk-vglyph__waves">
          <path d={WAVE_ARCS[0]} />
          <path d={WAVE_ARCS[1]} />
        </g>
      ) : null}
      {look === 'muted' ? <path className="dk-vglyph__strike" d="M13.2 13.6 19.6 1.6" /> : null}
      {look === 'speaking' ? (
        <g className="dk-vglyph__waves" data-bold="true">
          {WAVE_ARCS.map((d) => (
            <path key={d} d={d} />
          ))}
        </g>
      ) : null}
      {look === 'connecting' ? <path className="dk-vglyph__turn" d="M17.2 4.4A3.2 3.2 0 1 1 14 7.6" /> : null}
      {look === 'listening' ? (
        <g className="dk-vglyph__bars">
          <rect x="13.2" y="3.6" width="1.6" height="8" rx="0.8" />
          <rect x="15.4" y="3.6" width="1.6" height="8" rx="0.8" />
          <rect x="17.6" y="3.6" width="1.6" height="8" rx="0.8" />
          <rect x="19.8" y="3.6" width="1.6" height="8" rx="0.8" />
        </g>
      ) : null}
      {look === 'thinking' ? (
        <g className="dk-vglyph__dots">
          <circle cx="14.4" cy="7.6" r="1.15" />
          <circle cx="17" cy="7.6" r="1.15" />
          <circle cx="19.6" cy="7.6" r="1.15" />
        </g>
      ) : null}
      {look === 'error' ? (
        <g className="dk-vglyph__warn">
          <path d="M17.2 1.6 21.3 10.2H13.1Z" />
          <path d="M17.2 4.6V6.9" />
          <circle cx="17.2" cy="8.5" r="0.6" />
        </g>
      ) : null}
    </svg>
  )
}

/**
 * Which agent, as a mark rather than a word: Gemini a four-point spark,
 * ChatGPT a hexagon, Claude an eight-ray burst. Three silhouettes that stay
 * apart at 14px; the word is in the title, the accessible name, and the menu.
 */
function AgentMark({ agent }: { agent: WebVoiceProvider }): ReactNode {
  return (
    <svg className="dk-amark" data-agent={agent} width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
      {agent === 'gemini-live' ? (
        <path d="M7 .8C7.5 4.6 9.4 6.5 13.2 7 9.4 7.5 7.5 9.4 7 13.2 6.5 9.4 4.6 7.5.8 7 4.6 6.5 6.5 4.6 7 .8Z" fill="currentColor" />
      ) : agent === 'claude' ? (
        <path
          d="M7 1.2V4.6M7 9.4V12.8M1.2 7H4.6M9.4 7H12.8M2.9 2.9 5.3 5.3M8.7 8.7 11.1 11.1M11.1 2.9 8.7 5.3M5.3 8.7 2.9 11.1"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.7"
          strokeLinecap="round"
        />
      ) : (
        <path
          d="M7 1.4 11.85 4.2V9.8L7 12.6 2.15 9.8V4.2Z"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinejoin="round"
        />
      )}
    </svg>
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
  const agent = voiceAgentWord(voice.agent)
  const action = voice.lastAction
  if (voice.phase === 'error') {
    const reason = voice.error ?? 'The voice agent stopped.'
    return { tone: 'failed', glyph: 'failed', word: 'Failed', text: reason, action, announce: `${agent} failed: ${reason}` }
  }
  if (voice.phase === 'off') {
    if (!endedShown || !voice.ended) return null
    const why = voice.ended.replace(/^Conversation ended\s*[—-]\s*/, '')
    return { tone: 'ended', glyph: 'ended', word: 'Ended', text: why, action, announce: voice.ended }
  }
  const announce = `${agent}: ${phaseWord}`
  if (voice.caption && voice.phase !== 'connecting') {
    const you = voice.caption.role === 'user'
    return { tone: 'live', glyph: you ? 'you' : 'agent', word: you ? 'You' : agent, text: tail(voice.caption.text), action, announce }
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

/** Who the next message goes to, in words: "Claude Code, tab Wanda" — or a shell, said plainly. */
function toTitle(agent: DeckAgent): string {
  const who = agent.tabName ? `${agent.title}, tab ${agent.tabName}` : agent.title
  return isShellProfile(agent.profile)
    ? `Your next message goes to ${who} — a shell, not an agent`
    : `Your next message goes to ${who}`
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
          <span className="dk-vline__seg dk-vline__to" title={toTitle(current)}>
            <span className="dk-vline__eyebrow">To</span>
            <AgentBadge profile={current.profile} size="sm" />
            {current.tabName ? <span className="dk-vline__pane">{current.title}</span> : null}
            <span className="dk-vline__name">{current.tabName ?? current.title}</span>
            <AgentStateChip paneId={current.leaf.id} compact />
          </span>
        ) : (
          <span className="dk-vline__seg dk-vline__to" title="No pane on screen for your words to go to">
            <span className="dk-vline__eyebrow">To</span>
            <span className="dk-vline__name">No agent</span>
          </span>
        )
      ) : (
        <span className="dk-vline__seg dk-vline__link" title="The link to the desktop">
          <span className="dk-vline__eyebrow">Desktop</span>
          <span className="dk-vline__name">{linkWord(state.stage.kind, state.connection.state, state.desktopRecovering)}</span>
        </span>
      )}
    </div>
  )
}

/* -------------------------------------------------------------------- D
 *
 * D is the phone's dictation, from a key: the words go to the agent on screen
 * — spoken commands act, anything else waits in the composer with a countdown
 * and Undo, then sends. On screen it is the composer's own button, the mic
 * while the box is empty (SessionComposer runs it through ./dictation.ts too).
 */

/**
 * Whether D may start:a live link, an agent on screen for the words to go to
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
 * D's key, as the desktop's Dictate key reads it: a tap is a press of D; a
 * hold opens the microphone and its release stops and sends. A hold that
 * turns into a combo (Right Alt held a beat before AltGr+4) throws the
 * recording away. Read live, not as of the last render.
 */
function applyDKey(intent: GestureIntent, canStart: boolean): void {
  const phase = deckDictationPhase()
  const open = phase === 'starting' || phase === 'recording'
  if (intent === 'ptt-end') {
    if (open) toggleDeckDictation(canStart)
    return
  }
  if (intent === 'ptt-start' && open) return
  pressD(canStart, phase)
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
 *   Right Alt (or the key       D, the desktop's Dictate key: tap to start
 *   set in the … menu)          or stop, hold to talk while it is down
 *   Esc, while D listens        throw the recording away
 *   Esc, while words wait       Undo the dictation's send
 *   Ctrl+Shift+G                the composer (the desktop's voice card key)
 *   Ctrl+G                      the Wall, on or off (the desktop's mosaic key)
 *
 * D's key runs the desktop's gestures (../lib/talk-key.ts): a modifier only
 * counts pressed on its own, so Right Alt+C is not D, and it is never
 * swallowed, so AltGr characters still type on a UK layout. None of these
 * keys fire while the … menu is recording a new D key.
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
  const latest = useRef({ canStart, view, onView, place })
  latest.current = { canStart, view, onView, place }

  // Listen's link to the desktop, handed over whenever it changes (a reconnect
  // may replace it), and its mic held shut while D records and the desktop
  // writes it down (V5).
  const { state, actions } = useForge()
  const request = actions.request
  useEffect(() => setVoiceLink({ request }), [request])

  // Listen's moving around lands here, on this browser's own deck: the view is
  // this page's choice (./view.ts), and a project, tab or pane goes through the
  // same gestures a click would send. Full screen claims the pane's grid by
  // itself (PaneView), so nothing here resizes a terminal.
  const nav = useRef({ actions, projectId: state.projectId })
  nav.current = { actions, projectId: state.projectId }
  useEffect(() => {
    setVoiceNavigator((to) => {
      const { actions, projectId: showing } = nav.current
      if (to.projectId && to.projectId !== showing) actions.selectProject(to.projectId)
      if (to.view) latest.current.onView(to.view === 'mosaic' ? 'wall' : 'focus')
      const projectId = to.projectId ?? showing ?? undefined
      const where = projectId ? { projectId } : {}
      void (async () => {
        const refused =
          (to.tabId ? await actions.layout({ op: 'select-tab', tabId: to.tabId, ...where }) : null) ??
          (to.paneId ? await actions.layout({ op: 'focus-pane', paneId: to.paneId, ...where }) : null)
        if (refused) actions.setNotice(refused)
      })()
    })
    return () => setVoiceNavigator(null)
  }, [])

  const dictating = phase === 'starting' || phase === 'recording' || phase === 'transcribing'
  useEffect(() => holdWebVoiceMic(dictating), [dictating])

  const dKey = useDictationKey()
  useEffect(
    () =>
      attachTalkKey(
        window,
        dKey,
        () => {
          const phase = deckDictationPhase()
          return phase === 'starting' || phase === 'recording'
        },
        (intent) => applyDKey(intent, latest.current.canStart),
        { cancel: cancelDeckDictation, suspended: dictationKeySuspended }
      ),
    [dKey]
  )

  const live = useLive()
  const liveRef = useRef(live)
  liveRef.current = live
  useEffect(
    () =>
      dKey === LISTEN_KEY
        ? undefined
        : attachTalkKey(
            window,
            LISTEN_KEY,
            () => false,
            (intent) => applyListenKey(intent, liveRef.current),
            { cancel: cancelListenHold, suspended: dictationKeySuspended }
          ),
    [dKey]
  )

  useEffect(() => {
    const onDown = (e: KeyboardEvent): void => {
      if (dictationKeySuspended()) return
      if (e.key === 'Escape' && !e.isComposing) {
        const phase = deckDictationPhase()
        // Esc, from anywhere, while dictated words wait to send: Undo.
        if (phase === 'review') {
          e.preventDefault()
          e.stopPropagation()
          undoDeckDictation()
          return
        }
        // …and while D listens (or the desktop writes it down): throw it away.
        if (phase === 'starting' || phase === 'recording' || phase === 'transcribing') {
          e.preventDefault()
          e.stopPropagation()
          cancelDeckDictation()
          return
        }
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
    window.addEventListener('keydown', onDown, true)
    return () => window.removeEventListener('keydown', onDown, true)
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
