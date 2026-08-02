import { createHash, randomBytes } from 'node:crypto'
import WebSocket from 'ws'
import { DEFAULT_EDGE_VOICE, isEdgeVoice } from '@shared/tts'
import type { TtsErrorKind } from './gemini-tts'

/**
 * Microsoft Edge's neural voices, over the endpoint Edge's own Read Aloud uses.
 *
 * Why this exists: the agent's neural voice was Gemini TTS, and on a free AI
 * Studio key that model 429s after roughly six sentences a minute. Every
 * sentence past the quota silently fell back to Windows SAPI — so a streamed
 * reply, spoken sentence by sentence, would open in a warm female voice and
 * finish in a 1998 robot. Steve heard exactly that ("it keeps swapping
 * voices"). This engine is the fix, because it is free the way SAPI is free
 * and sounds the way Gemini sounds: no key, no meaningful quota, so the voice
 * a reply starts in is the voice it ends in.
 *
 * Like gemini-tts.ts this is plain Node — `ws` and `node:crypto`, no Electron
 * import — so the main process can call it and a headless script can drive it.
 *
 * ## The protocol, in one paragraph
 *
 * One WebSocket per utterance. Connect with the `TrustedClientToken` Edge
 * ships plus a `Sec-MS-GEC` proof (SHA-256 of the current 5-minute window in
 * Windows file time + the token — Microsoft added it in 2024 to cut off stale
 * clients, and without it the socket closes with a 403 before open). Send one
 * `speech.config` text frame naming the output format, then one `ssml` frame
 * with the text. Audio arrives as binary frames — two-byte big-endian header
 * length, header, then MP3 bytes — and a `Path:turn.end` text frame says the
 * clip is complete. MP3 rather than raw PCM is deliberate: it is a container
 * `decodeAudioData` understands, so the renderer needs no bespoke parsing.
 *
 * ## Voice consistency beats variety
 *
 * The default is en-GB-SoniaNeural and the module takes whatever valid name it
 * is given, but it never *chooses* between voices: choosing is the renderer's
 * chain and the Settings page. One engine, one voice, every sentence.
 */

const TRUSTED_CLIENT_TOKEN = '6A5AA1D4EAFF4E9FB37E23D68491D6F4'
const WSS_HOST = 'wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1'
/**
 * Version string the GEC check wants alongside the hash. Must be a CURRENT
 * Edge build — the endpoint refuses builds it considers retired (a 2024-era
 * `1-130.…` got a flat 403 in testing on 2026-08-01; `1-143.…`, the build the
 * edge-tts project ships today, connects). If Edge speech starts 403ing again
 * with a correct clock, bump this to whatever
 * https://github.com/rany2/edge-tts `constants.py` currently says.
 */
const SEC_MS_GEC_VERSION = '1-143.0.3650.75'
/** What the speech.config asks for. 24 kHz mono MP3 — small, and decodable. */
const OUTPUT_FORMAT = 'audio-24khz-48kbitrate-mono-mp3'

/** One spoken line, not a document. Matches gemini-tts.ts. */
export const MAX_EDGE_TTS_CHARS = 900
export const DEFAULT_EDGE_TIMEOUT_MS = 15_000

export interface EdgeSpeakOptions {
  text: string
  /** A neural voice short name. Empty or invalid means the default. */
  voice?: string
  timeoutMs?: number
  /** Abort mid-flight — barge-in. */
  signal?: AbortSignal
}

export interface EdgeOk {
  ok: true
  /** A complete MP3 file. */
  audio: Buffer
  mime: 'audio/mpeg'
  voice: string
  ms: number
}

export interface EdgeErr {
  ok: false
  kind: TtsErrorKind
  error: string
}

export type EdgeResult = EdgeOk | EdgeErr

/* ----------------------------------------------------------------- the GEC */

/**
 * The clock proof the endpoint checks since late 2024.
 *
 * Windows file time (100-ns ticks since 1601) rounded DOWN to the nearest five
 * minutes, concatenated with the trusted client token, SHA-256, uppercase hex.
 * Wrong or missing means the upgrade request is rejected outright, which
 * arrives here as an opaque "Unexpected server response: 403".
 */
export function secMsGec(nowMs = Date.now()): string {
  const WINDOWS_EPOCH_OFFSET_S = 11_644_473_600
  // Rounded in SECONDS, converted to ticks as a string. Converting first and
  // rounding after reads more naturally and is mathematically identical — and
  // silently wrong: seconds-since-1601 × 10⁷ is ~1.7 × 10¹⁷, past Number's
  // 2⁵³ integer ceiling, so the multiply loses low digits, the hashed string
  // is off, and the endpoint answers 403 to every single connection.
  let seconds = Math.floor(nowMs / 1000) + WINDOWS_EPOCH_OFFSET_S
  seconds -= seconds % 300
  return createHash('sha256')
    .update(`${seconds}0000000${TRUSTED_CLIENT_TOKEN}`, 'ascii')
    .digest('hex')
    .toUpperCase()
}

/* ---------------------------------------------------------------- plumbing */

function connectionId(): string {
  return randomBytes(16).toString('hex')
}

/** `&`, `<`, `>` are the three that break SSML. Quotes stay: text, not attrs. */
function escapeXml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function ssml(text: string, voice: string): string {
  return (
    `<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='en-US'>` +
    `<voice name='${voice}'>${escapeXml(text)}</voice></speak>`
  )
}

