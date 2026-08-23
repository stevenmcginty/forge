import { useCallback, useRef, useState, type ReactNode } from 'react'
import type { LayoutNode, PaneLeaf } from '@shared/types'
import type { EffortLevel } from '@shared/agents'
import { effortRefusal, effortSlash } from '@shared/agents'
import { isShellProfile, resolveProfile } from '@/lib/agents'
import { packImage } from '../lib/image'
import { usePaneStatus } from '../lib/pane-status'
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
   * Every agent pane gets the picker; what a pick does is the dialect question
   * `effortSlash` answers. A Claude-exe pane takes `/effort <level>` typed as
   * words and Enter as its own keystroke a beat later — the same two-write
   * rhythm `sendDraft` uses, because a slash command that arrives holding its
   * own `\r` reads as a paste and sits in the TUI's box unsent. A pane whose
   * CLI has no reachable dial gets the refusal sentence as a notice instead of
   * keystrokes into a menu this browser cannot see.
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

  return (
    <div className="session-composer">
      {profile ? (
        <AgentStatus profile={profile} status={status} live={canType} onCycleMode={() => sendRaw(BACK_TAB)} />
      ) : null}
      <Composer
        draft={draft}
        disabled={!canType}
        disabledReason={reason}
        to={to}
        onDraft={setDraft}
        onSend={(images) => void sendDraft(images)}
        onRaw={sendRaw}
        onEffort={profile && !isShellProfile(profile) ? (level) => void sendEffort(level) : undefined}
        onFocus={takePane}
        autoFocus={canType}
      />
    </div>
  )
}
