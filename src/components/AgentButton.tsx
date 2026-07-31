import { useEffect, useRef, type ReactNode } from 'react'
import { useApp } from '@/state/AppState'
import { useVoiceAgent } from '@/state/VoiceAgent'
import './AgentButton.css'

/**
 * The agent switch, in the status bar.
 *
 * Arming the voice agent used to mean finding the floating hub: drag the pill
 * out of its socket, wait for the card, press the round dial. Three gestures to
 * do the thing Steve does most — "when I press the agent button, it just starts
 * listening like the voice agent should". So the switch now lives next to the
 * dictation pill, always in reach, and one press is the whole of it.
 *
 * It is deliberately *not* the dictation pill with a modifier. Forge has two
 * microphones and the confusion between them is the oldest complaint in this
 * corner of the app: the pill dictates into the pane you are looking at, this
 * hands everything you say to the agent. Two jobs, two buttons, side by side,
 * each saying which one it is.
 *
 * Nothing here runs an engine. `toggleAgent` is the one in VoiceAgent.tsx that
 * every other surface calls — the hub's dial, the overlay's pill, Escape — so
 * this cannot become a second agent, only a second way to reach the first.
 */

/** What the word under the dot says, per phase. */
const PHASE_TITLE: Record<string, string> = {
  off: 'Talk to the agent — everything you say goes to Forge, not the pane',
  warming: 'Agent starting — loading the speech model…',
  listening: 'Agent is listening — press to stop, or Esc',
  thinking: 'Agent is thinking about what you said — press to stop',
  speaking: 'Agent is talking — press to interrupt it',
  replied: 'Agent is listening — press to stop, or Esc',
  error: 'The agent hit a problem — it is still listening'
}

export function AgentButton(): ReactNode {
  const { actions } = useApp()
  const { phase, armed, levelRef, toggleAgent } = useVoiceAgent()
  const dotRef = useRef<HTMLSpanElement | null>(null)

  /**
   * The dot breathes with your voice while it is listening.
   *
   * Straight to the DOM inside a rAF loop, the same way the pill's meter and the
   * hub's ring are driven: levels arrive ten times a second, and routing a
   * decoration through React state would re-render the status bar continuously.
   */
  useEffect(() => {
    const dot = dotRef.current
    if (!dot || phase !== 'listening') {
      if (dot) dot.style.transform = ''
      return undefined
    }
    let raf = 0
    let smoothed = 0
    const frame = (t: number): void => {
      const breathe = 0.08 + 0.06 * Math.sin(t / 600)
      const level = Math.max(breathe, Math.min(1, levelRef.current * 1.9))
      smoothed += (level - smoothed) * 0.28
      dot.style.transform = `scale(${(1 + smoothed * 0.55).toFixed(3)})`
      raf = requestAnimationFrame(frame)
    }
    raf = requestAnimationFrame(frame)
    return () => cancelAnimationFrame(raf)
  }, [phase, levelRef])

  /**
   * Say what just happened, in words.
   *
   * "it notifies it's an agent" — the light on the button is the permanent tell,
   * but the moment of the switch deserves a sentence, because what changes is
   * where every word you say for the next few minutes ends up. The status bar's
   * notice clears itself after a few seconds.
   *
   * A press *while it is talking* is a barge-in, not a switch: `toggleAgent`
   * shuts the reply up and leaves the agent armed, so there is nothing to
   * announce and announcing it would be a lie.
   */
  const onClick = (): void => {
    if (phase === 'speaking') {
      toggleAgent()
      return
    }
    const turningOn = !armed
    toggleAgent()
    actions.setNotice(
      turningOn
        ? 'Agent mode on — everything you say now goes to the agent'
        : 'Agent mode off — dictation goes back to the focused pane'
    )
  }

  return (
    <button
      type="button"
      className="agentbtn"
      data-phase={phase}
      aria-pressed={armed}
      aria-label={armed ? 'Stop talking to the agent' : 'Talk to the agent'}
      title={PHASE_TITLE[phase] ?? PHASE_TITLE.off}
      onClick={onClick}
    >
      <span className="agentbtn__dot" ref={dotRef} aria-hidden="true" />
      <span className="agentbtn__word">agent</span>
    </button>
  )
}
