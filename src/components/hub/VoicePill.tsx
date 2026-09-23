import { useRef, type ReactNode } from 'react'
import { hotkeyLabel } from '@/hooks/useDictation'
import { uiCommands } from '@/lib/uiCommands'
import { useApp } from '@/state/AppState'
import { useDictation } from '@/state/Dictation'
import { hubLook, isLive, LOOK_GLYPH, LOOK_WORD, PROVIDER_SHORT, useHubPreview, useHubView } from './hubView'
import { Waveform } from './Waveform'
import './VoicePill.css'

/**
 * The dock's voice socket: one glass capsule that says, in a waveform and a
 * word, what the voice side of Forge is doing right now.
 *
 * Its body is the mode switch — Dictate ⇄ Live (Ctrl+Shift+L). Dictate is
 * Parakeet into whatever has focus, exactly as it has always worked; Live is
 * the voice hub, on whichever brain Settings picked (Claude + Parakeet when
 * there is no key). While live, two chips sit beside it:
 *
 *   Quiet     the mic off for a moment; the session stays up. The pill says
 *             "muted" until you lift it.
 *   Discuss   talk it through, change nothing — tools that would change Forge
 *             are held as a plan until you say (or press) Go. Realtime only;
 *             on Claude the chip says so instead of pretending.
 *
 * It never takes focus: every control prevents the mousedown focus move, so
 * the pane or the composer you were typing in keeps the keyboard.
 */
export function VoicePill(): ReactNode {
  const { state } = useApp()
  const hub = useHubView()
  const preview = useHubPreview()
  const dictation = useDictation()
  const live = isLive(hub.phase)
  const look = hubLook(hub.phase, hub.muted)
  const planned = hub.actions.filter((a) => a.status === 'planned').length

  const dictating = preview?.dictating ?? dictation.listening
  const dictLevel = useRef(0)
  dictLevel.current = preview?.dictating ? (preview.dictationLevel ?? 0.5) : dictation.status.level
  const dictLook = dictating ? 'listening' : dictation.needsSetup ? 'error' : 'offline'
  const dictWord = dictating
    ? 'listening'
    : dictation.needsSetup
      ? 'set up'
      : dictation.status.phase === 'finishing'
        ? 'writing'
        : 'ready'

  const key = hotkeyLabel(state.settings.sttHotkey || 'ControlRight')
  const provider = PROVIDER_SHORT[hub.provider]
  const title = live
    ? `Live talk with ${provider} — ${LOOK_WORD[look]}. Click to go back to dictation (Ctrl+Shift+L).`
    : `Dictation (${key}) — ${dictWord}. Click for live talk with ${provider} (Ctrl+Shift+L).`

  const noFocus = (e: React.MouseEvent): void => e.preventDefault()

  return (
    <div className="vpill" data-mode={live ? 'live' : 'dictate'} data-look={live ? look : dictLook}>
      <button
        type="button"
        className="vpill__main"
        title={title}
        aria-label={title}
        aria-pressed={live}
        onMouseDown={noFocus}
        onClick={() => (live ? hub.stop() : hub.start())}
        onContextMenu={(e) => {
          e.preventDefault()
          uiCommands.run('set-mode', 'talk')
        }}
      >
        <span className="vpill__wave">
          {live ? (
            <Waveform look={look} read={hub.readLevels} width={46} height={22} />
          ) : (
            <Waveform
              look={dictLook}
              read={() => ({ mic: dictLevel.current, out: 0 })}
              width={46}
              height={22}
              strands={2}
            />
          )}
        </span>
        <span className="vpill__text">
          <span className="vpill__eyebrow">
            <span className="vpill__seg" data-on={live ? undefined : 'true'}>
              Dictate
            </span>
            <span className="vpill__swap" aria-hidden="true">
              ⇄
            </span>
            <span className="vpill__seg" data-on={live ? 'true' : undefined}>
              Live
            </span>
          </span>
          <span className="vpill__word">
            <span className="vpill__glyph" aria-hidden="true">
              {live ? LOOK_GLYPH[look] : dictating ? LOOK_GLYPH.listening : dictation.needsSetup ? '!' : '○'}
            </span>
            {live ? LOOK_WORD[look] : dictWord}
          </span>
        </span>
      </button>

      {live ? (
        <span className="vpill__chips">
          <button
            type="button"
            className="vpill__chip"
            data-on={hub.muted ? 'true' : undefined}
            aria-pressed={hub.muted}
            title={hub.muted ? 'Quiet is on — the mic is off. Click to listen again (Ctrl+Shift+M)' : 'Quiet — mic off for a moment, the session stays up (Ctrl+Shift+M)'}
            onMouseDown={noFocus}
            onClick={() => hub.setMuted(!hub.muted)}
          >
            Quiet
          </button>
          <button
            type="button"
            className="vpill__chip"
            data-on={hub.discussionMode ? 'true' : undefined}
            data-unavailable={hub.discussionAvailable ? undefined : 'true'}
            aria-pressed={hub.discussionMode}
            aria-disabled={!hub.discussionAvailable}
            title={
              hub.discussionAvailable
                ? hub.discussionMode
                  ? 'Discussing — nothing that changes Forge runs until you say "go"'
                  : 'Discuss — talk it through; actions are held as a plan until you say "go"'
                : 'Discussion mode needs a live provider (Gemini Live or GPT Realtime) — Claude cannot hold a plan'
            }
            onMouseDown={noFocus}
            onClick={() => {
              if (hub.discussionAvailable) hub.setDiscussionMode(!hub.discussionMode)
            }}
          >
            {hub.discussionAvailable ? 'Discuss' : 'Discuss · live only'}
            {hub.discussionMode && planned ? <span className="vpill__count">{planned}</span> : null}
          </button>
          {hub.discussionMode && planned ? (
            <button
              type="button"
              className="vpill__go"
              title={`Run the ${planned} planned step${planned === 1 ? '' : 's'} now — the same as saying "go"`}
              onMouseDown={noFocus}
              onClick={() => hub.go()}
            >
              Go
            </button>
          ) : null}
        </span>
      ) : null}
    </div>
  )
}
