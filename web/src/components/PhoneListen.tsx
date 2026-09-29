import { useEffect, useRef, useState, useSyncExternalStore, type MouseEvent, type ReactNode } from 'react'
import type { WebVoiceProvider } from '@shared/web'
import { Icon } from '@/components/Icon'
import { SynthesizerIndicator } from '@/components/hub/SynthesizerIndicator'
import type { HubLook } from '@/components/hub/hubLook'
import {
  holdWebVoiceMic,
  readWebVoiceLevels,
  setVoiceLink,
  setVoiceNavigator,
  setWebVoiceAgent,
  stopWebVoice,
  toggleWebVoice,
  useWebVoice,
  webVoiceSupported,
  type WebVoiceState
} from '../deck/voiceAgent'
import { voiceAgentWord, voiceHint, voicePhaseWord, WEB_VOICE_AGENTS } from '../deck/voice-words'
import { withAgentSends } from '../lib/pane-sent'
import { useForge, useWorkspace } from '../state'
import { BottomSheet, SheetRow, SheetSection } from './BottomSheet'
import './PhoneListen.css'

/**
 * Listen, on the phone: the voice agent the deck's voice bar runs (Gemini
 * Live, ChatGPT or Claude, ../deck/voiceAgent.ts), as a conversation rather
 * than dictation.
 *
 * Two things on screen, two silhouettes, as on the deck: Listen is a capsule
 * at the front of the box's row (a mic with the equalizer beside it, then the
 * agent's mark and a chevron); the dictation mic stays the round disc at the
 * bottom right. One tap on the mic half turns Listen on and it is hands-free
 * from there — a pause sends, the reply is spoken, it listens again, and
 * talking over it interrupts. One tap turns it off. A tap on the agent half
 * opens the agent picker (the deck's three rows, in the phone's sheet).
 *
 * While it is on, the box's own face carries the voice line — the state in a
 * shape and a word, and the newest words heard or said — in place, so the dock
 * never grows and the terminal never resizes. The first letter typed (or a
 * dictation) takes the box back.
 */

/** How long "Ended — …" stays on the box before it hands the box back. */
const ENDED_SHOW_MS = 6000
/** The longest caption tail the line carries; two lines show the newest of it. */
const CAPTION_TAIL = 140

/* --------------------------------------------------------------- wiring */

/**
 * Listen's link, its moves and its lifetime on the phone face — DeckKeys'
 * job on the deck (../deck/VoiceBar.tsx). `enabled` is false on the deck's
 * own composer, which leaves all of it to DeckKeys.
 *
 * `dictating` holds Listen's mic shut while the phone's own dictation opens,
 * records or is being written down, so the agent never hears it.
 */
