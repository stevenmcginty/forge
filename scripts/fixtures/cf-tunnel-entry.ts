/**
 * Bundle entry for `npm run cf:tunnel`.
 *
 * The check drives the *real* supervisor, the real log parser and the real
 * refusal rules from electron/cloudflare-tunnel.ts — the same trick
 * scripts/fixtures/tunnel-entry.ts plays for the ngrok one. Nothing here is
 * part of the app; nothing here may add behaviour the app does not have.
 */
export {
  CloudflareTunnel,
  backoffDelay,
  cloudflaredArgs,
  ensureCloudflaredExe,
  parseCloudflaredLine,
  permanentRefusal,
  resolveCloudflaredExe,
  BACKOFF_CAP_MS,
  CLOUDFLARED_EXE_URL,
  HEALTHY_RESET_MS,
  QUICK_TUNNEL_URL,
  EDGE_FAILURE_LIMIT,
  EDGE_FAILURE_LINE,
  EDGE_RECOVERED_LINE,
  KILL_ESCALATE_MS,
  PROBE_INTERVAL_MS,
  PROBE_STRIKES,
  PROBE_TIMEOUT_MS,
  BIRTH_PROBE_INTERVAL_MS,
  BIRTH_PROBE_LIMIT,
  CONTROL_PROBE_URL
} from '../../electron/cloudflare-tunnel'
/**
 * The hostname normaliser Forge Web actually publishes through. A quick tunnel
 * URL that this rejects is a hostname no browser is ever told, so the check
 * asserts the real function against the real shape of address cloudflared hands
 * out rather than trusting that they fit.
 */
export { normaliseHost, webSocketUrl } from '../../shared/web'
