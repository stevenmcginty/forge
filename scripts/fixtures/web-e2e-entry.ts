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
 * browser will read, and does not need the frame-size constants the smoke test
 * asserts against.
 *
 * `HEARTBEAT_MS` and `HEARTBEAT_GRACE_MS` are here for a different job than the
 * smoke test gives them: not to assert against, but so the browser check can say
 * how long a page sitting at the PIN box has to hold still for — the window in
 * which a socket that was not being minded would have been swept away. Read
 * rather than restated, because a check that carried its own copy of either
 * number would keep passing after the shipped one moved.
 */
export { WebServer } from '../../electron/web/server'
export { WebAuth } from '../../electron/web/auth'
export { PtySessionManager } from '../../electron/pty/session-manager'
/*
 * The real folder listing, so the picker in the browser is walking a real
 * directory tree through the shipped code rather than through a stand-in
 * written to agree with it. This is the whole reason that module has no
 * Electron in it — see its header.
 */
export { checkFolder, listFolder } from '../../electron/web/fs-browse'
/*
 * The real fence a browser's "New project" name goes through, so the create
 * flow in the check is refused and allowed by the shipped rules rather than by
 * a stand-in. Electron-free for the same reason fs-browse is — see its header.
 */
export { planProjectFolder } from '../../electron/projectfolder'
export {
  HEARTBEAT_GRACE_MS,
  HEARTBEAT_MS,
  HOST_HEARTBEAT_MS,
  /*
   * The chunk ceiling, so the mirror phase asserts every encoded frame against
   * the number the shipped server would end the watch over rather than against
   * a figure written into the check. A local copy would keep passing after the
   * real one moved, which is the whole reason nothing here is restated.
   */
  MAX_MIRROR_CHUNK_BYTES,
  /** The shortest PIN the desktop accepts, so the box's own floor is asserted against it. */
  PIN_MIN_DIGITS,
  WEB_PROTO,
  webHostPath
} from '../../shared/web'
// The real PIN hashing, so a desktop in this check is seeded with the exact
// `scrypt$1$…` string the settings panel would have written — and the browser is
// therefore verified against `verifyPin` rather than against a stand-in written
// to agree with it.
export { hashPin } from '../../electron/web/pin'
