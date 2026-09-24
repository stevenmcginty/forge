import { useSyncExternalStore } from 'react'

/*
 * The deck face's little shared stores for the voice bar: whether the floating
 * composer has been asked for, where the Listen switch draws itself, and what
 * Listen is doing. Module-level, like ./sheet.tsx, because the triggers (the
 * top bar, the D button, the keyboard) and the composer live in different
 * components — and the composer itself (SessionComposer) is shared with the
 * phone and not the deck's to change.
 */

function store<T>(initial: T): {
  get: () => T
  set: (next: T) => void
  use: () => T
} {
  let value = initial
  const listeners = new Set<() => void>()
  const subscribe = (fn: () => void): (() => void) => {
    listeners.add(fn)
    return () => listeners.delete(fn)
  }
  const get = (): T => value
  return {
    get,
    set: (next) => {
      if (Object.is(next, value)) return
      value = next
      listeners.forEach((fn) => fn())
    },
    use: () => useSyncExternalStore(subscribe, get, get)
  }
}

/** The floating composer, asked for (a shortcut, Type, or the D button's words). */
export const composerOpen = store(false)

/**
 * Where the Listen switch draws itself — a span in the voice bar group, in
 * the top bar or the dock. SessionComposer renders the switch (it owns the
 * recording); ./ListenSwitch.tsx portals it here, so it keeps its state and
 * its place in the React tree while it sits somewhere else on screen.
 */
export const listenHost = store<HTMLElement | null>(null)

/** Listen's phase, published by the switch: a dictation in flight keeps the composer up. */
export const listenPhase = store<'idle' | 'recording' | 'transcribing' | 'review'>('idle')

/** The composer's text box, in whichever place the bar is. */
export function composerField(): HTMLTextAreaElement | null {
  return document.querySelector<HTMLTextAreaElement>('.app[data-face="deck"] .dk-composer .composer__input')
}

type TextField = HTMLInputElement | HTMLTextAreaElement

const TEXT_INPUTS = new Set(['text', 'search', 'url', 'email', 'tel', ''])

/**
 * The text field that has the keyboard, if any. Not xterm's: a terminal takes
 * keys through a hidden textarea, and words dropped into it would go nowhere a
 * person can see.
 */
export function focusedField(): TextField | null {
  const el = document.activeElement
  if (el instanceof HTMLTextAreaElement) {
    if (el.classList.contains('xterm-helper-textarea') || el.readOnly || el.disabled) return null
    return el
  }
  if (el instanceof HTMLInputElement) {
    if (!TEXT_INPUTS.has(el.type) || el.readOnly || el.disabled) return null
    return el
  }
  return null
}

/**
 * Put words at a field's caret, with a space either side where they would
 * otherwise run into a word. `insertText` rather than setting `value`, so the
 * field's own input handling (React's onChange) sees an ordinary edit and
 * Ctrl+Z takes it back; the value setter is the fallback where a browser
 * refuses the command.
 */
export function insertAtCaret(field: TextField, text: string, atEnd = false): void {
  field.focus()
  const length = field.value.length
  if (atEnd) field.setSelectionRange(length, length)
  const start = field.selectionStart ?? length
  const end = field.selectionEnd ?? start
  const before = field.value.slice(0, start)
  const after = field.value.slice(end)
  const words = `${before && !/\s$/.test(before) ? ' ' : ''}${text}${after && !/^\s/.test(after) ? ' ' : ''}`
  let done = false
  try {
    done = document.execCommand('insertText', false, words)
  } catch {
    done = false
  }
  if (done) return
  const proto = field instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
  Object.getOwnPropertyDescriptor(proto, 'value')?.set?.call(field, before + words + after)
  const caret = before.length + words.length
  field.setSelectionRange(caret, caret)
  field.dispatchEvent(new Event('input', { bubbles: true }))
}

/** Open the composer and focus its box, once it is on screen to take the focus. */
export function openComposer(then?: (field: HTMLTextAreaElement) => void): void {
  composerOpen.set(true)
  // Two frames: one for React to show it, one for the browser to make it focusable.
  requestAnimationFrame(() =>
    requestAnimationFrame(() => {
      const field = composerField()
      if (!field) return
      field.focus()
      then?.(field)
    })
  )
}

/** Words for the composer: open it and put them at the end of what is already there. */
export function dictateIntoComposer(text: string): boolean {
  if (!document.querySelector('.app[data-face="deck"] .dk-composer')) return false
  openComposer((field) => insertAtCaret(field, text, true))
  return true
}
