/**
 * The agent's voice.
 *
 * Chromium ships `speechSynthesis`, and on Windows it exposes every SAPI voice
 * the machine has — including the "Natural" neural ones, which are the only
 * ones that do not sound like a 1998 satnav. So v1 of talking back needs no
 * model, no key and no network: pick the best installed voice and speak.
 *
 * Two things here are not decoration:
 *
 *  1. `chooseVoice` is pure and exported so it can be tested without a browser.
 *     Voice availability differs on every machine, and "it picked something
 *     robotic" is a bug you cannot debug by hand.
 *  2. `speaker` promises to tell you when it has *stopped*. Forge listens with
 *     a real microphone a foot from the speakers; if the mic were open while
 *     the agent talked, it would transcribe itself and answer itself, forever.
 *     Everything about the loop in VoicePanel hangs off `speak()` resolving.
 */

/** Just enough of SpeechSynthesisVoice to choose between voices in a test. */
export interface VoiceLike {
  name: string
  lang: string
  localService?: boolean
  default?: boolean
}

/**
 * Windows names its neural voices "Microsoft Aria Online (Natural) - English",
 * "Microsoft Sonia Natural", and so on. Worth several of anything else.
 */
const NATURAL = /natural|neural/i

/**
 * The legacy SAPI voices, split by which ones are bearable.
 *
 * This is not tidy and it should not be: `SpeechSynthesisVoice` carries no
 * gender, no quality and no rating, so the only signal available is the name.
 * Measured on Steve's machine, Chromium exposes exactly three — George, Hazel
 * and Susan — and Windows marks **George as the default**, which is how the
 * first thing he heard was the robotic male voice he called "awful". So
 * `default` is worth nothing here, and the male legacy voices are pushed below
 * everything else rather than merely not preferred.
 */
const GOOD_VOICES = /\b(aria|jenny|sonia|libby|michelle|zira|hazel|susan|catherine|linda|eva|clara)\b/i
const ROBOTIC_MALE = /\b(david|mark|george|guy|ryan|richard|ravi|james|william)\b/i

/**
 * Pick a voice: an explicit choice, else the best-sounding English one.
 *
 * Ranking, highest first — neural, then a known-good (female) legacy voice,
 * then British, and a hard penalty for the male legacy voices.
 */
export function chooseVoice(voices: VoiceLike[], preferred = ''): VoiceLike | null {
  const all = voices ?? []
  if (all.length === 0) return null

  const wanted = preferred.trim()
  if (wanted) {
    const exact = all.find((v) => v.name === wanted)
    if (exact) return exact
  }

  const english = all.filter((v) => /^en\b|^en[-_]/i.test(v.lang ?? ''))
  const pool = english.length ? english : all
  const rank = (v: VoiceLike): number => {
    let score = 0
    if (NATURAL.test(v.name)) score += 8
    if (GOOD_VOICES.test(v.name)) score += 4
    if (ROBOTIC_MALE.test(v.name)) score -= 6
    if (/^en-GB/i.test(v.lang ?? '')) score += 2
    return score
  }
  // Stable: equal scores keep the platform's own order.
  return [...pool].map((v, i) => ({ v, i })).sort((a, b) => rank(b.v) - rank(a.v) || a.i - b.i)[0]!.v
}

/**
 * Strip a reply down to something worth hearing.
 *
 * A drafted prompt is a page of markdown and reading it aloud would take a
 * minute and tell Steve nothing. The brain is instructed to keep `say`
 * speakable, but instructions are not guarantees, so anything that has clearly
 * turned into a document is cut off rather than recited.
 */
