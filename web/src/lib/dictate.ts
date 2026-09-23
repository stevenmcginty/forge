import {
  MAX_DICTATION_BYTES,
  MAX_FILE_CHUNK_BYTES,
  WEB_FEATURE_DICTATE_STREAM,
  type WebRequest,
  type WebResult
} from '@shared/web'
import { desktopHas } from './client'
import { bufferToBase64 } from './file'

/**
 * Dictation from this browser's microphone, transcribed on the desktop.
 *
 * The phone is the microphone and the desktop is the ear: the browser only
 * records (MediaRecorder, whatever container this browser produces) and ships
 * the bytes down the socket in `dictate` chunks; the desktop asks its own
 * speech-to-text provider and answers with words. No audio API of the
 * browser's own is asked to understand speech — the Web Speech API was, and
 * it went silent on Android as often as it worked.
 *
 * One recording at a time. `start` opens the microphone (the browser asks
 * permission the first time), `stop` closes it and resolves to the words.
 *
 * ## Streamed, when the desktop can take it
 *
 * On a desktop that announces `dictate-stream`, and when the caller names the
 * pane, each MediaRecorder slice goes down the socket *while* Steve is still
 * talking (`start`, then `append` per slice, in order), so stopping leaves only
 * a `done` and the one transcription. The whole recording is still kept here
 * as a Blob, and any trouble with the stream (a refused slice, a dropped link,
 * a `failed`/`limit` answer) falls back to sending that Blob the old way, N of
 * M `dictate` chunks, which every desktop takes. A recording that is cancelled
 * — or stopped and then never handed to `transcribeOnDesktop`, which is what
 * the silence check does — is `cancel`led on the desktop and never transcribed.
 */

/** A recording longer than this is stopped and sent anyway. */
export const MAX_RECORDING_MS = 10 * 60 * 1000

/** How long `stop` waits for the browser's last chunk before taking what it has. */
const STOP_GRACE_MS = 2500

const CONTAINERS = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus', 'audio/ogg']

export function isDictationSupported(): boolean {
  return (
    typeof navigator !== 'undefined' &&
    !!navigator.mediaDevices?.getUserMedia &&
    typeof MediaRecorder !== 'undefined'
  )
}

function pickContainer(): string {
  for (const mime of CONTAINERS) {
    try {
      if (MediaRecorder.isTypeSupported(mime)) return mime
    } catch {
      // an older browser without isTypeSupported: let the recorder choose
    }
  }
  return ''
}

/** How a recording is being held: toggled by a tap, or held down like a walkie-talkie. */
export type VoiceMode = 'tap' | 'hold'

/**
 * Where one dictation is, for whoever draws it. Times are `Date.now()` values.
 *
 * idle → recording → transcribing → review → (sent) idle. A spoken command
 * ("stop", "yes") goes transcribing → idle, skipping review. Cancel leaves
 * recording or transcribing for idle with nothing sent; Undo leaves review for
 * idle with the words kept in the box.
 */
export type VoiceState =
  | { phase: 'idle' }
  /** The microphone is open. `mode` flips to `'hold'` once a press outlasts a tap. */
  | { phase: 'recording'; mode: VoiceMode; startedAt: number }
  /** The audio is on its way to the desktop, and the words on their way back. */
  | { phase: 'transcribing'; startedAt: number }
  /** The words are in the box and send at `endsAt` unless undone. */
  | { phase: 'review'; text: string; endsAt: number }

/** Where a streamed recording goes. Absent → record only, and upload on stop as before. */
export interface DictationTarget {
  /** The pane the words are for (the desktop checks it exists). */
  sessionId: string
  request: (body: WebRequest) => Promise<WebResult>
}

/** How long after `stop` resolves a recording may wait to be handed over before it is cancelled. */
const CLAIM_MS = 400

/**
 * One recording's stream to the desktop. Slices go out one at a time, in
 * order — a chain rather than a burst, which is all the backpressure a 1 s
 * timeslice needs, and keeps well inside the desktop's per-second budget.
 */
