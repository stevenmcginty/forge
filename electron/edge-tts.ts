import { randomBytes } from 'node:crypto'
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
 * ships plus a `Sec-MS-GEC` proof (a hash of the current 5-minute window in
 * Windows file time + the token — Microsoft added it in 2024 to cut off stale
 * clients and hardened it to "v2" in late 2026; wrong or stale, the socket
 * closes with a 403 before open) and a random `muid` cookie. Send one
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
 * Version string the GEC check wants alongside the hash: `<token version>-<Edge
 * build>`. The build must be CURRENT — the endpoint refuses builds it considers
 * retired (a 2024-era `1-130.…` got a flat 403 in testing on 2026-08-01). The
 * `2-` prefix names the v2 token `secMsGec` makes; `1-143.…` stopped working
 * in late 2026. If Edge speech starts 403ing again with a correct clock, check
 * https://github.com/rany2/edge-tts `constants.py` and `drm.py`.
 */
const SEC_MS_GEC_VERSION = '2-143.0.3650.75'
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

// The v2 token (Microsoft, late 2026). Ported from rany2/edge-tts
// src/edge_tts/drm.py (LGPL-3.0), constant for constant. A plain SHA-256 of
// the ticks + token now gets a flat 403: the endpoint wants a SHA-256 of a
// 57-byte prefix nobody publishes followed by that string — upstream ships the
// first block's mid-state instead of the prefix — plus a "CS64" checksum keyed
// by the digest. Every value is a uint32; `>>> 0` and Math.imul keep it so.

// FIPS 180-4 initial hash value.
const SHA256_INITIAL = [
  0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19
]
// Working registers after round 13 of the hidden prefix's block.
const SHA256_STATE = [
  0xfd9fbea2, 0x91243ce7, 0xbe499094, 0xcd2e1e0a, 0x6c006f49, 0x04bd35ab, 0xfeb0a7e4, 0x03effbd2
]
// That block's schedule words 16–29, as far as the prefix alone fixes them.
const SHA256_SCHEDULE = [
  0xeb24bf9e, 0x1558691f, 0xa0c09ee2, 0x0cfa32ba, 0xa622ee8c, 0xd1dd9491, 0xc0dd25a0, 0xf9e70ab6,
  0xf0c31573, 0x7058ce4e, 0x7188e606, 0x00e5ab33, 0xd258b060, 0x72766564
]
const SHA256_ROUND_CONSTANTS = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
]
const SHA256_ADJUSTMENT = 0xc9dc06a7
/** The round constants with K[14] swapped, for resuming inside the prefix block. */
const SHA256_BLOCK_CONSTANTS = SHA256_ROUND_CONSTANTS.map((k, i) => (i === 14 ? SHA256_ADJUSTMENT : k))
const SHA256_SIGMA0_ADJUSTMENT = 0x059c0b80
const SHA256_SIGMA1_ADJUSTMENT = 0x000b92c0

/** [coefficient, offset] pairs. */
const CS64_COEFFICIENTS: ReadonlyArray<readonly [number, number]> = [
  [0xe82e91b1, 0xb32700d0],
  [0x44de24c6, 0x88dff51d],
  [0x3beb65bc, 0x29514038],
  [0xc89c5933, 0xb328cbdf],
  [0x8d1ec211, 0xd405b4d5],
  [0x314ef5d5, 0x26e55f3c],
  [0xe92491b1, 0x607801c6],
  [0xf0a5b9d5, 0x82b2c1fb],
  [0x06064cf3, 0xfa51a3da],
  [0xda79fa60, 0x207cc464],
  [0xbed20560, 0x3c3c74f3],
  [0x89f9c9f8, 0xd2d14b61],
  [0x35fa38c6, 0xbb04a2c1],
  [0xcb49e3c6, 0xc5626167]
]
const CS64_FACTOR = 0x82893933
const CS64_ADJUSTMENT0 = 0xf2f90b1a
const CS64_ADJUSTMENT1 = 0x0b1a0000

const rotr = (v: number, n: number): number => ((v >>> n) | (v << (32 - n))) >>> 0
const rol16 = (v: number): number => ((v << 16) | (v >>> 16)) >>> 0
const mul = (a: number, b: number): number => Math.imul(a, b) >>> 0
const sigma0 = (v: number): number => (rotr(v, 7) ^ rotr(v, 18) ^ (v >>> 3)) >>> 0
const sigma1 = (v: number): number => (rotr(v, 17) ^ rotr(v, 19) ^ (v >>> 10)) >>> 0

