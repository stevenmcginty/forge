import { useCallback, useRef, useState, type ReactNode } from 'react'
import { packImage } from '../lib/image'
import { useForge, useWorkspace } from '../state'
import { Composer } from './Composer'

/**
 * The one text box for this browser.
 *
 * Panes paint the terminal; this is the app's input. It always talks to the
 * focused pane — the same pane a click in the display selects — so a split
 * still has one box, not one per sliver.
 */

export function SessionComposer(): ReactNode {
  const { state, actions } = useForge()
  const workspace = useWorkspace()
  const [draft, setDraft] = useState('')
  const sendingImage = useRef(false)

  const offline = state.stage.kind === 'offline'
  const live = !offline && state.connection.state === 'live'
  const tab = workspace.tabs.find((t) => t.id === workspace.activeTabId) ?? workspace.tabs[0]
  const paneId = tab?.activePaneId ?? null
  const alive = paneId !== null && (state.picture?.sessions ?? []).some((s) => s.id === paneId)
  const canType = live && alive && paneId !== null

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

  const sendDraft = useCallback(() => {
    const text = draft.replace(/\s+$/, '')
    if (!text || !canType || !paneId) return
    // A newline in this box is a line in the prompt, not a submit. Bracketed
    // paste is how the TUI takes a multi-line draft as one message; a bare
    // `\n` down the PTY is Enter, and would send the first line alone.
    const payload = text.includes('\n') ? `\x1b[200~${text}\x1b[201~\r` : `${text}\r`
    actions.write(paneId, payload)
    setDraft('')
    takePane()
  }, [actions, canType, draft, paneId, takePane])

  const sendRaw = useCallback(
    (data: string) => {
      if (!canType || !paneId || !data) return
      actions.write(paneId, data)
      takePane()
    },
    [actions, canType, paneId, takePane]
  )

  const pasteFromClipboard = useCallback(async () => {
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
        if (images.length) {
          void sendImages(images)
          return
        }
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
  }, [actions, canType, sendImages])

  if (offline && state.offlineMode === 'github') return null
  if (!tab) return null

  return (
    <Composer
      draft={draft}
      disabled={!canType}
      onDraft={setDraft}
      onSend={sendDraft}
      onRaw={sendRaw}
      onImages={(files) => void sendImages(files)}
      onPasteClick={() => void pasteFromClipboard()}
      onFocus={takePane}
      autoFocus={canType}
    />
  )
}
