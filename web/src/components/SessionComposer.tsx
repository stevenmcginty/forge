import { useCallback, useRef, useState, type ReactNode } from 'react'
import type { ClaudePermissionMode, LayoutNode, PaneLeaf } from '@shared/types'
import type { EffortLevel } from '@shared/agents'
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
import { isShellProfile, resolveProfile } from '@/lib/agents'
import { packImage } from '../lib/image'
import { requestPaneView, usePaneStatus, usePaneView, type PaneFace } from '../lib/pane-status'
import { getClaudeView, setClaudeView } from '../lib/view-pref'
import type { PermissionMode } from '@/lib/rich'
import { useForge, useProfiles, useWorkspace } from '../state'
import { AgentStatus } from './AgentStatus'
import { BACK_TAB, Composer } from './Composer'

/**
 * The one text box for this browser, with the agent's status strip over it.
 *
 * Panes paint the terminal; this is the app's input. It always talks to the
 * focused pane — the same pane a click in the display selects — so a split
 * still has one box, not one per sliver.
 */

/** How long the TUI gets to finish taking a pasted image path before the words arrive. */
const SETTLE_AFTER_IMAGE_MS = 400
/** The gap between the words and the Enter that sends them. */
const SETTLE_BEFORE_ENTER_MS = 120
/** The gap between Shift+Tab presses while walking a permission cycle. */
const SETTLE_BETWEEN_TABS_MS = 80

/** The Forge rung the status strip is reporting, plus Claude's extra `auto`. */
function liveRung(mode: PermissionMode | undefined): ClaudePermissionMode | 'auto' | null {
  if (mode === 'default' || mode === 'plan' || mode === 'bypass') return mode
  if (mode === 'accept-edits') return 'acceptEdits'
  if (mode === 'auto') return 'auto'
  return null
}

const pause = (ms: number): Promise<void> => new Promise((resolve) => window.setTimeout(resolve, ms))

function findLeaf(node: LayoutNode, id: string): PaneLeaf | null {
  if (node.type === 'leaf') return node.id === id ? node : null
  return findLeaf(node.a, id) ?? findLeaf(node.b, id)
}

