import { useEffect, useState } from 'react'
import { isPhoneFace, phoneFaceFromWindow } from './viewport'

/**
 * Is this page being driven by a thumb on a phone?
 *
 * Two conditions, because each alone names the wrong thing:
 *
 *  - **A coarse pointer.** `(pointer: coarse)` is how the browser says the
 *    primary input is a finger. A desktop window dragged narrow still has a
 *    mouse, and for a mouse the folded desktop layout (`useNarrow`) is the right
 *    answer — precise clicks on 26px buttons are fine, and the person has a
 *    hardware keyboard with Esc, Tab and Ctrl on it.
 *  - **A phone's size.** A tablet with a finger is still wide enough for the
 *    desktop's split grid to mean something. The test is in `isPhoneFace`: a
 *    phone's *screen* short edge is ≤ 500 CSS px even when Safari's layout
 *    viewport is lying (first paint, desktop-site mode, Pro Max landscape at
 *    956 CSS px). iPad Mini's short edge is 744. Viewport width ≤ 900 and
 *    viewport height ≤ 500 are the fallbacks for a browser that reports a
 *    swapped `screen`.
 *
 * What flips on is a different *face* of the same application: the same
 * state, the same socket, the same `PaneView`. A phone gets one pane, a drawer
 * for projects, and a composer sized for a thumb. A desktop browser keeps the
 * sidebar and the space. Forge Mobile (the APK) remains the native client;
 * this is what somebody gets when they open the public URL in phone Chrome.
 */

/**
 * `?phone` on the dev server: answer yes without a finger.
 *
 * A laptop dragged to 390px has a mouse, so `(pointer: coarse)` is false and
 * this hook — correctly — says desktop. That is the right answer for a person,
 * and the wrong one for looking at the phone face, which is the only way most
 * of this gets reviewed. Without the override the two halves disagreed: the
 * app's `data-mobile` attribute came from a Preview-local `?phone` escape
 * hatch, so the CSS wore the phone face while every component asking this hook
 * was still told desktop — a preview that lies about exactly the thing it
 * exists to show. One source, so both halves say the same word.
 *
 * `__DEV_SERVER__` is false in everything `vite build` emits, so no published
 * bundle can be talked into the phone face by a query string.
 */
function askedPhone(): boolean {
  if (!__DEV_SERVER__ || typeof window === 'undefined') return false
  return new URLSearchParams(window.location.search).has('phone')
}

function readMobile(): boolean {
  if (typeof window === 'undefined') return askedPhone()
  return isPhoneFace(phoneFaceFromWindow(askedPhone()))
}

export function useMobile(): boolean {
  const [mobile, setMobile] = useState(readMobile)

  useEffect(() => {
    const update = (): void => setMobile(readMobile())
    update()
    const query = window.matchMedia('(pointer: coarse)')
    query.addEventListener('change', update)
    window.addEventListener('resize', update)
    window.addEventListener('orientationchange', update)
    const vv = window.visualViewport
    vv?.addEventListener('resize', update)
    return () => {
      query.removeEventListener('change', update)
      window.removeEventListener('resize', update)
      window.removeEventListener('orientationchange', update)
      vv?.removeEventListener('resize', update)
    }
  }, [])

  return mobile
}
