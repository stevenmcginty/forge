import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { MAX_PANES_PER_TAB, MAX_SESSIONS } from '@shared/ipc'
import type { AgentProfile } from '@shared/types'
import { resolveProfile } from '@/lib/agents'
import { buildManifest, type ManifestSnapshot } from '@/lib/appmanifest'
import {
  runAppAction,
  type ActionContext,
  type ActionOutcome,
  type ActionRunner,
  type AppAction
} from '@/lib/appactions'
import { makeId } from '@/lib/ids'
import { collectLeaves, countLeaves } from '@/lib/splitTree'
import { terminalHost, type PaneStatus } from '@/lib/terminals'
import { transcriptBus, typedTranscript } from '@/lib/transcriptSource'
import { parseUtterance } from '@/lib/voicecommands'
import {
  brainStatusLabel,
  getActiveBrain,
  maskKey,
  type BrainContext,
  type BrainReply,
  type BrainStatus,
  type BrainTurn
} from '@/lib/voicebrain'
import { useActiveProject, useApp, VOICE_PANEL_MAX, VOICE_PANEL_MIN } from '@/state/AppState'
import { AgentBadge } from './AgentBadge'
import { EmptyState } from './EmptyState'
import { Icon } from './Icon'
import { Popover, PopoverRow, PopoverSection } from './Popover'
import './VoicePanel.css'

/**
 * The voice agent panel — talk to Forge, and talk about what to build.
 *
 * Two paths through one input:
 *
 *  1. Commands ("open up three tabs of kimmy") are matched by the deterministic
 *     grammar and executed immediately, through the very same AppState actions
 *     the buttons use. No model, no key, no latency, works offline.
 *  2. Everything else goes to the active brain — Gemini when a key is set,
 *     otherwise the stub, which echoes and says so. A brain may return actions
 *     too; they run through the same executor, so it can never do more than the
 *     grammar could.
 *
 * The transcript arrives via `transcriptBus`, which is fed by the text box today
 * and by dictation once M3 lands — no change needed here. Replies are text only:
 * nothing is ever spoken aloud.
 */

interface TurnBase {
  id: string
  said: string
  at: number
}

interface CommandTurn extends TurnBase {
  kind: 'command'
  actions: AppAction[]
  outcomes: ActionOutcome[]
}

interface BrainTurnState extends TurnBase {
  kind: 'brain'
  phase: 'thinking' | 'done' | 'error'
  reply?: BrainReply
  error?: string
  /** The draft prompt as the user has edited it. */
  draft: string
  outcomes?: ActionOutcome[]
}

type Turn = CommandTurn | BrainTurnState

interface PaneOption {
  paneId: string
  tabId: string
  tabTitle: string
  title: string
  profile: AgentProfile
  status: PaneStatus
}

