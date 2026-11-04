import { SPEAK_CHUNK_MAX, takeSpeechChunks, voiceSpeaker, type VoiceConfig } from '@/lib/tts'

/**
 * Claude Live's mouth: one queue in front of src/lib/tts.ts `voiceSpeaker`.
 *
 * The voice brain's text arrives in pieces; `pushReply` cuts it into what can
 * already be said (`takeSpeechChunks`, the first chunk of a reply at a clause
 * so Kokoro starts on four words, not a sentence) and the drain says them in
 * order, asking for the next two ahead (`prefetch`) while one plays. An ack or
 * a news line goes through the same queue — one mouth, never two voices.
 *
 * Every sound plays through tts.ts's AudioContext, which is what lets the
 * mic's echo canceller hear it as the reference.
 *
 * `voiceSpeaker.speak` stops whatever was playing, so the drain is the only
 * caller while Live runs, one item at a time.
 */

export type MouthKind = 'reply' | 'ack' | 'news'

export interface MouthItem {
  kind: MouthKind
  text: string
  /** The turn a reply chunk or ack belongs to. */
  turnId?: string
  /** For a reply chunk: where it ends in the reply text, for the spoken-so-far caption. */
  endChar?: number
}

export interface MouthEvents {
  /** True from the first thing queued to the last thing said. */
  onBusy(busy: boolean): void
  /** An item's first sample is out (Date.now() ms). */
  onStart(item: MouthItem, at: number): void
  /** An item is over: said in full (`spoke`) or not. */
  onEnd(item: MouthItem, spoke: boolean): void
  /** A one-line notice from the voice chain (fell back to another voice). */
  onNotice(message: string): void
}

/** Reply chunks asked for ahead of the one playing (plan: 2-clause prefetch). */
const PREFETCH_AHEAD = 2

interface ReplyBuffer {
  rest: string
  /** Reply text so far, for `endChar`. */
  text: string
  /** Where the next chunk is looked for in `text`. */
  cursor: number
  chunks: number
}

export class LiveMouth {
  private readonly config: () => VoiceConfig
  private readonly events: MouthEvents
  private queue: MouthItem[] = []
  private current: MouthItem | null = null
  private started = false
  private draining = false
  private busy = false
  private readonly replies = new Map<string, ReplyBuffer>()
  private offSpeaker: (() => void) | null = null

  constructor(config: () => VoiceConfig, events: MouthEvents) {
    this.config = config
    this.events = events
    this.offSpeaker = voiceSpeaker.onChange((speaking) => {
      const item = this.current
      if (!speaking || !item || this.started) return
      this.started = true
      this.events.onStart(item, Date.now())
    })
  }

  /** Something queued or being said. */
  get active(): boolean {
    return this.busy
  }

  /** The item being said now, if any. */
  get saying(): MouthItem | null {
    return this.current
  }

  /** Is anything of this turn queued or playing? */
  holds(turnId: string): boolean {
    return this.current?.turnId === turnId || this.queue.some((q) => q.turnId === turnId)
  }

  /** A piece of the reply to `turnId`. */
  pushReply(turnId: string, delta: string): void {
    const buf = this.replies.get(turnId) ?? { rest: '', text: '', cursor: 0, chunks: 0 }
    buf.rest += delta
    buf.text += delta
    this.replies.set(turnId, buf)
    const { chunks, rest } = takeSpeechChunks(buf.rest, SPEAK_CHUNK_MAX, { firstClause: buf.chunks === 0 })
    buf.rest = rest
    for (const chunk of chunks) this.enqueueChunk(turnId, buf, chunk)
  }

  /** The reply to `turnId` is complete: say what is left of it. */
  endReply(turnId: string): void {
    const buf = this.replies.get(turnId)
    if (!buf) return
    const last = buf.rest.trim()
    buf.rest = ''
    if (last) this.enqueueChunk(turnId, buf, last)
    this.replies.delete(turnId)
  }

  /** An ack for `turnId`: ahead of its reply, and only while nothing is playing. */
  ack(turnId: string, line: string): boolean {
    if (this.current) return false
    this.queue.unshift({ kind: 'ack', text: line, turnId })
    this.drain()
    return true
  }

  /** A news line, after whatever is queued. */
  say(text: string): void {
    this.queue.push({ kind: 'news', text })
    this.drain()
  }

  /** Get quieter (barge-in's first move) or come back up (1). */
  duck(level: number): void {
    voiceSpeaker.duck(level)
  }

  /** Forget a turn: its queued chunks go, and if it is playing, it stops. */
  dropTurn(turnId: string): void {
    this.replies.delete(turnId)
    this.queue = this.queue.filter((q) => q.turnId !== turnId)
    if (this.current?.turnId === turnId) voiceSpeaker.cancel()
    this.settle()
  }

  /** Stop talking now and throw away everything not yet said. */
  cancel(): void {
    this.replies.clear()
    this.queue = []
    if (this.current) voiceSpeaker.cancel()
    this.settle()
  }

  dispose(): void {
    this.cancel()
    this.offSpeaker?.()
    this.offSpeaker = null
  }

  private enqueueChunk(turnId: string, buf: ReplyBuffer, chunk: string): void {
    const at = buf.text.indexOf(chunk, buf.cursor)
    const endChar = at >= 0 ? at + chunk.length : buf.text.length - buf.rest.length
    buf.cursor = Math.max(buf.cursor, endChar)
    buf.chunks += 1
    this.queue.push({ kind: 'reply', text: chunk, turnId, endChar })
    this.drain()
  }

  private setBusy(next: boolean): void {
    if (next === this.busy) return
    this.busy = next
    this.events.onBusy(next)
  }

  private settle(): void {
    if (!this.current && !this.queue.length && !this.draining) this.setBusy(false)
  }

  private prefetchAhead(): void {
    const config = this.config()
    if (!config.kokoroVoice) return
    for (const item of this.queue.slice(0, PREFETCH_AHEAD)) voiceSpeaker.prefetch(item.text, config)
  }

  private drain(): void {
    if (this.draining) return
    if (!this.queue.length) return this.settle()
    this.draining = true
    this.setBusy(true)
    void (async () => {
      try {
        for (let item = this.queue.shift(); item; item = this.queue.shift()) {
          this.current = item
          this.started = false
          this.prefetchAhead()
          let spoke = false
          try {
            const result = await voiceSpeaker.speak(item.text, this.config(), (msg) => this.events.onNotice(msg))
            spoke = result.spoke
          } catch {
            spoke = false
          }
          // A clip that played without a speaking edge (cached, instant) still started.
          if (spoke && !this.started) {
            this.started = true
            this.events.onStart(item, Date.now())
          }
          this.current = null
          this.events.onEnd(item, spoke)
        }
      } finally {
        this.current = null
        this.draining = false
        if (this.queue.length) this.drain()
        else this.setBusy(false)
      }
    })()
  }
}
