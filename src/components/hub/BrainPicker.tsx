import { memo, useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import {
  agentBrainSpec,
  isForgeBrainAgent,
  migrateAgentBrain,
  voiceMenuRows,
  type AgentBrainId,
  type AgentBrainKind,
  type AgentBrainSpec
} from '@shared/agent-brain'
import { useBrainProbes } from '@/hooks/useBrainStatus'
import { barBrainLabel, brainSwitchWaits, brainUnavailable, forgeBrainStatus, statusOf, type BrainStatus } from '@/lib/brainStatus'
import { resolveAgentBrain } from '@/lib/realtime/provider'
import { useApp } from '@/state/AppState'
import { ContextRing, contextWords, useBrainContext } from '../brain/BrainContext'
import { BrainIntro } from '../brain/BrainIntro'
import { brainSnapshot, startBrainFeed, useBrain } from '../brain/brainStore'
import { Icon } from '../Icon'
import { Popover } from '../Popover'
import { BrainMark, brandStyle } from './BrainMark'
import { listenState, useHubView } from './hubView'
import '../brain/Brain.css'
import './BrainPicker.css'

/**
 * The voice agent, picked in place: the right half of the voice unit (Listen
 * is the left — see VoicePill.css), naming the brain that will actually answer
 * by its mark and its name, and a short menu (Settings → Voice menu) to switch
 * to without opening Settings. More shows the rest. In a narrow window the chip keeps only the mark.
 *
 * The chip reads the setting the same way Settings' Main agent card does
 * (resolveAgentBrain), so a pick that fell back for want of a key says so in
 * words: "Claude · Gemini Live needs a key". The menu's status words come from
 * the same probe as the card's (hooks/useBrainStatus + lib/brainStatus); a
 * brain that needs a key, is not installed or is not logged in cannot be
 * picked here, and says which. Picking writes `agentBrain`, exactly as the
 * card does. The rows are the visible list (shared/agent-brain.ts
 * VISIBLE_AGENT_BRAINS): Forge Brain, Gemini Live, GPT Realtime.
 *
 * Forge Brain can be picked while it is off: the pick is kept and the menu
 * turns into the brain's own intro (components/brain/BrainIntro), with Turn on.
 *
 * Picked while Listen is on, a Parakeet brain answers from the next turn; a
 * pick that involves a live session (ending one, or opening one) waits for the
 * next press of Listen — its row says so (lib/brainStatus `brainSwitchWaits`).
 *
 * A mouse press never takes focus (the pane or the bar keeps the keys). Opened
 * from the keyboard, the menu takes focus, the arrows move through it, and
 * Escape brings focus back to the chip.
 */
export const BrainPicker = memo(function BrainPicker(): ReactNode {
  const { state, actions } = useApp()
  const s = state.settings
  const hub = useHubView()
  const [chip, setChip] = useState<HTMLButtonElement | null>(null)
  const [open, setOpen] = useState(false)
  // Forge Brain picked while it is off: the pop-over shows its intro instead of the menu.
  const [intro, setIntro] = useState(false)
  const brainStatus = useBrain().status
  const byKeyboard = useRef(false)

  const chosen = s.agentBrain ?? migrateAgentBrain(s.voiceHubProvider, s.voiceBrain)
  const resolved = resolveAgentBrain(chosen, s)
  const label = barBrainLabel(chosen, resolved)
  const fellBack = label !== agentBrainSpec(resolved.brain).label
  // Forge Brain answering: how full its context is, on the chip.
  const context = useBrainContext()
  const showContext = isForgeBrainAgent(resolved.brain) && context.shown

  const close = useCallback((): void => {
    setOpen(false)
    setIntro(false)
    // Focus inside the menu goes back to the chip; focus anywhere else (a
    // pane, the bar's text, an outside click's target) stays where it is.
    const at = document.activeElement
    if (chip && (at === document.body || (at instanceof Element && at.closest('.bpick')))) chip.focus()
  }, [chip])

  return (
    <>
      <button
        ref={setChip}
        type="button"
        className="bpick-chip"
        data-open={open ? 'true' : undefined}
        data-fallback={fellBack ? 'true' : undefined}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`Voice agent: ${label}${showContext ? `, ${contextWords(context)}` : ''}. Pick another`}
        title={`Voice agent: ${label} — pick who answers Listen`}
        onMouseDown={(e) => e.preventDefault()}
        onClick={(e) => {
          byKeyboard.current = e.detail === 0
          setIntro(false)
          setOpen((v) => !v)
        }}
      >
        <span className="bpick-chip__tile mplate" style={brandStyle(resolved.brain)} aria-hidden="true">
          <BrainMark brain={resolved.brain} size={isForgeBrainAgent(resolved.brain) ? 16 : 12} />
          {/* A fallback: a warn diamond on the mark, and the words say why. */}
          {fellBack ? <span className="bpick-chip__mark" /> : null}
        </span>
        <span className="bpick-chip__name truncate">{label}</span>
        {showContext ? <ContextRing view={context} /> : null}
        <Icon name="chevronDown" size={11} className="bpick-chip__chev" />
      </button>
      <Popover anchor={chip} open={open} onClose={close} align="start" width={intro ? 412 : 336} label={intro ? 'Forge Brain' : 'Voice agent'}>
        {intro ? (
          <BrainIntro status={brainStatus} onOn={close} onClose={close} />
        ) : (
          <BrainMenu
            chosen={chosen}
            current={resolved.brain}
            listening={listenState(hub).on}
            liveRealtime={hub.realtime}
            takeFocus={byKeyboard.current}
            onPick={(id) => {
              if (id !== chosen) actions.patchSettings({ agentBrain: id })
              if (isForgeBrainAgent(id) && brainSnapshot().status?.enabled !== true) setIntro(true)
              else close()
            }}
            onSettings={() => {
              close()
              actions.openSettings('voice')
            }}
          />
        )}
      </Popover>
    </>
  )
})

