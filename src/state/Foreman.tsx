import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode
} from 'react'
import { MAX_PANES_PER_TAB, MAX_SESSIONS } from '@shared/ipc'
import { isShellProfile } from '@shared/agents'
import {
  idleForemanState,
  type ForemanState,
  type ForemanStatus,
  type ForemanToolRequest,
  type ForemanToolResult
} from '@shared/foreman'
import { resolveProfile } from '@/lib/agents'
import {
  runAppAction,
  type ActionContext,
  type ActionPane,
  type ActionRunner,
  type AppAction
} from '@/lib/appactions'
import { collectLeaves, countLeaves } from '@/lib/splitTree'
import { terminalHost } from '@/lib/terminals'
import { useApp } from '@/state/AppState'

/**
 * Foreman, as the renderer holds it.
 *
 * The agent itself lives in the main process (electron/foreman/) — one Agent
 * SDK session per driven pane, whose hands are that pane's keyboard. This side
 * does exactly two things, and mounting it once above the whole tree is what
 * keeps both of them singular:
 *
 *  1. **It holds the states.** `list()` at mount, then every `onState` push,
 *     keyed by pane. Every surface that draws a driven pane — the header
 *     toggle, the footer, the decision log — is a view of this one map, so two
 *     panes' headers can never disagree about what Foreman is doing.
 *  2. **It answers.** Only the renderer knows what is open, so when Foreman
 *     hires an agent it asks *this* side to open the pane, over
 *     `foreman:tool-request`. The host bounds that round trip at 15 seconds and
 *     an unanswered request is a hire that silently fails, so the contract is
 *     the one src/lib/agenttools.ts states for the voice agent: **exactly one
 *     answer per request id, always** — a request that throws, or names a tool
 *     Forge does not have, still answers, with `ok: false` and a sentence
 *     saying why.
 *
 * Its own channel and its own subscription rather than the voice agent's: two
 * hosts sharing one request/result pair would have each other's answers
 * resolving their promises (see FOREMAN_IPC in shared/foreman.ts).
 */

/** Statuses where Foreman has the keyboard. The toggle is lit for these. */
export function foremanDriving(status: ForemanStatus): boolean {
  return status === 'starting' || status === 'driving' || status === 'waiting'
}

export interface ForemanCtx {
  /** This pane's state, or the idle one for a pane nobody has driven. */
  paneState(paneId: string): ForemanState
  /** Switch Foreman on. An empty seed means "take over what is already here". */
  start(paneId: string, seed: string): Promise<void>
  /** Switch it off. The human has the keyboard from that line on. */
  stop(paneId: string): void
  /**
   * Take a finished or failed footer off the screen.
   *
   * Local to this window and deliberately so: main keeps the state (and the
   * log) for as long as the app runs, which is what lets you reopen the log
   * after dismissing the line. Any later push about the same pane — a new job
   * on it — un-dismisses it.
   */
  dismiss(paneId: string): void
  dismissed(paneId: string): boolean
}

const ForemanContext = createContext<ForemanCtx | null>(null)

