/**
 * Bundle entry for `npm run web:offline`.
 *
 * The same trick and the same rule as scripts/fixtures/web-e2e-entry.ts: one
 * root for esbuild to follow into the *real* link server and the *real*
 * Firebase token verifier, so the check drives what ships rather than a
 * lookalike. Nothing here is part of the app, and nothing here may add
 * behaviour the app does not have.
 *
 * A file of its own rather than reusing the e2e entry because this check needs
 * no `PtySessionManager`: Phase 4 is about the browser with the desktop *off*,
 * and the one thing it wants a real desktop for is proving that a shutdown drops
 * the client into GitHub mode and that a desktop coming back takes it out again
 * — neither of which involves a shell.
 */
export { WebServer } from '../../electron/web/server'
export { WebAuth } from '../../electron/web/auth'
export { WEB_PROTO, webHostPath } from '../../shared/web'
