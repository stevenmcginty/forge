/** The Telegram bot's state, pushed to Settings whenever it moves. */
export type TelegramState = 'off' | 'no-token' | 'checking' | 'pairing' | 'ready' | 'error'
export interface TelegramStatus {
  enabled: boolean
  state: TelegramState
  /** From getMe, e.g. "ForgeSteveBot". Null until the token is checked. */
  botUsername: string | null
  /** True when a chat id is locked in. */
  paired: boolean
  /** The paired chat's first name or username, for display. */
  pairedName: string | null
  /** Six digits while pairing is armed, else null. Shown only in desktop Settings. */
  pairCode: string | null
  pairCodeExpiresAt: number | null
  error: string | null
  lastMessageAt: number | null
  lastSentAt: number | null
}
export type TelegramTestResult = { ok: true } | { ok: false; error: string }
export const TELEGRAM_TEXT_MAX = 4096
export const TELEGRAM_PAIR_TTL_MS = 10 * 60_000
export const TELEGRAM_PAIR_MAX_WRONG = 5
export const TELEGRAM_IPC = {
  status: 'telegram:status', // R→M invoke → TelegramStatus
  setEnabled: 'telegram:set-enabled', // R→M invoke (enabled: boolean) → TelegramStatus
  pair: 'telegram:pair', // R→M invoke → TelegramStatus (arms a fresh code)
  unpair: 'telegram:unpair', // R→M invoke → TelegramStatus
  test: 'telegram:test', // R→M invoke → TelegramTestResult
  state: 'telegram:state' // M→R push TelegramStatus
} as const
