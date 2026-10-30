import { randomInt } from 'node:crypto'
import type {
  BrainAskResult,
  BrainFreshStartResult,
  BrainSaysEvent,
  BrainSendResult,
  BrainStatus
} from '@shared/brain'
import type { Settings } from '@shared/types'
import {
  TELEGRAM_PAIR_MAX_WRONG,
  TELEGRAM_PAIR_TTL_MS,
  type TelegramState,
  type TelegramStatus,
  type TelegramTestResult
} from '@shared/telegram'
import type { TelegramApi, TgCallbackQuery, TgMessage, TgPhotoSize, TgResult, TgUpdate } from './api'
import { splitForTelegram } from './split'

/**
 * The Telegram chat plugin: one bot, long-polling, paired to Steve's one chat,
 * talking to Forge Brain.
 *
 * Every outside thing comes in through `TelegramDeps` (the Bot API, the brain,
 * settings, speech to text, the inbox folder, the clock), so the next chat
 * plugin copies this shape and scripts/telegram-check.mjs runs it with fakes.
 * No Electron import here; ./ipc.ts wires the real ones.
 *
 * Pairing: Settings arms a six-digit code (`pair`); the first chat to send it
 * (bare, or as `/start CODE`) is locked in as `telegramChatId`. A right code
 * pairs at once. Only wrong codes are counted (a message of digits, or
 * `/start` with something after it; "hi" is not a guess):
 * `TELEGRAM_PAIR_MAX_WRONG` from one chat drops the code. Once paired, every
 * update from any other chat is dropped without a word.
 *
 * The token never leaves this process: it is handed to `deps.api` and is in
 * no status, no log line and no reply.
 */

export interface TelegramBrain {
  ask(text: string, timeoutMs?: number): Promise<BrainAskResult>
  send(text: string): BrainSendResult
  status(): BrainStatus
  onStatus(listener: (status: BrainStatus) => void): () => void
  onSays(listener: (event: BrainSaysEvent) => void): () => void
  answerConfirm(answer: { id: string; allow: boolean }): boolean
  freshStart(): Promise<BrainFreshStartResult>
}

export type TelegramSettings = Pick<
  Settings,
  'telegramEnabled' | 'telegramBotToken' | 'telegramChatId' | 'telegramChatName' | 'brainEnabled'
>

export interface TelegramDeps {
  api: (token: string) => TelegramApi
  brain: TelegramBrain
  settings: {
    get(): TelegramSettings
    set(patch: Partial<TelegramSettings>): void
  }
  transcribe: (bytes: Uint8Array, mime: string) => Promise<{ ok: true; text: string } | { ok: false; error: string }>
  /** Writes the bytes under the inbox folder; returns the absolute path. */
  saveInboxFile: (name: string, bytes: Uint8Array) => string
  now?: () => number
  log: { info(message: string): void; warn(message: string): void }
  /** Waits `ms`, or less when `signal` aborts. Injected by the check so backoffs take no time. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>
}

/** How long Forge waits for the brain's reply to one Telegram message. */
export const TELEGRAM_ASK_MS = 5 * 60_000
/** Telegram shows "typing…" for at most 5 s; repeated a little sooner. */
const TYPING_EVERY_MS = 4_000
/** A report-back identical to a message sent this recently is not sent again. */
const SAYS_DEDUPE_MS = 5_000
/** Confirm cards remembered, so a late answer or a vanished question can edit its card. */
const CONFIRMS_REMEMBERED = 50
/** Network failures in a row before the state says `error` (it keeps retrying either way). */
const NETWORK_FAILURES_FOR_ERROR = 3
const BACKOFF_MIN_MS = 1_000
const BACKOFF_MAX_MS = 60_000
/** A 409 means another getUpdates (or a webhook) holds the bot. */
const CONFLICT_WAIT_MS = 5_000
const POLL_SECONDS = 30

export const TG_TEXT = {
  paired: 'Paired. This chat now talks to Forge Brain. Say /help for the short list.',
  help: [
    '/status - Forge Brain, the queue, the engine',
    '/fresh - start Forge Brain on a new conversation',
    '/help - this list',
    'Anything else goes to Forge Brain. Voice notes and photos work.'
  ].join('\n'),
  late: 'Still working. I will message here when it is done.',
  brainOff: 'Forge Brain is off. Turn it on in Forge Settings.',
  freshDone: 'Fresh start done.',
  otherKinds: 'I can take text, voice notes and photos here.',
  test: 'Test from Forge. This chat is paired.',
  photoAsk: 'Look at this photo.',
  emptyReply: 'Forge Brain gave an empty reply.',
  tooManyWrong: 'Too many wrong codes. Press Pair again.',
  tokenRefused: 'Telegram refused the bot token. Check it in Settings.',
  answeredElsewhere: 'Answered in Forge, or timed out.'
} as const

type Phase = 'off' | 'no-token' | 'checking' | 'running' | 'refused'

interface PostedConfirm {
  summary: string
  /** Null while the card is still being sent. */
  messageId: number | null
  /** Answered from this chat: the card is edited by the answer. */
  answered: boolean
  /** Gone from `confirms[]` without our answer. */
  vanished: boolean
}

const BRAIN_STATE_WORDS: Record<BrainStatus['state'], string> = {
  off: 'off',
  starting: 'starting',
  idle: 'ready',
  busy: 'busy',
  asking: 'waiting for your yes',
  error: 'error'
}

function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve()
    const timer = setTimeout(done, ms)
    function done(): void {
      clearTimeout(timer)
      signal?.removeEventListener('abort', done)
      resolve()
    }
    signal?.addEventListener('abort', done, { once: true })
  })
}

