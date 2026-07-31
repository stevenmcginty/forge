/**
 * Bundle entry for `npm run tunnel:check`.
 *
 * The check drives the *real* supervisor, the real log parser and the real
 * refusal rules from electron/mobile-tunnel.ts — the same trick
 * scripts/fixtures/mobile-entry.ts plays for the link server. Nothing here is
 * part of the app; nothing here may add behaviour the app does not have.
 */
export {
  NgrokTunnel,
  backoffDelay,
  bsdtarPath,
  ensureNgrokExe,
  ngrokArgs,
  pairEndpoint,
  parseNgrokLine,
  permanentRefusal,
  redactAuthtoken,
  resolveNgrokExe,
  BACKOFF_CAP_MS,
  HEALTHY_RESET_MS
} from '../../electron/mobile-tunnel'
export { normaliseNgrokDomain, pairLink } from '../../shared/mobile'
/**
 * The phone's own parsers, not a re-implementation. The QR encodes what
 * `pairLink` builds and the phone decodes it with these two — bundling the
 * real functions is the only way the check can promise the two sides agree,
 * which is the whole hazard: a builder and parser that drift produce a QR
 * that scans cleanly and pairs against a dead address.
 */
export { pairTokenOf, toOrigin } from '../../mobile/src/lib/secure'