/** Extend a schedule in place to 64 words, starting at `firstWord`. */
function expandSchedule(words: number[], firstWord = 16): void {
  for (let i = firstWord; i < 64; i++) {
    words[i] = (sigma1(words[i - 2]) + words[i - 7] + sigma0(words[i - 15]) + words[i - 16]) >>> 0
  }
}

/** SHA-256 compression rounds `firstRound`–63; returns the working registers (not yet added in). */
function sha256Rounds(state: readonly number[], words: readonly number[], firstRound = 0): number[] {
  let [a, b, c, d, e, f, g, h] = state
  const k = firstRound === 14 ? SHA256_BLOCK_CONSTANTS : SHA256_ROUND_CONSTANTS
  for (let i = firstRound; i < 64; i++) {
    const t1 = (h + (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) + ((g ^ (e & (f ^ g))) >>> 0) + k[i] + words[i]) >>> 0
    const t2 = ((rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) + (((a & b) | (c & (a | b))) >>> 0)) >>> 0
    h = g
    g = f
    f = e
    e = (d + t1) >>> 0
    d = c
    c = b
    b = a
    a = (t1 + t2) >>> 0
  }
  return [a, b, c, d, e, f, g, h]
}

/** The state after the hidden prefix's block, which ends in the first 7 bytes of data. */
function sha256Init(data: Buffer): number[] {
  const w: number[] = new Array<number>(14).fill(0)
  w.push(data.readUIntBE(0, 3), data.readUInt32BE(3))
  for (let i = 16; i < 30; i++) {
    let value = SHA256_SCHEDULE[i - 16]
    if (i - 2 >= 14) value += i === 16 ? (sigma1(w[i - 2]) ^ SHA256_SIGMA1_ADJUSTMENT) >>> 0 : sigma1(w[i - 2])
    if (i - 7 >= 14) value += w[i - 7]
    if (i - 15 >= 14) value += i === 29 ? (sigma0(w[i - 15]) ^ SHA256_SIGMA0_ADJUSTMENT) >>> 0 : sigma0(w[i - 15])
    w.push(value >>> 0)
  }
  w.push((sigma1(w[28]) + w[23] + sigma0(w[15]) + w[14] + SHA256_ADJUSTMENT - SHA256_ROUND_CONSTANTS[14]) >>> 0)
  expandSchedule(w, 31)
  const working = sha256Rounds(SHA256_STATE, w, 14)
  return SHA256_INITIAL.map((x, i) => (x + working[i]) >>> 0)
}

/** SHA-256(hidden 57-byte prefix + data). */
function sha256Digest(data: Buffer): Buffer {
  const length = 57 + data.length
  const zeros = (((55 - length) % 64) + 64) % 64
  const lengthBits = Buffer.alloc(8)
  lengthBits.writeBigUInt64BE(BigInt(length * 8))
  const padded = Buffer.concat([data.subarray(7), Buffer.from([0x80]), Buffer.alloc(zeros), lengthBits])
  let state = sha256Init(data)
  for (let offset = 0; offset < padded.length; offset += 64) {
    const words: number[] = []
    for (let i = 0; i < 16; i++) words.push(padded.readUInt32BE(offset + i * 4))
    expandSchedule(words)
    const working = sha256Rounds(state, words)
    state = state.map((x, i) => (x + working[i]) >>> 0)
  }
  const out = Buffer.alloc(32)
  state.forEach((x, i) => out.writeUInt32BE(x, i * 4))
  return out
}

