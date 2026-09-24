import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { AGENT_BRAINS, agentBrainSpec, migrateAgentBrain, type AgentBrainId, type AgentBrainKind, type AgentBrainSpec } from '@shared/agent-brain'
import { useBrainProbes } from '@/hooks/useBrainStatus'
import { barBrainLabel, brainSwitchWaits, brainUnavailable, statusOf, type BrainStatus } from '@/lib/brainStatus'
import { resolveAgentBrain } from '@/lib/realtime/provider'
import { useApp } from '@/state/AppState'
import { Icon } from '../Icon'
import { Popover } from '../Popover'
import { BrainMark } from './BrainMark'
import { listenState, useHubView } from './hubView'
import './BrainPicker.css'

/**
 * The voice agent, picked in place: the right half of the voice unit (Listen
 * is the left — see VoicePill.css), naming the brain that will actually answer
 * by its mark and its name, and a menu of every brain (AGENT_BRAINS) to switch
 * to without opening Settings. In a narrow window the chip keeps only the mark.
 *
 * The chip reads the setting the same way Settings' Main agent card does
 * (resolveAgentBrain), so a pick that fell back for want of a key says so in
 * words: "Claude · Gemini Live needs a key". The menu's status words come from
 * the same probe as the card's (hooks/useBrainStatus + lib/brainStatus); a
 * brain that needs a key, is not installed or is not logged in cannot be
 * picked here, and says which. Picking writes `agentBrain`, exactly as the
 * card does.
 *
 * Picked while Listen is on, a Parakeet brain answers from the next turn; a
 * pick that involves a live session (ending one, or opening one) waits for the
 * next press of Listen — its row says so (lib/brainStatus `brainSwitchWaits`).
 *
 * A mouse press never takes focus (the pane or the bar keeps the keys). Opened
 * from the keyboard, the menu takes focus, the arrows move through it, and
 * Escape brings focus back to the chip.
 */
export function BrainPicker(): ReactNode {
  const { state, actions } = useApp()
  const s = state.settings
  const hub = useHubView()
  const [chip, setChip] = useState<HTMLButtonElement | null>(null)
  const [open, setOpen] = useState(false)
  const byKeyboard = useRef(false)

  const chosen = s.agentBrain ?? migrateAgentBrain(s.voiceHubProvider, s.voiceBrain)
  const resolved = resolveAgentBrain(chosen, s)
  const label = barBrainLabel(chosen, resolved)
  const fellBack = label !== agentBrainSpec(resolved.brain).label

  const close = useCallback((): void => {
    setOpen(false)
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
        aria-label={`Voice agent: ${label}. Pick another`}
        title={`Voice agent: ${label} — pick who answers Listen`}
        onMouseDown={(e) => e.preventDefault()}
        onClick={(e) => {
          byKeyboard.current = e.detail === 0
          setOpen((v) => !v)
        }}
      >
        <span className="bpick-chip__tile" aria-hidden="true">
          <BrainMark brain={resolved.brain} size={13} />
          {/* A fallback: a warn diamond on the mark, and the words say why. */}
          {fellBack ? <span className="bpick-chip__mark" /> : null}
        </span>
        <span className="bpick-chip__name truncate">{label}</span>
        <Icon name="chevronDown" size={11} className="bpick-chip__chev" />
      </button>
      <Popover anchor={chip} open={open} onClose={close} align="start" width={336} label="Voice agent">
        <BrainMenu
          chosen={chosen}
          current={resolved.brain}
          listening={listenState(hub).on}
          liveRealtime={hub.realtime}
          takeFocus={byKeyboard.current}
          onPick={(id) => {
            if (id !== chosen) actions.patchSettings({ agentBrain: id })
            close()
          }}
          onSettings={() => {
            close()
            actions.openSettings('voice')
          }}
        />
      </Popover>
    </>
  )
}

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

  return (
    <div ref={ref} className="bpick" role="menu" aria-label="Voice agent" onKeyDown={onKeyDown}>
      <div className="bpick__head">
        <span className="eyebrow">Voice agent</span>
        <span className="bpick__hint">answers Listen</span>
      </div>
      {AGENT_BRAINS.map((spec) => {
        const inUse = spec.id === current
        const status = statusOf(spec, s, probes[spec.id])
        const off = !inUse && brainUnavailable(status)
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
            <span className="bpick__tile" data-look={inUse ? 'use' : off ? 'off' : undefined} aria-hidden="true">
              <BrainMark brain={spec.id} size={14} />
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
      })}
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
  json: 'Text turns'
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
  return `${KIND_WORD[spec.kind]} · ${auth}`
}
