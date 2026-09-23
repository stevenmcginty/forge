import { useEffect, useRef, useState, type ReactNode } from 'react'
import { useKeymap } from '@/hooks/useHub'
import { comboFromEvent, formatCombo, reservedReason } from '@/lib/keymap'
import { suspendShortcuts } from '@/lib/keymapRegistry'

/**
 * "Press the new keys." A field that listens for one combo and hands it back.
 *
 * Every shortcut is suspended while it listens, so Ctrl+W can be recorded
 * instead of closing a pane. A combo a terminal needs (a bare letter, Ctrl+C,
 * an arrow…) is refused on the spot with the reason, before anything is saved;
 * Esc gives up, Backspace clears.
 */
export function KeyRecorder({
  value,
  onRecord,
  onCancel,
  onClear,
  autoFocus = true
}: {
  value?: string | null
  onRecord: (combo: string) => void
  onCancel: () => void
  onClear?: () => void
  autoFocus?: boolean
}): ReactNode {
  const ref = useRef<HTMLButtonElement | null>(null)
  const [refusal, setRefusal] = useState<string | null>(null)
  const [held, setHeld] = useState<string>('')

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

  return (
    <span className="krec">
      <button
        ref={ref}
        type="button"
        className="krec__field"
        data-refused={refusal ? 'true' : undefined}
        onKeyDown={onKeyDown}
        onKeyUp={() => setHeld('')}
        onBlur={onCancel}
      >
        {held ? <span className="kbd kbd--live">{held}+…</span> : <span className="krec__prompt">Press the new keys…</span>}
        {value && !held ? <span className="krec__was">was {value}</span> : null}
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
