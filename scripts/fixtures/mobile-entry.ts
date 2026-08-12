/**
 * Bundle entry for `npm run mobile:smoke`.
 *
 * The smoke test drives the *real* link server, the *real* auth and the *real*
 * PTY manager, so this file exists only to give esbuild one root to follow —
 * the same trick scripts/pty-smoke.mjs uses on session-manager.ts. Nothing here
 * is part of the app; nothing here may add behaviour the app does not have.
 */
export { MobileServer, isAllowedSource, resolveWithin } from '../../electron/mobile/server'
export { MobileAuth, PAIR_TTL_MS, hashToken } from '../../electron/mobile/auth'
export { PtySessionManager } from '../../electron/pty/session-manager'
// The real geometry policy, so the ownership phases drive the shipped registry
// against a real PTY rather than a stand-in written to agree with it. This is
// what that module has no Electron in it for.
export { DESK_VIEWER, GridOwners } from '../../electron/pty/grid-owner'
// Re-exported so the checks use exactly the shipped values rather than a
// number that could drift from them: the approval window, the screen mirror's
// signalling payload cap, and the longest phrase one text frame may carry.
export { ACCEPT_WINDOW_MS, MAX_INPUT_PER_SECOND, MAX_SIGNAL_CHARS, MAX_TEXT_CHARS } from '../../shared/mobile'