export function usePhoneVoice(enabled: boolean, dictating: boolean): void {
  const { state, actions } = useForge()
  const request = actions.request
  // The workspace the agent's sends are resolved against: read at answer time.
  const workspace = useWorkspace()
  const workspaceRef = useRef(workspace)
  workspaceRef.current = workspace
  useEffect(() => {
    // The agent's sends into a pane get the agent's comet (lib/pane-sent.ts).
    if (enabled) setVoiceLink({ request: withAgentSends(request, () => workspaceRef.current) })
  }, [enabled, request])

  // A move lands on this phone: a project, a tab, a pane, through the same
  // gestures a tap sends. The phone has one face, so a view is ignored.
  const nav = useRef({ actions, projectId: state.projectId })
  nav.current = { actions, projectId: state.projectId }
  useEffect(() => {
    if (!enabled) return undefined
    setVoiceNavigator((to) => {
      const { actions, projectId: showing } = nav.current
      if (to.projectId && to.projectId !== showing) actions.selectProject(to.projectId)
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
  }, [enabled])

  useEffect(() => {
    if (enabled) holdWebVoiceMic(dictating)
  }, [enabled, dictating])

  // Leaving the phone face (a window widened into the deck's) closes the conversation.
  useEffect(() => {
    if (!enabled) return undefined
    return () => {
      stopWebVoice()
      holdWebVoiceMic(false)
      setVoiceLink(null)
    }
  }, [enabled])
}

/* --------------------------------------------------------------- picker */

/** The picker is opened from Listen (its agent half) and from the line; one flag for both. */
let pickerOpen = false
const pickerListeners = new Set<() => void>()

function setPicker(open: boolean): void {
  if (pickerOpen === open) return
  pickerOpen = open
  pickerListeners.forEach((fn) => fn())
}

function subscribePicker(fn: () => void): () => void {
  pickerListeners.add(fn)
  return () => pickerListeners.delete(fn)
}

function usePickerOpen(): boolean {
  return useSyncExternalStore(subscribePicker, () => pickerOpen, () => pickerOpen)
}

/* ---------------------------------------------------------------- looks */

function lookOf(voice: WebVoiceState): HubLook {
  switch (voice.phase) {
    case 'off':
      return 'offline'
    case 'error':
      return 'error'
    case 'listening':
      return voice.muted ? 'muted' : 'listening'
    default:
      return voice.phase
  }
}

function isOn(voice: WebVoiceState): boolean {
  return voice.phase !== 'off' && voice.phase !== 'error'
}

/** The link to the desktop is up. */
function useLive(): boolean {
  const { state } = useForge()
  return state.stage.kind === 'connected' && state.connection.state === 'live'
}

/* --------------------------------------------------------------- Listen */

/** Listen, wired: the cohesive capsule button at the front of the row and the picker it opens. */
export function PhoneListen(): ReactNode {
  const voice = useWebVoice()
  const live = useLive()
  const { actions } = useForge()
  const open = usePickerOpen()
  return (
    <>
      <ListenUnit
        voice={voice}
        live={live}
        supported={webVoiceSupported()}
        onToggle={toggleWebVoice}
        onOpenPicker={() => setPicker(true)}
        onRefused={actions.setNotice}
      />
      <VoicePicker
        open={open}
        voice={voice}
        onClose={() => setPicker(false)}
        onPick={(agent) => {
          setPicker(false)
          setWebVoiceAgent(agent)
        }}
        onOff={() => {
          setPicker(false)
          stopWebVoice()
        }}
      />
    </>
  )
}

/**
 * The capsule: two buttons, each a full touch target, in one pill.
 *
 * Left: the mic, a switch — tap to talk, tap again to stop — with the
 * equalizer beside it (dots at rest, bars that move with the voice). Right:
 * the agent's mark and a chevron, which opens the picker. Its state is a fill
 * and a shape, never a hue alone: the mic half filled with ink while a
 * conversation is open, a dashed rim when it failed or cannot start; the
 * words are on the voice line and in the switch's name. A switch that cannot
 * start stays tappable (aria-disabled), so the tap can say why.
 */
export function ListenUnit({
  voice,
  live,
  supported,
  onToggle,
  onOpenPicker,
  onRefused
}: {
  voice: WebVoiceState
  live: boolean
  supported: boolean
  onToggle: () => void
  onOpenPicker: () => void
  onRefused: (words: string) => void
}): ReactNode {
  const on = isOn(voice)
  const failed = voice.phase === 'error'
  const look = lookOf(voice)
  const agent = voiceAgentWord(voice.agent)
  const blocked = !supported
    ? 'Listen needs a secure page and a microphone — this browser cannot run it here.'
    : !live && !on && !failed
      ? `Listen needs a live link to the desktop to talk to ${agent}.`
      : null
  const word = voicePhaseWord(voice.phase, voice.muted)

  const handleToggle = (e: MouseEvent): void => {
    e.preventDefault()
    if (blocked) onRefused(blocked)
    else onToggle()
  }

  const handleOpenPicker = (e: MouseEvent): void => {
    e.preventDefault()
    onOpenPicker()
  }

  return (
    <span
      className="plisten-unit"
      role="group"
      data-on={on ? 'true' : undefined}
      data-recording={look === 'listening' ? 'true' : undefined}
      data-look={look}
      data-blocked={blocked ? 'true' : undefined}
      aria-label="Agent voice controls"
    >
      <button
        type="button"
        role="switch"
        aria-checked={on}
        className="plisten__btn"
        data-on={on ? 'true' : undefined}
        title={
          blocked ??
          (on
            ? `Listen is on with ${agent} — tap to stop.`
            : failed
              ? `${agent} failed — tap to try again.`
              : `Tap to talk to ${agent}, hands-free.`)
        }
        aria-label={`Listen: ${on ? 'on' : 'off'} — ${agent}: ${word}`}
        aria-disabled={blocked ? true : undefined}
        onClick={handleToggle}
      >
        <span className="plisten__mic-wrap" aria-hidden="true">
          <Icon name="mic" size={15} className="plisten__mic-icon" />
        </span>
        <SynthesizerIndicator
          look={look}
          readLevels={readWebVoiceLevels}
          width={24}
          height={14}
          className="plisten__synth"
        />
      </button>

      <button
        type="button"
        className="plisten__agent-btn"
        title={`Voice agent: ${agent} — tap to pick Gemini, ChatGPT or Claude`}
        aria-label={`Voice agent: ${agent}. Pick Gemini, ChatGPT or Claude`}
        onClick={handleOpenPicker}
      >
        <span className="plisten__agent-tile" aria-hidden="true">
          <AgentMark agent={voice.agent} size={13} />
        </span>
        <Icon name="chevronDown" size={10} className="plisten__chev" />
      </button>
    </span>
  )
}

/**
 * Which agent, as a mark: Gemini a four-point spark, ChatGPT a hexagon,
 * Claude an eight-ray burst — the deck's three silhouettes. The word is
 * always beside it somewhere: the line, the picker, the accessible name.
 */
function AgentMark({ agent, size = 14, className }: { agent: WebVoiceProvider; size?: number; className?: string }): ReactNode {
  return (
    <svg className={className} data-agent={agent} width={size} height={size} viewBox="0 0 14 14" aria-hidden="true">
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
        <path d="M7 1.4 11.85 4.2V9.8L7 12.6 2.15 9.8V4.2Z" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />
      )}
    </svg>
  )
}

