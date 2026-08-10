/**
 * Bundle entry for `npm run web:rendezvous`.
 *
 * The check drives the *real* rendezvous service against the *real* Firebase
 * emulator, so this file exists only to give esbuild one root to follow — the
 * same trick scripts/fixtures/mobile-entry.ts uses. Nothing here is part of the
 * app; nothing here may add behaviour the app does not have.
 *
 * One root rather than two, and that part is load-bearing. `WebRendezvous`
 * branches on `err instanceof OfflineError`, and two separate esbuild bundles
 * would each carry their own copy of that class — so an `OfflineError` thrown by
 * a separately-bundled `FirebaseRest` would fail the very `instanceof` the check
 * exists to prove. Exporting both from one entry means one copy of each class.
 */
export { WebRendezvous } from '../../electron/web/rendezvous'
export { FirebaseRest, OfflineError, RevokedError } from '../../electron/companion/rest'
// Re-exported so the checks assert against exactly the shipped values rather
// than numbers that could drift from them.
export {
  HOST_HEARTBEAT_MS,
  HOST_STALE_MS,
  isHostLive,
  normaliseHost,
  parseHostRecord,
  WEB_PROTO,
  webHostPath
} from '../../shared/web'
