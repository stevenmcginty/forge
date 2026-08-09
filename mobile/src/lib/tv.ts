/**
 * Is this screen a TV?
 *
 * One seam, deliberately. Two ways in, and the rest of the app only ever asks
 * this one question:
 *
 *  - `__FORGE_TV__`, baked at build time by scripts/apk-tv-build.mjs the way
 *    `__BAKED_ORIGIN__` bakes the desktop's address. The Fire TV APK has no
 *    address bar to append a query to, so its answer has to be inside it.
 *  - `?tv` in the query — how a browser pointed at the desktop opts in, which
 *    is still how the dashboard is looked at without a TV in the room.
 *
 * The define is first so that in every other build this reads as
 * `false || …`, and the TV branches fold away at build time.
 */
export function isTv(): boolean {
  return __FORGE_TV__ || new URLSearchParams(window.location.search).has('tv')
}
