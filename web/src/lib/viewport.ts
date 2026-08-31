/**
 * The visible window, as a phone actually has it.
 *
 * Two Safari bugs share a workaround, and both show up as "rotate the phone
 * and rotate it back, then Forge fits":
 *
 *  1. **First paint is the large viewport.** `html { height: 100% }` and even
 *     `100dvh` on iOS are the URL-bar-hidden height, or a leftover from the
 *     last orientation. Android Chrome is already the visible window, which is
 *     why the same page looks fine on a Pixel and cropped on a Pro Max.
 *     `window.innerHeight` is that same stale number. `visualViewport.height`
 *     is the glass; this file pins `--app-height` to it, and reads it again a
 *     few hundred milliseconds later because Safari often corrects the value
 *     *without* firing `resize` until an orientation change forces one.
 *  2. **A Pro Max in landscape is wider than 900px.** iPhone 16 Pro Max is
 *     440×956. The old `(max-width: 900px)` test therefore called landscape a
 *     desktop, and a first paint that reported the landscape width in portrait
 *     did the same. A phone's *screen* short edge is 320–440 CSS px even when
 *     the layout viewport is lying; iPad Mini is 744. That is the test.
 *
 * `--keyboard-inset` used to be the composer's job, lifting the dock by the
 * difference between `innerHeight` and the visual viewport. Once the shell
 * itself is the visual viewport, that difference is already the height, and
 * adding it again would pad the keyboard twice. It stays at 0.
 */

/** CSS px. Every shipping phone's short edge is under this; iPad Mini is 744. */
export const PHONE_SHORT_EDGE_PX = 500

/** Portrait phones, and the original media-query fold. */
export const PHONE_VIEWPORT_MAX_PX = 900

/** Landscape phones, including Pro Max at 440 CSS px tall. */
export const PHONE_LANDSCAPE_MAX_HEIGHT_PX = 500

export interface PhoneFaceInput {
  askedPhone: boolean
  coarse: boolean
  viewportWidth: number
  viewportHeight: number
  screenWidth: number
  screenHeight: number
}

export function isPhoneFace(input: PhoneFaceInput): boolean {
  if (input.askedPhone) return true
  if (!input.coarse) return false
  const screenShort = Math.min(input.screenWidth, input.screenHeight)
  if (screenShort > 0 && screenShort <= PHONE_SHORT_EDGE_PX) return true
  if (input.viewportWidth > 0 && input.viewportWidth <= PHONE_VIEWPORT_MAX_PX) return true
  if (input.viewportHeight > 0 && input.viewportHeight <= PHONE_LANDSCAPE_MAX_HEIGHT_PX) {
    return true
  }
  return false
}

export function phoneFaceFromWindow(askedPhone: boolean): PhoneFaceInput {
  return {
    askedPhone,
    coarse: window.matchMedia('(pointer: coarse)').matches,
    viewportWidth: window.innerWidth,
    viewportHeight: window.innerHeight,
    screenWidth: window.screen.width,
    screenHeight: window.screen.height
  }
}

export interface AppViewportInput {
  visualHeight: number | null
  visualOffsetTop: number | null
  visualScale: number | null
  innerHeight: number
}

/**
 * Size the shell to the glass, not the layout viewport.
 *
 * A pinch-zoom (`scale !== 1`) must *not* reflow: the document zooms, the
 * columns stay put. Keyboard and URL-bar motion keep scale at 1 and shrink
 * `visualHeight`; that is the case this exists for.
 */
export function appViewport(input: AppViewportInput): { height: number; top: number } {
  const scaled = input.visualScale != null && Math.abs(input.visualScale - 1) > 0.02
  const visual = input.visualHeight != null && input.visualHeight > 0 ? input.visualHeight : 0
  const inner = input.innerHeight > 0 ? input.innerHeight : 0
  const height = scaled || visual === 0 ? inner : visual
  const top = scaled || input.visualOffsetTop == null || input.visualOffsetTop < 0 ? 0 : input.visualOffsetTop
  return { height, top }
}

export function appViewportFromWindow(): AppViewportInput {
  const vv = window.visualViewport
  return {
    visualHeight: vv ? vv.height : null,
    visualOffsetTop: vv ? vv.offsetTop : null,
    visualScale: vv ? vv.scale : null,
    innerHeight: window.innerHeight
  }
}

const SETTLE_MS = [0, 50, 250, 500, 1000] as const

function writePin(next: { height: number; top: number }): void {
  const root = document.documentElement
  if (next.height > 0) root.style.setProperty('--app-height', `${Math.round(next.height)}px`)
  root.style.setProperty('--app-top', `${Math.round(next.top)}px`)
  root.style.setProperty('--keyboard-inset', '0px')
  if (next.top === 0 && window.scrollY !== 0) window.scrollTo(0, 0)
}

export function pinAppViewport(): void {
  writePin(appViewport(appViewportFromWindow()))
}

/**
 * Pin now, pin after Safari's delayed correction, and pin on every real change.
 *
 * `orientationchange` on iOS fires *before* the window has the new size, which
 * is why a single listener is not enough and why a rotate-and-back used to be
 * the only thing that fitted the page. The settle timeouts are that rotate,
 * without the rotate.
 */
export function watchAppViewport(): () => void {
  const timers: number[] = []
  const pin = (): void => pinAppViewport()
  const pinSoon = (): void => {
    pin()
    for (const ms of SETTLE_MS) timers.push(window.setTimeout(pin, ms))
  }

  pinSoon()
  window.addEventListener('resize', pin)
  window.addEventListener('orientationchange', pinSoon)
  window.addEventListener('pageshow', pinSoon)
  document.addEventListener('visibilitychange', pin)
  const vv = window.visualViewport
  vv?.addEventListener('resize', pin)
  vv?.addEventListener('scroll', pin)

  return () => {
    for (const id of timers) window.clearTimeout(id)
    window.removeEventListener('resize', pin)
    window.removeEventListener('orientationchange', pinSoon)
    window.removeEventListener('pageshow', pinSoon)
    document.removeEventListener('visibilitychange', pin)
    vv?.removeEventListener('resize', pin)
    vv?.removeEventListener('scroll', pin)
  }
}
