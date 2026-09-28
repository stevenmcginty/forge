import type { TerminalTab, Workspace } from '@shared/types'
import { chatLeafOf, collectLeaves } from './splitTree'

/**
 * The stops Full screen's Previous / Next panel walks (pane.prev / pane.next,
 * and the carousel's paddles, which run those commands).
 *
 * Tabs in order. A terminal tab gives each of its panes in order — the Agents
 * menu's order — and a chat tab is one stop of its own, so the arrows flick
 * into ChatGPT, Gemini or Claude and out the other side. Plain module, no DOM,
 * so the order can be checked without a window.
 */
export type PaneStop =
  | { kind: 'pane'; tabId: string; paneId: string }
  | { kind: 'chat'; tabId: string; chatId: string }

export function paneStops(tabs: readonly Pick<TerminalTab, 'id' | 'root'>[]): PaneStop[] {
  const out: PaneStop[] = []
  for (const tab of tabs) {
    const chat = chatLeafOf(tab)
    if (chat) out.push({ kind: 'chat', tabId: tab.id, chatId: chat.id })
    else for (const leaf of collectLeaves(tab.root)) out.push({ kind: 'pane', tabId: tab.id, paneId: leaf.id })
  }
  return out
}

/**
 * The stop `delta` away from where the workspace is now, wrapping at both
 * ends: the active chat tab's stop, else the active tab's focused pane. Null
 * when there is nowhere else to go.
 */
export function stepStop(
  workspace: Pick<Workspace, 'activeTabId'> & { tabs: readonly Pick<TerminalTab, 'id' | 'root' | 'activePaneId'>[] },
  delta: number
): PaneStop | null {
  const stops = paneStops(workspace.tabs)
  if (stops.length < 2) return null
  const tab = workspace.tabs.find((t) => t.id === workspace.activeTabId)
  const i = Math.max(
    0,
    stops.findIndex((s) =>
      s.kind === 'chat' ? s.tabId === tab?.id : s.tabId === tab?.id && s.paneId === tab.activePaneId
    )
  )
  return stops[(i + delta + stops.length) % stops.length]!
}
