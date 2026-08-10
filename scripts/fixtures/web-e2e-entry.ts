/**
 * Bundle entry for `npm run web:e2e`.
 *
 * The same trick, and the same rule, as scripts/fixtures/web-smoke-entry.ts:
 * this file exists only to give esbuild one root to follow into the *real* link
 * server, the *real* Firebase token verifier and the *real* PTY manager. Nothing
 * here is part of the app, and nothing here may add behaviour the app does not
 * have.
 *
 * A file of its own rather than reusing the smoke entry, because that one's
 * header names the check it serves and the two want different exports — this one
 * needs `webHostPath` and `HOST_HEARTBEAT_MS` to publish a rendezvous record the
 * browser will read, and does not need the heartbeat or frame-size constants the
 * smoke test asserts against.
 */
export { WebServer } from '../../electron/web/server'
export { WebAuth } from '../../electron/web/auth'
export { PtySessionManager } from '../../electron/pty/session-manager'
export { HOST_HEARTBEAT_MS, WEB_PROTO, webHostPath } from '../../shared/web'
