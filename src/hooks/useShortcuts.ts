import { useEffect } from 'react'
import type { SplitDirection } from '@shared/types'
import { terminalHost } from '@/lib/terminals'
import { useActiveTab, useActiveWorkspace, useApp } from '@/state/AppState'

/** Broadcast so <TerminalGrid> can pop its agent chooser open. */
export const NEW_TAB_EVENT = 'forge:new-tab'

type Dir = 'left' | 'right' | 'up' | 'down'

const ARROWS: Record<string, Dir> = {
  ArrowLeft: 'left',
  ArrowRight: 'right',
  ArrowUp: 'up',
  ArrowDown: 'down'
}

/**
 * Global keyboard map. Registered in the capture phase so it wins against
 * xterm's textarea handler, which would otherwise swallow Ctrl+W and friends.
 */
export function useShortcuts(): void {
  const { state, actions } = useApp()
  const workspace = useActiveWorkspace()
  const tab = useActiveTab()

  useEffect(() => {
    const handler = (e: KeyboardEvent): void => {
      const ctrl = e.ctrlKey && !e.altKey
      const shift = e.shiftKey
      const alt = e.altKey && !e.ctrlKey

      const stop = (): void => {
        e.preventDefault()
        e.stopPropagation()
      }

      // The voice panel toggle works from anywhere, including its own text box.
      if (ctrl && shift && e.code === 'KeyG') {
        stop()
        actions.toggleVoicePanel()
        return
      }

      // Text fields (renaming a pane/tab, popover forms, the voice composer)
      // keep their keys.
      const el = document.activeElement
      if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) return

      const activePaneId = tab?.activePaneId ?? null

      /* --------------------------------------------------- tabs & panes */

      if (ctrl && !shift && e.code === 'KeyT') {
        stop()
        window.dispatchEvent(new CustomEvent(NEW_TAB_EVENT))
        return
      }

      if (ctrl && !shift && e.code === 'KeyW') {
        stop()
        if (activePaneId) actions.closePane(activePaneId)
        return
      }

      if (ctrl && shift && e.code === 'KeyW') {
        stop()
        if (tab) actions.closeTab(tab.id)
        return
      }

      if (ctrl && e.code === 'Tab') {
        stop()
        const tabs = workspace.tabs
        if (tabs.length < 2) return
        const i = tabs.findIndex((t) => t.id === workspace.activeTabId)
        const next = shift ? (i - 1 + tabs.length) % tabs.length : (i + 1) % tabs.length
        actions.selectTab(tabs[next]!.id)
        return
      }

      if (alt && /^Digit[1-9]$/.test(e.code)) {
        const index = Number(e.code.slice(5)) - 1
        const target = workspace.tabs[index]
        if (target) {
          stop()
          actions.selectTab(target.id)
        }
        return
      }

      /* ------------------------------------------------------- splitting */

      if (ctrl && shift && ARROWS[e.key]) {
        stop()
        if (!activePaneId) return
        const dir = ARROWS[e.key]!
        const direction: SplitDirection = dir === 'left' || dir === 'right' ? 'row' : 'column'
        actions.splitPane(activePaneId, direction)
        return
      }

      /* --------------------------------------------------- focus movement */

      if (alt && ARROWS[e.key]) {
        stop()
        if (!activePaneId) return
        const target = neighbour(activePaneId, ARROWS[e.key]!)
        if (target) {
          actions.focusPane(target)
          terminalHost.focus(target)
        }
        return
      }

      /* ------------------------------------------------------ clipboard
       *
       * Ctrl+C / Ctrl+V inside a terminal are handled per pane, in
       * terminalHost's xterm key handler, so that a plain Ctrl+C with nothing
       * selected still reaches the shell as ^C. These two are the app-wide
       * aliases: they work even when focus sits on some piece of chrome rather
       * than in the terminal itself.
       */

      if (ctrl && shift && e.code === 'KeyC') {
        if (!activePaneId) return
        if (terminalHost.copySelectionToClipboard(activePaneId)) stop()
        return
      }

      if (ctrl && shift && e.code === 'KeyV') {
        stop()
        if (activePaneId) void terminalHost.pasteFromClipboard(activePaneId)
        return
      }

      /* -------------------------------------------------------- chrome */

      if (ctrl && shift && e.code === 'KeyB') {
        stop()
        actions.toggleRail()
        return
      }

      if (ctrl && !shift && (e.code === 'Equal' || e.code === 'NumpadAdd')) {
        stop()
        actions.setFontSize(state.settings.terminalFontSize + 1)
        return
      }

      if (ctrl && !shift && (e.code === 'Minus' || e.code === 'NumpadSubtract')) {
        stop()
        actions.setFontSize(state.settings.terminalFontSize - 1)
        return
      }

      if (ctrl && !shift && e.code === 'Digit0') {
        stop()
        actions.setFontSize(13)
      }
    }

    window.addEventListener('keydown', handler, true)
    return () => window.removeEventListener('keydown', handler, true)
  }, [actions, state.settings.terminalFontSize, tab, workspace])
}

/**
 * Geometric pane navigation: from the focused pane, pick the nearest pane whose
 * centre lies in the requested direction. Works for any split arrangement
 * without having to reason about the tree.
 */
function neighbour(fromPaneId: string, dir: Dir): string | null {
  const panes = [...document.querySelectorAll<HTMLElement>('.pane[data-pane-id]')]
  const self = panes.find((p) => p.dataset['paneId'] === fromPaneId)
  if (!self || panes.length < 2) return null

  const a = self.getBoundingClientRect()
  const ax = a.left + a.width / 2
  const ay = a.top + a.height / 2

  let best: { id: string; score: number } | null = null
  for (const pane of panes) {
    const id = pane.dataset['paneId']
    if (!id || id === fromPaneId) continue
    const b = pane.getBoundingClientRect()
    const dx = b.left + b.width / 2 - ax
    const dy = b.top + b.height / 2 - ay

    const along = dir === 'left' ? -dx : dir === 'right' ? dx : dir === 'up' ? -dy : dy
    if (along <= 1) continue
    const across = Math.abs(dir === 'left' || dir === 'right' ? dy : dx)
    // Prefer the closest pane in the travel direction, penalising sideways drift.
    const score = along + across * 2
    if (!best || score < best.score) best = { id, score }
  }
  return best?.id ?? null
}
