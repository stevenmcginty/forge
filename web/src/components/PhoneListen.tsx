import {
  useEffect,
  useId,
  useRef,
  useState,
  useSyncExternalStore,
  type CSSProperties,
  type MouseEvent,
  type ReactNode
} from 'react'
import { Icon } from '@/components/Icon'
import { BrainGlyphMark } from './BrainGlyph'
import type { HubLook } from '@/components/hub/hubLook'
import {
  holdWebVoiceMic,
  setVoiceLink,
  setVoiceNavigator,
  setWebVoiceAgent,
  stopWebVoice,
  toggleWebVoice,
  useWebVoice,
  webVoiceSupported,
  type WebVoiceState
} from '../deck/voiceAgent'
import { voiceAgentWord, voiceHint, voicePhaseWord, WEB_VOICE_AGENTS, type WebVoiceAgent } from '../deck/voice-words'
import { useBackClose } from '../lib/back-stack'
import { withAgentSends } from '../lib/pane-sent'
import { useForge, useWorkspace } from '../state'
import { BottomSheet, SheetRow, SheetSection } from './BottomSheet'
import './PhoneListen.css'

/**
 * Listen, on the phone: the voice agent the deck's voice bar runs (Forge
 * Brain, Gemini Live or ChatGPT, ../deck/voiceAgent.ts), as a conversation rather
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
  useYourTurnBuzz(lookOf(voice))
  return (
    <>
      <ListenUnit
        voice={voice}
        live={live}
        supported={webVoiceSupported()}
        onToggle={toggleWebVoice}
        onOpenPicker={() => setPicker(!pickerOpen)}
        onRefused={actions.setNotice}
        pickerOpen={open}
      />
      <VoiceFan
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

/** A turn of the agent's that hands the floor back: the next "listening" is his cue to talk. */
const AGENT_TURN: ReadonlySet<HubLook> = new Set(['connecting', 'thinking', 'speaking'])

/**
 * A short buzz the moment it becomes his turn to talk — the agent has
 * finished speaking or thinking, or the conversation has just opened — so a
 * phone in a pocket or at arm's length says so without a look.
 */
function useYourTurnBuzz(look: HubLook): void {
  const last = useRef(look)
  useEffect(() => {
    const was = last.current
    last.current = look
    if (look !== 'listening' || !AGENT_TURN.has(was)) return
    try {
      navigator.vibrate?.(15)
    } catch {
      /* no motor, or not allowed: the glyph still says it */
    }
  }, [look])
}

/**
 * The agent disc: the dictation disc's twin at the other end of the row, the
 * same 56px round, in the voice agent's own blue, so the dock reads
 * symmetrical — talk to the agent on the left, dictate on the right.
 *
 * The disc is a switch — tap to talk, tap again to stop — whose glyph IS the
 * state, one silhouette each, readable at arm's length and without colour: an
 * outline mic (off), a turning ring (connecting), a solid mic (your turn),
 * three dots (thinking), a speaker with waves (its turn), a slashed mic
 * (held), a warning triangle (failed). A halo breathes round it on your turn
 * and ripples out while the agent speaks. The agent's mark sits on its rim as
 * a small badge; a tap on the badge slides the agents out above the disc. A
 * switch that cannot start stays tappable (aria-disabled), so the tap can say why.
 */
export function ListenUnit({
  voice,
  live,
  supported,
  onToggle,
  onOpenPicker,
  onRefused,
  pickerOpen = false
}: {
  voice: WebVoiceState
  live: boolean
  supported: boolean
  onToggle: () => void
  onOpenPicker: () => void
  onRefused: (words: string) => void
  /** The agents are slid out above the disc. */
  pickerOpen?: boolean
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
      data-agent={voice.agent}
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
        <span className="plisten__halo" aria-hidden="true" />
        <span className="plisten__mic-wrap" aria-hidden="true">
          <ListenGlyph key={look} look={look} />
        </span>
      </button>

      <button
        type="button"
        className="plisten__agent-btn"
        aria-haspopup="menu"
        aria-expanded={pickerOpen}
        title={`Voice agent: ${agent} — tap to pick Gemini, ChatGPT, Claude or Forge Brain`}
        aria-label={`Voice agent: ${agent}. Pick Gemini, ChatGPT, Claude or Forge Brain`}
        onClick={handleOpenPicker}
      >
        <span className="plisten__agent-tile" aria-hidden="true">
          <AgentMark agent={voice.agent} size={12} />
        </span>
      </button>
    </span>
  )
}

/**
 * The state, as one 20px silhouette — drawn so no two share an outline: a mic
 * (hollow, solid or slashed), a ring with a gap, three dots, a speaker, a
 * triangle. The motion (the ring turning, the dots rising, the waves going
 * out) is extra; with reduced motion each still stands on its shape.
 */
