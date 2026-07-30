import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import type { AgentPresence, SttModelState } from '@shared/types'
import { Icon } from './Icon'
import { useApp, type SettingsSection } from '@/state/AppState'
import './Onboarding.css'

/**
 * The first-run welcome.
 *
 * It exists for exactly one person: whoever is handed a copy of Forge and opens
 * it on a machine that has never run it. Three things stand between them and a
 * working terminal, and none of them are discoverable —
 *
 *   1. Forge is empty until you point it at a folder.
 *   2. The agent panes launch `claude` / `kimi` / `gemini`, which are separate
 *      installs. Without this, a fresh pane just says "not recognized".
 *   3. Dictation needs a 660 MB model that is deliberately not in the download.
 *
 * Deliberately not a wizard: three rows, each independently skippable, one
 * button out. Everything here also lives in Settings, permanently and in more
 * detail; this is only the version you see once.
 */

type StepState = 'todo' | 'done' | 'skip'

export function Onboarding(): ReactNode {
  const { state, actions } = useApp()
  const [agents, setAgents] = useState<AgentPresence[] | null>(null)
  const [model, setModel] = useState<SttModelState | null>(null)
  const [voiceTouched, setVoiceTouched] = useState(false)
  const cardRef = useRef<HTMLDivElement | null>(null)

  const open = state.ready && !state.settings.onboarded

  /* ------------------------------------------------------------- probing */

  useEffect(() => {
    if (!open) return
    let live = true
    void (async () => {
      const [found, m] = await Promise.all([window.forge.probeAgents(), window.forge.stt.modelState()])
      if (!live) return
      setAgents(found)
      setModel(m)
    })()
    return () => {
      live = false
    }
  }, [open])

  // The download is owned by the main process, so the overlay only has to
  // listen. Closing this card mid-download does not stop it.
  useEffect(() => {
    if (!open) return
    const offs = [
      window.forge.stt.onDownloadProgress(setModel),
      window.forge.stt.onDownloadDone(setModel),
      window.forge.stt.onDownloadError(setModel)
    ]
    return () => offs.forEach((off) => off())
  }, [open])

  useEffect(() => {
    if (open) cardRef.current?.focus()
  }, [open])

  const finish = useCallback(() => {
    actions.patchSettings({ onboarded: true })
  }, [actions])

  /**
   * Everything on this card also lives in Settings, in more detail and
   * permanently. Rather than keep a second copy of the key form in step with
   * that one, the welcome hands over: mark first-run done, then land on the
   * section that owns the thing you clicked.
   */
  const handOver = useCallback(
    (section: SettingsSection) => {
      actions.patchSettings({ onboarded: true })
      actions.openSettings(section)
    },
    [actions]
  )

  if (!open) return null

  /* --------------------------------------------------------------- steps */

  const projectStep: StepState = state.projects.length > 0 ? 'done' : 'todo'
  const agentStep: StepState = agents === null ? 'todo' : agents.some((a) => a.found) ? 'done' : 'skip'
  const hasKey = Boolean(state.settings.geminiKey)
  const voiceStep: StepState =
    model?.status === 'ready' || hasKey ? 'done' : voiceTouched ? 'skip' : 'todo'

  const downloading = model?.status === 'downloading'
  const percent = Math.round((model?.fraction ?? 0) * 100)

  return (
    <div className="onboard" role="dialog" aria-modal="true" aria-label="Welcome to Forge">
      <div
        className="onboard__card"
        ref={cardRef}
        tabIndex={-1}
        onKeyDown={(e) => {
          e.stopPropagation()
          if (e.key === 'Escape') finish()
        }}
      >
        <button type="button" className="ghost-btn onboard__dismiss" aria-label="Dismiss" onClick={finish}>
          <Icon name="close" size={12} />
        </button>

        <header className="onboard__head">
          <div className="onboard__mark">
            <Icon name="forge" size={20} />
          </div>
          <div>
            <div className="eyebrow onboard__eyebrow">First run</div>
            <h1 className="onboard__title">Forge</h1>
          </div>
        </header>
        <p className="onboard__lede">
          A grid of real terminals, one per agent, with your projects down the side. Three things worth doing before
          you start — none of them compulsory.
        </p>

        <ol className="onboard__steps">
          {/* -------------------------------------------------- 1. project */}
          <Step n={1} title="Add a project" state={projectStep}>
            {state.projects.length > 0 ? (
              <p className="onboard__body">
                <span className="mono onboard__path">{state.projects[0]!.name}</span>
                {state.projects.length > 1 ? ` and ${state.projects.length - 1} more` : ''} — panes open there.
              </p>
            ) : (
              <p className="onboard__body">Every terminal Forge opens starts in a project folder.</p>
            )}
            <button type="button" className="cta-btn onboard__action" onClick={() => void actions.addProject()}>
              <Icon name="folder" size={13} />
              {state.projects.length > 0 ? 'Add another' : 'Choose a folder…'}
            </button>
          </Step>

          {/* --------------------------------------------------- 2. agents */}
          <Step n={2} title="Agents on this machine" state={agentStep}>
            {agents === null ? (
              <p className="onboard__body">Looking…</p>
            ) : (
              <>
                <ul className="onboard__agents">
                  {agents.map((agent) => (
                    <li key={agent.id} className="onboard__agent" data-found={agent.found}>
                      <span className="onboard__agent-dot" aria-hidden="true" />
                      <span className="onboard__agent-name">{agent.name}</span>
                      <span className="mono onboard__agent-cmd">{agent.command}</span>
                      {agent.found ? (
                        <span className="onboard__agent-state">installed</span>
                      ) : (
                        <a
                          className="onboard__agent-link"
                          href={agent.installUrl}
                          target="_blank"
                          rel="noreferrer noopener"
                        >
                          get it →
                        </a>
                      )}
                    </li>
                  ))}
                </ul>
                <p className="onboard__body onboard__note">
                  Missing ones still open a pane — it will just be a shell that cannot find the command. Forge does
                  not install anything for you.
                </p>
              </>
            )}
          </Step>

          {/* ---------------------------------------------------- 3. voice */}
          <Step n={3} title="Voice — optional" state={voiceStep}>
            <p className="onboard__body">
              Dictation runs on this machine; the voice agent asks Gemini. Both are off until you set them up, and
              neither is needed to use Forge.
            </p>

            <div className="onboard__field">
              <span className="onboard__label">Gemini API key</span>
              <p className="onboard__note">
                {hasKey
                  ? 'A key is already stored — the voice agent has a brain.'
                  : 'Without one the voice agent still obeys spoken commands, but cannot hold a conversation.'}
              </p>
              <button type="button" className="ghost-btn onboard__ghost" onClick={() => handOver('models')}>
                {hasKey ? 'Change it in Settings' : 'Add a key in Settings'} &rarr;
              </button>
            </div>

            <div className="onboard__field">
              <span className="onboard__label">Speech model</span>
              {model?.status === 'ready' ? (
                <p className="onboard__body">Installed — dictation is ready.</p>
              ) : downloading ? (
                <>
                  <div
                    className="onboard__bar"
                    role="progressbar"
                    aria-valuenow={percent}
                    aria-valuemin={0}
                    aria-valuemax={100}
                  >
                    <span className="onboard__bar-fill" style={{ width: `${percent}%` }} />
                  </div>
                  <p className="onboard__note">
                    {percent}% — {model?.message}
                  </p>
                  <button
                    type="button"
                    className="ghost-btn onboard__ghost"
                    onClick={() => void window.forge.stt.cancelDownload()}
                  >
                    Stop
                  </button>
                </>
              ) : (
                <>
                  <div className="onboard__row">
                    <button
                      type="button"
                      className="cta-btn onboard__action"
                      onClick={() => {
                        setVoiceTouched(true)
                        void window.forge.stt.downloadModel()
                      }}
                    >
                      Download {model?.sizeHint ?? '~660 MB'}
                    </button>
                    <button
                      type="button"
                      className="ghost-btn onboard__ghost"
                      onClick={() => setVoiceTouched(true)}
                    >
                      Skip for now
                    </button>
                  </div>
                  <p className="onboard__note">
                    {model?.status === 'partial'
                      ? model.message
                      : 'One-time, and it resumes if the connection drops. You can do this later in Settings.'}
                  </p>
                </>
              )}
            </div>
          </Step>
        </ol>

        <footer className="onboard__foot">
          <button type="button" className="onboard__foot-hint" onClick={() => handOver('voice')}>
            Settings has all of this, permanently
          </button>
          <button type="button" className="cta-btn" onClick={finish}>
            Start using Forge
          </button>
        </footer>
      </div>
    </div>
  )
}

/* -------------------------------------------------------------------- step */

function Step({
  n,
  title,
  state,
  children
}: {
  n: number
  title: string
  state: StepState
  children: ReactNode
}): ReactNode {
  return (
    <li className="onboard__step" data-state={state}>
      <div className="onboard__step-num mono" aria-hidden="true">
        {state === 'done' ? <Icon name="check" size={11} /> : n}
      </div>
      <div className="onboard__step-body">
        <h2 className="onboard__step-title">{title}</h2>
        {children}
      </div>
    </li>
  )
}
