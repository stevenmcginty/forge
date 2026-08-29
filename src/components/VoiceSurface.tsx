import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { VoiceReplyMode } from '@shared/types'
import type { ActionOutcome } from '@/lib/appactions'
import { brainStatusLabel } from '@/lib/voicebrain'
import { useApp } from '@/state/AppState'
import {
  useVoiceAgent,
  THINKING_PATIENCE_MS,
  type AgentPhase,
  type BrainTurnState,
  type CommandTurn,
  type NoteTurn,
  type PaneOption,
  type Turn
} from '@/state/VoiceAgent'
import { AgentBadge } from './AgentBadge'
import { EmptyState } from './EmptyState'
import { Icon } from './Icon'
import { Popover, PopoverRow, PopoverSection } from './Popover'
import './VoiceSurface.css'

/**
 * The voice agent, as parts.
 *
 * These were the innards of the right-hand panel. The panel is gone — Steve
 * decided a permanent column showing what the hub already shows was not worth
 * the width — so the dial, the log, the composer and the chips are components
 * that the hub card arranges instead. Nothing was dropped on the way: the
 * conversation, the drafted prompts, the send-to-pane picker, the outcome
 * chips, the reply-mode switch and the brain chip are all still here, wearing
 * the same stylesheet they always wore.
 *
 * They take almost no props: everything comes from `useVoiceAgent()`, the one
 * headless engine at the app root. That is what let the panel be deleted
 * without deleting the agent — and what would let a second surface exist again
 * tomorrow without doubling a word of it.
 *
 * Nothing here subscribes to anything. If a part in this file ever grows a
 * `transcriptBus`, a `stt.on*` or a `speakOnce`, it would be a second engine —
 * `npm run hub:check` fails the build if one appears.
 */

/* ------------------------------------------------------------- presence */

/**
 * Jarvis, as one word.
 *
 * `phase` alone cannot tell calm monitoring apart from active listening — it
 * says `listening` for both (see VoiceAgentCtx). Folding `wakeMode` and
 * `capturing` in here, once, is what lets every surface — the status-bar
 * button, the dial, the desktop orb — speak the same nine-state grammar
 * without three copies of the same ifs.
 *
  *   monitoring   sitting on an open mic waiting for "hey Jarvis" — calm
  *   listening    armed and attentive, nothing arriving yet
  *   capturing    speech is actually going to the engine right now
  *   dictating    buffer mode is on — every word is being held, not acted on
 */
export type JarvisPresence =
  | 'off'
  | 'warming'
  | 'monitoring'
  | 'listening'
  | 'capturing'
  | 'dictating'
  | 'thinking'
  | 'speaking'
  | 'replied'
  | 'error'

export function jarvisPresence(
  phase: AgentPhase,
  wakeMode: boolean,
  capturing: boolean,
  dictating: boolean
): JarvisPresence {
  // Buffer mode is the most load-bearing thing a surface can show — every word
  // he says is being held, which looks identical to plain capturing without it.
  if (dictating && phase === 'listening') return 'dictating'
  if (phase === 'listening') {
    if (capturing) return 'capturing'
    return wakeMode ? 'monitoring' : 'listening'
  }
  if (phase === 'off') return wakeMode ? 'monitoring' : 'off'
  return phase
}

/* ----------------------------------------------------------- agent button */

/** What the orb says about itself, by presence. */
const AGENT_LABEL: Record<JarvisPresence, { title: string; sub: string }> = {
  off: { title: 'Jarvis', sub: 'tap to wake him' },
  warming: { title: 'Waking', sub: 'loading the speech engine…' },
  monitoring: { title: 'On watch', sub: 'say “hey Jarvis” — or tap' },
  listening: { title: 'Listening', sub: 'say what you want — tap to stop' },
  capturing: { title: 'Listening', sub: 'got you — keep going' },
  dictating: { title: 'Dictating', sub: 'holding every word — say “stop dictation” to send it all' },
  thinking: { title: 'Thinking', sub: 'working on it…' },
  // Not "mic off while I talk" any more — it is not. The AEC'd microphone is
  // open for the whole reply and talking over it is the intended way to stop
  // it, so the hint says so. See src/lib/bargein.ts.
  speaking: { title: 'Speaking', sub: 'talk over me any time' },
  replied: { title: 'Answered', sub: 'still listening' },
  error: { title: 'That failed', sub: 'still listening — try again' }
}

