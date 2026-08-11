/**
 * Bundle entry for `npm run web:auth`.
 *
 * The check drives the *real* electron/web/auth.ts — the module is the thing
 * under test, so nothing about it is mocked; only the JWKS fetcher and the
 * clock are injected, which is exactly what the host injects in production.
 * This file exists only to give esbuild one root to follow, the same trick
 * scripts/fixtures/mobile-entry.ts plays. Nothing here is part of the app;
 * nothing here may add behaviour the app does not have.
 */
export { WebAuth, GOOGLE_JWKS_URL, CLOCK_SKEW_MS } from '../../electron/web/auth'
// The real settings writer, so the "no credential in settings.json" check can
// read the file back off disk rather than trusting an in-memory array.
export { setSettings } from '../../electron/store'
// The real PIN hashing, so the check sets a PIN exactly as `web:pin-set` does
// rather than asserting against a second implementation written to agree with
// the first — and so `verifyPin` is exercised as the shipped total function.
export { hashPin, isValidPin, verifyPin } from '../../electron/web/pin'
// Re-exported so the checks use exactly the shipped values rather than numbers
// that could drift from them.
export { PIN_MAX_DIGITS, PIN_MIN_DIGITS } from '../../shared/web'
export { AUTH_LOCKOUT_MS, AUTH_MAX_FAILURES } from '../../shared/mobile'
