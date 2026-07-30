/**
 * Where the voice agent's words come from.
 *
 * A `TranscriptSource` is anything that emits finished phrases. Today there is
 * exactly one — the panel's text box, i.e. "type what you'd say…". Tomorrow
 * dictation (M3) is a second one, and the voice panel must not have to change
 * to accept it. So nothing subscribes to a source directly: sources register
 * with `transcriptBus`, and the panel listens to the bus.
 *
 * Merging dictation is therefore a one-liner wherever the dictation engine is
 * started:
 *
 *     import { transcriptBus } from '@/lib/transcriptSource'
 *     transcriptBus.register(dictationSource)   // returns an unregister fn
 *
 * where `dictationSource` is any object with `onPhrase(cb) => unsubscribe`.
 */

export interface TranscriptSource {
  /** Subscribe to finished phrases. Returns an unsubscribe function. */
  onPhrase(cb: (text: string) => void): () => void
}

/** A source you also push into — used by the panel's text box. */
export interface PushableTranscriptSource extends TranscriptSource {
  push(text: string): void
}

/** Blank phrases are never worth a turn. */
function clean(text: string): string {
  return text.replace(/\s+$/g, '').replace(/^\s+/g, '')
}

export function createPushSource(): PushableTranscriptSource {
  const listeners = new Set<(text: string) => void>()
  return {
    onPhrase(cb) {
      listeners.add(cb)
      return () => {
        listeners.delete(cb)
      }
    },
    push(text) {
      const phrase = clean(text)
      if (!phrase) return
      for (const cb of [...listeners]) cb(phrase)
    }
  }
}

/** Phrases held for a listener that has not attached yet. */
const PENDING_LIMIT = 8

/**
 * Fan-in for every source. Itself a `TranscriptSource`, so a bus can be handed
 * to anything that takes one.
 *
 * One deliberate wrinkle: a phrase that arrives while *nothing* is listening is
 * kept and handed to the first listener that attaches. Without that, a phrase
 * spoken in the instant before the panel wires itself up would vanish, and a
 * swallowed first utterance is the worst possible first impression. Once there
 * is a listener nothing is buffered, so there is no replay to reason about.
 */
class TranscriptBus implements TranscriptSource {
  private readonly listeners = new Set<(text: string) => void>()
  private readonly sources = new Map<TranscriptSource, () => void>()
  private pending: string[] = []

  register(source: TranscriptSource): () => void {
    if (this.sources.has(source)) return () => this.unregister(source)
    const off = source.onPhrase((text) => this.emit(text))
    this.sources.set(source, off)
    return () => this.unregister(source)
  }

  unregister(source: TranscriptSource): void {
    const off = this.sources.get(source)
    if (!off) return
    this.sources.delete(source)
    off()
  }

  /** How many sources are feeding the panel — shown nowhere yet, handy in tests. */
  sourceCount(): number {
    return this.sources.size
  }

  onPhrase(cb: (text: string) => void): () => void {
    const first = this.listeners.size === 0
    this.listeners.add(cb)
    if (first && this.pending.length > 0) {
      const held = this.pending
      this.pending = []
      for (const phrase of held) cb(phrase)
    }
    return () => {
      this.listeners.delete(cb)
    }
  }

  /** Anything said before a listener attached, still waiting. */
  pendingCount(): number {
    return this.pending.length
  }

  private emit(text: string): void {
    const phrase = clean(text)
    if (!phrase) return
    if (this.listeners.size === 0) {
      this.pending.push(phrase)
      if (this.pending.length > PENDING_LIMIT) this.pending.shift()
      return
    }
    for (const cb of [...this.listeners]) cb(phrase)
  }
}

export const transcriptBus = new TranscriptBus()

/** The panel's text box. Registered eagerly so the panel can mount whenever. */
export const typedTranscript = createPushSource()
transcriptBus.register(typedTranscript)
