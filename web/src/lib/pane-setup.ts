import { useCallback, useSyncExternalStore } from 'react'
import type { AgentProfile, ClaudePermissionMode } from '@shared/types'
import type { AgentModelSpec, EffortLevel, EffortLevelSpec, PermissionModeSpec } from '@shared/agents'
import {
  agentModels,
  effortLevels,
  effortRefusal,
  effortSlash,
  matchAgentModel,
  modePickerSlash,
  modeRefusal,
  modelRefusal,
  modelSlash,
  permissionModes,
  permissionSpec,
  tabsToPermissionMode
} from '@shared/agents'
import { isShellProfile } from '@/lib/agents'
import type { PermissionMode } from '@/lib/rich'
import { BACK_TAB } from '../components/Composer'
import { useForge } from '../state'
import { usePaneStatus } from './pane-status'

/**
 * How a pane is set up — its model, the effort picked for it and its
 * permission mode — and the three senders that change them. One hook, read by
 * both faces that show it on a phone: the side drawer's model pill
 * (SessionComposer → ModelChip) and the top bar's context chip (ContextChip),
 * so a pick in either shows in both and goes down the wire the same way.
 *
 * Effort has no reading off the pane (no CLI prints it), so the rung picked
 * here is kept per pane in a module store, outside any component: the drawer
 * mounts its pill only while it is out, and the chip must see a pick made
 * there. A model pick likewise stands in for the pane's reading until that
 * reading moves.
 */

/** The gap between the words and the Enter that sends them. Same as SessionComposer's. */
const SETTLE_BEFORE_ENTER_MS = 120
/** The gap between Shift+Tab presses while walking a permission cycle. */
const SETTLE_BETWEEN_TABS_MS = 80

const pause = (ms: number): Promise<void> => new Promise((resolve) => window.setTimeout(resolve, ms))

/** The Forge rung the status strip is reporting, plus Claude's extra `auto`. */
export function liveRung(mode: PermissionMode | undefined): ClaudePermissionMode | 'auto' | null {
  if (mode === 'default' || mode === 'plan' || mode === 'bypass') return mode
  if (mode === 'accept-edits') return 'acceptEdits'
  if (mode === 'auto') return 'auto'
  return null
}

/* ------------------------------------------------------------- the picks */

const effortPicked = new Map<string, EffortLevel>()
/** A model picked here, and the pane's own reading it was picked over. */
const modelPicked = new Map<string, { id: string; over: string | null }>()
const listeners = new Set<() => void>()
let version = 0

