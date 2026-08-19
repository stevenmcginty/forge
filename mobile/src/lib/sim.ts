/**
 * Is this screen the desk's preview of a phone, and which phone is it playing?
 *
 * One seam, the same idea as `lib/tv.ts`: everything the app does about being
 * previewed hangs off this one question, and the only way in is `?sim=` in the
 * query — how Forge's Devices view opts a frame in. A real phone never carries
 * the param, so it never takes any of these branches.
 *
 * What it changes, and everything it changes:
 *
 *  - `body.sim-ios` / `body.sim-android` (set in main.tsx before first paint),
 *    which pins the safe-area custom properties in styles.css to the values of
 *    the phone being played — a desktop iframe has no notch, so `env()` answers
 *    0 and the app would draw under where the system bar will be drawn.
 *  - `isIos()` in lib/pwa.ts, whose only job is the install-instructions
 *    sentence on the pairing screen.
 *  - `hardwareName()` in App.tsx, so the device row in Settings says
 *    "Preview · iPhone" rather than "Chrome on Windows" — that name is also how
 *    the Devices view recognises its own frames checking in.
 */
export type SimDevice = 'ios' | 'android'

export function simDevice(): SimDevice | null {
  const value = new URLSearchParams(window.location.search).get('sim')
  return value === 'ios' || value === 'android' ? value : null
}
