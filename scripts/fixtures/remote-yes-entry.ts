/**
 * Bundle entry for `npm run remote-yes:check`.
 *
 * The check drives the *real* parsers, the real password generator, the real
 * elevated script builder and the real watcher out of electron/remote-yes.ts —
 * the same trick scripts/fixtures/tunnel-entry.ts plays for the ngrok
 * supervisor. Nothing here is part of the app; nothing here may add behaviour
 * the app does not have.
 */
export {
  buildSetupScript,
  firstOptionMismatch,
  generatePassword,
  parseLatestRelease,
  parseSetupResult,
  parseTailscaleIp,
  parseTasklistConsent,
  redactPassword,
  UacWatcher,
  PASSWORD_LENGTH,
  REMOTE_YES_PORT,
  RUSTDESK_EXE,
  RUSTDESK_OPTIONS,
  RUSTDESK_SERVICE,
  UAC_POLL_MS
} from '../../electron/remote-yes'