export function ForemanProvider({ children }: { children: ReactNode }): ReactNode {
  const { state, actions } = useApp()

  const [states, setStates] = useState<ReadonlyMap<string, ForemanState>>(() => new Map())
  const [hidden, setHidden] = useState<ReadonlySet<string>>(() => new Set())

  /** Fold one state in, and un-dismiss the pane it belongs to. */
  const absorb = useCallback((next: ForemanState): void => {
    if (!next?.paneId) return
    setStates((prev) => new Map(prev).set(next.paneId, next))
    setHidden((prev) => {
      if (!prev.has(next.paneId)) return prev
      const out = new Set(prev)
      out.delete(next.paneId)
      return out
    })
  }, [])

  // `list()` first, then the pushes. A pane driven before this window reloaded
  // is still being driven, and its header has to say so on the first paint.
  useEffect(() => {
    // A renderer that hot-reloaded ahead of its preload (the desktop app has
    // not restarted since Foreman landed) has no `foreman` on the bridge. That
    // is a missing feature, never a reason to unmount the whole app — the phone
    // and the browser run their layout commands through this renderer.
    const api = window.forge?.foreman
    if (!api) {
      console.error('[foreman] window.forge.foreman is missing; restart Forge to load the new preload.')
      return
    }
    let alive = true
    void api.list().then((list) => {
      if (!alive) return
      setStates((prev) => {
        const out = new Map(prev)
        for (const s of list) out.set(s.paneId, s)
        return out
      })
    })
    const off = api.onState((next) => absorb(next))
    return () => {
      alive = false
      off()
    }
  }, [absorb])

  /* ------------------------------------------------------------- executor
   *
   * The same `runAppAction` every other path uses, over a context and a runner
   * snapshotted each render and read through refs — the session outlives every
   * render, and a copy captured when the subscription was made would be
   * answering about a Forge from ten minutes ago.
   */

  /**
   * The executor's view of one project.
   *
   * Built per request rather than once per render, and for the project that
   * *owns the driven pane* rather than the one on screen: Foreman hires from a
   * pane the human may have left for another project minutes ago, and a hire
   * that followed their focus was work leaking into the wrong folder. Every
   * pane is numbered the way the executor numbers them; `lastFocusedAt` is 0
   * for all of them, and honestly so — focus order exists to disambiguate a
   * *spoken* target and nothing Foreman sends is spoken.
   */
  const stateRef = useRef(state)
  stateRef.current = state
  const contextFor = (projectId: string | null): ActionContext => {
    const st = stateRef.current
    const proj = projectId ? (st.projects.find((p) => p.id === projectId) ?? null) : null
    const ws = proj ? st.workspaces[proj.id] : undefined
    const tab = ws?.tabs.find((t) => t.id === ws.activeTabId) ?? null
    const panes: ActionPane[] = []
    ws?.tabs.forEach((t, tabIndex) => {
      for (const leaf of collectLeaves(t.root)) {
        const profile = resolveProfile(st.settings.agentProfiles, leaf.profileId)
        const status = terminalHost.runtime(leaf.id).status
        panes.push({
          paneId: leaf.id,
          tabId: t.id,
          tabNumber: tabIndex + 1,
          tabTitle: t.title,
          number: panes.length + 1,
          title: leaf.title.trim() || profile.name,
          profileId: profile.id,
          profileName: profile.name,
          live: status !== 'exited' && status !== 'error',
          focused: leaf.id === t.activePaneId && t.id === ws?.activeTabId,
          agent: !isShellProfile(profile),
          lastFocusedAt: 0
        })
      }
    })
    let total = 0
    for (const w of Object.values(st.workspaces)) for (const t of w.tabs) total += countLeaves(t.root)
    return {
      panes,
      projects: st.projects.map((p) => ({ id: p.id, name: p.name })),
      profiles: st.settings.agentProfiles,
      defaultProfileId: proj?.defaultProfileId ?? st.settings.agentProfiles[0]?.id ?? 'pwsh',
      activeProjectId: proj?.id ?? null,
      activeProjectName: proj?.name ?? null,
      loadedProjectIds: Object.keys(st.workspaces),
      tabs: (ws?.tabs ?? []).map((t) => ({ id: t.id, title: t.title })),
      activeTabId: ws?.activeTabId ?? null,
      focusedPaneId: tab?.activePaneId ?? null,
      paneCount: total,
      panesInActiveTab: tab ? countLeaves(tab.root) : 0,
      maxSessions: MAX_SESSIONS,
      maxPanesPerTab: MAX_PANES_PER_TAB
    }
  }
  const contextForRef = useRef(contextFor)
  contextForRef.current = contextFor

  /** The project whose workspace holds this pane, or null if it is gone. */
  const projectOwning = (paneId: string): string | null => {
    for (const [projectId, ws] of Object.entries(stateRef.current.workspaces)) {
      for (const t of ws.tabs) if (collectLeaves(t.root).some((leaf) => leaf.id === paneId)) return projectId
    }
    return null
  }
  const projectOwningRef = useRef(projectOwning)
  projectOwningRef.current = projectOwning
  /**
   * The layout actions, and only those.
   *
   * Hiring an agent pane is the one thing Foreman asks the app for today
   * (`open_agent_pane` in electron/foreman/host.ts sends `open_panes`), and the
   * rest of the layout vocabulary comes free with the executor. The optional
   * runners are deliberately absent: typing into a pane and reading one back
   * are tools Foreman already has in main, against the PTY itself, and a second
   * road to the same keyboard is a second thing to keep honest. An action that
   * needs one of them fails with a sentence rather than doing nothing quietly.
   */
  const runnerRef = useRef<ActionRunner | null>(null)
  runnerRef.current = {
    newTab: (profileId) => actions.newTab(profileId),
    splitPane: (paneId, direction, profileId) => actions.splitPane(paneId, direction, profileId),
    closePane: (paneId) => actions.closePane(paneId),
    closeTab: (tabId) => actions.closeTab(tabId),
    selectProject: (projectId) => actions.selectProject(projectId),
    selectTab: (tabId) => actions.selectTab(tabId),
    renameTab: (tabId, title) => actions.renameTab(tabId, title),
    setViewMode: (mode) => actions.setViewMode(mode),
    openSettings: (section) => actions.openSettings(section as Parameters<typeof actions.openSettings>[0])
  }

  /* --------------------------------------------------------- the answers */

  useEffect(() => {
    const api = window.forge?.foreman
    if (!api) {
      // A stale preload bundle rather than broken wiring — see src/lib/agentbrain.ts.
      console.error('[foreman] window.forge.foreman is missing; hiring is not wired up.')
      return undefined
    }

    const answer = async (request: ForemanToolRequest): Promise<void> => {
      const id = String(request?.id ?? '')
      if (!id) return

      let result: ForemanToolResult
      try {
        if (request.name !== 'run_app_action') {
          result = { id, ok: false, error: `Forge has no tool called ${String(request.name)}` }
        } else {
          const action = asAction(request.args)
          // Anchored actions run in the project that owns the anchor pane.
          const anchor = action && 'anchorPaneId' in action ? String(action.anchorPaneId ?? '') : ''
          const projectId = anchor ? projectOwningRef.current(anchor) : (stateRef.current.activeProjectId ?? null)
          const ctx = contextForRef.current(projectId)
          const runner = runnerRef.current
          if (!action) {
            result = { id, ok: false, error: 'that action had no "kind" — see the tool description' }
          } else if (!ctx || !runner) {
            result = { id, ok: false, error: 'the executor was not ready — try that again' }
          } else {
            // `ok` is carried rather than folded into the text: a refused action
            // has a perfectly cheerful summary ("This tab is full — nothing
            // split") and Foreman has to be able to tell it from a hire that
            // actually happened.
            const outcome = runAppAction(action, ctx, runner)
            result = outcome.ok ? { id, ok: true, result: outcome.summary } : { id, ok: false, error: outcome.summary }
          }
        }
      } catch (err) {
        result = { id, ok: false, error: err instanceof Error ? err.message : String(err) }
      }

      try {
        await api.toolResult(result)
      } catch (err) {
        console.error('[foreman] could not deliver a tool result:', err)
      }
    }

    return api.onToolRequest((request) => void answer(request))
  }, [])

  /* ------------------------------------------------------------ the switch */

  const start = useCallback(
    async (paneId: string, seed: string): Promise<void> => {
      // Optimistic, so the header lights the instant it is clicked: opening the
      // session is a round trip through the SDK and the toggle must not sit
      // grey while it happens. The real state lands a beat later, on the
      // invoke's answer and then on every push.
      absorb({ paneId, status: 'starting', line: 'Brief taken — starting Foreman', seed, log: [] })
      // And a notice in the status bar, where a glance lands: the footer line
      // is small and the brief is minutes of planning before the pane moves.
      actions.setNotice('Foreman is on it — reading the pane and planning the brief')
      try {
        const api = window.forge?.foreman
        if (!api) throw new Error('Foreman is not loaded — restart Forge.')
        absorb(await api.start({ paneId, seed }))
      } catch (err) {
        absorb({
          paneId,
          status: 'error',
          line: err instanceof Error ? err.message : String(err),
          seed,
          log: []
        })
      }
    },
    [absorb, actions]
  )

  const stop = useCallback(
    (paneId: string): void => {
      // Off *now*, locally, for the same reason: the human has just said they
      // want the keyboard back, and the answer is the confirmation, not the act.
      const current = states.get(paneId)
      absorb({
        paneId,
        status: 'off',
        line: 'Stopped — you have the keyboard',
        seed: current?.seed ?? '',
        log: current?.log ?? []
      })
      void window.forge?.foreman?.stop(paneId).then(absorb, (err: unknown) => {
        console.error('[foreman] stop failed:', err)
      })
    },
    [absorb, states]
  )

  const dismiss = useCallback((paneId: string): void => {
    setHidden((prev) => {
      if (prev.has(paneId)) return prev
      const out = new Set(prev)
      out.add(paneId)
      return out
    })
  }, [])

  const value = useMemo<ForemanCtx>(
    () => ({
      paneState: (paneId) => states.get(paneId) ?? idleForemanState(paneId),
      start,
      stop,
      dismiss,
      dismissed: (paneId) => hidden.has(paneId)
    }),
    [states, hidden, start, stop, dismiss]
  )

  return <ForemanContext.Provider value={value}>{children}</ForemanContext.Provider>
}

export function useForeman(): ForemanCtx {
  const ctx = useContext(ForemanContext)
  if (!ctx) throw new Error('useForeman must be used inside <ForemanProvider>')
  return ctx
}

/**
 * An action object off the wire, checked just enough to hand on.
 *
 * Deliberately shallow, exactly as src/lib/agenttools.ts is: `runAppAction`
 * validates every field it uses and answers "I did not understand that" for an
 * unknown kind, so a second schema here would be a second thing to keep in step
 * with the union.
 */
function asAction(args: unknown): AppAction | null {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return null
  const kind = (args as { kind?: unknown }).kind
  if (typeof kind !== 'string' || !kind.trim()) return null
  return args as AppAction
}
