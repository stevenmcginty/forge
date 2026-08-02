import { useEffect, useRef, type ReactNode } from 'react'
import { useApp } from '@/state/AppState'
import { useVoiceAgent } from '@/state/VoiceAgent'
import { jarvisPresence, type JarvisPresence } from './VoiceSurface'
import './AgentButton.css'

/**
 * Jarvis's docked presence, in the status bar.
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
 * hands everything you say to Jarvis. Two jobs, two buttons, side by side,
 * each saying which one it is.
 *
 * The tell is a miniature of the orb every other surface draws — the same
 * presence grammar at 9px, so his state reads from the corner of an eye:
 * ember breathing while he monitors for his name, blooming with your voice
 * while he takes it down, ticking while he thinks, cadenced while he talks,
 * amber when something failed.
 *
 * Nothing here runs an engine. `toggleAgent` is the one in VoiceAgent.tsx that
 * every other surface calls — the hub's orb, the overlay's orb, Escape — so
 * this cannot become a second agent, only a second way to reach the first.
 */

/** What hovering the orb tells you, per presence. */
const PRESENCE_TITLE: Record<JarvisPresence, string> = {
  off: 'Talk to Jarvis — everything you say goes to Forge, not the pane',
  warming: 'Jarvis is waking — loading the speech model…',
  monitoring: 'Jarvis is on watch — say “hey Jarvis”, or press to talk',
  listening: 'Jarvis is listening — press to stop, or Esc',
  capturing: 'Jarvis heard you — taking it down',
  dictating: 'Dictating — every word is held until you say “stop dictation”',
  thinking: 'Jarvis is thinking about what you said — press to stop',
  speaking: 'Jarvis is talking — press to interrupt him',
  replied: 'Jarvis answered — still listening',
  error: 'Jarvis hit a problem — he is still listening'
}

export function AgentButton(): ReactNode {
  const { actions } = useApp()
  const { phase, armed, wakeMode, capturing, dictating, levelRef, toggleAgent } = useVoiceAgent()
  const orbRef = useRef<HTMLSpanElement | null>(null)
  const presence = jarvisPresence(phase, wakeMode, capturing, dictating)
  const live = presence === 'listening' || presence === 'capturing' || presence === 'dictating'

  /**
   * The orb breathes with your voice while he is listening.
   *
   * Straight to the DOM inside a rAF loop, the same way the pill's meter and
   * the dial's ring are driven: levels arrive ten times a second, and routing a
   * decoration through React state would re-render the status bar continuously.
   * The loop only runs while he is actually listening — monitoring is pure CSS.
   */
  useEffect(() => {
    const orb = orbRef.current
    if (!orb || !live) {
      if (orb) orb.style.transform = ''
      return undefined
    }
    let raf = 0
    let smoothed = 0
    const frame = (t: number): void => {
      const breathe = 0.08 + 0.06 * Math.sin(t / 600)
      const level = Math.max(breathe, Math.min(1, levelRef.current * 1.9))
      smoothed += (level - smoothed) * 0.28
      orb.style.transform = `scale(${(1 + smoothed * 0.5).toFixed(3)})`
      raf = requestAnimationFrame(frame)
    }
    raf = requestAnimationFrame(frame)
    return () => cancelAnimationFrame(raf)
  }, [live, levelRef])

  /**
   * Say what just happened, in words.
   *
   * The light on the button is the permanent tell, but the moment of the switch
   * deserves a sentence, because what changes is where every word you say for
   * the next few minutes ends up. The status bar's notice clears itself after a
   * few seconds.
   *
   * A press *while he is talking* is a barge-in, not a switch: `toggleAgent`
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
        ? 'Jarvis is listening — everything you say now goes to him'
        : 'Jarvis stood down — dictation goes back to the focused pane'
    )
  }

  return (
    <button
      type="button"
      className="agentbtn"
      data-presence={presence}
      aria-pressed={armed}
      aria-label={armed ? 'Stop talking to Jarvis' : 'Talk to Jarvis'}
      title={PRESENCE_TITLE[presence] ?? PRESENCE_TITLE.off}
      onClick={onClick}
    >
      <span className="agentbtn__orb" ref={orbRef} aria-hidden="true">
        <span className="agentbtn__iris" />
      </span>
      <span className="agentbtn__word">jarvis</span>
    </button>
  )
}
