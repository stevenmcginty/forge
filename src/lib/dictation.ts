import { terminalHost } from '@/lib/terminals'

/**
 * Where a dictated phrase should land, and how to put it there.
 *
 * The rule is "wherever focus is". The wrinkle is that xterm's own focus target
 * is a hidden textarea, so a focused terminal *looks* like a focused text field
 * unless you check — and that a click on the pill itself moves focus off
 * whatever the user was actually aiming at, which is why callers keep a
 * remembered target from when listening started.
 */

export type InsertTarget =
  | { kind: 'terminal'; paneId: string }
  | { kind: 'field'; el: HTMLInputElement | HTMLTextAreaElement }
  | { kind: 'none' }

/** xterm's hidden textarea — a focused terminal, not a form field. */
export const XTERM_TEXTAREA = 'xterm-helper-textarea'

const TEXTY_INPUT_TYPES = new Set(['text', 'search', 'url', 'email', 'tel', 'password', ''])

function isTextField(el: Element): el is HTMLInputElement | HTMLTextAreaElement {
  if (el instanceof HTMLTextAreaElement) return !el.disabled && !el.readOnly
  if (el instanceof HTMLInputElement) {
    return !el.disabled && !el.readOnly && TEXTY_INPUT_TYPES.has(el.type)
  }
  return false
}

/** The pane id of the terminal `el` sits inside, if any. */
function enclosingPaneId(el: Element): string | null {
  const pane = el.closest<HTMLElement>('.pane[data-pane-id]')
  return pane?.dataset['paneId'] ?? null
}

/**
 * Resolve the live insertion target from whatever currently has focus.
 * `fallbackPaneId` is the app's own idea of the focused pane, used when focus
 * is sitting on our chrome (the pill, a toolbar button) rather than anywhere
 * that takes text.
 */
export function resolveInsertTarget(fallbackPaneId: string | null): InsertTarget {
  const el = document.activeElement

  if (el && el instanceof HTMLElement) {
    if (el.classList.contains(XTERM_TEXTAREA)) {
      const paneId = enclosingPaneId(el)
      if (paneId) return { kind: 'terminal', paneId }
    } else if (isTextField(el)) {
      return { kind: 'field', el }
    }
  }

  if (fallbackPaneId && terminalHost.has(fallbackPaneId)) {
    return { kind: 'terminal', paneId: fallbackPaneId }
  }
  return { kind: 'none' }
}

/**
 * Insert text at the caret of an input/textarea.
 *
 * Assigning `.value` directly would be invisible to React, which caches the
 * last value it rendered — so we go through the prototype's setter and then fire
 * the native `input` event React actually listens for.
 */
export function insertIntoField(el: HTMLInputElement | HTMLTextAreaElement, text: string): void {
  const start = el.selectionStart ?? el.value.length
  const end = el.selectionEnd ?? start
  const next = el.value.slice(0, start) + text + el.value.slice(end)

  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement : HTMLInputElement
  const setter = Object.getOwnPropertyDescriptor(proto.prototype, 'value')?.set
  if (setter) setter.call(el, next)
  else el.value = next

  const caret = start + text.length
  el.setSelectionRange(caret, caret)
  el.dispatchEvent(new Event('input', { bubbles: true }))
}

export type InsertOutcome = 'terminal' | 'field' | 'clipboard'

/**
 * Put one dictated phrase where it belongs. A trailing space is added so
 * consecutive phrases do not run into each other.
 *
 * Nothing focused means nothing gets typed into the void: the text goes to the
 * clipboard and the caller says so, which is recoverable. Losing the words is
 * not.
 *
 * **The insertion takes focus with it.** Dictation is started by clicking the
 * pill or pressing the hotkey, and a click leaves DOM focus on the pill — so the
 * words appeared at the prompt while the keyboard was still pointed at a button.
 * The tell was the cursor: xterm draws a hollow outline box instead of its
 * blinking bar when the terminal is unfocused, and Enter went to the pill rather
 * than the shell (on the pill, Enter re-triggers it — so dictation toggled off
 * instead of the command running). You had to click into the pane to say what
 * you had already said. Landing the text and handing focus to the same place is
 * what makes "dictate, read it back, press Enter" work.
 */
export function insertPhrase(text: string, target: InsertTarget): InsertOutcome {
  const payload = `${text.trim()} `

  if (target.kind === 'terminal' && terminalHost.type(target.paneId, payload)) {
    terminalHost.focus(target.paneId)
    return 'terminal'
  }
  if (target.kind === 'field' && target.el.isConnected) {
    // Focus first, then insert: the insert leaves the caret after the phrase,
    // and taking focus afterwards is the one order that can move it back.
    target.el.focus()
    insertIntoField(target.el, payload)
    return 'field'
  }

  void navigator.clipboard.writeText(payload).catch(() => {
    /* a denied clipboard is not worth a crash */
  })
  return 'clipboard'
}
