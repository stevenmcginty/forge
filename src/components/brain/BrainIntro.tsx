import { useState, type ReactNode } from 'react'
import { BRAIN_ENGINE_NAME, BRAIN_ENGINES, type BrainEngine, type BrainStatus } from '@shared/brain'
import { useApp } from '@/state/AppState'
import { BrainMark } from '../hub/BrainMark'
import { BrainGlyph } from './BrainGlyph'
import { pickBrainEngine, turnBrainOn } from './brainStore'

/**
 * Forge Brain while it is off: the pop-over under the top bar's brain. Only
 * ever seen because Steve pressed the brain — off never nags. The first time,
 * it explains itself; after that it is one line and the same Turn on. Once it
 * is on, `onOn` takes him on (to the map).
 */

/** What each engine is, in a few words. */
const ENGINE_LINE: Record<BrainEngine, string> = {
  claude: 'Claude Code, on your subscription',
  codex: 'OpenAI Codex CLI',
  gemini: 'Google Gemini CLI',
  local: 'A free model on this PC, via Ollama'
}

export function EngineMark({ engine, size = 16 }: { engine: BrainEngine; size?: number }): ReactNode {
  if (engine === 'claude') return <BrainMark brain="claude" size={size} />
  if (engine === 'codex') return <BrainMark brain="codex-cli" size={size} />
  if (engine === 'gemini') return <BrainMark brain="gemini-cli" size={size} />
  // A chip: the model runs here, on this machine.
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" aria-hidden="true">
      <rect x="3.5" y="3.5" width="9" height="9" rx="1.6" />
      <rect x="6.2" y="6.2" width="3.6" height="3.6" rx="0.6" fill="currentColor" stroke="none" />
      <path d="M6 1.2v2.3M10 1.2v2.3M6 12.5v2.3M10 12.5v2.3M1.2 6h2.3M1.2 10h2.3M12.5 6h2.3M12.5 10h2.3" strokeLinecap="round" />
    </svg>
  )
}

/**
 * Who runs it: four cards, the chosen one ringed and ticked. An engine this PC
 * cannot run is shown, disabled, with the reason in words.
 */
export function EnginePicker({
  value,
  unavailable,
  onPick,
  disabled
}: {
  value: BrainEngine
  unavailable: BrainStatus['unavailable']
  onPick: (engine: BrainEngine) => void
  disabled?: boolean
}): ReactNode {
  return (
    <div className="brainengines" role="radiogroup" aria-label="Who runs Forge Brain">
      {BRAIN_ENGINES.map((engine) => {
        const why = unavailable[engine]
        const on = engine === value
        return (
          <button
            key={engine}
            type="button"
            role="radio"
            aria-checked={on}
            className="brainengine"
            data-on={on ? 'true' : undefined}
            disabled={disabled || Boolean(why)}
            title={why ?? ENGINE_LINE[engine]}
            onClick={() => onPick(engine)}
          >
            <span className="brainengine__mark">
              <EngineMark engine={engine} />
            </span>
            <span className="brainengine__text">
              <span className="brainengine__name">
                {BRAIN_ENGINE_NAME[engine]}
                {on ? (
                  <span className="brainengine__tick" aria-hidden="true">
                    ✓
                  </span>
                ) : null}
              </span>
              <span className="brainengine__line">{why ? `Not available — ${why}` : ENGINE_LINE[engine]}</span>
            </span>
          </button>
        )
      })}
    </div>
  )
}

export function BrainIntro({
  status,
  onOn,
  onClose
}: {
  status: BrainStatus | null
  onOn: () => void
  onClose: () => void
}): ReactNode {
  const { state, actions } = useApp()
  const seen = state.settings.brainIntroSeen
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const engine = status?.engine ?? state.settings.brainEngine
  const unavailable = status?.unavailable ?? {}
  const blocked = unavailable[engine]

  const markSeen = (): void => {
    if (!seen) actions.patchSettings({ brainIntroSeen: true })
  }

  const turnOn = async (): Promise<void> => {
    setBusy(true)
    setError(null)
    const why = await turnBrainOn()
    setBusy(false)
    markSeen()
    if (why) setError(why)
    else onOn()
  }

  return (
    <div className="brainintro" data-first={seen ? undefined : 'true'}>
      <div className="brainintro__hero">
        <BrainGlyph state={busy ? 'starting' : 'idle'} size={seen ? 44 : 64} />
        <div>
          {!seen ? <p className="brainintro__eyebrow">One agent for all of Forge</p> : null}
          <h2 className="brainintro__title">{seen ? 'Forge Brain is off' : 'Forge Brain'}</h2>
        </div>
      </div>
      {!seen ? (
        <p className="brainintro__para">
          Forge Brain is one agent that sees the whole of Forge — every project, every pane, your settings. Tell it what
          you want in plain words, typed or spoken: it opens agents, hands them work, tells you when they finish, and
          changes settings for you. It runs in a terminal of its own, so you can always watch it work. Forge works just
          the same with it off.
        </p>
      ) : (
        <p className="brainintro__para brainintro__para--short">
          One agent that can reach every project and pane. Turn it on, then talk to it by picking Forge Brain as the voice agent.
        </p>
      )}
      <p className="brainintro__label">Who runs it</p>
      <EnginePicker value={engine} unavailable={unavailable} disabled={busy} onPick={(e) => void pickBrainEngine(e)} />
      {error ? (
        <p className="brainintro__error" role="alert">
          <span aria-hidden="true">×</span> {error}
        </p>
      ) : null}
      <div className="brainintro__acts">
        <button
          type="button"
          className="brainintro__on"
          disabled={busy || Boolean(blocked) || !window.forge.brain}
          onClick={() => void turnOn()}
        >
          <span className="brainintro__power" aria-hidden="true" />
          {busy ? 'Turning on…' : 'Turn on'}
        </button>
        <button
          type="button"
          className="brainintro__later"
          onClick={() => {
            markSeen()
            onClose()
          }}
        >
          Not now
        </button>
      </div>
      <p className="brainintro__foot">Change who runs it, or turn it off, any time in Settings → Forge Brain.</p>
    </div>
  )
}
