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
 * "Microsoft Sonia Natural", and so on. Anything matching is worth having over
 * the legacy David/Zira pair.
 */
const NATURAL = /natural|neural|aria|jenny|sonia|ryan|libby|guy|michelle/i

/** British first, then any English, then whatever there is. */
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
    if (NATURAL.test(v.name)) score += 4
    if (/^en-GB/i.test(v.lang ?? '')) score += 2
    if (v.default) score += 1
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

  async speak(text: string, options: SpeakOptions = {}): Promise<boolean> {
    const body = speakable(text)
    if (!body || !this.available) return false
    this.cancel()

    const utterance = new SpeechSynthesisUtterance(body)
    const voice = chooseVoice(this.voices(), options.voiceName ?? '')
    if (voice) utterance.voice = voice as SpeechSynthesisVoice
    utterance.rate = options.rate ?? 1.05
    this.current = utterance
    this.announce(true)

    return new Promise<boolean>((resolve) => {
      let done = false
      const finish = (spoke: boolean): void => {
        if (done) return
        done = true
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
