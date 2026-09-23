import { useEffect, useRef } from 'react'
import type { SplitDirection } from '@shared/types'
import { XTERM_TEXTAREA } from '@/lib/dictation'
import { focusNavTarget, getHubRuntime } from '@/lib/hubRuntime'
import { comboFromEvent } from '@/lib/keymap'
import { commandForCombo, hasHandler, runCommand, setCommandHandler, type CommandHandler } from '@/lib/keymapRegistry'
import { terminalHost } from '@/lib/terminals'
import { useActiveTab, useActiveWorkspace, useApp } from '@/state/AppState'
import { useVoiceHubController } from '@/state/VoiceHubController'
import { useHubRuntime } from './useHubRuntime'

/** Broadcast so <TerminalGrid> can pop its agent chooser open. */
export const NEW_TAB_EVENT = 'forge:new-tab'

type Dir = 'left' | 'right' | 'up' | 'down'

/**
 * Global keyboard map. Registered in the capture phase so it wins against
 * xterm's textarea handler, which would otherwise swallow Ctrl+W and friends.
 *
 * The keys themselves are no longer written here: every command is a row in
 * the keymap registry (src/lib/shortcutCommands.ts for the built-ins, plus
 * saved prompts, agent profiles and whatever else registers), and Steve can
 * rebind any of them. This hook is the one keydown listener and the home of
 * the built-in handlers. A handler that answers `false` did nothing, and the
 * key carries on to the terminal as if Forge had never looked at it.
 *
 * It also mounts the hub runtime (call-signs, the voice tools' view of the
 * panes), because this hook is mounted exactly once, for the life of the app.
 */