function ListenGlyph({ look }: { look: HubLook }): ReactNode {
  const cut = useId()
  const mic = (
    <>
      <rect x="7" y="2.2" width="6" height="10.6" rx="3" />
      <path d="M4.3 9.4a5.7 5.7 0 0 0 11.4 0M10 15.1v2.9" fill="none" />
    </>
  )
  return (
    <svg className="plisten__glyph" data-look={look} width="20" height="20" viewBox="0 0 20 20" aria-hidden="true">
      {look === 'offline' ? <g fill="none">{mic}</g> : null}
      {look === 'listening' ? <g className="plisten__glyph-solid">{mic}</g> : null}
      {look === 'muted' ? (
        <>
          <mask id={cut}>
            <rect width="20" height="20" fill="#fff" />
            <path d="M3 3 17 17" stroke="#000" strokeWidth="5" />
          </mask>
          <g fill="none" mask={`url(#${cut})`}>
            {mic}
          </g>
          <path d="M3.4 3.4 16.6 16.6" />
        </>
      ) : null}
      {look === 'connecting' ? <circle className="plisten__glyph-ring" cx="10" cy="10" r="7" fill="none" /> : null}
      {look === 'thinking' ? (
        <g className="plisten__glyph-dots">
          <circle cx="4" cy="10" r="2.1" />
          <circle cx="10" cy="10" r="2.1" />
          <circle cx="16" cy="10" r="2.1" />
        </g>
      ) : null}
      {look === 'speaking' ? (
        <>
          <path className="plisten__glyph-solid" d="M2.6 7.6h2.9L9.6 4.2v11.6l-4.1-3.4H2.6Z" />
          <g className="plisten__glyph-waves" fill="none">
            <path d="M12.7 7.3a3.8 3.8 0 0 1 0 5.4" />
            <path d="M15.3 4.8a7.3 7.3 0 0 1 0 10.4" />
          </g>
        </>
      ) : null}
      {look === 'error' ? (
        <>
          <path d="M10 2.6 18.3 17H1.7Z" fill="none" />
          <path d="M10 7.9v4.2" />
          <circle className="plisten__glyph-solid" cx="10" cy="14.6" r="0.6" />
        </>
      ) : null}
    </svg>
  )
}

/**
 * Which agent, as a mark: Gemini a four-point spark, ChatGPT a hexagon,
 * Claude an eight-ray burst, Forge Brain the desktop top bar's brain glyph,
 * still (./BrainGlyph.tsx) — the deck's silhouettes. The word is always
 * beside it somewhere: the line, the picker, the accessible name.
 */
function AgentMark({ agent, size = 14, className }: { agent: WebVoiceAgent; size?: number; className?: string }): ReactNode {
  if (agent === 'forge-brain') return <BrainGlyphMark size={size} className={className} />
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
          aria-label={`Voice agent: ${voiceAgentWord(voice.agent)}. Pick Gemini, ChatGPT, Claude or Forge Brain`}
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


/* ------------------------------------------------------------------ fan */

/**
 * The agents, slid out above the agent disc: a small glass panel that rises
 * from the disc, its rows following one after another — the agent's mark, its
 * name, a tick and "In use" on the one Listen talks to — and, while a
 * conversation is open or failed, a way to turn it off. A pick mid-
 * conversation closes the live one and opens the new agent in its place. A
 * tap anywhere else, Back or Esc puts it away.
 */
export function VoiceFan({
  open,
  voice,
  onClose,
  onPick,
  onOff
}: {
  open: boolean
  voice: WebVoiceState
  onClose: () => void
  onPick: (agent: WebVoiceAgent) => void
  onOff: () => void
}): ReactNode {
  const on = isOn(voice)
  const ref = useRef<HTMLDivElement | null>(null)
  const closeRef = useRef(onClose)
  closeRef.current = onClose
  useBackClose(open, onClose)

  useEffect(() => {
    if (!open) return undefined
    const away = (e: PointerEvent): void => {
      const target = e.target as Element | null
      if (!target || ref.current?.contains(target) || target.closest('.plisten__agent-btn')) return
      closeRef.current()
    }
    const esc = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') closeRef.current()
    }
    document.addEventListener('pointerdown', away, true)
    document.addEventListener('keydown', esc)
    return () => {
      document.removeEventListener('pointerdown', away, true)
      document.removeEventListener('keydown', esc)
    }
  }, [open])

  return (
    <div
      ref={ref}
      className="plisten-fan"
      data-open={open ? 'true' : 'false'}
      role="menu"
      aria-label="Voice agent"
      aria-hidden={open ? undefined : true}
      data-testid="voice-agent-fan"
    >
      <div className="plisten-fan__head" aria-hidden="true">
        Talk to
      </div>
      {WEB_VOICE_AGENTS.map((id, i) => {
        const here = id === voice.agent
        return (
          <button
            key={id}
            type="button"
            className="plisten-fan__row"
            role="menuitemradio"
            aria-checked={here}
            tabIndex={open ? 0 : -1}
            data-current={here ? 'true' : undefined}
            data-agent={id}
            style={{ '--i': i } as CSSProperties}
            onClick={() => onPick(id)}
          >
            <span className="plisten-fan__mark">
              <AgentMark agent={id} size={18} />
            </span>
            <span className="plisten-fan__text">
              <span className="plisten-fan__name">{voiceAgentWord(id)}</span>
              {here ? (
                <span className="plisten-fan__sub">
                  In use{on || voice.phase === 'error' ? ` · ${voicePhaseWord(voice.phase, voice.muted)}` : ''}
                </span>
              ) : null}
            </span>
            <span className="plisten-fan__tick" aria-hidden="true">
              {here ? <Icon name="check" size={16} /> : null}
            </span>
          </button>
        )
      })}
      {on || voice.phase === 'error' ? (
        <button
          type="button"
          className="plisten-fan__row"
          data-kind="off"
          role="menuitem"
          tabIndex={open ? 0 : -1}
          style={{ '--i': WEB_VOICE_AGENTS.length } as CSSProperties}
          onClick={onOff}
        >
          <span className="plisten-fan__mark">
            <Icon name="close" size={16} />
          </span>
          <span className="plisten-fan__text">
            <span className="plisten-fan__name">Turn Listen off</span>
          </span>
        </button>
      ) : null}
    </div>
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
  onPick: (agent: WebVoiceAgent) => void
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