/**
 * The hero: Jarvis himself, as an obsidian sphere with a volt-lit iris.
 *
 * No icon and no glyph on purpose. A microphone drawing makes it a control; a
 * lit eye set in dark glass makes it a presence, and every state he can be in
 * is a different quality of that light — dark asleep, an ember while he
 * monitors for his name, blooming with your voice while he takes it down, an
 * orbiting arc while he works, a spoken cadence while he talks, amber when
 * something failed.
 *
 * The ring and the halo are driven straight from the mic level inside a rAF
 * loop rather than through React state: levels arrive ten times a second and
 * the card has a conversation in it. Nothing here re-renders while you speak.
 * The loop only runs while he is actually listening — the idle states breathe
 * on pure compositor animation and cost nothing.
 *
 * `compact` is the floating pill's version: the same orb with the words left
 * off. All sizes are one component on purpose — the pill's orb, the card's and
 * the desktop overlay's are the same being in the same state, and two copies
 * of this rAF loop would drift apart the first time either was tuned.
 */
export function VoiceDial({ compact }: { compact?: boolean } = {}): ReactNode {
  const { phase, armed, wakeMode, capturing, dictating, levelRef, thinkingFor, holding, sttError, cancelAllHolds, toggleAgent } =
    useVoiceAgent()
  const ringRef = useRef<HTMLSpanElement | null>(null)
  const haloRef = useRef<HTMLSpanElement | null>(null)
  const presence = jarvisPresence(phase, wakeMode, capturing, dictating)
  const live = presence === 'listening' || presence === 'capturing' || presence === 'dictating'

  useEffect(() => {
    const ring = ringRef.current
    const halo = haloRef.current
    if (!ring || !halo) return undefined
    if (!live) {
      ring.style.transform = ''
      ring.style.opacity = ''
      halo.style.transform = ''
      halo.style.opacity = ''
      return undefined
    }
    let raf = 0
    let smoothed = 0
    const frame = (t: number): void => {
      // A slow breathe underneath, so silence still looks alive.
      const breathe = 0.06 + 0.04 * Math.sin(t / 620)
      const level = Math.max(breathe, Math.min(1, levelRef.current * 1.9))
      smoothed += (level - smoothed) * 0.28
      ring.style.transform = `scale(${(1 + smoothed * 0.22).toFixed(3)})`
      ring.style.opacity = (0.35 + smoothed * 0.65).toFixed(3)
      halo.style.transform = `scale(${(1 + smoothed * 0.3).toFixed(3)})`
      halo.style.opacity = (0.18 + smoothed * 0.72).toFixed(3)
      raf = requestAnimationFrame(frame)
    }
    raf = requestAnimationFrame(frame)
    return () => cancelAnimationFrame(raf)
  }, [live, levelRef])

  const label = AGENT_LABEL[presence]
  // Never a silent dead orb: past five seconds it starts counting out loud.
  const sub =
    presence === 'thinking' && thinkingFor >= THINKING_PATIENCE_MS / 1000
      ? `still thinking… ${thinkingFor}s`
      : presence === 'error' && sttError
        ? sttError
        : label.sub

  return (
    <div className="agentdial" data-presence={presence} data-compact={compact ? 'true' : undefined}>
      <button
        type="button"
        className="agentdial__btn"
        data-presence={presence}
        aria-pressed={armed}
        aria-label={armed ? 'Stop talking to Jarvis' : 'Talk to Jarvis'}
        title={armed ? 'Jarvis is on — tap or press Esc to stop' : 'Tap to talk to Jarvis'}
        onClick={toggleAgent}
      >
        <span className="agentdial__halo" ref={haloRef} aria-hidden="true" />
        <span className="agentdial__orbit" aria-hidden="true" />
        <span className="agentdial__ring" ref={ringRef} aria-hidden="true" />
        <span className="agentdial__sphere" aria-hidden="true">
          <span className="agentdial__iris" />
        </span>
      </button>
      {compact ? null : (
        <div className="agentdial__labels">
          <span className="agentdial__title">{label.title}</span>
          <span className="agentdial__sub">{sub}</span>
        </div>
      )}
      {holding > 0 && !compact ? (
        <button type="button" className="agentdial__hold" onClick={() => cancelAllHolds()}>
          {holding === 1 ? 'Sending a prompt…' : `Sending ${holding} prompts…`} tap or say “wait” to hold
        </button>
      ) : null}
    </div>
  )
}

