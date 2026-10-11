import type { BrowserWindow } from 'electron'

/**
 * The window that holds the real renderer — the one that answers the desk's
 * asks. `BrowserWindow.getAllWindows()` lists newest first, so `[0]` is the
 * mini bar, a mirror window, the overlay or a shot card whenever one exists,
 * and none of those has anything listening. Anything that sends the renderer a
 * question asks for this window instead.
 */
let main: BrowserWindow | null = null

export function setMainWindow(win: BrowserWindow | null): void {
  main = win
}

/** The main window, or null when it is not open (or already destroyed). */
export function getMainWindow(): BrowserWindow | null {
  return main && !main.isDestroyed() ? main : null
}
