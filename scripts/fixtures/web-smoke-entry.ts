/**
 * Bundle entry for `npm run web:smoke`.
 *
 * The smoke test drives the *real* link server, the *real* Firebase token
 * verifier and the *real* PTY manager, so this file exists only to give esbuild
 * one root to follow — the same trick scripts/fixtures/mobile-entry.ts and
 * scripts/fixtures/web-auth-entry.ts play. Nothing here is part of the app;
 * nothing here may add behaviour the app does not have.
 */
export { WebServer, isAllowedSource } from '../../electron/web/server'
export { WebAuth } from '../../electron/web/auth'
export { PtySessionManager } from '../../electron/pty/session-manager'
// The real geometry policy, so the ownership phases drive the shipped registry
// against a real PTY rather than a stand-in written to agree with it. This is
// what that module has no Electron in it for.
export { DESK_VIEWER, GridOwners } from '../../electron/pty/grid-owner'
// The real PIN hashing, so the phases that put a PIN on a stub host seed it
// with exactly what `web:pin-set` would write rather than with a fixture that
// could keep passing after the stored form moved.
export { hashPin } from '../../electron/web/pin'
export { INBOX_KEEP, saveInboxImage } from '../../electron/web/inbox'
// Re-exported so the checks assert against exactly the shipped values rather
// than numbers that could drift from them.
export {
  HEARTBEAT_GRACE_MS,
  HEARTBEAT_MS,
  MAX_FRAME_BYTES,
  MAX_IMAGE_BASE64,
  MAX_INPUT_PER_SECOND,
  MAX_MIRROR_CHUNK_BYTES,
  MAX_MIRROR_INPUT_PER_SECOND,
  MAX_REPLAY_BYTES,
  MAX_WRITE_CHARS,
  WEB_PROTO,
  WEB_SUBPROTOCOL,
  WEB_WS_PATH,
  webSocketUrl
} from '../../shared/web'
/**
 * The two `MAX_SESSIONS` constants, both of them.
 *
 * shared/web.ts restates shared/ipc.ts's value rather than importing it, so the
 * browser bundle does not carry the desktop's whole IPC channel table for one
 * integer, and its comment says flatly that "the two numbers must match". Until
 * they are both in scope somewhere that can compare them, nothing enforces
 * that. Here they are, under two names, so a check can.
 */
export { MAX_SESSIONS as WEB_MAX_SESSIONS } from '../../shared/web'
export { MAX_SESSIONS as IPC_MAX_SESSIONS } from '../../shared/ipc'
export { AUTH_MAX_FAILURES } from '../../shared/mobile'