export function VoicePanel(): ReactNode {
  const { state, actions } = useApp()
  const project = useActiveProject()

  const open = state.settings.voicePanelOpen
  const [turns, setTurns] = useState<Turn[]>([])
  const [draftPhrase, setDraftPhrase] = useState('')
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [dragWidth, setDragWidth] = useState<number | null>(null)

  const logRef = useRef<HTMLDivElement | null>(null)
  const composerRef = useRef<HTMLTextAreaElement | null>(null)

  /* --------------------------------------------------------------- brain */

  const brain = useMemo(
    () =>
      getActiveBrain({
        voiceBrain: state.settings.voiceBrain,
        anthropicKey: state.settings.anthropicKey,
        geminiKey: state.settings.geminiKey,
        geminiModel: state.settings.geminiModel
      }),
    [state.settings.voiceBrain, state.settings.anthropicKey, state.settings.geminiKey, state.settings.geminiModel]
  )
  const status: BrainStatus = brain.ready()

  /* ------------------------------------------------- state for the agent */

  const workspace = project ? state.workspaces[project.id] : undefined
  const activeTab = workspace?.tabs.find((t) => t.id === workspace.activeTabId) ?? null
  const paneCount = useMemo(() => {
    let n = 0
    for (const ws of Object.values(state.workspaces)) for (const tab of ws.tabs) n += countLeaves(tab.root)
    return n
  }, [state.workspaces])

  // Snapshotted every render and read through a ref, so the transcript
  // subscription never has to be torn down and rebuilt.
  const ctxRef = useRef<ActionContext | null>(null)
  ctxRef.current = {
    projects: state.projects.map((p) => ({ id: p.id, name: p.name })),
    profiles: state.settings.agentProfiles,
    defaultProfileId: project?.defaultProfileId ?? state.settings.agentProfiles[0]?.id ?? 'pwsh',
    activeProjectId: project?.id ?? null,
    activeProjectName: project?.name ?? null,
    loadedProjectIds: Object.keys(state.workspaces),
    tabs: (workspace?.tabs ?? []).map((t) => ({ id: t.id, title: t.title })),
    activeTabId: workspace?.activeTabId ?? null,
    focusedPaneId: activeTab?.activePaneId ?? null,
    paneCount,
    panesInActiveTab: activeTab ? countLeaves(activeTab.root) : 0,
    maxSessions: MAX_SESSIONS,
    maxPanesPerTab: MAX_PANES_PER_TAB
  }

  const runnerRef = useRef<ActionRunner | null>(null)
  runnerRef.current = {
    newTab: (profileId) => actions.newTab(profileId),
    splitPane: (paneId, direction, profileId) => actions.splitPane(paneId, direction, profileId),
    closePane: (paneId) => actions.closePane(paneId),
    closeTab: (tabId) => actions.closeTab(tabId),
    selectProject: (projectId) => actions.selectProject(projectId),
    selectTab: (tabId) => actions.selectTab(tabId)
  }

  const manifestRef = useRef<string>('')
  manifestRef.current = useMemo(() => {
    const snapshot: ManifestSnapshot = {
      appVersion: state.info?.version ?? null,
      projects: state.projects.map((p) => ({ name: p.name, path: p.path, active: p.id === project?.id })),
      profiles: state.settings.agentProfiles,
      tabs: (workspace?.tabs ?? []).map((tab, i) => ({
        number: i + 1,
        title: tab.title,
        active: tab.id === workspace?.activeTabId,
        panes: collectLeaves(tab.root).map((leaf) => {
          const profile = resolveProfile(state.settings.agentProfiles, leaf.profileId)
          return {
            title: leaf.title.trim() || profile.name,
            profileName: profile.name,
            status: terminalHost.runtime(leaf.id).status,
            focused: leaf.id === tab.activePaneId
          }
        })
      })),
      paneCount,
      maxSessions: MAX_SESSIONS,
      maxPanesPerTab: MAX_PANES_PER_TAB,
      view: {
        railCollapsed: state.settings.railCollapsed,
        voicePanelWidth: state.settings.voicePanelWidth,
        terminalFontSize: state.settings.terminalFontSize,
        shell: state.info?.shell ?? state.settings.shell
      }
    }
    return buildManifest(snapshot)
  }, [
    state.info,
    state.projects,
    state.settings.agentProfiles,
    state.settings.railCollapsed,
    state.settings.voicePanelWidth,
    state.settings.terminalFontSize,
    state.settings.shell,
    workspace,
    project?.id,
    paneCount
  ])

  // Conversation so far, for multi-turn context.
  const historyRef = useRef<BrainTurn[]>([])
  historyRef.current = turns.flatMap((turn): BrainTurn[] => {
    const mine: BrainTurn = { role: 'user', text: turn.said }
    if (turn.kind === 'command') {
      return [mine, { role: 'agent', text: turn.outcomes.map((o) => o.summary).join('; ') }]
    }
    const said = turn.reply?.say ?? turn.reply?.understood
    return said ? [mine, { role: 'agent', text: said }] : [mine]
  })

  /* ------------------------------------------------------------- executor */

  const runActions = useCallback((list: AppAction[]): ActionOutcome[] => {
    let ctx = ctxRef.current
    const runner = runnerRef.current
    if (!ctx || !runner) return []
    const out: ActionOutcome[] = []
    for (const action of list) {
      const outcome = runAppAction(action, ctx, runner)
      out.push(outcome)
      // Later actions in the same breath must see the earlier ones' effect.
      if (action.kind === 'open_tabs') {
        ctx = { ...ctx, paneCount: ctx.paneCount + outcome.done }
      } else if (action.kind === 'open_panes') {
        ctx = {
          ...ctx,
          paneCount: ctx.paneCount + outcome.done,
          panesInActiveTab: ctx.panesInActiveTab + outcome.done
        }
      } else if (action.kind === 'close_pane') {
        ctx = { ...ctx, paneCount: Math.max(0, ctx.paneCount - outcome.done) }
      }
    }
    return out
  }, [])

  /* ---------------------------------------------------- transcript intake */

  const handlePhrase = useCallback(
    (said: string) => {
      const id = makeId('turn')

      // 1 — plain commands never touch a model.
      const ctx = ctxRef.current
      const hit = ctx ? parseUtterance(said, ctx) : null
      if (hit) {
        const outcomes = runActions(hit.actions)
        setTurns((prev) => [
          ...prev,
          { id, said, at: Date.now(), kind: 'command', actions: hit.actions, outcomes }
        ])
        return
      }

      // 2 — everything else is a conversation with the brain.
      setTurns((prev) => [...prev, { id, said, at: Date.now(), kind: 'brain', phase: 'thinking', draft: '' }])

      const context: BrainContext = {
        projectName: ctx?.activeProjectName ?? undefined,
        projectPath: project?.path,
        recentTranscript: [...historyRef.current.filter((t) => t.role === 'user').map((t) => t.text), said],
        manifest: manifestRef.current,
        history: [...historyRef.current]
      }

      brain
        .interpret(said, context)
        .then((reply) => {
          const outcomes = reply.actions?.length ? runActions(reply.actions) : undefined
          setTurns((prev) =>
            prev.map((t) =>
              t.id === id && t.kind === 'brain'
                ? { ...t, phase: 'done', reply, draft: reply.draftPrompt ?? '', outcomes }
                : t
            )
          )
        })
        .catch((err: unknown) =>
          setTurns((prev) =>
            prev.map((t) =>
              t.id === id && t.kind === 'brain'
                ? { ...t, phase: 'error', error: err instanceof Error ? err.message : String(err) }
                : t
            )
          )
        )
    },
    [brain, project?.path, runActions]
  )

  // One subscription for every source that ever registers with the bus — which
  // is how M3's dictation joins in without this component changing.
  useEffect(() => transcriptBus.onPhrase(handlePhrase), [handlePhrase])

  useEffect(() => {
    const log = logRef.current
    if (log) log.scrollTop = log.scrollHeight
  }, [turns, open])

  useEffect(() => {
    if (open) composerRef.current?.focus()
  }, [open])

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

  /* --------------------------------------------------------------- panes */

  const paneOptions = useCallback((): PaneOption[] => {
    if (!workspace) return []
    const out: PaneOption[] = []
    for (const tab of workspace.tabs) {
      for (const leaf of collectLeaves(tab.root)) {
        const profile = resolveProfile(state.settings.agentProfiles, leaf.profileId)
        out.push({
          paneId: leaf.id,
          tabId: tab.id,
          tabTitle: tab.title,
          title: leaf.title.trim() || profile.name,
          profile,
          status: terminalHost.runtime(leaf.id).status
        })
      }
    }
    return out
  }, [workspace, state.settings.agentProfiles])

  /** Type a draft into a pane. Never appends Enter — Steve presses that. */
  const sendToPane = useCallback(
    (option: PaneOption, text: string): void => {
      const body = text.replace(/[\r\n]+$/, '')
      if (!body.trim()) {
        actions.setNotice('Nothing to send — the draft is empty')
        return
      }
      const runtime = terminalHost.runtime(option.paneId)
      if (runtime.status !== 'live' && runtime.status !== 'starting') {
        actions.setNotice(`${option.title} has no live shell`)
        return
      }
      if (workspace && workspace.activeTabId !== option.tabId) actions.selectTab(option.tabId)
      actions.focusPane(option.paneId)
      terminalHost.paste(option.paneId, body)
      terminalHost.focus(option.paneId)
      actions.setNotice(`Draft typed into ${option.title} — press Enter there to run it`)
    },
    [actions, workspace]
  )

  /* ---------------------------------------------------------------- send */

  const submitPhrase = useCallback((): void => {
    const text = draftPhrase.trim()
    if (!text) return
    setDraftPhrase('')
    typedTranscript.push(text)
  }, [draftPhrase])

  /* --------------------------------------------------------------- render */

  if (!open) {
    // Stays mounted so the conversation survives a collapse.
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
        <span className="voice__mark">
          <Icon name="voice" size={14} />
        </span>
        <h2 className="voice__title">Voice Agent</h2>
        <BrainChip status={status} brainName={brain.name} />
        <span className="voice__spacer" />
        <button
          type="button"
          className="ghost-btn voice__icon-btn"
          title="Voice agent settings"
          aria-pressed={settingsOpen}
          data-on={settingsOpen ? 'true' : undefined}
          onClick={() => setSettingsOpen((v) => !v)}
        >
          <Icon name="gear" size={13} />
        </button>
        <button
          type="button"
          className="ghost-btn voice__icon-btn"
          title="Hide voice agent (Ctrl+Shift+G)"
          onClick={() => actions.toggleVoicePanel()}
        >
          <Icon name="close" size={13} />
        </button>
      </header>

      {settingsOpen ? <VoiceSettings /> : null}

      <div className="voice__log" ref={logRef}>
        {turns.length === 0 ? (
          <EmptyState
            icon="voice"
            size="sm"
            eyebrow={status.ok ? 'listening' : 'commands only'}
            title="Tell it what you want"
            body="Say “open three Kimi tabs” and it just does it — or describe what you want built and it drafts the prompt for you to fire at an agent."
          />
        ) : (
          turns.map((turn) =>
            turn.kind === 'command' ? (
              <CommandCard key={turn.id} turn={turn} />
            ) : (
              <TurnCard
                key={turn.id}
                turn={turn}
                paneOptions={paneOptions}
                onSend={sendToPane}
                onEdit={(draft) =>
                  setTurns((prev) =>
                    prev.map((t) => (t.id === turn.id && t.kind === 'brain' ? { ...t, draft } : t))
                  )
                }
              />
            )
          )
        )}
      </div>

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
            e.stopPropagation()
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              submitPhrase()
            }
          }}
        />
        <div className="voice__composer-foot">
          <span className="voice__composer-hint">Enter to send · Shift+Enter for a new line</span>
          <button
            type="button"
            className="cta-btn voice__say"
            disabled={!draftPhrase.trim()}
            onClick={submitPhrase}
          >
            Say it
            <Icon name="send" size={13} />
          </button>
        </div>
      </div>
    </aside>
  )
}

