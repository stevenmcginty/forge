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
/*
 * The real layout engine, so the phase that closes a pane with no renderer
 * anywhere is driving the class electron/web-host.ts hands the frame to rather
 * than a stand-in written to agree with it. Electron-free for exactly this
 * reason — see its header.
 */
export { LayoutEngine, UNSUPPORTED } from '../../electron/layout-engine'
// The real geometry policy, so the ownership phases drive the shipped registry
// against a real PTY rather than a stand-in written to agree with it. This is
// what that module has no Electron in it for.
export { DESK_VIEWER, GridOwners } from '../../electron/pty/grid-owner'
// The real PIN hashing, so the phases that put a PIN on a stub host seed it
// with exactly what `web:pin-set` would write rather than with a fixture that
// could keep passing after the stored form moved.
export { hashPin } from '../../electron/web/pin'
export { GROK_IMAGE_PASTE, INBOX_KEEP, imagePasteIntoPane, saveInboxImage } from '../../electron/web/inbox'
export {
  planPointerDelta,
  planTouchScroll,
  TUI_PAGE_ROWS,
  wheelDeltaPx,
  wheelReportCell
} from '../../shared/touch-scroll'
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
// Foreman's seed ceiling, from the file that owns it, so the boundary
// assertion below is against the shipped number and not a copy of it.
export { FOREMAN_SEED_MAX } from '../../shared/foreman'
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
export { AUTH_MAX_FAILURES, AUTH_LOCKOUT_MS } from '../../shared/mobile'
/*
 * The handoff boundary rule, from the file both links share. Exported so the
 * smoke test asserts against the shipped reader rather than a copy of the three
 * kinds written to agree with it.
 */
export { readHandoffTarget } from '../../shared/handoffview'