/** `/cmd`, `/cmd@SomeBot`, with the rest of the line. Null when it is not a command. */
function parseCommand(text: string): { name: string; arg: string } | null {
  const m = /^\/([a-z_]+)(?:@\w+)?(?:\s+([\s\S]*))?$/i.exec(text.trim())
  return m ? { name: m[1].toLowerCase(), arg: (m[2] ?? '').trim() } : null
}

const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err))

export class TelegramChannel {
  private readonly deps: TelegramDeps
  private readonly now: () => number
  private readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>

  private phase: Phase = 'off'
  private api: TelegramApi | null = null
  private abort: AbortController | null = null
  /** The token the running poller was started with, to see a change. Never leaves this object. */
  private runningToken = ''
  private botUsername: string | null = null
  private networkFailures = 0
  private networkError: string | null = null

  private pairCode: string | null = null
  private pairCodeExpiresAt: number | null = null
  private pairTimer: ReturnType<typeof setTimeout> | null = null
  private pairError: string | null = null
  private readonly wrongCodes = new Map<string, number>()

  private lastMessageAt: number | null = null
  private lastSentAt: number | null = null

  /** Messages for the brain, one at a time, in order. */
  private queue: Promise<void> = Promise.resolve()
  /** Asks to the brain in flight from this chat. */
  private asking = 0
  private readonly recentSent: { text: string; at: number }[] = []
  private readonly confirms = new Map<string, PostedConfirm>()
  private readonly unknownChats = new Set<string>()

  private readonly listeners = new Set<(status: TelegramStatus) => void>()
  private lastEmitted = ''
  private readonly unsubscribe: (() => void)[] = []
  private disposed = false

  constructor(deps: TelegramDeps) {
    this.deps = deps
    this.now = deps.now ?? Date.now
    this.sleep = deps.sleep ?? defaultSleep
    this.unsubscribe.push(deps.brain.onStatus((status) => this.syncConfirms(status)))
    this.unsubscribe.push(deps.brain.onSays((event) => this.onSays(event)))
  }

  /* ------------------------------------------------------------ public */

  /** Re-read settings and bring the poller in line: start, stop, or restart on a new token. */
  apply(): TelegramStatus {
    if (this.disposed) return this.status()
    const s = this.deps.settings.get()
    const token = (s.telegramBotToken ?? '').trim()
    if (!s.telegramEnabled) {
      this.stop('off')
    } else if (!token) {
      this.stop('no-token')
    } else if (token !== this.runningToken || this.phase === 'off' || this.phase === 'no-token') {
      this.start(token)
    } else if (this.phase === 'running') {
      this.syncConfirms(this.deps.brain.status())
    }
    this.changed()
    return this.status()
  }