export function speakable(text: string, limit = 340): string {
  let out = (text ?? '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/^#{1,6}\s*/gm, '')
    .replace(/^[-*]\s+/gm, '')
    .replace(/\*\*?([^*]+)\*\*?/g, '$1')
    .replace(/https?:\/\/\S+/g, 'a link')
    .replace(/\s+/g, ' ')
    .trim()
  if (out.length <= limit) return out
  out = out.slice(0, limit)
  const stop = Math.max(out.lastIndexOf('. '), out.lastIndexOf('! '), out.lastIndexOf('? '))
  return (stop > 80 ? out.slice(0, stop + 1) : out).trim()
}

export interface SpeakOptions {
  voiceName?: string
  rate?: number
}

/**
 * One mouth for the whole app.
 *
 * `speak` resolves when the utterance has finished, been cancelled, or failed —
 * never hangs, because the microphone is waiting on it. Chromium sometimes
 * drops `onend` on a cancelled utterance, hence the belt-and-braces timeout
 * sized from the length of the text.
 */
class Speaker {
  private current: SpeechSynthesisUtterance | null = null
  private listeners = new Set<(speaking: boolean) => void>()
  /**
   * Turns already spoken.
   *
   * Steve's words: "he keeps going on and on, over and over again". A React
   * component re-renders for any number of reasons, and anything that speaks
   * from a render path can speak twice. So a turn is a *key*, and a key is
   * spoken exactly once for the life of the app — belt over the braces of
   * calling `speak` from one place per turn. Bounded so a long session cannot
   * grow it forever.
   */
  private spoken = new Set<string>()
  /** How many utterances are queued. Must never exceed one. */
  private queued = 0

  get available(): boolean {
    return typeof window !== 'undefined' && 'speechSynthesis' in window
  }

  get speaking(): boolean {
    return this.current !== null
  }

  onChange(cb: (speaking: boolean) => void): () => void {
    this.listeners.add(cb)
    return () => {
      this.listeners.delete(cb)
    }
  }

  voices(): VoiceLike[] {
    if (!this.available) return []
    return window.speechSynthesis.getVoices()
  }

  cancel(): void {
    if (!this.available) return
    window.speechSynthesis.cancel()
    this.settle()
  }

  /** How many utterances are in flight — 0 or 1, and a test asserts it. */
  get pending(): number {
    return this.queued
  }

  /**
   * Say something once, keyed by a turn id.
   *
   * Returns false without a sound if that key has already been spoken. Every
   * caller in the app goes through here rather than `speak`, so a re-render
   * cannot say the same sentence twice.
   */
  async speakOnce(key: string, text: string, options: SpeakOptions = {}): Promise<boolean> {
    if (this.spoken.has(key)) return false
    this.spoken.add(key)
    if (this.spoken.size > 400) {
      // Oldest first — Sets iterate in insertion order.
      const oldest = this.spoken.values().next().value
      if (oldest !== undefined) this.spoken.delete(oldest)
    }
    return this.speak(text, options)
  }

  /** Only for the settings page's sample line. Turns use `speakOnce`. */
  async speak(text: string, options: SpeakOptions = {}): Promise<boolean> {
    const body = speakable(text)
    if (!body || !this.available) return false
    // Cancel whatever was talking before queueing: the queue is never a queue.
    this.cancel()

    const utterance = new SpeechSynthesisUtterance(body)
    const voice = chooseVoice(this.voices(), options.voiceName ?? '')
    if (voice) utterance.voice = voice as SpeechSynthesisVoice
    utterance.rate = options.rate ?? 1.05
    this.current = utterance
    this.announce(true)

    this.queued += 1
    return new Promise<boolean>((resolve) => {
      let done = false
      const finish = (spoke: boolean): void => {
        if (done) return
        done = true
        this.queued = Math.max(0, this.queued - 1)
        window.clearTimeout(guard)
        this.settle()
        resolve(spoke)
      }
      // Roughly 14 characters a second, plus headroom. Only ever a backstop.
      const guard = window.setTimeout(() => finish(true), 4000 + body.length * 90)
      utterance.onend = () => finish(true)
      utterance.onerror = () => finish(false)
      window.speechSynthesis.speak(utterance)
    })
  }

  private settle(): void {
    if (!this.current) return
    this.current = null
    this.announce(false)
  }

  private announce(speaking: boolean): void {
    for (const cb of [...this.listeners]) cb(speaking)
  }
}

export const speaker = new Speaker()
