import { useCallback, useState, type ReactNode } from 'react'
import { useApp, VOICE_PANEL_MAX, VOICE_PANEL_MIN } from '@/state/AppState'
import { useVoiceAgent } from '@/state/VoiceAgent'
import { Icon } from './Icon'
import {
  BrainChip,
  DegradedLink,
  LastLine,
  ReplyModeToggle,
  VoiceComposer,
  VoiceDial,
  VoiceLog,
  VoiceOnlyNote
} from './VoiceSurface'
import './VoicePanel.css'

/**
 * The voice agent panel — talk to Forge, and talk about what to build.
 *
 * The panel is a *frame* now, not the agent. Everything it shows lives in
 * src/state/VoiceAgent.tsx (one engine, one microphone, one voice) and is
 * rendered by the parts in VoiceSurface.tsx, so the floating hub card can show
 * exactly the same conversation without either of them doubling a subscription
 * or speaking a reply twice. What is left here is what is genuinely the panel's
 * own: its width, its resizer, its header and whether it is open at all.
 */
export function VoicePanel(): ReactNode {
  const { state, actions } = useApp()
  const { replyMode } = useVoiceAgent()
  const [dragWidth, setDragWidth] = useState<number | null>(null)

  const open = state.settings.voicePanelOpen

  /* ------------------------------------------------------------- resizing */

  const width = dragWidth ?? state.settings.voicePanelWidth

  const onResizeDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      e.preventDefault()
      const startX = e.clientX
      const startW = state.settings.voicePanelWidth
      let latest = startW

      const clamp = (n: number): number => Math.min(VOICE_PANEL_MAX, Math.max(VOICE_PANEL_MIN, n))
      const onMove = (ev: PointerEvent): void => {
        latest = clamp(startW + (startX - ev.clientX))
        setDragWidth(latest)
      }
      const onUp = (): void => {
        window.removeEventListener('pointermove', onMove)
        window.removeEventListener('pointerup', onUp)
        window.removeEventListener('pointercancel', onUp)
        setDragWidth(null)
        actions.setVoicePanelWidth(latest)
      }
      window.addEventListener('pointermove', onMove)
      window.addEventListener('pointerup', onUp)
      window.addEventListener('pointercancel', onUp)
    },
    [actions, state.settings.voicePanelWidth]
  )

  /* --------------------------------------------------------------- render */

  if (!open) {
    // Stays mounted so the panel's own furniture (width, resizer) survives a
    // collapse. The conversation itself is not in here to lose.
    return <aside className="voice" data-open="false" aria-hidden="true" />
  }

  return (
    <aside className="voice" data-open="true" style={{ width }} aria-label="Voice agent">
      <div
        className="voice__resizer"
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize voice panel"
        onPointerDown={onResizeDown}
        onDoubleClick={() => actions.setVoicePanelWidth(380)}
      />

      <header className="voice__head">
        <span className="voice__mark" title="The voice agent — say what you want and it does it">
          <Icon name="mic" size={14} />
        </span>
        <h2 className="voice__title">Voice Agent</h2>
        <BrainChip />
        <span className="voice__spacer" />
        <ReplyModeToggle />
        <button
          type="button"
          className="ghost-btn voice__icon-btn"
          title="Voice settings — brain, keys and model (Ctrl+,)"
          aria-label="Voice settings"
          onClick={() => actions.openSettings('models')}
        >
          <Icon name="gear" size={13} />
        </button>
        <button
          type="button"
          className="ghost-btn voice__icon-btn"
          title="Hide the voice agent (Ctrl+Shift+G)"
          aria-label="Hide the voice agent"
          onClick={() => actions.toggleVoicePanel()}
        >
          <Icon name="close" size={13} />
        </button>
      </header>

      {/*
        Why the settings live elsewhere: this panel used to hold an expandable
        settings section, and scrolled down inside it there was no way back out —
        the gear that opened it was off the top of the panel and nothing else
        said "done". A one-line status that links to the real Settings page
        cannot trap anybody.
      */}
      <DegradedLink />

      <VoiceDial />

      {/*
        Voice-only mode is a different panel, not a decorated one. If the agent
        is talking to you, the transcript and the text box are just furniture in
        front of your terminals — so they go, and one line of status stays.
      */}
      {replyMode === 'voice' ? (
        <>
          <LastLine />
          <VoiceOnlyNote />
        </>
      ) : (
        <>
          <VoiceLog />
          <VoiceComposer autoFocus />
        </>
      )}
    </aside>
  )
}
