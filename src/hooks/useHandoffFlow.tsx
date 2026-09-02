import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { handoffAskPrompt, handoffTakePrompt } from '@shared/handoff'
import type { HandoffRecord, HandoffStartRequest } from '@shared/types'
import { isClaudeCommand, isShellProfile, paneDisplayTitle, resolveProfile } from '@/lib/agents'
import { handoffPaneTitle, type HandoffTarget } from '@/lib/handoffview'
import { collectLeaves } from '@/lib/splitTree'
import { terminalHost } from '@/lib/terminals'
import { useActiveProject, useActiveWorkspace, useApp } from '@/state/AppState'

/**
 * The Handoff gesture, from the click to the take-over prompt.
 *
 * A provider rather than a plain hook, and for the reason the share snapshot is
 * one watch rather than one per row: `handoff:watch` is singular in main
 * (electron/handoff-watcher.ts keeps exactly one), so a hook called from every
 * TerminalPane would have every pane stopping and restarting every other pane's
 * watch on each render. One subscription above the grid, one list of records,
 * and every pane's menu and chip is a view of it.
 *
 * What the flow actually does, in order:
 *
 *  1. `start` writes the pack — header and template, `open` — and Forge pastes
 *     the ask into the *source* pane. Never submitted unless the tab says so.
 *  2. The agent fills the file with its own tools. Main's watcher notices and
 *     promotes it to `ready`. Nothing here polls, and nothing here nags: an
 *     agent that never writes the pack leaves a chip in its header saying so,
 *     and that is the whole of the reminder.
 *  3. On `ready`, the pack is marked `taken` *first* and delivered second — two
 *     change events for the same file cannot both get past a mark that has
 *     already moved it off `ready`.
 *
 * The chosen target lives in renderer memory, keyed by handoff id, because it
 * is the one part of a handoff that is not in the file: the pack records who
 * *took* it, which is not knowable until it is taken. Restart Forge mid-handoff
 * and the target is lost — the pack survives, still `open` or `ready` on disk,
 * and the source pane's menu can hand it off again. That is deliberately not
 * worth a second index alongside the files.
 */

/** A target waiting for its pack to be written. Renderer memory only — see above. */
interface Waiting {
  target: HandoffTarget
  /** `tab.settings?.handoffAutoSend === true` at the moment the handoff started. */
  autoSend: boolean
  /** The source pane's display title, for the new pane's tab name. */
  fromTitle: string
}

/** A new pane that has been opened but whose id the record does not know yet. */
interface Adoption {
  handoffId: string
  title: string
  /** Every pane id that existed before the tab was opened. The new one is the odd one out. */
  before: Set<string>
  at: number
}

/** How long a new pane has to appear before its adoption is given up on. */
const ADOPT_TIMEOUT_MS = 30_000

export interface HandoffFlow {
  /** Every pack in the active project, as main last read them. Newest first. */
  records: HandoffRecord[]
  /** Start one: write the pack and ask this pane's agent to fill it in. */
  handOff(paneId: string, target: HandoffTarget): Promise<void>
  /** Show a pack in Explorer. `null` shows the folder. */
  reveal(id: string | null): void
}

const HandoffContext = createContext<HandoffFlow | null>(null)

export function useHandoffFlow(): HandoffFlow {
  const ctx = useContext(HandoffContext)
  if (!ctx) throw new Error('useHandoffFlow must be used inside <HandoffProvider>')
  return ctx
}

