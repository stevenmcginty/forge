/**
 * Bundle entry for `npm run mobile:auth`.
 *
 * The check drives the *real* electron/mobile/auth.ts — the module is the
 * thing under test, so nothing about it is mocked; only the clock is
 * injected, which is exactly what the host injects in production. This file
 * exists only to give esbuild one root to follow, the same trick
 * scripts/fixtures/web-auth-entry.ts plays for `npm run web:auth`. Nothing
 * here is part of the app; nothing here may add behaviour the app does not
 * have.
 */
export { MobileAuth, hashToken } from '../../electron/mobile/auth'
// The real settings writer, so the "no credential in settings.json" check can
// read the file back off disk rather than trusting an in-memory array.
export { setSettings } from '../../electron/store'