export function SessionComposer(): ReactNode {
  const { state, actions } = useForge()
  const workspace = useWorkspace()
  const profiles = useProfiles()
  const [draft, setDraft] = useState('')
  const sendingImage = useRef(false)

  const offline = state.stage.kind === 'offline'
  const live = !offline && state.connection.state === 'live'
  const tab = workspace.tabs.find((t) => t.id === workspace.activeTabId) ?? workspace.tabs[0]
  const paneId = tab?.activePaneId ?? null
  const alive = paneId !== null && (state.picture?.sessions ?? []).some((s) => s.id === paneId)
  const canType = live && alive && paneId !== null
  const leaf = tab && paneId ? findLeaf(tab.root, paneId) : null
  const profile = leaf ? resolveProfile(profiles, leaf.profileId) : null
  const status = usePaneStatus(paneId)
  const view = usePaneView(paneId)
  const project = state.picture?.projects?.find((p) => p.id === state.projectId)?.name ?? ''

  const sendImages = useCallback(
    async (files: File[]) => {
      if (!files.length || !canType || !paneId || sendingImage.current) return
      sendingImage.current = true
      try {
        for (const file of files) {
          try {
            const packed = await packImage(file)
            const result = await actions.request({
              kind: 'paste-image',
              sessionId: paneId,
              mime: packed.mime,
              data: packed.data
            })
            if (result.kind === 'failed') actions.setNotice(result.message)
          } catch (err) {
            actions.setNotice(err instanceof Error ? err.message : 'That image could not be sent.')
          }
        }
      } finally {
        sendingImage.current = false
      }
    },
    [actions, canType, paneId]
  )

  const takePane = useCallback(() => {
    if (paneId && canType) actions.claim(paneId)
  }, [actions, canType, paneId])

  const sendDraft = useCallback(
    async (images: File[]) => {
      if (!canType || !paneId) return
      const text = draft.replace(/\s+$/, '')
      if (!text && !images.length) return
      // Images first: the TUI takes each as a paste into its own box, and the
      // words after it become the message that refers to them.
      if (images.length) {
        await sendImages(images)
        // The TUI is still taking the pasted path into its box; words landing
        // in the same instant get folded into that paste.
        await pause(SETTLE_AFTER_IMAGE_MS)
      }
      if (text) {
        // A newline in this box is a line in the prompt, not a submit. Bracketed
        // paste is how the TUI takes a multi-line draft as one message; a bare
        // `\n` down the PTY is Enter, and would send the first line alone.
        actions.write(paneId, text.includes('\n') ? `\x1b[200~${text}\x1b[201~` : text)
        setDraft('')
        // Enter is its own keystroke, a beat after the words — never in the
        // same write. Claude Code's input reads one burst holding text and a
        // `\r` as a paste and turns the `\r` into a newline, so the message sat
        // in its box unsent. The desktop's own `submit()` keeps the carriage
        // return separate for the same reason.
        await pause(SETTLE_BEFORE_ENTER_MS)
        actions.write(paneId, '\r')
      }
      takePane()
    },
    [actions, canType, draft, paneId, sendImages, takePane]
  )

  const sendRaw = useCallback(
    (data: string) => {
      if (!canType || !paneId || !data) return
      actions.write(paneId, data)
      takePane()
    },
    [actions, canType, paneId, takePane]
  )

  /**
   * An effort level, picked for this pane.
   *
   * The composer only offers the picker when `effortLevels` is non-empty;
   * what a pick does is the dialect question `effortSlash` answers. A Claude
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

  if (offline && state.offlineMode === 'github') return null
  if (!tab) return null

  const to = profile ? (project ? `${profile.name} · ${project}` : profile.name) : undefined
  const reason = offline
    ? 'The desktop is asleep'
    : !live
      ? 'Reconnecting…'
      : !alive
        ? 'This pane has closed'
        : 'Reconnecting…'
  const roster = profile && !isShellProfile(profile) ? agentModels(profile.command) : []
  const levels = profile && !isShellProfile(profile) ? effortLevels(profile.command) : []
  const ladder = profile && !isShellProfile(profile) ? permissionModes(profile.command) : []
  const rung = liveRung(status?.mode)
  const currentModeId = rung === 'auto' || rung === null ? null : rung
  const currentModelId = matchAgentModel(roster, status?.model)?.id ?? null

  const isAgent = profile && !isShellProfile(profile)
  const activeView: PaneFace = view ?? (isAgent ? getClaudeView() : 'term')
  const nextView: PaneFace = isAgent ? (activeView === 'chat' ? 'feed' : activeView === 'feed' ? 'term' : 'chat') : 'term'

  const onFlipView = () => {
    if (!paneId) return
    requestPaneView(paneId, nextView)
    if (isAgent) setClaudeView(nextView)
  }

  return (
    <div className="session-composer" data-view={view}>
      {profile ? (
        <AgentStatus
          profile={profile}
          status={status}
          live={canType}
          view={activeView}
          onFlipView={isAgent ? onFlipView : undefined}
        />
      ) : null}
      <Composer
        draft={draft}
        disabled={!canType}
        disabledReason={reason}
        to={to}
        onDraft={setDraft}
        onSend={(images) => void sendDraft(images)}
        onRaw={sendRaw}
        models={roster}
        currentModelId={currentModelId}
        onModel={roster.length ? (id) => void sendModel(id) : undefined}
        effortLevels={levels}
        onEffort={levels.length ? (level) => void sendEffort(level) : undefined}
        modes={ladder}
        currentModeId={currentModeId}
        onMode={ladder.length ? (mode) => void sendMode(mode) : undefined}
        onFocus={takePane}
        autoFocus={canType}
      />
    </div>
  )
}