/* ------------------------------------------------------------------- chip */

export function BrainChip(): ReactNode {
  const { brainStatus, brainName } = useVoiceAgent()
  return (
    <span
      className="voice__chip"
      data-ok={brainStatus.ok ? 'true' : 'false'}
      title={`${brainName} brain — ${brainStatus.detail ?? brainStatusLabel(brainStatus)}`}
    >
      <span className="voice__chip-dot" />
      {brainStatusLabel(brainStatus)}
    </span>
  )
}

/* -------------------------------------------------------- reply mode */

const REPLY_MODES: Array<{ id: VoiceReplyMode; label: string; hint: string }> = [
  { id: 'text', label: 'Aa', hint: 'Written replies only' },
  { id: 'both', label: 'Aa+', hint: 'Written and spoken' },
  { id: 'voice', label: '♪', hint: 'Spoken only — hides the log and the text box' }
]

/** Three-way switch, in the header where the mic used to be. */
export function ReplyModeToggle(): ReactNode {
  const { replyMode, canSpeak, setReplyMode } = useVoiceAgent()
  return (
    <div className="replymode" role="group" aria-label="How the agent replies">
      {REPLY_MODES.map((m) => (
        <button
          key={m.id}
          type="button"
          className="replymode__btn"
          data-on={m.id === replyMode ? 'true' : undefined}
          aria-pressed={m.id === replyMode}
          disabled={m.id !== 'text' && !canSpeak}
          title={canSpeak ? m.hint : 'Nothing can speak — add a Gemini key, or install a Windows voice'}
          onClick={() => setReplyMode(m.id)}
        >
          {m.label}
        </button>
      ))}
    </div>
  )
}

/* ------------------------------------------------------------ brain model */

const CLAUDE_MODELS: Array<{ id: string; label: string; hint: string }> = [
  { id: 'sonnet', label: 'Sonnet', hint: 'Sonnet — faster' },
  { id: 'opus', label: 'Opus', hint: 'Opus — smarter; takes effect on your next phrase' }
]

/**
 * Which Claude is answering, in the header rather than in Settings.
 *
 * It is the same `voiceClaudeModel` the Models page writes, so the two never
 * disagree — and a model typed in there by hand lights neither segment rather
 * than pretending to be one of them. Clicking still writes the alias, because
 * that is what these two buttons mean.
 *
 * Only shown for the Claude brain: the others take their model from Settings
 * and a Sonnet/Opus switch over a Gemini session would be a lie.
 */
export function ModelToggle(): ReactNode {
  const { brainName, brainModel, setBrainModel } = useVoiceAgent()
  if (brainName !== 'Claude') return null
  const current = brainModel.trim().toLowerCase()
  return (
    <div className="modelpick" role="group" aria-label="Which Claude model answers">
      {CLAUDE_MODELS.map((m) => (
        <button
          key={m.id}
          type="button"
          className="modelpick__btn"
          data-on={m.id === current ? 'true' : undefined}
          aria-pressed={m.id === current}
          title={m.hint}
          onClick={() => setBrainModel(m.id)}
        >
          {m.label}
        </button>
      ))}
    </div>
  )
}

/* ------------------------------------------------------------- degraded */

/**
 * The one honest line when the brain is not really connected. It is a button,
 * and it goes somewhere: the settings section that used to live in the panel
 * could be scrolled into with no visible way back out, which is exactly the
 * shape of thing a one-line link cannot become.
 */
export function DegradedLink(): ReactNode {
  const { actions } = useApp()
  const { brainStatus } = useVoiceAgent()
  if (brainStatus.ok) return null
  return (
    <button
      type="button"
      className="voice__degraded"
      onClick={() => actions.openSettings('models')}
      title="Open Models & APIs"
    >
      <span className="voice__degraded-text">{brainStatus.detail ?? 'No model key — spoken commands still work'}</span>
      <span className="voice__degraded-go">Set it up →</span>
    </button>
  )
}

/* -------------------------------------------------------- tool activity */