/* ------------------------------------------------------------------- chip */

function BrainChip({ status, brainName }: { status: BrainStatus; brainName: string }): ReactNode {
  return (
    <span
      className="voice__chip"
      data-ok={status.ok ? 'true' : 'false'}
      title={`${brainName} brain — ${status.detail ?? brainStatusLabel(status)}`}
    >
      <span className="voice__chip-dot" />
      {brainStatusLabel(status)}
    </span>
  )
}

/* --------------------------------------------------------------- settings */

const BRAIN_ROWS: Array<{ id: 'gemini' | 'stub' | 'claude' | 'openai'; name: string; note: string; ready: boolean }> = [
  { id: 'gemini', name: 'Gemini', note: 'live — needs a key', ready: true },
  { id: 'stub', name: 'Stub', note: 'offline, echoes you', ready: true },
  { id: 'claude', name: 'Claude', note: 'coming soon', ready: false },
  { id: 'openai', name: 'OpenAI', note: 'coming soon', ready: false }
]

function VoiceSettings(): ReactNode {
  const { state, actions } = useApp()
  const [reveal, setReveal] = useState(false)
  const [geminiDraft, setGeminiDraft] = useState(state.settings.geminiKey)
  const [anthropicDraft, setAnthropicDraft] = useState(state.settings.anthropicKey)
  const [modelDraft, setModelDraft] = useState(state.settings.geminiModel)
  const [found, setFound] = useState<{ key: string; last4: string; source: string } | null>(null)
  const [importError, setImportError] = useState<string | null>(null)

  useEffect(() => setGeminiDraft(state.settings.geminiKey), [state.settings.geminiKey])
  useEffect(() => setAnthropicDraft(state.settings.anthropicKey), [state.settings.anthropicKey])
  useEffect(() => setModelDraft(state.settings.geminiModel), [state.settings.geminiModel])

  const importKey = async (): Promise<void> => {
    setImportError(null)
    setFound(null)
    const result = await window.forge.voice.importKey()
    if (result.ok) setFound({ key: result.key, last4: result.last4, source: result.source })
    else setImportError(result.error)
  }

  return (
    <section className="voice__settings" aria-label="Voice agent settings">
      <div className="eyebrow voice__settings-eyebrow">Brain</div>
      <div className="voice__brains">
        {BRAIN_ROWS.map((row) => (
          <button
            key={row.id}
            type="button"
            className="voice__brain"
            data-selected={state.settings.voiceBrain === row.id ? 'true' : undefined}
            disabled={!row.ready}
            title={row.ready ? `Use the ${row.name} brain` : `${row.name} — coming soon`}
            onClick={() => actions.setVoiceBrain(row.id)}
          >
            <span className="voice__brain-name">{row.name}</span>
            <span className="voice__brain-note mono">{row.note}</span>
          </button>
        ))}
      </div>

      <div className="field voice__field">
        <label className="field__label" htmlFor="voice-gemini-key">
          Gemini API key
        </label>
        <div className="voice__key-row">
          <input
            id="voice-gemini-key"
            className="field__input mono voice__key-input"
            type={reveal ? 'text' : 'password'}
            autoComplete="off"
            spellCheck={false}
            placeholder="AIza…"
            value={geminiDraft}
            onChange={(e) => setGeminiDraft(e.target.value)}
            onBlur={() => actions.setGeminiKey(geminiDraft)}
            onKeyDown={(e) => {
              e.stopPropagation()
              if (e.key === 'Enter') actions.setGeminiKey(geminiDraft)
            }}
          />
          <button
            type="button"
            className="ghost-btn voice__key-toggle"
            title={reveal ? 'Hide keys' : 'Show keys'}
            onClick={() => setReveal((v) => !v)}
          >
            {reveal ? 'hide' : 'show'}
          </button>
        </div>
        <div className="voice__key-state mono">
          {state.settings.geminiKey ? maskKey(state.settings.geminiKey) : 'no key stored'}
        </div>

        {found ? (
          <div className="voice__import">
            <span className="voice__import-text">
              Found a key ending <span className="mono">{found.last4}</span> in{' '}
              <span className="mono voice__import-path">{found.source}</span>
            </span>
            <div className="voice__import-actions">
              <button type="button" className="ghost-btn turn__action" onClick={() => setFound(null)}>
                Cancel
              </button>
              <button
                type="button"
                className="ghost-btn turn__action turn__action--send"
                onClick={() => {
                  actions.setGeminiKey(found.key)
                  actions.setVoiceBrain('gemini')
                  setFound(null)
                }}
              >
                Use this key
              </button>
            </div>
          </div>
        ) : (
          <button type="button" className="ghost-btn voice__import-btn" onClick={() => void importKey()}>
            Import from DictationMic
          </button>
        )}
        {importError ? <div className="voice__import-error">{importError}</div> : null}
      </div>

      <div className="field voice__field">
        <label className="field__label" htmlFor="voice-gemini-model">
          Model
        </label>
        <input
          id="voice-gemini-model"
          className="field__input mono"
          spellCheck={false}
          value={modelDraft}
          onChange={(e) => setModelDraft(e.target.value)}
          onBlur={() => actions.setGeminiModel(modelDraft)}
          onKeyDown={(e) => {
            e.stopPropagation()
            if (e.key === 'Enter') actions.setGeminiModel(modelDraft)
          }}
        />
      </div>

      <div className="field voice__field">
        <label className="field__label" htmlFor="voice-anthropic-key">
          Anthropic API key (unused)
        </label>
        <input
          id="voice-anthropic-key"
          className="field__input mono"
          type={reveal ? 'text' : 'password'}
          autoComplete="off"
          spellCheck={false}
          placeholder="sk-ant-…"
          value={anthropicDraft}
          onChange={(e) => setAnthropicDraft(e.target.value)}
          onBlur={() => actions.setAnthropicKey(anthropicDraft)}
          onKeyDown={(e) => {
            e.stopPropagation()
            if (e.key === 'Enter') actions.setAnthropicKey(anthropicDraft)
          }}
        />
        <div className="voice__key-state mono">
          {state.settings.anthropicKey ? maskKey(state.settings.anthropicKey) : 'no key stored'}
        </div>
      </div>

      <p className="voice__settings-note">
        Keys live in <span className="mono">settings.json</span> on this PC. The Gemini key is the only one that goes
        anywhere: when Gemini is the brain, what you say plus a summary of your projects, tabs and panes is sent to{' '}
        <span className="mono">generativelanguage.googleapis.com</span>. Nothing else in Forge makes a network call,
        and the Anthropic key is stored but never used.
      </p>
      <p className="voice__settings-note">
        Commands like “open two Claude tabs” are matched here on your machine and never sent anywhere. Replies are
        text only — nothing is ever spoken aloud.
      </p>
    </section>
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
                onKeyDown={(e) => e.stopPropagation()}
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
