import { MAX_DICTATION_BYTES, MAX_FILE_CHUNK_BYTES, type WebRequest, type WebResult } from '@shared/web'
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
 */

/** A recording longer than this is stopped and sent anyway. */
export const MAX_RECORDING_MS = 3 * 60 * 1000

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

export interface Recording {
  /** Stop the microphone and hand back what it heard. Empty when nothing was said. */
  stop: () => Promise<Blob>
  /** Throw the recording away without transcribing it. */
  cancel: () => void
}

/** Open the microphone and start recording. Rejects when the browser refuses the mic. */
export async function startRecording(onAutoStop?: () => void): Promise<Recording> {
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
  recorder.ondataavailable = (event: BlobEvent) => {
    if (event.data && event.data.size > 0) parts.push(event.data)
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
        resolve(new Blob(parts, { type: recorder.mimeType || container || 'audio/webm' }))
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
    stop: () => {
      window.clearTimeout(limiter)
      return finish()
    },
    cancel: () => {
      window.clearTimeout(limiter)
      recorder.ondataavailable = null
      parts.length = 0
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
  if (audio.size === 0) return ''
  if (audio.size > MAX_DICTATION_BYTES) throw new Error('That recording is too long to send.')
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
