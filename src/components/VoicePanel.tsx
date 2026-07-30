import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { MAX_PANES_PER_TAB, MAX_SESSIONS } from '@shared/ipc'
import type { AgentProfile, KeySource, VoiceBrainId } from '@shared/types'
import { agentMemory } from '@/lib/agentmemory'
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
  DEFAULT_OPENROUTER_MODEL,
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

  /* ----------------------------------------------------------------- mic
   *
   * The mic button arms *routing*: while it is on and this panel is open,
   * dictated phrases are the agent's rather than the focused pane's (the rule
   * lives in useDictation). Arming also starts the sidecar, because a mic button
   * that does not turn the mic on would be a strange thing to ship.
   *
   * The engine is driven by IPC rather than through useDictation on purpose:
   * that hook owns the global dictation hotkey, and a second copy of it would
   * mean every press of Right Ctrl toggled twice and cancelled itself out.
   */

  const armed = state.agentListening
  const [micLive, setMicLive] = useState(false)

  useEffect(() => window.forge.stt.onStatus((s) => setMicLive(s.phase === 'listening')), [])

  const toggleMic = useCallback(() => {
    const next = !armed
    actions.setAgentListening(next)
    if (next) void window.forge.stt.start()
    else void window.forge.stt.stop()
  }, [armed, actions])

  // Closing the panel disarms, so it never reopens secretly pointed at the
  // agent. The sidecar is left alone: the pill may still be dictating into a
  // pane, and that is not this panel's business to stop.
  useEffect(() => {
    if (!open && armed) actions.setAgentListening(false)
  }, [open, armed, actions])

  /* --------------------------------------------------------------- brain */

  const brain = useMemo(
    () =>
      getActiveBrain({
        voiceBrain: state.settings.voiceBrain,
        anthropicKey: state.settings.anthropicKey,
        geminiKey: state.settings.geminiKey,
        geminiModel: state.settings.geminiModel,
        openrouterKey: state.settings.openrouterKey,
        openrouterModel: state.settings.openrouterModel
      }),
    [
      state.settings.voiceBrain,
      state.settings.anthropicKey,
      state.settings.geminiKey,
      state.settings.geminiModel,
      state.settings.openrouterKey,
      state.settings.openrouterModel
    ]
  )
  const status: BrainStatus = brain.ready()

  // Agent memory (M7). Warmed here so the brain context can be built without an
  // await; everything that decides what to remember lives in lib/agentmemory.ts.
  useEffect(() => void agentMemory.prime(project?.id ?? null), [project?.id])

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
    selectTab: (tabId) => actions.selectTab(tabId),
    // Media generation goes to the main process, which holds the key, writes
    // into the project's assets/generated/ and puts the result in the tray.
    makeImage: async (request) => {
      const res = await window.forge.voice.makeImage({ ...request, projectPath: project?.path })
      if (!res.ok) return { ok: false, summary: mediaFailure(res.error), requested: request.count, done: 0 }
      const made = res.paths.length
      return {
        ok: true,
        summary:
          `Made ${made} ${made === 1 ? 'image' : 'images'} in assets/generated` +
          `${res.adopted > 0 ? ' — also in the shot tray' : ''}${res.note ? ` (${res.note})` : ''}`,
        requested: request.count,
        done: made,
        paths: res.paths
      }
    },
    editImage: async (request) => {
      const res = await window.forge.voice.editImage({ ...request, projectPath: project?.path })
      if (!res.ok) return { ok: false, summary: mediaFailure(res.error), requested: 1, done: 0 }
      return {
        ok: true,
        summary: `Edited image saved to assets/generated${res.adopted > 0 ? ' — also in the shot tray' : ''}`,
        requested: 1,
        done: res.paths.length,
        paths: res.paths
      }
    },
    recallMemory: () => agentMemory.recall(project?.id ?? null),
    forgetMemory: () => agentMemory.forget(project?.id ?? null)
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

  /**
   * `onResolved` exists for the asynchronous actions only. Generating an image
   * takes seconds, so `runAppAction` hands back a provisional "Generating…"
   * outcome plus a promise; when it settles the chip is replaced in place rather
   * than the card sitting there lying about what happened.
   */
  const runActions = useCallback(
    (list: AppAction[], onResolved?: (index: number, outcome: ActionOutcome) => void): ActionOutcome[] => {
      let ctx = ctxRef.current
      const runner = runnerRef.current
      if (!ctx || !runner) return []
      const out: ActionOutcome[] = []
      for (const [i, action] of list.entries()) {
        const outcome = runAppAction(action, ctx, runner)
        out.push(outcome)
        if (outcome.pending && onResolved) {
          const index = i
          void outcome.pending.then(
            (settled) => onResolved(index, settled),
            (err: unknown) =>
              onResolved(index, {
                ok: false,
                summary: mediaFailure(err instanceof Error ? err.message : String(err)),
                requested: outcome.requested,
                done: 0
              })
          )
        }
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
    },
    []
  )

  /** Replace one chip on a turn once its slow action has settled. */
  const patchOutcome = useCallback((turnId: string, index: number, outcome: ActionOutcome): void => {
    setTurns((prev) =>
      prev.map((t) => {
        if (t.id !== turnId) return t
        const current = t.kind === 'command' ? t.outcomes : t.outcomes
        if (!current || !current[index]) return t
        const next = [...current]
        next[index] = outcome
        return t.kind === 'command' ? { ...t, outcomes: next } : { ...t, outcomes: next }
      })
    )
  }, [])

  /* ---------------------------------------------------- transcript intake */

  const handlePhrase = useCallback(
    (said: string) => {
      const id = makeId('turn')

      // 1 — plain commands never touch a model.
      const ctx = ctxRef.current
      const hit = ctx ? parseUtterance(said, ctx) : null
      if (hit) {
        const outcomes = runActions(hit.actions, (index, outcome) => patchOutcome(id, index, outcome))
        setTurns((prev) => [
          ...prev,
          { id, said, at: Date.now(), kind: 'command', actions: hit.actions, outcomes }
        ])
        void agentMemory.record({ projectId: ctx?.activeProjectId ?? null, utterance: said, at: Date.now(), outcomes })
        return
      }

      // 2 — everything else is a conversation with the brain.
      setTurns((prev) => [...prev, { id, said, at: Date.now(), kind: 'brain', phase: 'thinking', draft: '' }])

      const context: BrainContext = {
        projectName: ctx?.activeProjectName ?? undefined,
        projectPath: project?.path,
        recentTranscript: [...historyRef.current.filter((t) => t.role === 'user').map((t) => t.text), said],
        manifest: manifestRef.current,
        history: [...historyRef.current],
        projectMemory: agentMemory.cached(ctx?.activeProjectId ?? null)
      }

      brain
        .interpret(said, context)
        .then((reply) => {
          const outcomes = reply.actions?.length
            ? runActions(reply.actions, (index, outcome) => patchOutcome(id, index, outcome))
            : undefined
          setTurns((prev) =>
            prev.map((t) =>
              t.id === id && t.kind === 'brain'
                ? { ...t, phase: 'done', reply, draft: reply.draftPrompt ?? '', outcomes }
                : t
            )
          )
          void agentMemory.record({ projectId: ctx?.activeProjectId ?? null, utterance: said, at: Date.now(), reply, outcomes })
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
    [brain, patchOutcome, project?.path, runActions]
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
          className="ghost-btn voice__icon-btn voice__mic"
          title={
            armed
              ? 'Dictation is feeding the agent — click to send it back to the focused pane'
              : 'Send dictation to the agent instead of the focused pane'
          }
          aria-pressed={armed}
          aria-label="Send dictation to the agent"
          data-on={armed ? 'true' : undefined}
          data-live={armed && micLive ? 'true' : undefined}
          onClick={toggleMic}
        >
          <Icon name="voice" size={13} />
        </button>
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

/* ---------------------------------------------------------------- failures */

/**
 * A provider's error is a paragraph aimed at an agent; an outcome chip is one
 * line. Keep the first sentence — which is where the actual reason lives ("out
 * of quota", "refused the key") — and drop the advice that follows it.
 */
function mediaFailure(error: string): string {
  const first = (error ?? '').split('\n')[0]?.trim() || (error ?? '').trim() || 'Image generation failed'
  return first.length > 180 ? `${first.slice(0, 177)}…` : first
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

const BRAIN_ROWS: Array<{ id: VoiceBrainId; name: string; note: string; ready: boolean }> = [
  { id: 'gemini', name: 'Gemini', note: 'live — needs a key', ready: true },
  { id: 'openrouter', name: 'OpenRouter', note: 'live — any model', ready: true },
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
  const [openrouterDraft, setOpenrouterDraft] = useState(state.settings.openrouterKey)
  const [openrouterModelDraft, setOpenrouterModelDraft] = useState(state.settings.openrouterModel)
  const [found, setFound] = useState<{ key: string; last4: string; source: string; which: KeySource } | null>(null)
  const [importError, setImportError] = useState<string | null>(null)

  useEffect(() => setGeminiDraft(state.settings.geminiKey), [state.settings.geminiKey])
  useEffect(() => setAnthropicDraft(state.settings.anthropicKey), [state.settings.anthropicKey])
  useEffect(() => setModelDraft(state.settings.geminiModel), [state.settings.geminiModel])
  useEffect(() => setOpenrouterDraft(state.settings.openrouterKey), [state.settings.openrouterKey])
  useEffect(() => setOpenrouterModelDraft(state.settings.openrouterModel), [state.settings.openrouterModel])

  const importKey = async (which: KeySource): Promise<void> => {
    setImportError(null)
    setFound(null)
    const result = await window.forge.voice.importKey(which)
    if (result.ok) setFound({ key: result.key, last4: result.last4, source: result.source, which })
    else setImportError(result.error)
  }

  /** Take the key that was found, and switch to the brain it belongs to. */
  const acceptFound = (): void => {
    if (!found) return
    if (found.which === 'openrouter') {
      actions.patchSettings({ openrouterKey: found.key })
      actions.setVoiceBrain('openrouter')
    } else {
      actions.setGeminiKey(found.key)
      actions.setVoiceBrain('gemini')
    }
    setFound(null)
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
              <button type="button" className="ghost-btn turn__action turn__action--send" onClick={acceptFound}>
                Use this key
              </button>
            </div>
          </div>
        ) : (
          <button type="button" className="ghost-btn voice__import-btn" onClick={() => void importKey('gemini')}>
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
        <label className="field__label" htmlFor="voice-openrouter-key">
          OpenRouter API key
        </label>
        <div className="voice__key-row">
          <input
            id="voice-openrouter-key"
            className="field__input mono voice__key-input"
            type={reveal ? 'text' : 'password'}
            autoComplete="off"
            spellCheck={false}
            placeholder="sk-or-v1-…"
            value={openrouterDraft}
            onChange={(e) => setOpenrouterDraft(e.target.value)}
            onBlur={() => actions.patchSettings({ openrouterKey: openrouterDraft.trim() })}
            onKeyDown={(e) => {
              e.stopPropagation()
              if (e.key === 'Enter') actions.patchSettings({ openrouterKey: openrouterDraft.trim() })
            }}
          />
        </div>
        <div className="voice__key-state mono">
          {state.settings.openrouterKey ? maskKey(state.settings.openrouterKey) : 'no key stored'}
        </div>
        <button type="button" className="ghost-btn voice__import-btn" onClick={() => void importKey('openrouter')}>
          Import from ~/.kimi-key
        </button>
      </div>

      <div className="field voice__field">
        <label className="field__label" htmlFor="voice-openrouter-model">
          OpenRouter model
        </label>
        <input
          id="voice-openrouter-model"
          className="field__input mono"
          spellCheck={false}
          value={openrouterModelDraft}
          onChange={(e) => setOpenrouterModelDraft(e.target.value)}
          onBlur={() => actions.patchSettings({ openrouterModel: openrouterModelDraft.trim() || DEFAULT_OPENROUTER_MODEL })}
          onKeyDown={(e) => {
            e.stopPropagation()
            if (e.key === 'Enter') {
              actions.patchSettings({ openrouterModel: openrouterModelDraft.trim() || DEFAULT_OPENROUTER_MODEL })
            }
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
        Keys live in <span className="mono">settings.json</span> on this PC. Only the selected brain&rsquo;s key goes
        anywhere: what you say plus a summary of your projects, tabs and panes is sent to{' '}
        <span className="mono">generativelanguage.googleapis.com</span> or <span className="mono">openrouter.ai</span>.
        The Gemini key is also used to generate images, and is written into the MCP config that gives Claude panes{' '}
        <span className="mono">make_image</span>. The Anthropic key is stored but never used.
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