/* ----------------------------------------------------------- voice line */

type LineLead = 'live' | 'muted' | 'wait' | 'agent' | 'failed' | 'ended'

interface LineContent {
  tone: 'live' | 'failed' | 'ended'
  lead: LineLead
  word: string
  agent: string
  /** Whose words the text is: a caption's speaker, or null for a hint. */
  who: 'you' | 'agent' | 'action' | null
  text: string
  /** What a screen reader is told, politely: the phase, or the failure. */
  announce: string
}

function tail(text: string): string {
  return text.length > CAPTION_TAIL ? `…${text.slice(-CAPTION_TAIL).trimStart()}` : text
}

function lineOf(voice: WebVoiceState, endedShown: boolean): LineContent | null {
  const agent = voiceAgentWord(voice.agent)
  if (voice.phase === 'error') {
    const reason = voice.error ?? 'The voice agent stopped.'
    return { tone: 'failed', lead: 'failed', word: 'Failed', agent, who: null, text: reason, announce: `${agent} failed: ${reason}` }
  }
  if (voice.phase === 'off') {
    if (!endedShown || !voice.ended) return null
    const why = voice.ended.replace(/^Conversation ended\s*[—-]\s*/, '')
    return { tone: 'ended', lead: 'ended', word: 'Ended', agent, who: null, text: why, announce: voice.ended }
  }
  const word = voicePhaseWord(voice.phase, voice.muted)
  const lead: LineLead =
    voice.phase === 'connecting' || voice.phase === 'thinking'
      ? 'wait'
      : voice.phase === 'speaking'
        ? 'agent'
        : voice.muted
          ? 'muted'
          : 'live'
  const base = { tone: 'live' as const, lead, word, agent, announce: `${agent}: ${word}` }
  if (voice.caption && voice.phase !== 'connecting') {
    return { ...base, who: voice.caption.role === 'user' ? 'you' : 'agent', text: tail(voice.caption.text) }
  }
  if (voice.lastAction?.status === 'running') return { ...base, who: 'action', text: voice.lastAction.label }
  return { ...base, who: null, text: voiceHint(voice.phase, voice.muted) }
}

/**
 * The voice line, wired: on the box's face while Listen has something to
 * say — and for a few seconds after it ends, to say why — or nothing at all.
 */
export function PhoneListenLine(): ReactNode {
  const voice = useWebVoice()

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

  return <ListenLine voice={voice} endedShown={endedShown} onPick={() => setPicker(true)} />
}

/**
 * The line itself: a shape and the state's word, the agent's name, then two
 * lines of the newest words — what it heard (a dot, you) or what it is saying
 * (a play mark, the agent) — or what to do next. Touch passes through it to
 * the box underneath, so a tap still brings the keyboard; only the picker
 * chip at its end takes a tap. Nothing to say, nothing drawn.
 */
export function ListenLine({
  voice,
  endedShown,
  onPick
}: {
  voice: WebVoiceState
  endedShown: boolean
  onPick: () => void
}): ReactNode {
  const content = lineOf(voice, endedShown)
  if (!content) return null
  return (
    <div className="plisten-line" data-tone={content.tone} data-lead={content.lead}>
      <span className="plisten-sr" role="status" aria-live="polite">
        {content.announce}
      </span>
      <span className="plisten-line__body" aria-hidden="true">
        <span className="plisten-line__head">
          {/* Whose voice this is, in a word: dictation's strip says "Listening"
              too, and the two must never be told apart by colour alone. */}
          <span className="plisten-line__tag">Agent</span>
          <LeadMark lead={content.lead} />
          <span className="plisten-line__word">{content.word}</span>
          <span className="plisten-line__agent">· {content.agent}</span>
        </span>
        {content.text ? (
          <span className="plisten-line__cap" data-who={content.who ?? undefined}>
            {content.who ? <WhoMark who={content.who} /> : null}
            <span className="plisten-line__text">{content.text}</span>
          </span>
        ) : null}
      </span>
      {content.tone !== 'ended' ? (
        <button
          type="button"
          className="plisten-line__pick"
          aria-label={`Voice agent: ${voiceAgentWord(voice.agent)}. Pick Gemini, ChatGPT or Claude`}
          title="Pick the voice agent"
          onClick={onPick}
        >
          <AgentMark agent={voice.agent} size={15} />
          <Icon name="chevronDown" size={12} />
        </button>
      ) : null}
    </div>
  )
}

