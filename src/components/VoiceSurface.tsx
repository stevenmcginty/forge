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

/* ----------------------------------------------------------- agent button */

/** What the circle says about itself, by state. */
const AGENT_LABEL: Record<AgentPhase, { title: string; sub: string }> = {
  off: { title: 'Agent', sub: 'Tap to talk to your agent' },
  warming: { title: 'Warming up', sub: 'loading the speech engine…' },
  listening: { title: 'Listening', sub: 'say what you want — tap to stop' },
  thinking: { title: 'Thinking', sub: 'working on it…' },
  // Not "mic off while I talk" any more — it is not. The AEC'd microphone is
  // open for the whole reply and talking over it is the intended way to stop
  // it, so the hint says so. See src/lib/bargein.ts.
  speaking: { title: 'Speaking', sub: 'talk over me any time' },
  replied: { title: 'Answered', sub: 'still listening' },
  error: { title: 'That failed', sub: 'still listening — try again' }
}

/**
 * The hero. One big round button that says, without a manual, "this is the
 * agent, and it is either on or it is not".
 *
 * The ring is driven straight from the mic level inside a rAF loop rather than
 * through React state: levels arrive ten times a second and the panel has a
 * conversation in it. Nothing here re-renders while you speak.
 *
 * `compact` is the floating pill's version: the same circle and the same
 * states, at 34px, with the words left off — the pill is 56px tall and there is
 * nowhere to put them.
 *
 * Both sizes are one component on purpose. The pill's circle and the card's are
 * the same agent in the same phase, and two copies of this rAF loop would drift
 * apart the first time either was tuned.
 */
export function VoiceDial({ compact }: { compact?: boolean } = {}): ReactNode {
  const { phase, armed, levelRef, thinkingFor, holding, sttError, cancelAllHolds, toggleAgent } = useVoiceAgent()
  const ringRef = useRef<HTMLSpanElement | null>(null)

  useEffect(() => {
    const ring = ringRef.current
    if (!ring) return undefined
    if (phase !== 'listening') {
      ring.style.transform = ''
      ring.style.opacity = ''
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
      raf = requestAnimationFrame(frame)
    }
    raf = requestAnimationFrame(frame)
    return () => cancelAnimationFrame(raf)
  }, [phase, levelRef])

  const label = AGENT_LABEL[phase]
  // Never a silent dead circle: past five seconds it starts counting out loud.
  const sub =
    phase === 'thinking' && thinkingFor >= THINKING_PATIENCE_MS / 1000
      ? `still thinking… ${thinkingFor}s`
      : phase === 'error' && sttError
        ? sttError
        : label.sub

  return (
    <div className="agentdial" data-phase={phase} data-compact={compact ? 'true' : undefined}>
      <button
        type="button"
        className="agentdial__btn"
        data-phase={phase}
        aria-pressed={armed}
        aria-label={armed ? 'Stop talking to the agent' : 'Talk to your agent'}
        title={armed ? 'Agent mode is on — tap or press Esc to stop' : 'Tap to talk to your agent'}
        onClick={toggleAgent}
      >
        <span className="agentdial__ring" ref={ringRef} aria-hidden="true" />
        <span className="agentdial__spin" aria-hidden="true" />
        <span className="agentdial__core" aria-hidden="true">
          <Icon name={armed ? 'voice' : 'mic'} size={compact ? 14 : 26} />
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

/* ------------------------------------------------------- voice-only line */

/** Voice-only mode's whole transcript: the most recent thing that happened. */
export function LastLine(): ReactNode {
  const { turns } = useVoiceAgent()
  const last = turns[turns.length - 1]
  let text = 'Nothing yet — tap the circle and talk.'
  let tone: 'idle' | 'ok' | 'warn' = 'idle'
  if (last?.kind === 'command') {
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

/** The conversation. Scrolls itself to the bottom whenever a turn lands. */
export function VoiceLog(): ReactNode {
  const { turns, brainStatus, paneOptions, sendToPane, editDraft } = useVoiceAgent()
  const logRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    const log = logRef.current
    if (log) log.scrollTop = log.scrollHeight
  }, [turns])

  return (
    <div className="voice__log" ref={logRef}>
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
  const { draftPhrase, setDraftPhrase, submitPhrase } = useVoiceAgent()
  const composerRef = useRef<HTMLTextAreaElement | null>(null)

  useEffect(() => {
    if (autoFocus) composerRef.current?.focus()
  }, [autoFocus])

  return (
    <div className="voice__composer">
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