/** The CS64 checksum: two uint32s, keyed by the first eight digest bytes. */
function cs64Digest(data: Buffer, digest: Buffer): [number, number] {
  const keyA = (digest.readUInt32LE(0) | 1) >>> 0
  const keyB = (digest.readUInt32LE(4) | 1) >>> 0
  const factors = [mul(keyA, CS64_FACTOR), mul(keyB, CS64_FACTOR)]
  const terms = CS64_COEFFICIENTS.map(([coefficient], i) => mul(coefficient, factors[i % 2]))
  const offsets = CS64_COEFFICIENTS.map(([, offset]) => offset)
  // A zero byte, then the data, as little-endian words padded to an even count.
  const bytes = Buffer.concat([Buffer.from([0]), data])
  const padded = Buffer.concat([bytes, Buffer.alloc((4 - (bytes.length % 4)) % 4)])
  const words: number[] = []
  for (let i = 0; i < padded.length; i += 4) words.push(padded.readUInt32LE(i))
  if (words.length % 2) words.push(0)
  words.forEach((word, i) => {
    let term = mul(word, i % 2 === 0 ? keyA : keyB)
    let offset = mul(rol16(word), i % 2 === 0 ? 0xef0569fb : 0xc31713db)
    if (i === 0) {
      term = (term + mul(CS64_ADJUSTMENT0, factors[0])) >>> 0
      offset = (offset + CS64_ADJUSTMENT1) >>> 0
    }
    terms.push(term)
    offsets.push(offset)
  })
  let swapAcc = 0
  let swapLast = 0
  let state = 0
  let acc = 0
  for (let i = 0; i < terms.length; i += 2) {
    const x = terms[i]
    const y = terms[i + 1]
    let q = mul(rol16((offsets[i] + x) >>> 0), 0x76f50f34)
    swapAcc = (swapAcc + mul(rol16(q), 0xc3efea97) + q) >>> 0
    q = mul(rol16((offsets[i + 1] + y) >>> 0), 0x1881ce3c)
    swapLast = (mul(rol16(q), 0x35bd1ec9) + q) >>> 0
    swapAcc = (swapAcc + swapLast) >>> 0

    state = (mul(state, keyA) + x) >>> 0
    state = mul(rol16(state), 0xcf98b111)
    state = mul(rol16(state), 0x87085b9f)
    state = mul(rol16(state), 0x12ceb96d)
    state = mul(rol16(state), 0x257e1d83)
    acc = (acc + state) >>> 0
    let t = (mul(state, keyB) + y) >>> 0
    t = mul(rol16(t), 0xa27416f5)
    t = mul(rol16(t), 0xd38396ff)
    state = mul(rol16(mul(rol16(t), 0x7c932b89)), 0xbfa49f69)
    acc = (acc + state) >>> 0
  }
  return [(swapLast ^ state) >>> 0, (swapAcc ^ acc) >>> 0]
}

/**
 * The clock proof the endpoint checks, v2: `<16 hex CS64>-<64 hex SHA-256>`.
 *
 * Both halves hash the same string as v1 did: Windows file time (100-ns ticks
 * since 1601) rounded DOWN to the nearest five minutes, then the trusted client
 * token. Wrong or missing means the upgrade request is rejected outright, which
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
  const data = Buffer.from(`${seconds}0000000${TRUSTED_CLIENT_TOKEN}`, 'ascii')
  const digest = sha256Digest(data)
  const cs64 = Buffer.alloc(8)
  const [lo, hi] = cs64Digest(data, digest)
  cs64.writeUInt32LE(lo, 0)
  cs64.writeUInt32LE(hi, 4)
  return `${cs64.toString('hex').toUpperCase()}-${digest.toString('hex').toUpperCase()}`
}

/** A random machine id, sent as the `muid` cookie — upstream adds one per connection. */
function muid(): string {
  return randomBytes(16).toString('hex').toUpperCase()
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
    `&ConnectionId=${connectionId()}` +
    `&Sec-MS-GEC=${secMsGec()}&Sec-MS-GEC-Version=${SEC_MS_GEC_VERSION}`

  return new Promise<EdgeResult>((resolve) => {
    const chunks: Buffer[] = []
    let settled = false

    // Upstream's WSS_HEADERS. Its `Sec-WebSocket-Version: 13` is left out: `ws`
    // always sets that header itself and would overwrite ours.
    const ws = new WebSocket(url, {
      headers: {
        Pragma: 'no-cache',
        'Cache-Control': 'no-cache',
        Origin: 'chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold',
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) ' +
          'Chrome/143.0.0.0 Safari/537.36 Edg/143.0.0.0',
        'Accept-Encoding': 'gzip, deflate, br, zstd',
        'Accept-Language': 'en-US,en;q=0.9',
        Cookie: `muid=${muid()};`
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
