/**
 * A thin Telegram Bot API client over `fetch` (https://core.telegram.org/bots/api).
 *
 * Only the methods the channel uses, typed only as far as it reads them. Every
 * call answers `{ok: true, result}` or `{ok: false, status, description}` and
 * never throws: a network failure is `status: 0`. The token is in the URL and
 * nowhere else; it is scrubbed out of every description this file returns, so
 * a fetch error that quotes the URL cannot carry it into a log or a status.
 *
 * `TelegramApi` is the seam scripts/telegram-check.mjs fills with a fake.
 */

export interface TgUser {
  id: number
  is_bot?: boolean
  first_name?: string
  username?: string
}

export interface TgChat {
  id: number
  type?: string
  first_name?: string
  username?: string
}

export interface TgPhotoSize {
  file_id: string
  width: number
  height: number
  file_size?: number
}

export interface TgVoice {
  file_id: string
  duration?: number
  mime_type?: string
  file_size?: number
}

export interface TgMessage {
  message_id: number
  from?: TgUser
  chat: TgChat
  date?: number
  text?: string
  caption?: string
  voice?: TgVoice
  photo?: TgPhotoSize[]
}

export interface TgCallbackQuery {
  id: string
  from: TgUser
  message?: TgMessage
  data?: string
}

export interface TgUpdate {
  update_id: number
  message?: TgMessage
  callback_query?: TgCallbackQuery
}

export interface TgFile {
  file_id: string
  file_size?: number
  file_path?: string
}

export interface TgInlineButton {
  text: string
  callback_data: string
}

/** One Bot API answer. `status` 0 = never reached Telegram (network, abort, bad JSON). */
export type TgResult<T> =
  | { ok: true; result: T }
  | { ok: false; status: number; description: string; retryAfter?: number }

export interface TgGetUpdates {
  offset?: number
  /** Long-poll seconds. */
  timeout: number
  allowed_updates: string[]
}

export interface TelegramApi {
  getMe(): Promise<TgResult<TgUser>>
  deleteWebhook(): Promise<TgResult<boolean>>
  getUpdates(params: TgGetUpdates, signal?: AbortSignal): Promise<TgResult<TgUpdate[]>>
  sendMessage(chatId: string, text: string, inlineKeyboard?: TgInlineButton[][]): Promise<TgResult<TgMessage>>
  sendChatAction(chatId: string, action: 'typing'): Promise<TgResult<boolean>>
  getFile(fileId: string): Promise<TgResult<TgFile>>
  /** The file's bytes. Refuses anything over `TG_FILE_MAX` (the Bot API's own download limit). */
  downloadFile(filePath: string): Promise<TgResult<Uint8Array>>
  answerCallbackQuery(queryId: string, text?: string): Promise<TgResult<boolean>>
  editMessageText(chatId: string, messageId: number, text: string): Promise<TgResult<TgMessage | boolean>>
}

/** Bots may download files up to 20 MB. */
export const TG_FILE_MAX = 20 * 1024 * 1024

/** How long an ordinary call may take before it counts as a network failure. */
const CALL_MS = 30_000
/** Added to a long poll's own wait before the client gives up on it. */
const POLL_GRACE_MS = 15_000

const BASE = 'https://api.telegram.org'

/** Every Bot API response body. */
interface TgEnvelope<T> {
  ok?: boolean
  result?: T
  description?: string
  error_code?: number
  parameters?: { retry_after?: number }
}

export function createTelegramApi(token: string, fetchImpl: typeof fetch = fetch): TelegramApi {
  const scrub = (text: string): string => (token ? text.split(token).join('<token>') : text)

  const failure = (err: unknown): { ok: false; status: number; description: string } => {
    const name = (err as { name?: string } | null)?.name
    if (name === 'AbortError') return { ok: false, status: 0, description: 'Aborted.' }
    if (name === 'TimeoutError') return { ok: false, status: 0, description: 'Telegram did not answer in time.' }
    const message = err instanceof Error ? err.message : String(err)
    return { ok: false, status: 0, description: scrub(message || 'Network error.') }
  }

  const signalFor = (ms: number, signal?: AbortSignal): AbortSignal =>
    signal ? AbortSignal.any([signal, AbortSignal.timeout(ms)]) : AbortSignal.timeout(ms)

  async function call<T>(method: string, body: Record<string, unknown>, signal?: AbortSignal, ms = CALL_MS): Promise<TgResult<T>> {
    try {
      const res = await fetchImpl(`${BASE}/bot${token}/${method}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: signalFor(ms, signal)
      })
      let json: TgEnvelope<T> | null
      try {
        json = (await res.json()) as TgEnvelope<T> | null
      } catch {
        json = null
      }
      if (json?.ok === true) return { ok: true, result: json.result as T }
      const retryAfter = json?.parameters?.retry_after
      return {
        ok: false,
        status: typeof json?.error_code === 'number' ? json.error_code : res.status,
        description: scrub(String(json?.description ?? `HTTP ${res.status}`)),
        ...(typeof retryAfter === 'number' ? { retryAfter } : {})
      }
    } catch (err) {
      return failure(err)
    }
  }

  return {
    getMe: () => call<TgUser>('getMe', {}),
    deleteWebhook: () => call<boolean>('deleteWebhook', { drop_pending_updates: false }),
    getUpdates: (params, signal) =>
      call<TgUpdate[]>(
        'getUpdates',
        {
          ...(params.offset !== undefined ? { offset: params.offset } : {}),
          timeout: params.timeout,
          allowed_updates: params.allowed_updates
        },
        signal,
        params.timeout * 1000 + POLL_GRACE_MS
      ),
    sendMessage: (chatId, text, inlineKeyboard) =>
      call<TgMessage>('sendMessage', {
        chat_id: chatId,
        text,
        ...(inlineKeyboard ? { reply_markup: { inline_keyboard: inlineKeyboard } } : {})
      }),
    sendChatAction: (chatId, action) => call<boolean>('sendChatAction', { chat_id: chatId, action }),
    getFile: (fileId) => call<TgFile>('getFile', { file_id: fileId }),
    async downloadFile(filePath) {
      try {
        const res = await fetchImpl(`${BASE}/file/bot${token}/${filePath}`, { signal: AbortSignal.timeout(60_000) })
        if (!res.ok) return { ok: false, status: res.status, description: `HTTP ${res.status}` }
        const length = Number(res.headers.get('content-length') ?? 0)
        if (length > TG_FILE_MAX) return { ok: false, status: 413, description: 'The file is over 20 MB.' }
        const bytes = new Uint8Array(await res.arrayBuffer())
        if (bytes.length > TG_FILE_MAX) return { ok: false, status: 413, description: 'The file is over 20 MB.' }
        return { ok: true, result: bytes }
      } catch (err) {
        return failure(err)
      }
    },
    answerCallbackQuery: (queryId, text) =>
      call<boolean>('answerCallbackQuery', { callback_query_id: queryId, ...(text ? { text } : {}) }),
    editMessageText: (chatId, messageId, text) =>
      call<TgMessage | boolean>('editMessageText', { chat_id: chatId, message_id: messageId, text })
  }
}
