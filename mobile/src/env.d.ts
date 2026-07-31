/**
 * The build-time constants Vite `define` injects (see mobile/vite.config.ts).
 * These are textual substitutions, not runtime values — a `typeof` check on
 * them is meaningless, and code must be written assuming they always exist.
 * They do: version.json is in the repo, so even a plain `mobile:build` for
 * the browser route gets real numbers rather than placeholders.
 */
declare const __APK_VERSION_CODE__: number
declare const __APK_VERSION_NAME__: string
declare const __APK_MANIFEST_URL__: string
/**
 * `wss://<domain>` of the desktop this APK was built for, or '' when the
 * build was unstamped — in which case the app offers only the QR and typed
 * paths. Always run through `toOrigin` before use; the stamp is trusted to be
 * an origin, not proven to be one.
 */
declare const __BAKED_ORIGIN__: string