/**
 * The activity strip: which tool Jarvis has his hands on right now, in words
 * (src/lib/toolLabels.ts), with a count of the calls finished this turn.
 *
 * Sits directly under the dial, above the conversation. It is always rendered
 * so its row can slide open and shut (grid-template-rows in the CSS) — an
 * unmounted strip would pop the log up and down instead. `on: false` with a
 * label still set is the slide-out, painting its last line on the way.
 */
export function ToolActivityBar(): ReactNode {
  const { toolActivity } = useVoiceAgent()
  const { on, label, failed, done } = toolActivity
  return (
    <div className="voice__activity" data-on={on ? 'true' : undefined} aria-hidden={on ? undefined : 'true'}>
      <div className="voice__activity-clip">
        <div className="voice__activity-strip" data-fail={failed ? 'true' : undefined} role="status">
          <span className="voice__activity-dot" aria-hidden="true" />
          <span className="voice__activity-label">{label}</span>
          {done > 0 ? <span className="voice__activity-count mono">{done} done</span> : null}
        </div>
      </div>
    </div>
  )
}

/* ------------------------------------------------------- voice-only line */

/** Voice-only mode's whole transcript: the most recent thing that happened. */
export function LastLine(): ReactNode {
  const { turns, capturing, dictating, dictationBuffer, phase, wakeMode } = useVoiceAgent()
  const last = turns[turns.length - 1]
  let text = 'Nothing yet — tap the orb and talk.'
  let tone: 'idle' | 'ok' | 'warn' = 'idle'
  if (dictating) {
    text = dictationBuffer.trim() || 'holding every word…'
    tone = 'ok'
  } else if (wakeMode && capturing) {
    text = dictationBuffer.trim() || 'hearing you…'
    tone = 'ok'
  } else if (phase === 'warming') {
    text = 'waking the speech engine…'
  } else if (last?.kind === 'command') {
    text = last.outcomes.map((o) => o.summary).join(' · ') || last.said
    tone = last.outcomes.every((o) => o.ok) ? 'ok' : 'warn'
  } else if (last?.kind === 'note') {
    text = last.said
    tone = last.tone
  } else if (last?.kind === 'brain') {
    text =
      last.phase === 'thinking'
        ? 'thinking…'
        : last.phase === 'error'
          ? (last.error ?? 'that failed')
          : (last.reply?.say ?? last.reply?.understood ?? '—')
    tone = last.phase === 'error' ? 'warn' : 'ok'
  }
  return (
    <div className="voice__lastline" data-tone={tone} title={text}>
      {text}
    </div>
  )
}

/* ------------------------------------------------------------------ log */

/** Within this many px of the bottom still counts as "at the bottom". */
const PIN_SLACK = 48

/**
 * The conversation.
 *
 * It follows the newest turn only while the reader is already at the bottom.
 * `turns` is a fresh array on every streamed token (see the onText callback in
 * VoiceAgent.tsx), so an unconditional scroll-to-bottom here would drag the
 * view down mid-read the whole time a reply is streaming — which it did.
 * Scrolled up, their place is held and a "latest" chip offers the way back.
 */
export function VoiceLog(): ReactNode {
  const { turns, brainStatus, paneOptions, sendToPane, editDraft } = useVoiceAgent()
  const logRef = useRef<HTMLDivElement | null>(null)
  const pinnedRef = useRef(true)
  const [away, setAway] = useState(false)

  const jumpToLatest = (): void => {
    const log = logRef.current
    if (log) log.scrollTop = log.scrollHeight
  }

  useEffect(() => {
    if (pinnedRef.current) jumpToLatest()
  }, [turns])

  // A resized card or window keeps the newest turn in view while following.
  useEffect(() => {
    const log = logRef.current
    if (!log) return undefined
    const ro = new ResizeObserver(() => {
      if (pinnedRef.current) jumpToLatest()
    })
    ro.observe(log)
    return () => ro.disconnect()
  }, [])

  const onScroll = (): void => {
    const log = logRef.current
    if (!log) return
    const atBottom = log.scrollHeight - log.scrollTop - log.clientHeight < PIN_SLACK
    pinnedRef.current = atBottom
    setAway(!atBottom)
  }

  return (
    /* tabIndex puts PageUp/Home paging on the log itself once it is clicked
       into, without taking a single keystroke from the composer. */
    <div className="voice__log" ref={logRef} onScroll={onScroll} role="log" aria-label="Conversation" tabIndex={0}>
      {turns.length === 0 ? (
        <EmptyState
          icon="voice"
          size="sm"
          eyebrow={brainStatus.ok ? 'listening' : 'commands only'}
          title="Tell it what you want"
          body="Say “open three Kimi tabs” and it just does it — or describe what you want built and it drafts the prompt for you to fire at an agent."
        />
      ) : (
        turns.map((turn: Turn) =>
          turn.kind === 'note' ? (
            <NoteCard key={turn.id} turn={turn} />
          ) : turn.kind === 'command' ? (
            <CommandCard key={turn.id} turn={turn} />
          ) : (
            <TurnCard
              key={turn.id}
              turn={turn}
              paneOptions={paneOptions}
              onSend={sendToPane}
              onEdit={(draft) => editDraft(turn.id, draft)}
            />
          )
        )
      )}
      {away ? (
        <div className="voice__jump-row">
          <button type="button" className="voice__jump" onClick={jumpToLatest}>
            <Icon name="chevronDown" size={11} />
            latest
          </button>
        </div>
      ) : null}
    </div>
  )
}

