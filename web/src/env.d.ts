/**
 * The build-time constant Vite `define` injects (see web/vite.config.ts).
 *
 * A textual substitution, not a runtime value: a `typeof` guard on it is
 * meaningless and it always exists, because it is stamped from the root
 * package.json which is in the repo.
 */
declare const __WEB_CLIENT_VERSION__: string

/**
 * True only under `vite` (the dev server), false in everything `vite build`
 * emits. The one gate on the loopback WebSocket address — see `devLoopbackHost`
 * in web/src/config.ts and the note beside the `define` that sets it.
 */
declare const __DEV_SERVER__: boolean

/** The id of this bundle — commit plus build minute — compared against `/version.json`. See lib/update.ts. */
declare const __WEB_BUILD_ID__: string
