import { useSyncExternalStore } from 'react'
import type { PaneFace } from './pane-status'

/**
 * The pane on screen, as the status line needs to reach it.
 *
 * The status line lives in the composer's dock (SessionComposer), outside the
 * pane tree, and is also drawn by the preview harness with no store at all —
 * so it cannot ask the store for the pane, and it cannot hold the terminal.
 * The pane that is focused *and* on screen publishes itself here instead: its
 * id and the few things the line can do to it. Exactly one pane is both at a
 * time; a pane that stops being either withdraws, but only if it is still the
 * one published, so a hand-over in one commit cannot be undone by the loser's
 * cleanup running second.
 */
export interface ScreenPane {
  paneId: string
  /**
   * What is wrong with the pane, in one word's worth, or null. `waiting`: it
   * has settled on a question. `reconnecting`: the link dropped and the screen
   * is where it had got to. `frozen`: no desktop at all, the cached twin.
   */
  condition: 'waiting' | 'reconnecting' | 'frozen' | null
  /** Show one face of the pane. */
  showView: (face: PaneFace) => void
  /** Copy what the terminal shows, and say so in the toast. */
  copyScreen: () => void
  /** The next tab (+1) or the previous one (-1), the way the tab strip selects. */
  stepTab: (step: 1 | -1) => void
}

let current: ScreenPane | null = null
const listeners = new Set<() => void>()

function emit(): void {
  for (const listener of listeners) listener()
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function publishScreenPane(pane: ScreenPane): void {
  current = pane
  emit()
}

export function withdrawScreenPane(paneId: string): void {
  if (current?.paneId !== paneId) return
  current = null
  emit()
}

export function useScreenPane(): ScreenPane | null {
  return useSyncExternalStore(
    subscribe,
    () => current,
    () => null
  )
}

/* ------------------------------------------------------------ typing mode
 *
 * Whether the phone's composer box has the caret. The fold itself is CSS
 * (`:has()` on `.app[data-mobile]`, see styles.css); this is the same fact for
 * the one reader CSS cannot reach — the terminal, which holds its grid while
 * the chrome folds and the keyboard slides, so neither is a PTY resize.
 *
 * `focusin` / `focusout` on the document, read as "is the focused element the
 * composer's box" rather than tracked as a toggle: a focus that moves straight
 * from the box to another input is one `focusout` and one `focusin`, and the
 * answer after both is the right one whichever order they land in.
 */

const COMPOSER_BOX = '.session-composer .composer__input'

let typing = false
const typingListeners = new Set<() => void>()
let watching = false

function readTyping(): void {
  const active = typeof document === 'undefined' ? null : document.activeElement
  const next = active instanceof Element && active.matches(COMPOSER_BOX)
  if (next === typing) return
  typing = next
  for (const listener of typingListeners) listener()
}

function subscribeTyping(listener: () => void): () => void {
  typingListeners.add(listener)
  if (!watching && typeof document !== 'undefined') {
    watching = true
    // `focusout` fires before focus lands anywhere, so the read waits a task.
    document.addEventListener('focusin', readTyping, true)
    document.addEventListener('focusout', () => window.setTimeout(readTyping, 0), true)
  }
  return () => {
    typingListeners.delete(listener)
  }
}

export function useComposerFocus(): boolean {
  return useSyncExternalStore(
    subscribeTyping,
    () => typing,
    () => false
  )
}