class Stream {
  readonly dictationId: string
  private readonly request: DictationTarget['request']
  private chain: Promise<void>
  /** Slices handed to the chain so far — the `chunks` a `done` will claim. */
  private sent = 0
  /** Anything went wrong: `done` is not sent, and the Blob goes the old way. */
  private broken = false
  private ended = false
  /** Thrown away on purpose: no `done`, and no fallback upload either. */
  private cancelled = false

  constructor(target: DictationTarget, mime: string) {
    this.dictationId =
      typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
        ? crypto.randomUUID()
        : `d_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`
    this.request = target.request
    this.chain = this.request({
      kind: 'dictate-stream',
      op: 'start',
      dictationId: this.dictationId,
      sessionId: target.sessionId,
      mime
    }).then((result) => {
      if (result.kind !== 'ok') this.broken = true
    })
  }

  append(slice: Blob): void {
    if (this.broken || this.ended) return
    // A slice the desktop would refuse on size alone is not worth sending.
    if (slice.size > MAX_FILE_CHUNK_BYTES) {
      this.broken = true
      return
    }
    const seq = this.sent++
    this.chain = this.chain.then(async () => {
      if (this.broken) return
      const data = bufferToBase64(await slice.arrayBuffer())
      const result = await this.request({ kind: 'dictate-stream', op: 'append', dictationId: this.dictationId, seq, data })
      if (result.kind !== 'ok') this.broken = true
    })
  }

  /**
   * The words, or null when the stream cannot give them and the caller should
   * send the whole recording the old way (the desktop has dropped it already,
   * or is told to here).
   */
  async finish(): Promise<string | null> {
    this.ended = true
    await this.chain
    if (this.cancelled) return ''
    if (this.broken || this.sent === 0) {
      this.cancel()
      return null
    }
    const result = await this.request({ kind: 'dictate-stream', op: 'done', dictationId: this.dictationId, chunks: this.sent })
    if (result.kind === 'dictation') return result.text.trim()
    // `done` forgets the recording whatever it answers: nothing left to cancel.
    return null
  }

  cancel(): void {
    if (this.cancelled) return
    this.cancelled = true
    this.ended = true
    this.broken = true
    void this.chain.then(() => this.request({ kind: 'dictate-stream', op: 'cancel', dictationId: this.dictationId }))
  }
}

/** Each stopped recording's stream, until `transcribeOnDesktop` claims it or it is cancelled. */
const streams = new WeakMap<Blob, Stream>()

export interface Recording {
  /** The open microphone, for a meter to listen to while it records. */
  stream: MediaStream
  /** Stop the microphone and hand back what it heard. Empty when nothing was said. */
  stop: () => Promise<Blob>
  /** Throw the recording away without transcribing it. */
  cancel: () => void
}

/**
 * Open the microphone and start recording. Rejects when the browser refuses the mic.
 *
 * `target` streams the recording to the desktop as it is made, when the
 * desktop announces `dictate-stream`; without it (or on an older desktop) the
 * recording is only kept here and uploaded by `transcribeOnDesktop`.
 */
