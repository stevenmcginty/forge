import { useEffect, useRef, useSyncExternalStore } from 'react'
import type { KeyCommandDef } from './keymap'
import { defineCommands, setCommandHandler } from './keymapRegistry'

/**
 * The shell's command bus.
 *
 * Every surface the desktop shell can open — the project sheet, the panes
 * switcher, the composer, the settings pop-up, the shelf, a mode — answers to a
 * named command here, so the same thing can be done from a key, a voice tool, a
 * palette or a button without any of them knowing about the component that
 * draws it:
 *
 *   uiCommands.run('open-project-sheet')
 *   uiCommands.run('set-mode', 'browser')
 *
 * The component that owns a surface registers the handler (`useUiCommand`), so
 * a command whose surface is not mounted simply reports `false` from `run`
 * rather than throwing. Keys are not handled here either: every command without
 * an argument is handed to the keymap registry as `ui.<id>` (below), which
 * binds its `defaultKey`, lets Steve rebind it, and runs it through `run` — so
 * an unmounted surface lets the key fall through to the terminal.
 *
 * Other features add their own commands with `define` — the browser's
 * `open-browser`, say — and every registered canvas surface gets
 * `set-mode <id>` for free (see src/lib/shellSlots.ts).
 */

export type CoreUiCommand =
  | 'open-project-sheet'
  | 'close-project-sheet'
  | 'toggle-project-sheet'
  | 'open-panes-switcher'
  | 'close-panes-switcher'
  | 'toggle-panes-switcher'
  | 'focus-composer'
  | 'blur-composer'
  | 'toggle-composer'
  | 'open-settings'
  | 'close-settings'
  | 'toggle-settings'
  | 'open-shelf'
  | 'close-shelf'
  | 'toggle-shelf'
  | 'toggle-tools'
  | 'set-mode'
  | 'next-mode'
  | 'previous-mode'
  | 'toggle-canvas-view'
  | 'close-overlays'

/** Core ids are typed; `define`d ones are strings. */
export type UiCommandId = CoreUiCommand | (string & {})

export interface UiCommandSpec {
  id: UiCommandId
  title: string
  group: 'Shell' | 'Modes' | 'Panes' | (string & {})
  /** What the keymap should bind by default, written Electron-accelerator style. */
  defaultKey?: string
  /** Takes an argument — for `set-mode`, the mode id. */
  arg?: string
}

const CORE: UiCommandSpec[] = [
  // Ctrl+Shift+B is the built-in rail.toggle, which now toggles this sheet (App.tsx).
  { id: 'toggle-project-sheet', title: 'Projects', group: 'Shell' },
  { id: 'open-project-sheet', title: 'Open the project sheet', group: 'Shell' },
  { id: 'close-project-sheet', title: 'Close the project sheet', group: 'Shell' },
  { id: 'toggle-panes-switcher', title: 'Every pane (switcher)', group: 'Panes', defaultKey: 'Ctrl+Shift+E' },
  { id: 'open-panes-switcher', title: 'Open the panes switcher', group: 'Panes' },
  { id: 'close-panes-switcher', title: 'Close the panes switcher', group: 'Panes' },
  { id: 'focus-composer', title: 'Ask Forge (the bar)', group: 'Shell', defaultKey: 'Ctrl+Shift+J' },
  { id: 'blur-composer', title: 'Back to the pane', group: 'Shell' },
  { id: 'toggle-composer', title: 'Composer focus', group: 'Shell' },
  // Ctrl+, stays the built-in app.settings; binding it twice would be a conflict.
  { id: 'toggle-settings', title: 'Settings', group: 'Shell' },
  { id: 'open-settings', title: 'Open settings', group: 'Shell', arg: 'section' },
  { id: 'close-settings', title: 'Close settings', group: 'Shell' },
  { id: 'toggle-shelf', title: 'Menu: shelf & account', group: 'Shell', defaultKey: 'Ctrl+Shift+S' },
  { id: 'open-shelf', title: 'Open the shelf', group: 'Shell' },
  { id: 'close-shelf', title: 'Close the shelf', group: 'Shell' },
  { id: 'toggle-tools', title: 'Tools: Skills, Commands, tab colours, Wall text', group: 'Shell', defaultKey: 'Ctrl+Shift+Y' },
  { id: 'set-mode', title: 'Switch mode', group: 'Modes', arg: 'mode' },
  { id: 'next-mode', title: 'Next mode', group: 'Modes', defaultKey: 'Ctrl+Shift+]' },
  { id: 'previous-mode', title: 'Previous mode', group: 'Modes', defaultKey: 'Ctrl+Shift+[' },
  // Ctrl+G stays the built-in view.toggle.
  { id: 'toggle-canvas-view', title: 'Tabs or Wall', group: 'Panes' },
  { id: 'close-overlays', title: 'Close sheets and pop-ups', group: 'Shell' }
]

