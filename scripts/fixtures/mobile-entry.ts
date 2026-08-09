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
// Re-exported so the checks use exactly the shipped values rather than a
// number that could drift from them: the approval window, and the screen
// mirror's signalling payload cap.
export { ACCEPT_WINDOW_MS, MAX_INPUT_PER_SECOND, MAX_SIGNAL_CHARS } from '../../shared/mobile'
