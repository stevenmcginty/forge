/**
 * Bundle entry for `npm run input:check`.
 *
 * One root for esbuild to follow, exactly like fixtures/mobile-entry.ts: the
 * check drives the *real* validator and the *real* line encoder rather than a
 * copy of them, because a copy is a thing that can agree with the test while
 * disagreeing with the app. Nothing here is part of Forge.
 */
export { canDriveDesktop, lineFor, probeDesktopInput } from '../../electron/mobile/input'
export { readMirrorInput, MAX_WHEEL_NOTCHES, MIRROR_KEYS } from '../../shared/mobile'
// The television's half of the same feature. Bundled beside the desktop's
// because the two only mean anything together: what the sofa's grammar emits
// is exactly what the desk's validator has to accept.
export { startPointer } from '../../mobile/src/lib/pointer'