  status(): TelegramStatus {
    const s = this.deps.settings.get()
    const paired = Boolean((s.telegramChatId ?? '').trim())
    let state: TelegramState
    let error: string | null = null
    switch (this.phase) {
      case 'off':
        state = 'off'
        break
      case 'no-token':
        state = 'no-token'
        break
      case 'refused':
        state = 'error'
        error = TG_TEXT.tokenRefused
        break
      default:
        if (this.networkFailures >= NETWORK_FAILURES_FOR_ERROR) {
          state = 'error'
          error = this.networkError
        } else if (this.phase === 'checking') {
          state = 'checking'
        } else {
          state = paired ? 'ready' : 'pairing'
        }
    }
    if (!error && !paired && this.pairError) error = this.pairError
    return {
      enabled: s.telegramEnabled === true,
      state,
      botUsername: this.botUsername,
      paired,
      pairedName: paired ? s.telegramChatName || null : null,
      pairCode: paired ? null : this.pairCode,
      pairCodeExpiresAt: paired ? null : this.pairCodeExpiresAt,
      error,
      lastMessageAt: this.lastMessageAt,
      lastSentAt: this.lastSentAt
    }
  }

  onStatus(listener: (status: TelegramStatus) => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  /** Arm a fresh pairing code. Does nothing while paired, off, or without a token. */
  pair(): TelegramStatus {
    const s = this.deps.settings.get()
    if (this.disposed || this.paired() || !s.telegramEnabled || !(s.telegramBotToken ?? '').trim()) {
      return this.status()
    }
    this.clearCode()
    this.pairCode = String(randomInt(0, 1_000_000)).padStart(6, '0')
    this.pairCodeExpiresAt = this.now() + TELEGRAM_PAIR_TTL_MS
    this.pairError = null
    this.wrongCodes.clear()
    this.pairTimer = setTimeout(() => {
      this.clearCode()
      this.changed()
    }, TELEGRAM_PAIR_TTL_MS)
    this.pairTimer.unref?.()
    this.changed()
    return this.status()
  }

  /** Forget the paired chat. The bot keeps running, waiting for Pair. */
  unpair(): TelegramStatus {
    this.deps.settings.set({ telegramChatId: '', telegramChatName: '' })
    this.clearCode()
    this.pairError = null
    this.wrongCodes.clear()
    this.unknownChats.clear()
    this.confirms.clear()
    this.changed()
    return this.status()
  }

  setEnabled(enabled: boolean): TelegramStatus {
    if (this.deps.settings.get().telegramEnabled !== enabled) this.deps.settings.set({ telegramEnabled: enabled })
    return this.apply()
  }

  async test(): Promise<TelegramTestResult> {
    const status = this.status()
    const chatId = this.chatId()
    if (status.state !== 'ready' || !this.api || !chatId) return { ok: false, error: this.notReadyReason(status) }
    const sent = await this.sendText(chatId, TG_TEXT.test)
    return sent.ok ? { ok: true } : { ok: false, error: `Telegram would not take the message: ${sent.description}` }
  }

  dispose(): void {
    this.disposed = true
    this.stop('off')
    for (const off of this.unsubscribe.splice(0)) off()
    this.listeners.clear()
  }

  /* -------------------------------------------------------- the poller */

  private start(token: string): void {
    this.abort?.abort()
    const abort = new AbortController()
    this.abort = abort
    this.runningToken = token
    const api = this.deps.api(token)
    this.api = api
    this.phase = 'checking'
    this.botUsername = null
    this.networkFailures = 0
    this.networkError = null
    void this.run(api, abort.signal).catch((err) => this.deps.log.warn(`poller stopped: ${errorText(err)}`))
  }

  private stop(phase: 'off' | 'no-token'): void {
    this.abort?.abort()
    this.abort = null
    this.api = null
    this.runningToken = ''
    this.phase = phase
    this.botUsername = null
    this.networkFailures = 0
    this.networkError = null
    this.clearCode()
  }

  private async run(api: TelegramApi, signal: AbortSignal): Promise<void> {
    let backoff = BACKOFF_MIN_MS
    // The token first: a refused one stops here, a network failure retries.
    for (;;) {
      const me = await api.getMe()
      if (signal.aborted) return
      if (me.ok) {
        this.botUsername = me.result.username ?? null
        break
      }
      // A revoked token is a 401 on getMe, a malformed one a 404: both mean the token.
      if (me.status === 401 || me.status === 404) return this.refused()
      this.networkFailed(me)
      await this.sleep(backoff, signal)
      if (signal.aborted) return
      backoff = Math.min(backoff * 2, BACKOFF_MAX_MS)
    }
    // getUpdates refuses to run while a webhook is set.
    const hook = await api.deleteWebhook()
    if (signal.aborted) return
    if (!hook.ok && hook.status === 401) return this.refused()
    this.phase = 'running'
    this.networkOk()
    this.syncConfirms(this.deps.brain.status())

    backoff = BACKOFF_MIN_MS
    let offset: number | undefined
    for (;;) {
      const got = await api.getUpdates(
        { offset, timeout: POLL_SECONDS, allowed_updates: ['message', 'callback_query'] },
        signal
      )
      if (signal.aborted) return
      if (!got.ok) {
        if (got.status === 401) return this.refused()
        if (got.status === 409) {
          await this.sleep(CONFLICT_WAIT_MS, signal)
        } else if (got.status === 429) {
          await this.sleep(Math.max(1, got.retryAfter ?? 1) * 1000, signal)
        } else {
          this.networkFailed(got)
          await this.sleep(backoff, signal)
          backoff = Math.min(backoff * 2, BACKOFF_MAX_MS)
        }
        continue
      }
      backoff = BACKOFF_MIN_MS
      this.networkOk()
      for (const update of got.result) {
        offset = Math.max(offset ?? 0, update.update_id + 1)
        void this.handleUpdate(update).catch((err) => this.deps.log.warn(`update failed: ${errorText(err)}`))
      }
    }
  }

  private refused(): void {
    this.phase = 'refused'
    this.deps.log.warn('Telegram refused the bot token')
    this.changed()
  }

  private networkFailed(r: { status: number; description: string }): void {
    this.networkFailures++
    this.networkError = `Cannot reach Telegram (${r.description}). Trying again.`
    if (this.networkFailures === NETWORK_FAILURES_FOR_ERROR) this.deps.log.warn(this.networkError)
    this.changed()
  }

  private networkOk(): void {
    this.networkFailures = 0
    this.networkError = null
    this.changed()
  }

  /* ---------------------------------------------------------- updates */

  /**
   * One update from getUpdates. Resolves when it is fully handled — for a
   * message to the brain, after its reply went out. The poller does not wait
   * on it (a confirm's Yes must get through while an ask is in flight); the
   * check does.
   */
  async handleUpdate(update: TgUpdate): Promise<void> {
    if (this.disposed || this.phase !== 'running') return
    if (update.callback_query) return this.handleCallback(update.callback_query)
    const msg = update.message
    if (!msg?.chat) return
    const chatId = String(msg.chat.id)
    const paired = this.chatId()
    if (!paired) return this.handlePairing(msg)
    if (chatId !== paired) return this.dropUnknown(chatId)
    this.lastMessageAt = this.now()
    this.changed()
    return this.handleMessage(paired, msg)
  }

  private dropUnknown(chatId: string): void {
    if (this.unknownChats.has(chatId)) return
    this.unknownChats.add(chatId)
    this.deps.log.info(`ignoring a chat that is not the paired one (${chatId})`)
  }

  private async handlePairing(msg: TgMessage): Promise<void> {
    if (!this.pairCode || this.pairCodeExpiresAt === null) return
    if (this.now() > this.pairCodeExpiresAt) {
      this.clearCode()
      this.changed()
      return
    }
    const text = (msg.text ?? '').trim()
    const command = parseCommand(text)
    const attempt = command ? (command.name === 'start' ? command.arg : '') : /^\d+$/.test(text) ? text : ''
    // Not a code at all ("hi", the bare /start a new chat sends): ignored, not counted.
    if (!attempt) return
    const chatId = String(msg.chat.id)
    if (attempt === this.pairCode) {
      const name = msg.chat.first_name || msg.from?.first_name || msg.chat.username || msg.from?.username || ''
      this.deps.settings.set({ telegramChatId: chatId, telegramChatName: name })
      this.clearCode()
      this.pairError = null
      this.wrongCodes.clear()
      this.unknownChats.clear()
      this.lastMessageAt = this.now()
      this.deps.log.info('paired a chat')
      this.changed()
      this.syncConfirms(this.deps.brain.status())
      await this.sendText(chatId, TG_TEXT.paired)
      return
    }
    const wrong = (this.wrongCodes.get(chatId) ?? 0) + 1
    this.wrongCodes.set(chatId, wrong)
    if (wrong >= TELEGRAM_PAIR_MAX_WRONG) {
      this.clearCode()
      this.wrongCodes.clear()
      this.pairError = TG_TEXT.tooManyWrong
      this.deps.log.warn('pairing code dropped after too many wrong codes')
      this.changed()
    }
  }

  private async handleMessage(chatId: string, msg: TgMessage): Promise<void> {
    if (typeof msg.text === 'string') {
      const command = parseCommand(msg.text)
      if (command?.name === 'status') {
        await this.sendText(chatId, this.statusLine())
        return
      }
      if (command?.name === 'help' || (command?.name === 'start' && !command.arg)) {
        await this.sendText(chatId, TG_TEXT.help)
        return
      }
      if (command?.name === 'fresh') {
        const r = await this.deps.brain.freshStart()
        await this.sendText(chatId, r.ok ? TG_TEXT.freshDone : r.error)
        return
      }
      const text = msg.text.trim()
      if (!text) return
      return this.enqueue(() => this.askAndReply(chatId, text))
    }
    if (msg.voice) {
      const voice = msg.voice
      return this.enqueue(() => this.handleVoice(chatId, voice.file_id, voice.mime_type))
    }
    if (msg.photo && msg.photo.length > 0) {
      const photos = msg.photo
      const caption = (msg.caption ?? '').trim()
      return this.enqueue(() => this.handlePhoto(chatId, photos, caption))
    }
    await this.sendText(chatId, TG_TEXT.otherKinds)
  }

  /** Runs `job` after every message before it; resolves when it is done. */
  private enqueue(job: () => Promise<void>): Promise<void> {
    const run = this.queue.then(job)
    this.queue = run.catch((err) => this.deps.log.warn(`message failed: ${errorText(err)}`))
    return this.queue
  }

  private async handleVoice(chatId: string, fileId: string, mime: string | undefined): Promise<void> {
    const bytes = await this.download(fileId)
    if (!bytes.ok) {
      await this.sendText(chatId, `Could not fetch the voice note: ${bytes.description}`)
      return
    }
    const heard = await this.deps.transcribe(bytes.result, mime ?? 'audio/ogg')
    if (!heard.ok) {
      await this.sendText(chatId, heard.error)
      return
    }
    const text = heard.text.trim()
    if (!text) {
      await this.sendText(chatId, 'I heard nothing in that voice note.')
      return
    }
    await this.sendText(chatId, `Heard: "${text}"`)
    await this.askAndReply(chatId, text)
  }

  private async handlePhoto(chatId: string, photos: TgPhotoSize[], caption: string): Promise<void> {
    const largest = photos.reduce((best, p) => (p.width * p.height > best.width * best.height ? p : best))
    const bytes = await this.download(largest.file_id)
    if (!bytes.ok) {
      await this.sendText(chatId, `Could not fetch the photo: ${bytes.description}`)
      return
    }
    let path: string
    try {
      path = this.deps.saveInboxFile(`${this.now()}.jpg`, bytes.result)
    } catch (err) {
      await this.sendText(chatId, `Could not save the photo: ${errorText(err)}`)
      return
    }
    await this.askAndReply(chatId, `${caption || TG_TEXT.photoAsk} Photo file: ${path}`)
  }

  private async download(fileId: string): Promise<TgResult<Uint8Array>> {
    const api = this.api
    if (!api) return { ok: false, status: 0, description: 'The bot is not running.' }
    const file = await api.getFile(fileId)
    if (!file.ok) return file
    if (!file.result.file_path) return { ok: false, status: 0, description: 'Telegram gave no file to download.' }
    return api.downloadFile(file.result.file_path)
  }

  /** Text to the brain; its reply, or why there is none, back to the chat. */
  private async askAndReply(chatId: string, text: string): Promise<void> {
    if (this.deps.brain.status().enabled === false) {
      await this.sendText(chatId, TG_TEXT.brainOff)
      return
    }
    this.asking++
    const typing = (): void => {
      void this.api?.sendChatAction(chatId, 'typing')
    }
    typing()
    const timer = setInterval(typing, TYPING_EVERY_MS)
    let result: BrainAskResult
    try {
      result = await this.deps.brain.ask(`[Telegram] ${text}`, TELEGRAM_ASK_MS)
    } finally {
      clearInterval(timer)
      this.asking--
    }
    if (result.ok) {
      await this.sendText(chatId, result.text.trim() ? result.text : TG_TEXT.emptyReply)
    } else {
      await this.sendText(chatId, result.late ? TG_TEXT.late : result.error)
    }
  }

  private async handleCallback(query: TgCallbackQuery): Promise<void> {
    const chatId = this.chatId()
    const from = String(query.from?.id ?? '')
    if (!chatId) return
    if (from !== chatId) return this.dropUnknown(from)
    const api = this.api
    if (!api) return
    this.lastMessageAt = this.now()
    this.changed()
    const m = /^c:(.+):([yn])$/.exec(query.data ?? '')
    if (!m) {
      await api.answerCallbackQuery(query.id)
      return
    }
    const id = m[1]
    const allow = m[2] === 'y'
    const posted = this.confirms.get(id)
    // Marked before answering: the brain's status push (the question gone)
    // arrives inside answerConfirm and must not read as "answered elsewhere".
    if (posted) posted.answered = true
    const ok = this.deps.brain.answerConfirm({ id, allow })
    if (!ok) {
      if (posted) posted.answered = false
      await api.answerCallbackQuery(query.id, TG_TEXT.answeredElsewhere)
      return
    }
    const word = allow ? 'Yes' : 'No'
    await api.answerCallbackQuery(query.id, word)
    const messageId = query.message?.message_id ?? posted?.messageId
    const summary = posted?.summary ?? 'Forge Brain asked.'
    if (typeof messageId === 'number') await this.edit(chatId, messageId, `${summary}\nYou said: ${word}`)
  }

  /* ------------------------------------------- the brain talking first */

  private onSays(event: BrainSaysEvent): void {
    const chatId = this.chatId()
    if (!chatId || this.phase !== 'running' || !this.api) return
    // askBrain folds these lines into the reply it is waiting for.
    if (this.asking > 0) return
    const text = event.text.trim()
    if (!text || this.sentRecently(text)) return
    void this.sendText(chatId, text)
  }

  /** Post a card for every new confirm; tidy the cards whose question went away without us. */
  private syncConfirms(status: BrainStatus): void {
    const chatId = this.chatId()
    if (!chatId || this.phase !== 'running' || !this.api) return
    const live = new Set(status.confirms.map((c) => c.id))
    for (const [id, posted] of this.confirms) {
      if (live.has(id) || posted.answered || posted.vanished) continue
      posted.vanished = true
      if (posted.messageId !== null) {
        void this.edit(chatId, posted.messageId, `${posted.summary}\n${TG_TEXT.answeredElsewhere}`)
      }
    }
    for (const confirm of status.confirms) {
      if (this.confirms.has(confirm.id)) continue
      const posted: PostedConfirm = { summary: confirm.summary, messageId: null, answered: false, vanished: false }
      this.confirms.set(confirm.id, posted)
      while (this.confirms.size > CONFIRMS_REMEMBERED) {
        const oldest = this.confirms.keys().next().value
        if (oldest === undefined) break
        this.confirms.delete(oldest)
      }
      void this.postConfirm(chatId, confirm.id, confirm.summary, confirm.risk, posted)
    }
  }

  private async postConfirm(chatId: string, id: string, summary: string, risk: string, posted: PostedConfirm): Promise<void> {
    const api = this.api
    if (!api) return
    const sent = await api.sendMessage(chatId, `Forge Brain wants to: ${summary}\nRisk: ${risk}`, [
      [
        { text: 'Yes', callback_data: `c:${id}:y` },
        { text: 'No', callback_data: `c:${id}:n` }
      ]
    ])
    if (!sent.ok) {
      this.deps.log.warn(`confirm card not sent: ${sent.description}`)
      return
    }
    this.noteSent()
    posted.messageId = sent.result.message_id
    // The question went while the card was on its way.
    if (posted.vanished && !posted.answered) {
      await this.edit(chatId, posted.messageId, `${summary}\n${TG_TEXT.answeredElsewhere}`)
    }
  }

  /* ------------------------------------------------------------ sending */

  /** Send text, split to Telegram's size, in order. One retry on a 429. */
  private async sendText(chatId: string, text: string): Promise<{ ok: true } | { ok: false; description: string }> {
    const api = this.api
    if (!api) return { ok: false, description: 'The bot is not running.' }
    this.remember(text)
    for (const chunk of splitForTelegram(text)) {
      let sent = await api.sendMessage(chatId, chunk)
      if (!sent.ok && sent.status === 429) {
        await this.sleep(Math.max(1, sent.retryAfter ?? 1) * 1000)
        sent = await api.sendMessage(chatId, chunk)
      }
      if (!sent.ok) {
        this.deps.log.warn(`send failed: ${sent.description}`)
        return { ok: false, description: sent.description }
      }
      this.noteSent()
    }
    return { ok: true }
  }

  private async edit(chatId: string, messageId: number, text: string): Promise<void> {
    const r = await this.api?.editMessageText(chatId, messageId, text)
    if (r && !r.ok) this.deps.log.warn(`edit failed: ${r.description}`)
  }

  private noteSent(): void {
    this.lastSentAt = this.now()
    this.changed()
  }

  private remember(text: string): void {
    const at = this.now()
    this.recentSent.push({ text: text.trim(), at })
    while (this.recentSent.length > 0 && at - this.recentSent[0].at > SAYS_DEDUPE_MS) this.recentSent.shift()
  }

  private sentRecently(text: string): boolean {
    const at = this.now()
    return this.recentSent.some((s) => s.text === text && at - s.at <= SAYS_DEDUPE_MS)
  }

  /* ------------------------------------------------------------ helpers */

  private chatId(): string {
    return (this.deps.settings.get().telegramChatId ?? '').trim()
  }

  private paired(): boolean {
    return Boolean(this.chatId())
  }

  private clearCode(): void {
    if (this.pairTimer) clearTimeout(this.pairTimer)
    this.pairTimer = null
    this.pairCode = null
    this.pairCodeExpiresAt = null
  }

  private statusLine(): string {
    const b = this.deps.brain.status()
    const state = b.enabled ? (BRAIN_STATE_WORDS[b.state] ?? b.state) : 'off'
    const error = b.state === 'error' && b.error ? ` (${b.error})` : ''
    const bot = this.botUsername ? `@${this.botUsername}` : 'unknown'
    return `Forge Brain: ${state}${error}. Queued: ${b.queued}. Engine: ${b.engine}. Bot: ${bot}.`
  }

  private notReadyReason(status: TelegramStatus): string {
    switch (status.state) {
      case 'off':
        return 'The Telegram bot is off.'
      case 'no-token':
        return 'No bot token yet. Paste the one from @BotFather.'
      case 'checking':
        return 'Still checking the bot token.'
      case 'pairing':
        return 'Not paired yet. Press Pair and send the code to the bot.'
      default:
        return status.error ?? 'The Telegram bot is not ready.'
    }
  }

  private changed(): void {
    const status = this.status()
    const key = JSON.stringify(status)
    if (key === this.lastEmitted) return
    this.lastEmitted = key
    for (const listener of this.listeners) {
      try {
        listener(status)
      } catch (err) {
        this.deps.log.warn(`status listener failed: ${errorText(err)}`)
      }
    }
  }
}
