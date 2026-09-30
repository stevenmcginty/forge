import { useEffect, useId, useMemo, useRef, type ReactNode } from 'react'
import { useKeymap } from '@/hooks/useHub'
import { shellSheet, useShellSheet } from '@/lib/shellSlots'
import { voiceSpeaker } from '@/lib/tts'
import { uiCommands, useUiCommand } from '@/lib/uiCommands'
import { useApp } from '@/state/AppState'
import { BrainGlyph } from './BrainGlyph'
import { BrainPanel, glyphStateOf } from './BrainPanel'
import { replyTo, toRows } from './brainRows'
import { peekSpeakPending, setBrainOpen, startBrainFeed, takeSpeakPending, toggleBrainOpen, useBrain } from './brainStore'
import { useBrainVoice } from './brainVoice'
import './Brain.css'

/**
 * Forge Brain in the top bar: its mark, turning and taking in bolts while it
 * works, and the drop-down chat under it. Click, or the shortcut
 * (Ctrl+Shift+F, rebindable as "Forge Brain"), opens it; Esc or a click
 * anywhere else puts it away.
 *
 * The badge says what needs saying, by shape: "!" when it is asking Steve (a
 * Yes / No card, or a question on its screen), "×" when it has stopped, and a
 * count of replies that came while it was shut. Off, it says nothing at all.
 *
 * It also reads aloud the answer to a message Steve spoke (the drop-down's
 * mic), once the answer is in — whether or not the drop-down is still open.
 */

const TOGGLE = 'toggle-brain'

export function BrainButton(): ReactNode {
  const snap = useBrain()
  const { status, open, unread } = snap
  const btnRef = useRef<HTMLButtonElement | null>(null)
  const wrapRef = useRef<HTMLSpanElement | null>(null)
  const panelId = useId()
  const { commands } = useKeymap()
  const combo = commands.find((c) => c.id === `ui.${TOGGLE}`)?.keys[0]

  useEffect(() => startBrainFeed(), [])
  useEffect(() => uiCommands.define({ id: TOGGLE, title: 'Forge Brain (chat)', group: 'Shell', defaultKey: 'Ctrl+Shift+F' }), [])
  useUiCommand(TOGGLE, () => toggleBrainOpen())

  // One pop-up at a time: opening the brain puts a sheet away, and a sheet
  // opening puts the brain away.
  const sheet = useShellSheet()
  useEffect(() => {
    if (open) shellSheet.set(null)
  }, [open])
  useEffect(() => {
    if (sheet) setBrainOpen(false)
  }, [sheet])

  // Esc, or a press anywhere that is not the drop-down or its button. Esc in
  // the brain's own terminal is the terminal's (it interrupts the agent).
  useEffect(() => {
    if (!open) return undefined
    const onDown = (e: PointerEvent): void => {
      const t = e.target as HTMLElement | null
      if (!t || wrapRef.current?.contains(t)) return
      if (t.closest('.popover')) return
      setBrainOpen(false)
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape' || e.defaultPrevented) return
      if ((e.target as HTMLElement | null)?.closest?.('.brainpanel__term')) return
      // Dictated words counting down to send: Esc is their Undo (BrainComposer).
      if (document.querySelector('.braincomp__review')) return
      e.preventDefault()
      e.stopPropagation()
      setBrainOpen(false)
      btnRef.current?.focus()
    }
    window.addEventListener('pointerdown', onDown, true)
    window.addEventListener('keydown', onKey, true)
    return () => {
      window.removeEventListener('pointerdown', onDown, true)
      window.removeEventListener('keydown', onKey, true)
    }
  }, [open])

  useSpokenReplies()

  const on = Boolean(status?.enabled)
  const needs = on && status ? status.state === 'asking' || status.confirms.length > 0 : false
  const stopped = on && status?.state === 'error'
  const glyph = glyphStateOf(status)
  const badge = needs ? 'needs' : stopped ? 'error' : on && unread > 0 && !open ? 'news' : null

  const words = !status
    ? 'Forge Brain'
    : !on
      ? 'Forge Brain — off. Click to see what it is'
      : needs
        ? 'Forge Brain needs you'
        : stopped
          ? `Forge Brain stopped${status.error ? ` — ${status.error}` : ''}`
          : status.state === 'busy'
            ? 'Forge Brain — working'
            : status.state === 'starting'
              ? 'Forge Brain — starting'
              : unread > 0
                ? `Forge Brain — ${unread} new ${unread === 1 ? 'reply' : 'replies'}`
                : 'Forge Brain — ready'

  return (
    <span className="brainbtn-wrap" ref={wrapRef}>
      <button
        ref={btnRef}
        type="button"
        className="brainbtn"
        data-state={glyph}
        data-open={open ? 'true' : undefined}
        aria-label={words}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        title={combo ? `${words} (${combo})` : words}
        onClick={() => toggleBrainOpen()}
      >
        <BrainGlyph state={glyph} />
        {badge === 'needs' ? (
          <span className="brainbtn__badge" data-kind="needs" aria-hidden="true">
            !
          </span>
        ) : badge === 'error' ? (
          <span className="brainbtn__badge" data-kind="error" aria-hidden="true">
            ×
          </span>
        ) : badge === 'news' ? (
          <span className="brainbtn__badge" data-kind="news" aria-hidden="true">
            {unread > 9 ? '9+' : unread}
          </span>
        ) : null}
      </button>
      {open ? <BrainPanel id={panelId} /> : null}
    </span>
  )
}

/**
 * The reply to a spoken message is spoken: once the brain is idle again and
 * the transcript has an answer after that prompt, it is read in Forge's voice.
 */
function useSpokenReplies(): void {
  const snap = useBrain()
  const voice = useBrainVoice()
  const { actions } = useApp()
  const rows = useMemo(() => toRows(snap.feed.turns, []), [snap.feed.turns])
  const idle = snap.status?.state === 'idle'

  useEffect(() => {
    const waiting = peekSpeakPending()
    if (!waiting || !idle) return
    const reply = replyTo(rows, waiting.text)
    if (!reply) return
    takeSpeakPending()
    void voiceSpeaker.speakOnce(`brain:${reply.key}`, reply.text, voice, (msg) => actions.setNotice(msg))
  }, [rows, idle, voice, actions])
}