function headersOf(frame: string): Record<string, string> {
  const out: Record<string, string> = {}
  const end = frame.indexOf('\r\n\r\n')
  for (const line of frame.slice(0, end < 0 ? frame.length : end).split('\r\n')) {
    const colon = line.indexOf(':')
    if (colon > 0) out[line.slice(0, colon).trim()] = line.slice(colon + 1).trim()
  }
  return out
}

/* ---------------------------------------------------------------- the call */

/**
 * Text → one MP3 clip.
 *
 * A socket per utterance rather than a pooled one: the endpoint drops idle
 * connections within seconds anyway, an utterance is 1–3 s of wall time, and a
 * fresh socket makes cancellation trivial — abort simply closes it.
 */
export function speakEdge(opts: EdgeSpeakOptions): Promise<EdgeResult> {
  const text = (opts.text ?? '').trim()
  if (!text) return Promise.resolve(fail('bad-input', '`text` is required and must be a non-empty string'))
  if (text.length > MAX_EDGE_TTS_CHARS) {
    return Promise.resolve(
      fail('bad-input', `That is ${text.length} characters — a spoken line must be under ${MAX_EDGE_TTS_CHARS}`)
    )
  }
  if (opts.signal?.aborted) return Promise.resolve(fail('cancelled', 'Cancelled before it started'))

  const voice = isEdgeVoice(opts.voice ?? '') ? (opts.voice ?? '').trim() : DEFAULT_EDGE_VOICE
  const timeout = opts.timeoutMs ?? DEFAULT_EDGE_TIMEOUT_MS
  const started = Date.now()

  const url =
    `${WSS_HOST}?TrustedClientToken=${TRUSTED_CLIENT_TOKEN}` +
    `&Sec-MS-GEC=${secMsGec()}&Sec-MS-GEC-Version=${SEC_MS_GEC_VERSION}` +
    `&ConnectionId=${connectionId()}`

  return new Promise<EdgeResult>((resolve) => {
    const chunks: Buffer[] = []
    let settled = false

    const ws = new WebSocket(url, {
      headers: {
        Pragma: 'no-cache',
        'Cache-Control': 'no-cache',
        Origin: 'chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold',
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) ' +
          'Chrome/143.0.0.0 Safari/537.36 Edg/143.0.0.0'
      },
      handshakeTimeout: timeout
    })

    const finish = (result: EdgeResult): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      opts.signal?.removeEventListener('abort', onAbort)
      try {
        ws.close()
      } catch {
        /* already closed */
      }
      resolve(result)
    }

    const timer = setTimeout(
      () => finish(fail('network', `Edge speech did not answer within ${Math.round(timeout / 1000)}s`)),
      timeout
    )

    const onAbort = (): void => finish(fail('cancelled', 'Cancelled — he started talking again'))
    opts.signal?.addEventListener('abort', onAbort, { once: true })

    ws.on('open', () => {
      const stamp = new Date().toISOString()
      ws.send(
        `X-Timestamp:${stamp}\r\nContent-Type:application/json; charset=utf-8\r\nPath:speech.config\r\n\r\n` +
          JSON.stringify({
            context: {
              synthesis: {
                audio: {
                  metadataoptions: { sentenceBoundaryEnabled: 'false', wordBoundaryEnabled: 'false' },
                  outputFormat: OUTPUT_FORMAT
                }
              }
            }
          })
      )
      ws.send(
        `X-RequestId:${connectionId()}\r\nContent-Type:application/ssml+xml\r\n` +
          `X-Timestamp:${stamp}Z\r\nPath:ssml\r\n\r\n${ssml(text, voice)}`
      )
    })

    ws.on('message', (data: Buffer | ArrayBuffer | Buffer[], isBinary: boolean) => {
      if (isBinary) {
        const buf = Buffer.isBuffer(data) ? data : Buffer.concat(Array.isArray(data) ? data : [Buffer.from(data)])
        if (buf.length < 2) return
        const headerLength = buf.readUInt16BE(0)
        const header = buf.subarray(2, 2 + headerLength).toString('utf8')
        if (header.includes('Path:audio')) chunks.push(buf.subarray(2 + headerLength))
        return
      }
      const frame = String(data)
      const path = headersOf(frame)['Path']
      if (path === 'turn.end') {
        if (chunks.length === 0) {
          finish(fail('no-audio', `Edge speech finished the turn with no audio (voice ${voice}).`))
          return
        }
        finish({ ok: true, audio: Buffer.concat(chunks), mime: 'audio/mpeg', voice, ms: Date.now() - started })
      }
    })

    ws.on('error', (err: Error) => {
      const msg = err.message || String(err)
      // A 403 on upgrade is the endpoint refusing the client, not the network
      // being down — usually the GEC window or a retired token. Classified as
      // `model` so the renderer's chain moves on instead of blaming the wifi.
      if (/403/.test(msg)) {
        finish(fail('model', `Edge speech refused the connection (403). ${msg}`))
        return
      }
      finish(fail('network', `Could not reach Edge speech: ${msg}`))
    })

    ws.on('close', (code: number) => {
      // A close before turn.end with audio in hand is a truncated clip; with
      // nothing in hand it is a refusal. Either way the words were not said.
      finish(fail('network', `Edge speech closed early (code ${code}).`))
    })
  })
}

function fail(kind: TtsErrorKind, error: string): EdgeErr {
  return { ok: false, kind, error }
}
