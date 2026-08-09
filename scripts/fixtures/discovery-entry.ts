/**
 * Bundle entry for `npm run discovery:check`.
 *
 * One root for esbuild to follow, exactly like fixtures/mobile-entry.ts: the
 * responder itself, plus the shared constants the checks send and compare
 * against. Re-exported rather than copied so a probe that stops matching the
 * shipped protocol fails the check instead of quietly testing a fossil.
 */
export { DiscoveryResponder } from '../../electron/mobile/discovery'
export {
  DISCOVERY_MIN_PROBE_BYTES,
  DISCOVERY_PROBE,
  MOBILE_PROTO,
  parseDiscoveryReply
} from '../../shared/mobile'