export function useShortcuts(): void {
  const { state, actions } = useApp()
  const workspace = useActiveWorkspace()
  const tab = useActiveTab()
  const voice = useVoiceHubController()

  useHubRuntime()

  // Handlers are registered once and read the app through this ref, so a
  // re-render never re-registers forty handlers.
  const live = useRef({ state, actions, workspace, tab, voice })
  live.current = { state, actions, workspace, tab, voice }

  useEffect(() => {
    const L = (): typeof live.current => live.current
    const activePaneId = (): string | null => L().tab?.activePaneId ?? null

    const split = (direction: SplitDirection): CommandHandler => () => {
      const id = activePaneId()
      if (id) L().actions.splitPane(id, direction)
    }
    const focusDir = (dir: Dir): CommandHandler => () => {
      const id = activePaneId()
      if (!id) return
      const target = neighbour(id, dir)
      if (target) {
        L().actions.focusPane(target)
        terminalHost.focus(target)
      }
    }
    const stepTab = (delta: number): CommandHandler => () => {
      const tabs = L().workspace.tabs
      if (tabs.length < 2) return
      const i = tabs.findIndex((t) => t.id === L().workspace.activeTabId)
      L().actions.selectTab(tabs[(i + delta + tabs.length) % tabs.length]!.id)
    }
    const stepPane = (delta: number): CommandHandler => () => {
      const panes = getHubRuntime()?.panes() ?? []
      if (panes.length < 2) return
      const i = Math.max(0, panes.findIndex((p) => p.paneId === activePaneId()))
      focusNavTarget({ kind: 'pane', pane: panes[(i + delta + panes.length) % panes.length]! }, 'keyboard')
    }
    const stepProject = (delta: number): CommandHandler => () => {
      const { projects, activeProjectId } = L().state
      if (projects.length < 2) return
      const i = Math.max(0, projects.findIndex((p) => p.id === activeProjectId))
      L().actions.selectProject(projects[(i + delta + projects.length) % projects.length]!.id)
    }

    const handlers: Record<string, CommandHandler> = {
      // The voice hub, from anywhere — including its own text box, and
      // including the terminal you are typing in, which is the point of it.
      'voice.hubCard': () => L().actions.toggleVoiceHubCard(),
      // Settings, the way every other app opens settings. Also from a text
      // field: Ctrl+, is nobody's editing key.
      'app.settings': () => (L().state.view === 'settings' ? L().actions.closeSettings() : L().actions.openSettings()),

      'tab.new': () => {
        window.dispatchEvent(new CustomEvent(NEW_TAB_EVENT))
      },
      'pane.close': () => {
        const id = activePaneId()
        if (id) L().actions.closePane(id)
      },
      'tab.close': () => {
        const t = L().tab
        if (t) L().actions.closeTab(t.id)
      },
      'tab.next': stepTab(1),
      'tab.prev': stepTab(-1),
      'pane.next': stepPane(1),
      'pane.prev': stepPane(-1),
      'project.next': stepProject(1),
      'project.prev': stepProject(-1),

      'pane.split.left': split('row'),
      'pane.split.right': split('row'),
      'pane.split.up': split('column'),
      'pane.split.down': split('column'),
      'pane.focus.left': focusDir('left'),
      'pane.focus.right': focusDir('right'),
      'pane.focus.up': focusDir('up'),
      'pane.focus.down': focusDir('down'),

      'canvas.show': () => {
        focusNavTarget({ kind: 'canvas' }, 'keyboard')
      },

      /*
       * Ctrl+C / Ctrl+V inside a terminal are handled per pane, in
       * terminalHost's xterm key handler, so that a plain Ctrl+C with nothing
       * selected still reaches the shell as ^C. These two are the app-wide
       * aliases: they work even when focus sits on some piece of chrome rather
       * than in the terminal itself. Copy with nothing selected lets the key go.
       */
      'clipboard.copy': () => {
        const id = activePaneId()
        return id ? terminalHost.copySelectionToClipboard(id) : false
      },
      'clipboard.paste': () => {
        const id = activePaneId()
        if (id) void terminalHost.pasteFromClipboard(id)
      },

      'rail.toggle': () => L().actions.toggleRail(),
      // Tabs ⇄ mosaic. Grabbed even while a terminal has focus: it is the way
      // back out of a zoomed tile, so it has to work from inside one.
      'view.toggle': () => L().actions.toggleViewMode(),
      'font.bigger': () => L().actions.setFontSize(L().state.settings.terminalFontSize + 1),
      'font.smaller': () => L().actions.setFontSize(L().state.settings.terminalFontSize - 1),
      'font.reset': () => L().actions.setFontSize(13),

      // Live talk (B1's VoiceHubController). 'voice.mode.toggle' and
      // 'app.cheatSheet' get their handlers from the surfaces that own them.
      'voice.live.toggle': () => L().voice.toggle(),
      'voice.mute': () => {
        if (L().voice.phase === 'off') return false
        L().voice.setMuted(!L().voice.muted)
      },
      'voice.interrupt': () => {
        if (L().voice.phase !== 'speaking') return false
        L().voice.interrupt()
      }
    }
    for (let n = 1; n <= 9; n++) {
      // Only a tab that exists takes the key; Alt+7 with three tabs passes through.
      handlers[`tab.goto.${n}`] = () => {
        const target = L().workspace.tabs[n - 1]
        if (!target) return false
        L().actions.selectTab(target.id)
      }
      handlers[`pane.goto.${n}`] = () => {
        const pane = getHubRuntime()?.panes().find((p) => p.number === n)
        if (!pane) return false
        focusNavTarget({ kind: 'pane', pane }, 'keyboard')
      }
    }

    const offs = Object.entries(handlers).map(([id, fn]) => setCommandHandler(id, fn))
    return () => offs.forEach((off) => off())
  }, [])

  useEffect(() => {
    const handler = (e: KeyboardEvent): void => {
      const combo = comboFromEvent(e)
      if (!combo) return
      const command = commandForCombo(combo)
      if (!command || !hasHandler(command.id)) return

      if (command.scope === 'workspace') {
        // Text fields (renaming a pane/tab, popover forms, the voice composer)
        // keep their keys.
        //
        // xterm is the exception: it takes keystrokes through a hidden
        // textarea, which holds the focus the whole time you are typing in a
        // pane. Letting that count as a text field would silence every
        // workspace shortcut exactly when it is wanted — Ctrl+T, Ctrl+W,
        // Alt+arrows, and the Ctrl+G that is the way back out of a zoomed
        // mosaic tile.
        const el = document.activeElement
        const inTerminal = el instanceof HTMLTextAreaElement && el.classList.contains(XTERM_TEXTAREA)
        if (
          !inTerminal &&
          (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement)
        )
          return
        // The workspace is not the thing in front of you while settings is.
        // Ctrl+W in there would close a pane you are not looking at.
        if (live.current.state.view !== 'terminals') return
      }

      if (runCommand(command.id)) {
        e.preventDefault()
        e.stopPropagation()
      }
    }

    window.addEventListener('keydown', handler, true)
    return () => window.removeEventListener('keydown', handler, true)
  }, [])
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