/** What is left of the card once the transcript and the composer are gone. */
export function VoiceOnlyNote(): ReactNode {
  return (
    <div className="voice__voiceonly">
      Spoken replies only. Switch to <span className="mono">Aa</span> in the header to see the conversation.
    </div>
  )
}

/* ------------------------------------------------------------- composer */

/** `autoFocus` puts the caret in it as the card opens. */
export function VoiceComposer({ autoFocus }: { autoFocus?: boolean } = {}): ReactNode {
  const { draftPhrase, setDraftPhrase, submitPhrase, dictating, dictationBuffer } = useVoiceAgent()
  const composerRef = useRef<HTMLTextAreaElement | null>(null)

  useEffect(() => {
    if (autoFocus) composerRef.current?.focus()
  }, [autoFocus])

  return (
    <div className="voice__composer">
      {dictating && (
        <div className="voice__dictating" role="status">
          <span className="voice__dictating-word">holding</span>
          <span className="voice__dictating-text">{dictationBuffer || '…'}</span>
        </div>
      )}
      <textarea
        ref={composerRef}
        className="voice__input"
        rows={2}
        spellCheck={false}
        placeholder="type what you'd say…"
        value={draftPhrase}
        onChange={(e) => setDraftPhrase(e.target.value)}
        onKeyDown={(e) => {
          // Everything a composer swallows, except Escape.
          //
          // React attaches its listeners at the root container, so
          // stopPropagation here stops the *native* event before it ever
          // reaches window — which is where every escape hatch in the app
          // lives. Swallowing the app's shortcuts while he types a sentence is
          // right; swallowing the key that closes the thing he is typing into
          // is how you trap somebody inside a floating card.
          if (e.key !== 'Escape') e.stopPropagation()
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault()
            submitPhrase()
          }
        }}
      />
      <div className="voice__composer-foot">
        <span className="voice__composer-hint">Enter to send · Shift+Enter for a new line</span>
        {/* "Say it" read like the agent would speak back. It does not — this
            is the same door the microphone uses, so it is just Send. */}
        <button type="button" className="cta-btn voice__say" disabled={!draftPhrase.trim()} onClick={submitPhrase}>
          Send
          <Icon name="send" size={13} />
        </button>
      </div>
    </div>
  )
}

/* --------------------------------------------------------------- outcomes */

function OutcomeChips({ outcomes }: { outcomes: ActionOutcome[] }): ReactNode {
  return (
    <div className="voice__chips">
      {outcomes.map((outcome, i) => (
        <span key={i} className="action-chip" data-ok={outcome.ok ? 'true' : 'false'}>
          <Icon name={outcome.ok ? 'check' : 'close'} size={11} />
          {outcome.summary}
        </span>
      ))}
    </div>
  )
}

function CommandCard({ turn }: { turn: CommandTurn }): ReactNode {
  return (
    <article className="turn">
      <p className="turn__said">{turn.said}</p>
      <OutcomeChips outcomes={turn.outcomes} />
    </article>
  )
}

/** The agent speaking for itself — "held, nothing sent". */
function NoteCard({ turn }: { turn: NoteTurn }): ReactNode {
  return (
    <article className="turn turn--note" data-tone={turn.tone}>
      <p className="turn__note">{turn.said}</p>
    </article>
  )
}

