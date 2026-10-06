import { registerSurface } from '@/lib/shellSlots'
import { ReadSurface } from './ReadSurface'

/**
 * Plugs the Read mode into the shell: a `read` canvas surface that takes the
 * whole stage (a mode in the switcher, `set-mode read`). Files reach it through
 * ReaderOpener, which main.tsx mounts for the life of the window.
 *
 * Call `registerReader()` once at startup. It returns the undo.
 */
export function registerReader(): () => void {
  return registerSurface({ id: 'read', title: 'Read', placement: 'full', order: 30, render: ReadSurface })
}
