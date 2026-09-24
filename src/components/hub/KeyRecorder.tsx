import { useEffect, useRef, useState, type ReactNode } from 'react'
import { useKeymap } from '@/hooks/useHub'
import {
  comboFromEvent,
  formatCombo,
  isLoneModifier,
  lonerReason,
  reservedReason,
  talkKeyFromCode,
  TALK_KEY_RULE
} from '@/lib/keymap'
import { suspendShortcuts } from '@/lib/keymapRegistry'

/**
 * "Press the new keys." A field that listens for one combo and hands it back.
 *
 * Every shortcut is suspended while it listens, so Ctrl+W can be recorded
 * instead of closing a pane. A combo a terminal needs (a bare letter, Ctrl+C,
 * an arrow…) is refused on the spot with the reason, before anything is saved;
 * Esc gives up, Backspace clears.
 *
 * `talk` records a voice key instead (Dictate, Agent): ONE key on its own. A
 * lone modifier counts when it goes down and comes back up with nothing else
 * pressed, so Right Shift records as "Right Shift" (the code 'ShiftRight')
 * while Shift+A is refused. An ordinary command refuses a lone modifier with
 * the reason, instead of silently waiting for a second key.
 */
export function KeyRecorder({
  value,
  onRecord,
  onCancel,
  onClear,
  autoFocus = true,
  talk = false
}: {
  value?: string | null
  onRecord: (combo: string) => void
  onCancel: () => void
  onClear?: () => void
  autoFocus?: boolean
  /** Record a voice key (one key on its own, lone modifiers allowed) rather than a combo. */
  talk?: boolean
}): ReactNode {
  const ref = useRef<HTMLButtonElement | null>(null)
  const [refusal, setRefusal] = useState<string | null>(null)
  const [held, setHeld] = useState<string>('')
  /** The lone modifier that is down right now, and whether another key joined it. */
  const lone = useRef<{ code: string; other: boolean } | null>(null)

  useEffect(() => {
    const release = suspendShortcuts()
    if (autoFocus) ref.current?.focus()
    return release
  }, [autoFocus])

  const onKeyDown = (e: React.KeyboardEvent): void => {
    e.preventDefault()
    e.stopPropagation()
    if (e.key === 'Escape' && !e.ctrlKey && !e.altKey && !e.shiftKey) {
      onCancel()
      return
    }
    if ((e.key === 'Backspace' || e.key === 'Delete') && !e.ctrlKey && !e.altKey && !e.shiftKey && onClear) {
      onClear()
      return
    }
    if (e.repeat) return
    // Right Alt on a UK (AltGr) layout: Windows sends a fake Left Ctrl down
    // first, then Right Alt. Without this, Right Alt counted as "Left Ctrl +
    // another key" and nothing was ever recorded. The fake Ctrl is replaced.
    if (e.code === 'AltRight' && lone.current?.code === 'ControlLeft' && !lone.current.other) lone.current = null
    if (isLoneModifier(e.code)) {
      if (!lone.current) lone.current = { code: e.code, other: false }
      else lone.current.other = true
    } else if (lone.current) lone.current.other = true
    if (talk) {
      if (isLoneModifier(e.code)) {
        setHeld(formatCombo(e.code))
        return
      }
      const key = !lone.current && !e.ctrlKey && !e.altKey && !e.shiftKey && !e.metaKey ? talkKeyFromCode(e.code) : null
      if (!key) {
        setRefusal(TALK_KEY_RULE)
        return
      }
      setRefusal(null)
      onRecord(key)
      return
    }
    const mods = [e.ctrlKey && 'Ctrl', e.altKey && 'Alt', e.shiftKey && 'Shift', e.metaKey && 'Meta'].filter(Boolean)
    setHeld(mods.join('+'))
    const combo = comboFromEvent(e.nativeEvent)
    if (!combo) return
    const why = reservedReason(combo)
    if (why) {
      setRefusal(`${formatCombo(combo)} — ${why}`)
      return
    }
    setRefusal(null)
    onRecord(combo)
  }

  /** A lone modifier coming back up with nothing pressed alongside it. */
  const onKeyUp = (e: React.KeyboardEvent): void => {
    const down = lone.current
    // The fake Left Ctrl of AltGr comes up before Right Alt does: not ours.
    if (down?.code === 'AltRight' && e.code === 'ControlLeft') return
    setHeld('')
    if (!down || down.code !== e.code) return
    lone.current = null
    if (down.other) return
    if (talk) {
      setRefusal(null)
      onRecord(down.code)
      return
    }
    setRefusal(lonerReason(down.code))
  }

  return (
    <span className="krec">
      <button
        ref={ref}
        type="button"
        className="krec__field"
        data-refused={refusal ? 'true' : undefined}
        onKeyDown={onKeyDown}
        onKeyUp={onKeyUp}
        onBlur={onCancel}
      >
        {held ? (
          <span className="kbd kbd--live">{talk ? held : `${held}+…`}</span>
        ) : (
          <span className="krec__prompt">{talk ? 'Press the new key…' : 'Press the new keys…'}</span>
        )}
        {value && !held ? <span className="krec__was">was {formatCombo(value)}</span> : null}
      </button>
      {refusal ? (
        <span className="krec__refusal" role="alert">
          <span aria-hidden="true">✕</span> {refusal}
        </span>
      ) : (
        <span className="krec__hint">Esc cancels{onClear ? ' · Backspace clears' : ''}</span>
      )}
    </span>
  )
}

/** One combo as key caps: "Ctrl+Shift+G" → [Ctrl][Shift][G]. */
export function Keys({ combo, size = 'md' }: { combo: string; size?: 'sm' | 'md' }): ReactNode {
  const parts = formatCombo(combo).split('+')
  return (
    <span className="keys" data-size={size} aria-label={combo}>
      {parts.map((p, i) => (
        <kbd key={i} className="kbd">
          {p}
        </kbd>
      ))}
    </span>
  )
}

/** The keys a keymap command is bound to right now (rebinding updates it), or nothing. */
export function CommandKeys({ id, size = 'sm' }: { id: string; size?: 'sm' | 'md' }): ReactNode {
  const { commands } = useKeymap()
  const combo = commands.find((c) => c.id === id)?.keys[0]
  return combo ? <Keys combo={combo} size={size} /> : null
}
