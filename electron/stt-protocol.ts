import type { SttError, SttErrorKind, SttStatus } from '@shared/types'

/**
 * The decision-making half of the dictation host, kept free of Electron and of
 * child processes so it can be reasoned about — and tested — on its own.
 * `stt-sidecar.ts` owns the process and the socket; this owns what the answers
 * mean.
 *
 * Only `import type` is used above, so this module runs unmodified under Node's
 * type stripping (see scripts/stt-manager-test.mjs).
 */

/** Restarts inside this window count as "rapid". */
export const RAPID_WINDOW_MS = 60_000
export const MAX_RAPID_RESTARTS = 3

export const OFF_STATUS: SttStatus = { phase: 'off', level: 0, error: null, ready: false }

/**
 * Errors worth another go on the next keypress, as opposed to ones the user has
 * to fix something about. A busy microphone is bad luck; a missing model is a
 * missing model.
 */
export function isTransientSttError(kind: SttErrorKind): boolean {
  return kind === 'audio' || kind === 'internal' || kind === 'not-ready'
}

export function sttStatusEqual(a: SttStatus, b: SttStatus): boolean {
  return (
    a.phase === b.phase &&
    a.level === b.level &&
    a.ready === b.ready &&
    a.error?.kind === b.error?.kind &&
    a.error?.msg === b.error?.msg
  )
}

/**
 * A bare name like `python.exe` is resolved off PATH by the OS, so we can only
 * pre-judge something spelled as a path. Anything else gets the benefit of the
 * doubt and fails later with ENOENT, which lands in the same error anyway.
 */
export function pythonLooksMissing(exe: string, exists: (p: string) => boolean): boolean {
  if (!exe || !exe.trim()) return true
  if (!/[\\/]/.test(exe)) return false
  return !exists(exe)
}

/**
 * Three crashes in a minute is a broken install, not bad luck. Restarting past
 * that just grinds the machine, so the budget says when to stop.
 */
export class RestartBudget {
  private hits: number[] = []
  private windowMs: number
  private max: number

  constructor(windowMs: number = RAPID_WINDOW_MS, max: number = MAX_RAPID_RESTARTS) {
    this.windowMs = windowMs
    this.max = max
  }

  /** Record an unexpected exit. Returns false when we should stop restarting. */
  record(now: number = Date.now()): boolean {
    this.hits = this.hits.filter((t) => now - t < this.windowMs)
    this.hits.push(now)
    return this.hits.length <= this.max
  }

  /** A successful model load means whatever was wrong is fixed. */
  clear(): void {
    this.hits = []
  }

  get count(): number {
    return this.hits.length
  }
}

export interface SttReduction {
  status: SttStatus
  /** Text to forward to the renderer, if this event was a phrase. */
  phrase?: string
  /** The model just finished loading — flush any queued start. */
  becameReady?: boolean
}

/**
 * Fold one sidecar event into the status the renderer sees. Unknown events are
 * ignored rather than treated as errors: the sidecar is allowed to grow new
 * ones without this side needing a release.
 */
export function reduceSttEvent(status: SttStatus, msg: Record<string, unknown>): SttReduction {
  switch (msg['evt']) {
    case 'ready':
      return {
        status: {
          ...status,
          ready: true,
          error: null,
          phase: status.phase === 'listening' ? 'listening' : 'idle'
        },
        becameReady: true
      }

    case 'state': {
      const v = String(msg['v'] ?? '')
      if (v !== 'idle' && v !== 'listening' && v !== 'finishing') return { status }
      // The sidecar greets a new connection with its state, and that state is
      // "idle" for the several seconds it spends loading the model. Taking it at
      // face value would have the pill claim it was ready to listen before it
      // was — so until `ready` lands, idle still means starting.
      if (v === 'idle' && !status.ready) {
        return { status: { ...status, phase: 'starting', level: 0 } }
      }
      return { status: { ...status, phase: v, level: v === 'listening' ? status.level : 0 } }
    }

    case 'level': {
      const rms = Number(msg['rms'])
      if (!Number.isFinite(rms)) return { status }
      return { status: { ...status, level: Math.min(1, Math.max(0, rms)) } }
    }

    case 'phrase': {
      const text = String(msg['text'] ?? '').trim()
      return text ? { status, phrase: text } : { status }
    }

    case 'error': {
      const kind = String(msg['kind'] ?? 'internal') as SttErrorKind
      const error: SttError = { kind, msg: String(msg['msg'] ?? 'Dictation failed') }
      const transient = isTransientSttError(kind)
      return {
        status: {
          ...status,
          error,
          // Transient trouble leaves the sidecar usable, so the next keypress
          // can just try again; anything else is a dead end until it is fixed.
          phase: transient ? (status.ready ? 'idle' : status.phase) : 'error',
          level: 0
        }
      }
    }

    default:
      return { status }
  }
}