export function HandoffProvider({ children }: { children: ReactNode }): ReactNode {
  const { state, actions } = useApp()
  const project = useActiveProject()
  const workspace = useActiveWorkspace()

  const projectId = project?.id ?? ''
  const projectPath = project?.path ?? ''
  const profiles = state.settings.agentProfiles

  const [records, setRecords] = useState<HandoffRecord[]>([])

  const waiting = useRef(new Map<string, Waiting>())
  const delivering = useRef(new Set<string>())
  const adopting = useRef<Adoption[]>([])

  /*
   * The pieces the delivery effect needs but must not re-run for. It runs on the
   * records arriving, and re-running it because a pane was renamed would be a
   * second delivery attempt for a pack it has already handed on.
   */
  const live = useRef({ workspace, profiles, actions, projectId })
  live.current = { workspace, profiles, actions, projectId }

  /* ---------------------------------------------------------------- watch */

  useEffect(() => {
    // Another project is another folder of packs. Better a moment of nothing
    // than a moment of another project's chips on these panes.
    setRecords([])
    waiting.current.clear()
    delivering.current.clear()
    adopting.current = []
  }, [projectId])

  // Guarded, both effects: a renderer built after this feature can run against
  // a preload built before it (the everyday Forge updates by git pull and keeps
  // its boot-time bundle until restarted), and an unguarded call on a missing
  // bridge method unmounts the whole tree. No handoffs until the restart is a
  // far better failure than a blank window.
  useEffect(() => {
    if (!window.forge.handoff) return
    return window.forge.handoff.onChanged((id, next) => {
      if (id === projectId) setRecords(next)
    })
  }, [projectId])

  useEffect(() => {
    if (!projectId || !projectPath || !window.forge.handoff) return
    void window.forge.handoff.watch(projectId)
    return () => window.forge.handoff.unwatch(projectId)
  }, [projectId, projectPath])

  /* ------------------------------------------------------------ delivery */

  /**
   * Focus, a frame, then the text.
   *
   * The frame is the DECSET 1004 race documented on TerminalPane's file drop: an
   * agent that has just been told the terminal lost focus drops the paste that
   * follows it. Enter, when it is pressed at all, waits another frame — a
   * bracketed paste and its terminator have to be down the pipe before the
   * newline that submits them.
   */
  const deliverTo = useCallback((paneId: string, text: string, submit: boolean): void => {
    live.current.actions.revealPane(paneId)
    terminalHost.focus(paneId)
    requestAnimationFrame(() => {
      terminalHost.paste(paneId, text)
      if (submit) requestAnimationFrame(() => terminalHost.submit(paneId))
    })
  }, [])

  const deliver = useCallback(
    async (record: HandoffRecord, want: Waiting): Promise<void> => {
      const { workspace: ws, profiles: list, actions: act, projectId: id } = live.current
      const target = want.target

      if (target.paneId) {
        const leaf = ws.tabs.flatMap((t) => collectLeaves(t.root)).find((l) => l.id === target.paneId)
        if (!leaf || terminalHost.runtime(leaf.id).status !== 'live') {
          act.setNotice(`The pane “${target.label}” is gone — the pack is still in .forge/handoff`)
          waiting.current.delete(record.id)
          return
        }
        const profile = resolveProfile(list, leaf.profileId)
        const toTitle = paneDisplayTitle(profile, leaf.title)
        // Marked before it is delivered, so a second change event for the same
        // file finds a pack that is no longer `ready` and stops there.
        const marked = await window.forge.handoff.mark(id, record.id, {
          status: 'taken',
          to: leaf.id,
          toAgent: profile.name,
          toTitle
        })
        if (!marked) return
        waiting.current.delete(record.id)
        const body = await window.forge.handoff.read(id, record.id)
        deliverTo(leaf.id, handoffTakePrompt(marked, body?.body ?? null), want.autoSend)
        act.setNotice(`Handed off to ${profile.name}`)
        return
      }

      const profile = resolveProfile(list, target.profileId)
      const title = handoffPaneTitle(want.fromTitle)
      // `to` is left alone: the pane does not exist yet, and a pane id is only
      // worth writing once there is one. The adoption effect below fills it in
      // as soon as the new pane appears.
      const marked = await window.forge.handoff.mark(id, record.id, {
        status: 'taken',
        toAgent: profile.name,
        toTitle: title
      })
      if (!marked) return
      waiting.current.delete(record.id)
      const body = await window.forge.handoff.read(id, record.id)
      adopting.current.push({
        handoffId: record.id,
        title: title.slice(0, 40),
        before: new Set(ws.tabs.flatMap((t) => collectLeaves(t.root)).map((l) => l.id)),
        at: Date.now()
      })
      act.openAgentPane(title, handoffTakePrompt(marked, body?.body ?? null), {
        profileId: profile.id,
        submit: want.autoSend
      })
      act.setNotice(`Handed off to ${profile.name}`)
    },
    [deliverTo]
  )

  useEffect(() => {
    for (const record of records) {
      if (record.status !== 'ready') continue
      if (delivering.current.has(record.id)) continue
      const want = waiting.current.get(record.id)
      if (!want) continue
      // A pack whose source pane has gone belongs to a workspace this window is
      // no longer showing; leave it on disk rather than delivering it blind.
      const ws = live.current.workspace
      if (!ws.tabs.flatMap((t) => collectLeaves(t.root)).some((l) => l.id === record.from)) continue
      delivering.current.add(record.id)
      void deliver(record, want).finally(() => delivering.current.delete(record.id))
    }
  }, [records, deliver])

  /* ------------------------------------------------------------ adoption */

  /*
   * Name the pane a handoff opened.
   *
   * `openAgentPane` makes the tab and the pane in one dispatch, and the pane's
   * id is made inside the reducer — so the only way to learn it is to look at
   * the workspace afterwards and find the pane that was not there before. Worth
   * the round trip: without `to` on the record the new pane has no chip, and
   * nothing to hand back to.
   */
  useEffect(() => {
    if (adopting.current.length === 0) return
    const now = Date.now()
    const remaining: Adoption[] = []
    for (const want of adopting.current) {
      const leaf = workspace.tabs
        .filter((t) => t.title === want.title)
        .flatMap((t) => collectLeaves(t.root))
        .find((l) => !want.before.has(l.id))
      if (leaf) {
        void window.forge.handoff.mark(projectId, want.handoffId, { to: leaf.id })
        continue
      }
      // A pane that never opened — the session limit, a refused project — must
      // not leave an entry re-running this effect for the rest of the session.
      if (now - want.at < ADOPT_TIMEOUT_MS) remaining.push(want)
    }
    adopting.current = remaining
  }, [workspace, projectId])

  /* --------------------------------------------------------------- start */

  const handOff = useCallback(
    async (paneId: string, target: HandoffTarget): Promise<void> => {
      if (!projectId) return
      const all = workspace.tabs.flatMap((t) => collectLeaves(t.root))
      const leaf = all.find((l) => l.id === paneId)
      if (!leaf) return
      const tab = workspace.tabs.find((t) => collectLeaves(t.root).some((l) => l.id === paneId)) ?? null
      const profile = resolveProfile(profiles, leaf.profileId)
      if (isShellProfile(profile)) return
      const fromTitle = paneDisplayTitle(profile, leaf.title)
      const autoSend = tab?.settings?.handoffAutoSend === true

      // Only a Claude pane keeps a transcript on disk, and only one that has
      // said something has a file — the same rule the tab handover follows.
      let transcript = ''
      if (leaf.sessionId && isClaudeCommand(profile.command) && projectPath) {
        const found = await window.forge.system.claudeTranscript(projectPath, leaf.sessionId)
        if (found.exists) transcript = found.path
      }

      const req: HandoffStartRequest = {
        title: fromTitle,
        from: leaf.id,
        fromAgent: profile.name,
        fromTitle,
        toAgent: target.agent,
        ...(target.paneId ? { to: target.paneId } : {}),
        ...(target.origin ? { origin: target.origin } : {}),
        ...(transcript ? { transcript } : {})
      }

      const record = await window.forge.handoff.start(projectId, req)
      if (!record) {
        actions.setNotice('That handoff pack could not be written')
        return
      }
      waiting.current.set(record.id, { target, autoSend, fromTitle })
      deliverTo(leaf.id, handoffAskPrompt(record), autoSend)
    },
    [actions, deliverTo, profiles, projectId, projectPath, workspace]
  )

  const reveal = useCallback(
    (id: string | null): void => {
      if (projectId) window.forge.handoff.reveal(projectId, id)
    },
    [projectId]
  )

  const value = useMemo<HandoffFlow>(() => ({ records, handOff, reveal }), [records, handOff, reveal])

  return <HandoffContext.Provider value={value}>{children}</HandoffContext.Provider>
}