function emit(): void {
  version += 1
  for (const listener of listeners) listener()
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

const snapshot = (): number => version

/** Remember the effort picked for a pane from this phone. */
export function pickEffort(paneId: string, level: EffortLevel): void {
  effortPicked.set(paneId, level)
  emit()
}

/** Remember a model picked for a pane, over the reading it had when it was picked. */
export function pickModel(paneId: string, id: string, over: string | null): void {
  modelPicked.set(paneId, { id, over })
  emit()
}

/** The effort picked here for this pane, or null until one is. */
export function useEffortPicked(paneId: string | null): EffortLevel | null {
  useSyncExternalStore(subscribe, snapshot, snapshot)
  return paneId ? (effortPicked.get(paneId) ?? null) : null
}

/**
 * The model picked here for this pane, while the pane still reads what it read
 * when the pick was made. Once its own reading moves, that wins.
 */
export function useModelPicked(paneId: string | null, currentModelId: string | null): string | null {
  useSyncExternalStore(subscribe, snapshot, snapshot)
  if (!paneId) return null
  const pick = modelPicked.get(paneId)
  return pick && pick.over === currentModelId ? pick.id : null
}

/* -------------------------------------------------------------- the hook */

export interface PaneSetup {
  /** An agent with something to set: false for a shell or no pane. */
  agent: boolean
  roster: AgentModelSpec[]
  levels: EffortLevelSpec[]
  ladder: PermissionModeSpec[]
  rung: ClaudePermissionMode | 'auto' | null
  /** The pane's own model, matched to the roster. */
  currentModelId: string | null
  /** The model in force: a pick made here standing in, else the pane's own. */
  modelId: string | null
  /** The model as the pane printed it, for one that is not on the roster. */
  modelText: string | undefined
  currentModeId: ClaudePermissionMode | null
  /** A rung the ladder does not list (Claude's `auto`), in words. */
  modeText: string | undefined
  effortId: EffortLevel | null
  /** The pane takes input: the pickers are live. */
  canType: boolean
  sendModel: (id: string) => Promise<void>
  sendEffort: (level: EffortLevel) => Promise<void>
  sendMode: (mode: ClaudePermissionMode) => Promise<void>
}

export function usePaneSetup(paneId: string | null, profile: AgentProfile | null): PaneSetup {
  const { state, actions } = useForge()
  const status = usePaneStatus(paneId)
  const offline = state.stage.kind === 'offline'
  const live = !offline && state.connection.state === 'live'
  const alive = paneId !== null && (state.picture?.sessions ?? []).some((s) => s.id === paneId)
  const canType = live && alive && paneId !== null

  const agent = Boolean(profile && !isShellProfile(profile))
  const roster = profile && agent ? agentModels(profile.command) : []
  const levels = profile && agent ? effortLevels(profile.command) : []
  const ladder = profile && agent ? permissionModes(profile.command) : []
  const rung = liveRung(status?.mode)
  const currentModeId = rung === 'auto' || rung === null ? null : rung
  const currentModelId = matchAgentModel(roster, status?.model)?.id ?? null
  const picked = useModelPicked(paneId, currentModelId)
  const effortId = useEffortPicked(paneId)

  const takePane = useCallback(() => {
    if (paneId && canType) actions.claim(paneId)
  }, [actions, canType, paneId])

  /**
   * An effort level, picked for this pane.
   *
   * What a pick does is the dialect question `effortSlash` answers. A Claude
   * or Grok pane takes `/effort <level>` typed as words and Enter as its own
   * keystroke a beat later — the same two-write rhythm `sendDraft` uses,
   * because a slash command that arrives holding its own `\r` reads as a paste
   * and sits in the TUI's box unsent.
   */
  const sendEffort = useCallback(
    async (level: EffortLevel) => {
      if (!canType || !paneId || !profile) return
      const type = effortSlash(profile.command)
      if (!type) {
        actions.setNotice(effortRefusal(profile.command))
        return
      }
      actions.write(paneId, type(level))
      // The same wait `sendText` makes: the desktop has the command before its Enter.
      await actions.request({ kind: 'claim', sessionId: paneId })
      await pause(SETTLE_BEFORE_ENTER_MS)
      actions.write(paneId, '\r')
      takePane()
    },
    [actions, canType, paneId, profile, takePane]
  )

  /**
   * A model, picked for this pane from that CLI's own list.
   *
   * Claude and Grok take `/model <id>` typed as words and Enter a beat later,
   * the same two-write rhythm as effort. A CLI with no dialect gets a sentence
   * rather than keystrokes into a menu this browser cannot see.
   */
  const sendModel = useCallback(
    async (id: string) => {
      if (!canType || !paneId || !profile) return
      const type = modelSlash(profile.command)
      if (!type) {
        actions.setNotice(modelRefusal(profile.command))
        return
      }
      actions.write(paneId, type(id))
      await pause(SETTLE_BEFORE_ENTER_MS)
      actions.write(paneId, '\r')
      takePane()
    },
    [actions, canType, paneId, profile, takePane]
  )

  /**
   * A permission rung, picked for this pane from that CLI's own list.
   *
   * Claude and Grok walk Shift+Tab from the mode the status strip reports to
   * the one that was picked. Codex has no cycle — `/permissions` opens its
   * own menu. A rung that is launch-only (Claude bypass) is a sentence, not
   * a keystroke into a cycle that will never land there.
   */
  const sendMode = useCallback(
    async (mode: ClaudePermissionMode) => {
      if (!canType || !paneId || !profile) return
      const command = profile.command
      const picker = modePickerSlash(command)
      if (picker) {
        actions.write(paneId, picker)
        await pause(SETTLE_BEFORE_ENTER_MS)
        actions.write(paneId, '\r')
        takePane()
        return
      }
      const from = liveRung(status?.mode)
      const steps = tabsToPermissionMode(command, from, mode)
      if (steps === null) {
        const spec = permissionSpec(command, mode)
        actions.setNotice(
          from === null
            ? 'This pane has not printed its mode yet.'
            : spec
              ? `${spec.label} has to be chosen when the pane opens.`
              : modeRefusal(command)
        )
        return
      }
      if (steps === 0) return
      for (let i = 0; i < steps; i++) {
        actions.write(paneId, BACK_TAB)
        if (i < steps - 1) await pause(SETTLE_BETWEEN_TABS_MS)
      }
      takePane()
    },
    [actions, canType, paneId, profile, status?.mode, takePane]
  )

  return {
    agent,
    roster,
    levels,
    ladder,
    rung,
    currentModelId,
    modelId: picked ?? currentModelId,
    modelText: status?.model,
    currentModeId,
    modeText: rung === 'auto' ? 'Auto' : undefined,
    effortId,
    canType,
    sendModel,
    sendEffort,
    sendMode
  }
}
