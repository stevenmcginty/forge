import type { ScreenLook } from '@shared/screen'

/**
 * A fresh look at Steve's screen for the mini bar's Screen key
 * (src/state/MiniBarHost.tsx): with it on, every send carries one line that
 * points the agent at a picture of what Steve sees, so "fill out this form"
 * means the form on his screen.
 *
 * Main takes the picture (`window.forge.screen.look()`, shared/screen.ts).
 * A preload from before it existed has no `screen`, and a look that fails or
 * takes too long is no look: the words then go as they are, never held up.
 */

/** Default wait for the picture before the words go without it. */
const LOOK_TIMEOUT_MS = 2500

export async function lookAtScreen(timeoutMs = LOOK_TIMEOUT_MS): Promise<ScreenLook | null> {
  // `screen` is optional in ForgeApi: an older preload has none.
  const look = window.forge?.screen?.look
  if (typeof look !== 'function') return null
  let timer = 0
  const late = new Promise<null>((resolve) => {
    timer = window.setTimeout(() => resolve(null), timeoutMs)
  })
  try {
    const got = await Promise.race([look(), late])
    return got && got.ok === true && typeof got.path === 'string' && got.path ? got : null
  } catch {
    return null
  } finally {
    window.clearTimeout(timer)
  }
}

/** One line, no newlines: the words are pasted into a terminal, where a newline would submit early. */
function oneLine(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim()
}

/**
 * The line a send gets when the look worked, leading space included:
 *
 *    [Screen now: "C:\…\look.png" · in front: Chrome "Sign up" · open the picture …]
 *
 * The "in front" part is left out when main could not tell which app it was.
 */
export function screenNote(look: Pick<ScreenLook, 'path' | 'front'>): string {
  const app = look.front ? oneLine(look.front.app).replace(/"/g, "'") : ''
  const title = look.front ? oneLine(look.front.title).replace(/"/g, "'") : ''
  const who = app || title ? ` · in front: ${[app, title ? `"${title}"` : ''].filter(Boolean).join(' ')}` : ''
  return (
    ` [Screen now: "${oneLine(look.path)}"${who}` +
    ' · open the picture to see what Steve sees; act with window_read / window_click / window_type]'
  )
}
