/**
 * The build-time constants Vite `define` injects (see mobile/vite.config.ts).
 * These are textual substitutions, not runtime values — a `typeof` check on
 * them is meaningless, and code must be written assuming they always exist.
 * They do: version.json is in the repo, so even a plain `mobile:build` for
 * the browser route gets real numbers rather than placeholders.
 */
declare const __APK_VERSION_CODE__: number
declare const __APK_VERSION_NAME__: string
/**
 * The OTA feed this build polls, or '' in a build that has none — the Fire TV
 * APK, which is stamped by scripts/apk-tv-build.mjs and updated by being
 * rebuilt rather than by downloading the phone's release.
 */
declare const __APK_MANIFEST_URL__: string
/**
 * True only in a Fire TV build (scripts/apk-tv-build.mjs). `false` everywhere
 * else, which is what lets the TV-only branches fold away at build time rather
 * than shipping to a phone. The one place that reads it is `lib/tv.ts` — plus
 * the update guard, which has a different job. See both.
 */
declare const __FORGE_TV__: boolean
/**
 * `wss://<domain>` of the desktop this APK was built for, or '' when the
 * build was unstamped — in which case the app offers only the QR and typed
 * paths. Always run through `toOrigin` before use; the stamp is trusted to be
 * an origin, not proven to be one.
 */
declare const __BAKED_ORIGIN__: string