const ITEMS = '[role^="menuitem"]:not(:disabled)'

function BrainMenu({
  chosen,
  current,
  listening,
  liveRealtime,
  takeFocus,
  onPick,
  onSettings
}: {
  chosen: AgentBrainId
  current: AgentBrainId
  listening: boolean
  liveRealtime: boolean
  takeFocus: boolean
  onPick: (id: AgentBrainId) => void
  onSettings: () => void
}): ReactNode {
  const { state } = useApp()
  const s = state.settings
  // Mounted only while the menu is open, so the probes run when you look.
  const { probes } = useBrainProbes(s)
  const ref = useRef<HTMLDivElement | null>(null)
  const [more, setMore] = useState(false)
  // Forge Brain's row reads the brain's live status (components/brain/brainStore).
  useEffect(() => startBrainFeed(), [])
  const liveBrain = useBrain().status
  const rows = voiceMenuRows(s.voiceMenu, current)
  // While Forge Brain is on it is always in the short list: talking straight
  // to it is the point of turning it on.
  const lift = liveBrain?.enabled === true ? rows.rest.filter((spec) => isForgeBrainAgent(spec.id)) : []
  const first = [...rows.first, ...lift]
  const rest = rows.rest.filter((spec) => !lift.includes(spec))

  // From the keyboard: onto the brain in use. The popover is placed a frame
  // after it mounts, and a hidden button cannot take focus before that.
  useEffect(() => {
    if (!takeFocus) return undefined
    const raf = window.requestAnimationFrame(() => {
      const root = ref.current
      const here = root?.querySelector<HTMLButtonElement>(`[aria-checked="true"]:not(:disabled)`)
      ;(here ?? root?.querySelector<HTMLButtonElement>(ITEMS))?.focus()
    })
    return () => window.cancelAnimationFrame(raf)
  }, [takeFocus])

  const onKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp' && e.key !== 'Home' && e.key !== 'End') return
    const items = Array.from(ref.current?.querySelectorAll<HTMLButtonElement>(ITEMS) ?? [])
    if (items.length === 0) return
    e.preventDefault()
    const i = items.indexOf(document.activeElement as HTMLButtonElement)
    const next =
      e.key === 'Home'
        ? 0
        : e.key === 'End'
          ? items.length - 1
          : e.key === 'ArrowDown'
            ? (i + 1) % items.length
            : (i <= 0 ? items.length : i) - 1
    items[next]?.focus()
  }

  const rowFor = (spec: AgentBrainSpec): ReactNode => {
    const inUse = spec.id === current
    const status = isForgeBrainAgent(spec.id) ? forgeBrainStatus(liveBrain) : statusOf(spec, s, probes[spec.id])
    // Forge Brain off is still a pick: picking it shows how to turn it on.
    const off = !inUse && !isForgeBrainAgent(spec.id) && brainUnavailable(status)
    const sub =
      spec.id === chosen && chosen !== current
        ? 'Picked — add it in Voice settings'
        : !off && brainSwitchWaits({ listening, liveRealtime, current, target: spec.id })
          ? 'Starts next time you press Listen'
          : null
    return (
      <button
        key={spec.id}
        type="button"
        role="menuitemradio"
        aria-checked={inUse}
        className="popover__row bpick__row"
        data-selected={inUse ? 'true' : undefined}
        data-note={sub ? 'true' : undefined}
        disabled={off}
        title={probes[spec.id]?.result?.reason}
        onClick={() => onPick(spec.id)}
      >
        <span className="bpick__tile mplate" data-look={inUse ? 'use' : off ? 'off' : undefined} style={brandStyle(spec.id)} aria-hidden="true">
          <BrainMark brain={spec.id} size={isForgeBrainAgent(spec.id) ? 20 : 14} />
        </span>
        <span className="bpick__text">
          <span className="bpick__name">{spec.label}</span>
          <span className="bpick__sub">{sub ?? rowNote(spec, status, off)}</span>
        </span>
        {inUse ? (
          <span className="bpick__state" data-tone="use">
            in use
            <Icon name="check" size={12} className="bpick__check" />
          </span>
        ) : (
          <span className="bpick__state" data-tone={status.tone}>
            <span className="bpick__glyph" aria-hidden="true">
              {status.glyph}
            </span>
            {status.word}
          </span>
        )}
      </button>
    )
  }

  return (
    <div ref={ref} className="bpick" role="menu" aria-label="Voice agent" onKeyDown={onKeyDown}>
      <div className="bpick__head">
        <span className="eyebrow">Voice agent</span>
        <span className="bpick__hint">answers Listen</span>
      </div>
      {first.map((spec) => rowFor(spec))}
      {rest.length > 0 ? (
        <button
          type="button"
          role="menuitem"
          className="popover__row bpick__row"
          aria-expanded={more}
          onClick={() => setMore((v) => !v)}
        >
          {more ? 'Less' : 'More'}
        </button>
      ) : null}
      {more ? rest.map((spec) => rowFor(spec)) : null}
      <div className="popover__divider" />
      <button type="button" role="menuitem" className="popover__row bpick__row bpick__settings" onClick={onSettings}>
        <span className="bpick__tile" data-look="plain" aria-hidden="true">
          <Icon name="gear" size={13} />
        </span>
        <span className="bpick__text">
          <span className="bpick__name">Voice settings…</span>
        </span>
      </button>
    </div>
  )
}

const KIND_WORD: Record<AgentBrainKind, string> = {
  realtime: 'Live audio',
  session: 'Agent session',
  json: 'Text turns',
  brain: 'Straight to the brain'
}

/**
 * A row's second line: what the brain is and how it signs in — or, when it
 * cannot be picked, what to do about it, in words.
 */
function rowNote(spec: AgentBrainSpec, status: BrainStatus, off: boolean): string {
  // "your ChatGPT login (codex login)" reads "your ChatGPT login" on one line.
  const auth = spec.auth.replace(/\s*\(.*\)\s*$/, '')
  if (off) {
    if (status.word === 'Needs key') return `Add your ${auth} in Settings`
    if (status.word === 'Not logged in') return `Log in first — ${auth}`
    if (status.word === 'Not installed') return 'Not on this computer yet'
  }
  if (isForgeBrainAgent(spec.id)) {
    return status.word === 'Off' ? 'Off — pick it to see how to turn it on' : `${KIND_WORD[spec.kind]} · Parakeet hears, your voice setting speaks`
  }
  return `${KIND_WORD[spec.kind]} · ${auth}`
}