/**
 * The lead's shape: a dot is the mic live (lime, the phone's one other lime),
 * a ring the mic held, a diamond waiting, a play mark the agent speaking, a
 * triangle a failure, a square the end.
 */
function LeadMark({ lead }: { lead: LineLead }): ReactNode {
  return (
    <svg className="plisten-line__lead" data-lead={lead} width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
      {lead === 'live' ? <circle cx="6" cy="6" r="4" /> : null}
      {lead === 'muted' ? (
        <>
          <circle cx="6" cy="6" r="3.6" fill="none" strokeWidth="1.4" />
          <path d="M2.2 9.8 9.8 2.2" strokeWidth="1.4" />
        </>
      ) : null}
      {lead === 'wait' ? <path d="M6 1.4 10.6 6 6 10.6 1.4 6Z" fill="none" strokeWidth="1.5" /> : null}
      {lead === 'agent' ? <path d="M3 1.8 10 6 3 10.2Z" /> : null}
      {lead === 'ended' ? <rect x="2" y="2" width="8" height="8" rx="1.4" fill="none" strokeWidth="1.5" /> : null}
      {lead === 'failed' ? (
        <>
          <path d="M6 1 11.2 10.4H.8Z" fill="none" strokeWidth="1.4" strokeLinejoin="round" />
          <path d="M6 4.4V6.9" strokeWidth="1.4" strokeLinecap="round" />
          <circle cx="6" cy="8.6" r="0.75" />
        </>
      ) : null}
    </svg>
  )
}

/** Whose words: a dot for you, a play mark for the agent, an arc for a tool still running. */
function WhoMark({ who }: { who: 'you' | 'agent' | 'action' }): ReactNode {
  return (
    <svg className="plisten-line__who" width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
      {who === 'you' ? <circle cx="5" cy="5" r="3" fill="currentColor" /> : null}
      {who === 'agent' ? <path d="M2.6 1.6 8.4 5 2.6 8.4Z" fill="currentColor" /> : null}
      {who === 'action' ? (
        <path d="M5 1.4A3.6 3.6 0 1 1 1.4 5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      ) : null}
    </svg>
  )
}

/* --------------------------------------------------------------- picker */

/**
 * The deck's picker, in the phone's sheet: the three agents with a tick and
 * "In use" on the one Listen talks to, and — while a conversation is open or
 * failed — a way to turn it off. A pick mid-conversation closes the live one
 * and opens the new agent in its place, so Listen stays on.
 */
export function VoicePicker({
  open,
  voice,
  onClose,
  onPick,
  onOff
}: {
  open: boolean
  voice: WebVoiceState
  onClose: () => void
  onPick: (agent: WebVoiceProvider) => void
  onOff: () => void
}): ReactNode {
  const on = isOn(voice)
  return (
    <BottomSheet
      open={open}
      onClose={onClose}
      label="Voice agent"
      subtitle="Who Listen talks to. Tap the chevron by Listen to come back here."
      testId="voice-agent-sheet"
    >
      <div role="radiogroup" aria-label="Voice agent">
        {WEB_VOICE_AGENTS.map((id) => {
          const here = id === voice.agent
          return (
            <button
              key={id}
              type="button"
              className="bsrow plisten-pick"
              role="radio"
              aria-checked={here}
              data-current={here ? 'true' : undefined}
              onClick={() => onPick(id)}
            >
              <span className="bsrow__icon">
                <AgentMark agent={id} size={20} />
              </span>
              <span className="bsrow__text">
                <span className="bsrow__label">{voiceAgentWord(id)}</span>
                {here ? (
                  <span className="bsrow__sub">
                    In use{on || voice.phase === 'error' ? ` — ${voicePhaseWord(voice.phase, voice.muted)}` : ''}
                  </span>
                ) : null}
              </span>
              <span className="bsrow__trail plisten-pick__tick" aria-hidden="true">
                {here ? <Icon name="check" size={20} /> : null}
              </span>
            </button>
          )
        })}
      </div>
      {on || voice.phase === 'error' ? (
        <SheetSection>
          <SheetRow
            icon={<Icon name="close" size={20} />}
            label="Turn Listen off"
            secondary={`Now: ${voicePhaseWord(voice.phase, voice.muted)}`}
            onClick={onOff}
          />
        </SheetSection>
      ) : null}
    </BottomSheet>
  )
}
