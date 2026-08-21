import { useCallback, useRef, useState, type ReactNode } from 'react'
import type { LayoutNode, PaneLeaf } from '@shared/types'
import { resolveProfile } from '@/lib/agents'
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
      if (images.length) await sendImages(images)
      if (text) {
        // A newline in this box is a line in the prompt, not a submit. Bracketed
        // paste is how the TUI takes a multi-line draft as one message; a bare
        // `\n` down the PTY is Enter, and would send the first line alone.
        const payload = text.includes('\n') ? `\x1b[200~${text}\x1b[201~\r` : `${text}\r`
        actions.write(paneId, payload)
        setDraft('')
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

  /** Read the clipboard: text lands in the draft, images come back as attachments. */
  const pasteFromClipboard = useCallback(async (): Promise<File[] | void> => {
    if (!canType) return
    const clip = typeof navigator !== 'undefined' ? navigator.clipboard : undefined
    try {
      if (clip?.read) {
        const items = await clip.read()
        const images: File[] = []
        let text = ''
        for (const item of items) {
          const imageType = item.types.find((t) => t.startsWith('image/'))
          if (imageType) {
            const blob = await item.getType(imageType)
            images.push(new File([blob], `clipboard.${imageType.split('/')[1] ?? 'png'}`, { type: imageType }))
          } else if (item.types.includes('text/plain')) {
            text += await (await item.getType('text/plain')).text()
          }
        }
        if (images.length) return images
        if (text) {
          setDraft((current) => (current ? `${current}\n${text}` : text))
          return
        }
        actions.setNotice('The clipboard is empty.')
        return
      }
      if (clip?.readText) {
        const text = await clip.readText()
        if (text) setDraft((current) => (current ? `${current}\n${text}` : text))
        else actions.setNotice('The clipboard is empty.')
        return
      }
    } catch {
      actions.setNotice('Paste into the box — this browser will not hand the clipboard over.')
    }
  }, [actions, canType])

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
        onPasteClick={pasteFromClipboard}
        onFocus={takePane}
        autoFocus={canType}
      />
    </div>
  )
}
