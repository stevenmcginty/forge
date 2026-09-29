import { useEffect, useState, type ReactNode } from 'react'
import type { ForgeApi } from '@shared/api'
import type { ChatRelayActionResult, ChatRelayView } from '@shared/share'
import { ChatMark } from '../ChatMark'
import './ChatRelayBar.css'

/**
 * The chat relay banner: an agent asked ChatGPT, Gemini or Claude a question
 * (`chat_ask`), and Steve carries it — electron/chat-relay.ts holds the state.
 *
 *   needs-paste   "Rex asks ChatGPT: …"   [Copy and open ChatGPT]  [Dismiss]
 *   needs-answer  "Waiting for the answer…" [Send answer to Rex]   [Dismiss]
 *
 * Main does both clipboard moves, and only on these buttons: nothing is copied
 * and no tab is switched before Steve presses one. Several open questions show
 * the oldest, with "+N more". Every state is a word, never a colour alone.
 *
 * Mounted in the shell's flow under the title bar (App.tsx), so it pushes the
 * stage down and a chat page — a native view laid over the stage — is measured
 * below it rather than drawn over it.
 *
 * A Forge that booted an older preload has no `window.forge.chatRelay`; the
 * banner then renders nothing (the renderer hot-reloads, the preload does not).
 */

type RelayApi = NonNullable<ForgeApi['chatRelay']>

function relayBridge(): RelayApi | null {
  const api = (window as unknown as { forge?: Partial<ForgeApi> }).forge?.chatRelay
  if (
    !api ||
    typeof api.list !== 'function' ||
    typeof api.onState !== 'function' ||
    typeof api.copyAndOpen !== 'function' ||
    typeof api.sendAnswer !== 'function' ||
    typeof api.dismiss !== 'function'
  ) {
    return null
  }
  return api
}

/** How long "Sent to Rex" stays up. */
const SENT_MS = 2500

export function ChatRelayBar(): ReactNode {
  const [open, setOpen] = useState<ChatRelayView[]>([])
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<{ id: string; text: string } | null>(null)
  const [sent, setSent] = useState<string | null>(null)

  useEffect(() => {
    const api = relayBridge()
    if (!api) return
    let live = true
    api
      .list()
      .then((views) => {
        if (live && Array.isArray(views)) setOpen(views)
      })
      .catch(() => undefined)
    const off = api.onState((views) => setOpen(Array.isArray(views) ? views : []))
    return () => {
      live = false
      off?.()
    }
  }, [])

  useEffect(() => {
    if (!sent) return
    const t = setTimeout(() => setSent(null), SENT_MS)
    return () => clearTimeout(t)
  }, [sent])

  const api = relayBridge()
  if (!api) return null

  if (sent) {
    return (
      <div className="relaybar" role="status" data-state="sent">
        <div className="relaybar__row">
          <span className="relaybar__eyebrow">Chat relay</span>
          <span className="relaybar__text">
            <span aria-hidden="true">✓ </span>Sent to <strong>{sent}</strong>
          </span>
        </div>
      </div>
    )
  }

  const head = open[0]
  if (!head) return null
  const more = open.length - 1
  const shownNote = note && note.id === head.id ? note.text : ''

  const run = async (act: 'copy' | 'answer' | 'dismiss'): Promise<void> => {
    if (busy) return
    setBusy(true)
    let result: ChatRelayActionResult
    try {
      result =
        act === 'copy' ? await api.copyAndOpen(head.id) : act === 'answer' ? await api.sendAnswer(head.id) : await api.dismiss(head.id)
    } catch (err) {
      result = { ok: false, error: `Forge did not answer: ${(err as Error)?.message ?? String(err)}` }
    }
    setBusy(false)
    if (result?.ok) {
      setNote(null)
      if (act === 'answer') setSent(result.agent)
    } else {
      setNote({ id: head.id, text: result?.error || 'That did not work.' })
    }
  }

  const step = head.state === 'needs-paste' ? 'Step 1 of 2' : 'Step 2 of 2'

  return (
    <div className="relaybar" role="region" aria-label="Chat relay" data-state={head.state}>
      <div className="relaybar__row">
        <ChatMark bot={head.bot} size="sm" />
        <span className="relaybar__eyebrow" title={`Asked from ${head.projectName || 'a pane'}`}>
          Chat relay · {step}
        </span>
        {head.state === 'needs-paste' ? (
          <span className="relaybar__text" title={head.preview}>
            <strong>{head.agent}</strong> asks <strong>{head.botName}</strong>: “{head.preview}”
          </span>
        ) : (
          <span className="relaybar__text">
            Waiting for the answer. Copy it from <strong>{head.botName}</strong>, then press:
          </span>
        )}
        {more > 0 ? (
          <span className="relaybar__more" title={`${more} more question${more === 1 ? '' : 's'} waiting after this one`}>
            +{more} more
          </span>
        ) : null}
        <div className="relaybar__actions">
          {head.state === 'needs-paste' ? (
            <button type="button" className="relaybar__btn relaybar__btn--go" disabled={busy} onClick={() => void run('copy')}>
              Copy and open {head.botName}
            </button>
          ) : (
            <button type="button" className="relaybar__btn relaybar__btn--go" disabled={busy} onClick={() => void run('answer')}>
              Send answer to {head.agent}
            </button>
          )}
          <button type="button" className="relaybar__btn" disabled={busy} onClick={() => void run('dismiss')}>
            Dismiss
          </button>
        </div>
      </div>
      {shownNote ? (
        <div className="relaybar__note" role="alert">
          <strong>Not done:</strong> {shownNote}
        </div>
      ) : null}
    </div>
  )
}
