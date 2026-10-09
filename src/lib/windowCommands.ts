import { uiCommands } from './uiCommands'

/**
 * Forge's own window, as shell commands: minimise, maximise, un-maximise and
 * restore. No default keys; they show in the palette and the keymap like every
 * other command, and the agents run them through forge_command
 * (src/lib/forgeCommand.ts).
 *
 * Minimise is main's `minimize()`, so the mini bar comes up exactly as when
 * Steve minimises by hand (with its setting on). Restore is show_view's guarded
 * path (`revealIfAway`): back on screen only if it was away, never resized.
 *
 * Every call is optional-chained: a preload older than these answers
 * `RESTART_NOTE` instead of throwing.
 */

export type WindowShape = 'minimised' | 'maximised' | 'normal' | 'hidden'

export const WINDOW_COMMANDS = [
  { id: 'window-minimise', title: 'Minimise Forge', group: 'Window' },
  { id: 'window-maximise', title: 'Maximise Forge', group: 'Window' },
  { id: 'window-unmaximise', title: 'Un-maximise Forge', group: 'Window' },
  { id: 'window-restore', title: 'Bring Forge back (restore)', group: 'Window' }
] as const

export type WindowCommandId = (typeof WINDOW_COMMANDS)[number]['id']

export const RESTART_NOTE = 'Window control needs a Forge restart.'

export function isWindowCommand(id: string): id is WindowCommandId {
  return WINDOW_COMMANDS.some((c) => c.id === id)
}

type Control = (action: 'minimise' | 'maximise' | 'unmaximise' | 'state') => Promise<WindowShape>

function control(): Control | null {
  if (typeof window === 'undefined') return null
  const fn = window.forge?.window?.control
  return typeof fn === 'function' ? fn : null
}

/** The last window command's promise, so forge_command can say what the window is now. */
let last: Promise<WindowShape | null> = Promise.resolve(null)

async function perform(id: WindowCommandId): Promise<WindowShape | null> {
  const ctl = control()
  if (!ctl) return null
  if (id === 'window-restore') {
    const reveal = typeof window === 'undefined' ? undefined : window.forge?.window?.revealIfAway
    if (typeof reveal !== 'function') return null
    await reveal()
    return ctl('state')
  }
  return ctl(id === 'window-minimise' ? 'minimise' : id === 'window-maximise' ? 'maximise' : 'unmaximise')
}

/** Run one window command now. Null when this preload cannot (see RESTART_NOTE). Never rejects. */
export function runWindowCommand(id: WindowCommandId): Promise<WindowShape | null> {
  last = perform(id).catch(() => null)
  return last
}

/** What the most recent window command left the window as (null: it could not run). */
export function lastWindowCommand(): Promise<WindowShape | null> {
  return last
}

/** True when this preload has the window control the commands need. */
export function windowControlAvailable(): boolean {
  return control() !== null
}

/** Define the four commands and answer them. Call once at startup; returns the undo. */
export function registerWindowCommands(): () => void {
  const offs = WINDOW_COMMANDS.flatMap((c) => [
    uiCommands.define({ id: c.id, title: c.title, group: c.group }),
    uiCommands.handle(c.id, () => {
      void runWindowCommand(c.id)
    })
  ])
  return () => offs.reverse().forEach((off) => off())
}