/* ------------------------------------------------------------------- turn */

function TurnCard({
  turn,
  paneOptions,
  onSend,
  onEdit
}: {
  turn: BrainTurnState
  paneOptions: () => PaneOption[]
  onSend: (option: PaneOption, text: string) => void
  onEdit: (draft: string) => void
}): ReactNode {
  const sendRef = useRef<HTMLButtonElement | null>(null)
  const [pickerOpen, setPickerOpen] = useState(false)
  const [copied, setCopied] = useState(false)

  const copy = (): void => {
    void navigator.clipboard.writeText(turn.draft).then(() => {
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1400)
    })
  }

  const options = pickerOpen ? paneOptions() : []

  return (
    <article className="turn">
      <p className="turn__said">{turn.said}</p>

      {turn.phase === 'thinking' ? (
        <div className="turn__reply turn__reply--thinking">
          <span className="turn__pending mono">thinking…</span>
        </div>
      ) : null}

      {turn.phase === 'error' ? (
        <div className="turn__reply turn__reply--error">
          <div className="eyebrow turn__label">Brain failed</div>
          <p className="turn__error mono">{turn.error}</p>
        </div>
      ) : null}

      {turn.phase === 'done' && turn.reply ? (
        <div className="turn__reply">
          <header className="turn__reply-head">
            <span className="eyebrow turn__label">What I understood</span>
            <span className="turn__confidence mono" data-level={turn.reply.confidence}>
              {turn.reply.confidence}
            </span>
          </header>
          <p className="turn__understood">{turn.reply.understood}</p>

          {turn.reply.say ? <p className="turn__say">{turn.reply.say}</p> : null}

          {turn.outcomes?.length ? <OutcomeChips outcomes={turn.outcomes} /> : null}

          {turn.reply.questions?.length ? (
            <>
              <div className="eyebrow turn__label">Questions</div>
              <ul className="turn__questions">
                {turn.reply.questions.map((q, i) => (
                  <li key={i}>{q}</li>
                ))}
              </ul>
            </>
          ) : null}

          {turn.reply.draftPrompt !== undefined || turn.draft ? (
            <>
              <div className="eyebrow turn__label">Draft prompt</div>
              <textarea
                className="turn__draft mono"
                spellCheck={false}
                value={turn.draft}
                onChange={(e) => onEdit(e.target.value)}
                /* Escape gets through — see the note on the composer. */
                onKeyDown={(e) => {
                  if (e.key !== 'Escape') e.stopPropagation()
                }}
              />

              <div className="turn__actions">
                <button type="button" className="ghost-btn turn__action" onClick={copy}>
                  {copied ? <Icon name="check" size={13} /> : null}
                  {copied ? 'Copied' : 'Copy'}
                </button>
                <button
                  ref={sendRef}
                  type="button"
                  className="ghost-btn turn__action turn__action--send"
                  disabled={!turn.draft.trim()}
                  onClick={() => setPickerOpen(true)}
                >
                  Send to pane
                  <Icon name="send" size={13} />
                </button>
              </div>
            </>
          ) : null}

          <Popover
            anchor={sendRef.current}
            open={pickerOpen}
            onClose={() => setPickerOpen(false)}
            align="end"
            side="top"
            width={268}
            label="Send draft to pane"
          >
            <PopoverSection title="Send draft to">
              {options.length === 0 ? (
                <div className="popover__hint">No panes open in this project yet.</div>
              ) : (
                options.map((option) => {
                  const live = option.status === 'live' || option.status === 'starting'
                  return (
                    <PopoverRow
                      key={option.paneId}
                      disabled={!live}
                      onClick={() => {
                        onSend(option, turn.draft)
                        setPickerOpen(false)
                      }}
                    >
                      <AgentBadge profile={option.profile} size="sm" />
                      <span className="turn__pane-title truncate">{option.title}</span>
                      <span className="turn__pane-tab mono truncate">{option.tabTitle}</span>
                      {live ? null : <span className="turn__pane-dead mono">{option.status}</span>}
                    </PopoverRow>
                  )
                })
              )}
            </PopoverSection>
            <div className="popover__hint">Typed in without Enter — read it, then run it yourself.</div>
          </Popover>
        </div>
      ) : null}
    </article>
  )
}
