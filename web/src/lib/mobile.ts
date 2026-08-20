import { useEffect, useState } from 'react'

/**
 * Is this page being driven by a thumb on a phone?
 *
 * Two conditions, both required, because each alone names the wrong thing:
 *
 *  - **A coarse pointer.** `(pointer: coarse)` is how the browser says the
 *    primary input is a finger. A desktop window dragged narrow still has a
 *    mouse, and for a mouse the folded desktop layout (`useNarrow`) is the right
 *    answer — precise clicks on 26px buttons are fine, and the person has a
 *    hardware keyboard with Esc, Tab and Ctrl on it.
 *  - **A phone's width.** A tablet with a finger is still wide enough for the
 *    desktop's split grid to mean something. 900px is above every phone in
 *    landscape and below every tablet in portrait.
 *
 * What flips on is a different *layout*, not a different application: the same
 * state, the same socket, the same `PaneView`, the same tab strip — arranged for
 * one hand. One pane on screen at a time, the rail as a drawer, and a row of the
 * keys a phone keyboard does not have. Forge Mobile (the APK) remains the
 * full-fat phone client; this is what somebody gets when they open the public
 * URL in phone Chrome without installing anything.
 */
const MOBILE = '(pointer: coarse) and (max-width: 900px)'

export function useMobile(): boolean {
  const [mobile, setMobile] = useState(() => typeof window !== 'undefined' && window.matchMedia(MOBILE).matches)

  useEffect(() => {
    const query = window.matchMedia(MOBILE)
    const update = (): void => setMobile(query.matches)
    update()
    query.addEventListener('change', update)
    return () => query.removeEventListener('change', update)
  }, [])

  return mobile
}
