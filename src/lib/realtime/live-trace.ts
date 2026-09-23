/**
 * Dev-only evidence for a Gemini Live session that "does nothing".
 *
 * Each line goes to the console as `[realtime] …`. In dev, main copies the
 * renderer's warnings into %APPDATA%\<profile>\dev.log (electron/renderer-log.ts,
 * which also masks anything key- or token-shaped), so these are written at
 * warn level: the main process that is already running keeps them, and no
 * restart is needed to see them.
 *
 * Nothing here carries a key, a token, audio, or what was said — only counts,
 * levels, rates, states and message type names. Counters are summed and
 * printed every two seconds for the first half-minute of a session, then
 * every ten, so a day-long session does not flood the log.
 * In a packaged build every call is a no-op.
 */

const DEV = (() => {
  try {
    return Boolean(import.meta.env?.DEV)
  } catch {
    return false
  }
})()

const FLUSH_MS = 2000

type Sink = (line: string) => void
let sink: Sink = (line) => console.warn(line)
let forced = false

/** For scripts/gemini-live-check.mjs: capture the lines instead of printing them. */
export function setLiveTraceSink(next: Sink | null, force = false): void {
  sink = next ?? ((line) => console.warn(line))
  forced = force
}

function on(): boolean {
  return DEV || forced
}

export function liveTrace(text: string): void {
  if (on()) sink(`[realtime] ${text}`)
}

/** Sums per-second activity and prints one line per flush window. */
export class LiveTraceCounters {
  private sent = 0
  private sentBytes = 0
  private chunks = 0
  private dropped: Record<string, number> = {}
  private rmsSum = 0
  private rmsMax = 0
  private rmsN = 0
  private types: Record<string, number> = {}
  private seenTypes = new Set<string>()
  private audioIn = 0
  private audioInBytes = 0
  private windowStart = 0
  private timer: ReturnType<typeof setInterval> | null = null
  private ticks = 0
  private extra: () => string

  constructor(extra: () => string = () => '') {
    this.extra = extra
  }

  start(): void {
    if (!on() || this.timer) return
    this.windowStart = Date.now()
    this.ticks = 0
    this.timer = setInterval(() => {
      this.ticks++
      if (this.ticks <= 15 || this.ticks % 5 === 0) this.flush()
    }, FLUSH_MS)
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    this.flush()
  }

  /** One worklet chunk arrived; `sent` false with a reason when it was not sent. */
  mic(level: number, bytes: number, sent: boolean, why?: string): void {
    if (!on()) return
    this.chunks++
    this.rmsSum += level
    this.rmsN++
    if (level > this.rmsMax) this.rmsMax = level
    if (sent) {
      this.sent++
      this.sentBytes += bytes
    } else {
      const k = why ?? 'unknown'
      this.dropped[k] = (this.dropped[k] ?? 0) + 1
    }
  }

  /** One server message; its type names (first time each is seen prints at once). */
  server(names: string[]): void {
    if (!on()) return
    for (const n of names) {
      this.types[n] = (this.types[n] ?? 0) + 1
      if (!this.seenTypes.has(n)) {
        this.seenTypes.add(n)
        liveTrace(`first server message of type ${n}`)
      }
    }
  }

  audioChunk(bytes: number): void {
    if (!on()) return
    this.audioIn++
    this.audioInBytes += bytes
  }

  flush(): void {
    if (!on()) return
    const now = Date.now()
    const secs = Math.max(0.001, (now - this.windowStart) / 1000)
    this.windowStart = now
    const parts: string[] = []
    // The mic part always prints while a session runs: zero chunks is evidence too.
    {
      const drops = Object.entries(this.dropped)
        .map(([k, v]) => `${k}:${v}`)
        .join(',')
      parts.push(
        `mic chunks=${this.chunks} sent=${this.sent} (${(this.sent / secs).toFixed(1)}/s, ${Math.round(this.sentBytes / 2 / secs)} samples/s)` +
          ` rms avg=${(this.rmsSum / Math.max(1, this.rmsN)).toFixed(4)} max=${this.rmsMax.toFixed(4)}` +
          (drops ? ` dropped=${drops}` : '')
      )
    }
    const types = Object.entries(this.types)
    if (types.length) parts.push(`server ${types.map(([k, v]) => `${k}=${v}`).join(' ')}`)
    if (this.audioIn) parts.push(`audio in chunks=${this.audioIn} bytes=${this.audioInBytes}`)
    const extra = this.extra()
    liveTrace(`${parts.join(' | ')}${extra ? ` | ${extra}` : ''}`)
    this.sent = 0
    this.sentBytes = 0
    this.chunks = 0
    this.dropped = {}
    this.rmsSum = 0
    this.rmsMax = 0
    this.rmsN = 0
    this.types = {}
    this.audioIn = 0
    this.audioInBytes = 0
  }
}

/** The type names of one Live server message, for the trace. */
export function serverMessageTypes(msg: Record<string, unknown>): string[] {
  const out: string[] = []
  for (const [k, v] of Object.entries(msg)) {
    if (k === 'serverContent' && v && typeof v === 'object') {
      const sc = v as Record<string, unknown>
      const inner = Object.keys(sc).filter((x) => sc[x] !== undefined && sc[x] !== false)
      if (!inner.length) out.push('serverContent')
      for (const x of inner) out.push(x === 'modelTurn' ? 'modelTurn' : `serverContent.${x}`)
    } else {
      out.push(k)
    }
  }
  return out
}
