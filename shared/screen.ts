/**
 * A look at Steve's whole screen, saved to a file, for the mini bar's Screen
 * button and the desktop tools (electron/desktop-hands.ts).
 *
 * Main answers `window.forge.screen.look()` with one of these. The picture is
 * a PNG on disk, so a pane agent can open it by path; `front` is the top
 * window that is not Forge's own (EnumWindows order), which is the app Steve
 * was in before he clicked the bar.
 */
export interface ScreenLook {
  ok: true
  /** Absolute path of the PNG. */
  path: string
  /** Picture size in pixels. */
  width: number
  height: number
  /** The app in front, or null when none could be found. */
  front: { app: string; title: string } | null
}

export interface ScreenLookFailed {
  ok: false
  error: string
}

export type ScreenLookResult = ScreenLook | ScreenLookFailed