export async function startRecording(onAutoStop?: () => void, target?: DictationTarget): Promise<Recording> {
  if (!isDictationSupported()) throw new Error('This browser cannot record from a microphone.')
  let stream: MediaStream
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, channelCount: 1 }
    })
  } catch (err) {
    const name = err instanceof Error ? err.name : ''
    if (name === 'NotAllowedError' || name === 'SecurityError') {
      throw new Error('Microphone access was blocked. Allow the microphone for this site and try again.')
    }
    if (name === 'NotFoundError') throw new Error('No microphone was found on this device.')
    throw new Error(err instanceof Error ? err.message : 'Could not open the microphone.')
  }

  const container = pickContainer()
  const recorder = container ? new MediaRecorder(stream, { mimeType: container }) : new MediaRecorder(stream)
  const parts: Blob[] = []
  const upstream =
    target && target.sessionId && desktopHas(WEB_FEATURE_DICTATE_STREAM)
      ? new Stream(target, recorder.mimeType || container || 'audio/webm')
      : null
  /** Set when `stop` settles: a slice after that is in neither the Blob nor the stream. */
  let sealed = false
  recorder.ondataavailable = (event: BlobEvent) => {
    if (sealed || !event.data || event.data.size === 0) return
    parts.push(event.data)
    upstream?.append(event.data)
  }
  const release = (): void => {
    for (const track of stream.getTracks()) track.stop()
  }
  let done: Promise<Blob> | null = null
  const finish = (): Promise<Blob> => {
    if (done) return done
    done = new Promise<Blob>((resolve) => {
      let settled = false
      const settle = (): void => {
        if (settled) return
        settled = true
        window.clearTimeout(fallback)
        release()
        sealed = true
        const blob = new Blob(parts, { type: recorder.mimeType || container || 'audio/webm' })
        if (upstream) {
          streams.set(blob, upstream)
          // A caller that wants the words hands the Blob to `transcribeOnDesktop`
          // straight away; one that does not (nothing said, the silence check)
          // leaves it here, and the desktop is told to drop it.
          window.setTimeout(() => {
            if (streams.get(blob) !== upstream) return
            streams.delete(blob)
            upstream.cancel()
          }, CLAIM_MS)
        }
        resolve(blob)
      }
      // A browser that never fires `stop` (Safari has been seen to, with an
      // empty recording) would leave the button lit for ever: settle with
      // whatever arrived instead.
      const fallback = window.setTimeout(settle, STOP_GRACE_MS)
      recorder.onstop = settle
      recorder.onerror = settle
      if (recorder.state === 'inactive') {
        settle()
        return
      }
      try {
        recorder.stop()
      } catch {
        settle()
      }
    })
    return done
  }
  const limiter = window.setTimeout(() => {
    if (recorder.state !== 'inactive') {
      void finish()
      onAutoStop?.()
    }
  }, MAX_RECORDING_MS)
  recorder.start(1000)
  return {
    stream,
    stop: () => {
      window.clearTimeout(limiter)
      return finish()
    },
    cancel: () => {
      window.clearTimeout(limiter)
      recorder.ondataavailable = null
      parts.length = 0
      sealed = true
      upstream?.cancel()
      try {
        if (recorder.state !== 'inactive') recorder.stop()
      } catch {
        // already stopped
      }
      release()
    }
  }
}

/**
 * Ship a recording to the desktop in `dictate` chunks and resolve to the
 * words it heard. Throws with the desktop's own message when it could not.
 */
export async function transcribeOnDesktop(
  audio: Blob,
  sessionId: string,
  request: (body: WebRequest) => Promise<WebResult>
): Promise<string> {
  const stream = streams.get(audio)
  streams.delete(audio)
  if (audio.size === 0) {
    stream?.cancel()
    return ''
  }
  if (audio.size > MAX_DICTATION_BYTES) {
    stream?.cancel()
    throw new Error('That recording is too long to send.')
  }
  if (stream) {
    const heard = await stream.finish()
    if (heard !== null) return heard
    // The stream could not give the words: the whole recording, the old way.
  }
  const uploadId = `d_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
  const totalChunks = Math.max(1, Math.ceil(audio.size / MAX_FILE_CHUNK_BYTES))
  const mime = audio.type || 'audio/webm'
  for (let index = 0; index < totalChunks; index++) {
    const start = index * MAX_FILE_CHUNK_BYTES
    const slice = audio.slice(start, Math.min(start + MAX_FILE_CHUNK_BYTES, audio.size))
    const data = bufferToBase64(await slice.arrayBuffer())
    const result = await request({ kind: 'dictate', uploadId, sessionId, mime, index, totalChunks, data })
    if (result.kind === 'failed') throw new Error(result.message || 'The desktop could not hear that.')
    if (result.kind === 'dictation') return result.text.trim()
  }
  throw new Error('The desktop did not answer with words.')
}