type Handler = (arg?: string) => void

const handlers = new Map<string, Handler[]>()
const defined = new Map<string, UiCommandSpec>()
const listeners = new Set<() => void>()
let version = 0
let snapshot: UiCommandSpec[] = [...CORE]

/* ------------------------------------------------------------ the keymap */

const keyHandlers = new Map<string, () => void>()

function toKeymap(spec: UiCommandSpec): KeyCommandDef {
  return {
    id: `ui.${spec.id}`,
    title: spec.title,
    group: spec.group,
    defaultKeys: spec.defaultKey ? [spec.defaultKey] : [],
    // Every shell command is safe from a text field: none of the combos is an
    // editing key, and the composer itself is a text field that has to be able
    // to toggle the sheets.
    scope: 'global'
  }
}

function syncKeymap(): void {
  const bindable = snapshot.filter((spec) => !spec.arg)
  defineCommands('ui', bindable.map(toKeymap))
  for (const spec of bindable) {
    const id = `ui.${spec.id}`
    if (keyHandlers.has(id)) continue
    const off = setCommandHandler(id, () => uiCommands.run(spec.id))
    keyHandlers.set(id, off)
  }
  for (const [id, off] of keyHandlers) {
    if (bindable.some((spec) => `ui.${spec.id}` === id)) continue
    off()
    keyHandlers.delete(id)
  }
}

function changed(): void {
  version++
  snapshot = [...CORE, ...defined.values()]
  for (const cb of listeners) cb()
  syncKeymap()
}

export const uiCommands = {
  /** Run a command. False when nothing that answers it is mounted. */
  run(id: UiCommandId, arg?: string): boolean {
    const list = handlers.get(id)
    const fn = list?.[list.length - 1]
    if (!fn) return false
    fn(arg)
    return true
  },

  /** True when a surface is mounted that would answer `id`. */
  canRun(id: UiCommandId): boolean {
    return (handlers.get(id)?.length ?? 0) > 0
  },

  /**
   * Answer a command. The newest registration wins and the previous one comes
   * back when it unregisters, so a surface mounted twice (a remount mid-glide)
   * never leaves the command dead.
   */
  handle(id: UiCommandId, fn: Handler): () => void {
    const list = handlers.get(id) ?? []
    list.push(fn)
    handlers.set(id, list)
    return () => {
      const now = handlers.get(id)
      if (!now) return
      const i = now.lastIndexOf(fn)
      if (i >= 0) now.splice(i, 1)
      if (now.length === 0) handlers.delete(id)
    }
  },

  /** Add a command to the list the keymap and palette read. */
  define(spec: UiCommandSpec): () => void {
    defined.set(spec.id, spec)
    changed()
    return () => {
      if (defined.get(spec.id) === spec) {
        defined.delete(spec.id)
        changed()
      }
    }
  },

  /** Every command, core first. Stable between changes. */
  list(): UiCommandSpec[] {
    return snapshot
  },

  subscribe(cb: () => void): () => void {
    listeners.add(cb)
    return () => listeners.delete(cb)
  },

  /** Bumped whenever the list changes. */
  version(): number {
    return version
  }
}

syncKeymap()

/** Register a handler for as long as the calling component is mounted. */
export function useUiCommand(id: UiCommandId, fn: Handler): void {
  const ref = useRef(fn)
  ref.current = fn
  useEffect(() => uiCommands.handle(id, (arg) => ref.current(arg)), [id])
}

/** The command list, live. */
export function useUiCommandList(): UiCommandSpec[] {
  return useSyncExternalStore(uiCommands.subscribe, uiCommands.list)
}
