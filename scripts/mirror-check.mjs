/**
 * Head-less proof that the desktop half of the TV screen mirror survives a
 * retry.
 *
 * The mirror's hard part is not WebRTC — it is time. Opening a desktop capture
 * takes a second, sometimes several, and the television gives up waiting after
 * six. So the ordinary shape of a slow start is two attempts overlapping: the
 * sofa presses OK again while the first capture is still inside an await. The
 * bug that made this file necessary is what that used to do — the abandoned
 * attempt reported its own cancellation, the relay delivered that sentence to
 * whoever was watching *now*, and the healthy retry died reading "the mirror
 * was stopped before it started". Every press of OK was killed by the one
 * before it.
 *
 *   npm run mirror:check
 *
 * The real src/lib/mirror.ts is bundled and driven directly. Nothing here is a
 * peer connection: Node has no WebRTC and does not need one, because what is
 * being tested is which attempt is allowed to speak. The stubs below are the
 * smallest surface that file touches — a capture that resolves when this script
 * says so, and a peer whose offer does the same — so every await it takes can
 * be held open at exactly the moment a second attempt arrives.
 */
import { mkdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const ROOT = resolve(import.meta.dirname, '..')
const scratch = join(ROOT, 'node_modules', '.forge-mirror-check')
mkdirSync(scratch, { recursive: true })

let failures = 0
const log = (ok, message) => {
  if (!ok) failures++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${message}`)
}

/** A promise somebody else decides the fate of. */
function deferred() {
  let settle
  let fail
  const promise = new Promise((res, rej) => {
    settle = res
    fail = rej
  })
  return { promise, settle, fail }
}

/* ------------------------------------------------------------- the stubs */

class FakeTrack {
  constructor() {
    this.onended = null
    this.stopped = false
    /** Written by `preferSharpness`; read by case 6. */
    this.contentHint = ''
  }
  getSettings() {
    return { width: 2560, height: 1440 }
  }
  stop() {
    this.stopped = true
  }
}

class FakeStream {
  constructor() {
    this.track = new FakeTrack()
  }
  getVideoTracks() {
    return [this.track]
  }
  getTracks() {
    return [this.track]
  }
}

/** Every peer built during a run, so a superseded one can be checked as closed. */
const peers = []

class FakePeer {
  constructor() {
    this.closed = false
    this.localDescription = null
    this.connectionState = 'new'
    this.onicecandidate = null
    this.onconnectionstatechange = null
    /** Held open until the test lets the offer through. */
    this.offerGate = null
    /** The last parameters written by `widenTheChannel`, or null. */
    this.parameters = null
    peers.push(this)
  }
  addTransceiver() {
    return {
      setCodecPreferences: () => {},
      // The encoder knobs. `encodings: []` on purpose — it is what Chromium
      // hands back before a first negotiation on some builds, and the file
      // under test has to cope with filling it in rather than indexing into
      // nothing.
      sender: {
        getParameters: () => ({ encodings: [] }),
        setParameters: async (parameters) => {
          this.parameters = parameters
        }
      }
    }
  }
  /**
   * One plausible sample. A Map, because `RTCStatsReport` is one — the file
   * under test both iterates it and looks a codec up by id.
   */
  async getStats() {
    return new Map([
      [
        'out',
        {
          type: 'outbound-rtp',
          kind: 'video',
          bytesSent: 500_000,
          frameWidth: 1920,
          frameHeight: 1080,
          framesPerSecond: 27,
          qualityLimitationReason: 'none',
          qualityLimitationDurations: { bandwidth: 0, cpu: 0, other: 0 },
          pliCount: 0,
          codecId: 'codec'
        }
      ],
      ['codec', { type: 'codec', mimeType: 'video/H264' }],
      ['pair', { type: 'candidate-pair', state: 'succeeded', currentRoundTripTime: 0.004 }]
    ])
  }
  async createOffer() {
    if (this.offerGate) await this.offerGate
    return { type: 'offer', sdp: `v=0 peer-${peers.indexOf(this)}` }
  }
  async setLocalDescription(description) {
    this.localDescription = { type: 'offer', sdp: description.sdp }
  }
  close() {
    this.closed = true
  }
}

/** What the next `getUserMedia` will do, set per case. */
let capture = null

globalThis.RTCPeerConnection = FakePeer
// A capability list of nothing: preferH264 leaves the codec order alone, which
// is the same thing a build without H.264 does. Codec preference is not what
// this file is about.
globalThis.RTCRtpSender = { getCapabilities: () => null }
// Defined rather than assigned: modern Node ships its own `navigator`, and it
// is a getter-only property on the global.
Object.defineProperty(globalThis, 'navigator', {
  configurable: true,
  value: { mediaDevices: { getUserMedia: () => capture() } }
})
globalThis.window = globalThis
globalThis.window.forge = { mobile: { mirrorSource: async () => 'screen:0:0' } }

/* ---------------------------------------------------------------- the run */

const bundle = join(scratch, 'mirror.mjs')
await build({
  entryPoints: [join(ROOT, 'src', 'lib', 'mirror.ts')],
  outfile: bundle,
  bundle: true,
  format: 'esm',
  platform: 'neutral',
  target: 'es2022'
})
const { startMirror, stopMirror, handleSignal } = await import(pathToFileURL(bundle).href)

/** One start, with its sent payloads and closing sentence collected. */
function attempt() {
  const record = { sent: [], closed: [], error: undefined }
  record.done = startMirror(
    (data) => record.sent.push(JSON.parse(data)),
    (reason) => record.closed.push(reason)
  ).then((error) => {
    record.error = error
    return error
  })
  return record
}

const offersOf = (record) => record.sent.filter((s) => s.kind === 'offer')
/** Let every queued microtask and timer run before asserting on them. */
const settle = () => new Promise((res) => setTimeout(res, 20))

/* -------------------------------------------------- 1. the ordinary start */

capture = async () => new FakeStream()
const plain = attempt()
log((await plain.done) === null, 'a start that nothing interrupts reports no error')
log(offersOf(plain).length === 1, 'and sends exactly one offer')
log(plain.closed.length === 0, 'and says nothing about closing')
stopMirror()

/* ------------------------------- 2. stopped while the capture is opening */

const held = deferred()
capture = () => held.promise
const abandoned = attempt()
await settle()
// The television gave up and the sofa pressed Back: the mirror is stopped
// while `getUserMedia` has still not answered.
stopMirror()
held.settle(new FakeStream())
const abandonedError = await abandoned.done
log(abandonedError === null, 'an attempt stopped mid-capture returns silence, not a sentence')
log(offersOf(abandoned).length === 0, 'and never sends an offer for a mirror nobody is waiting on')
const strayStream = abandoned.sent.length === 0
log(strayStream, 'and sends nothing at all')

/* ---------------------------------- 3. superseded by the retry behind it */

const slow = deferred()
capture = () => slow.promise
const first = attempt()
await settle()

capture = async () => new FakeStream()
const second = attempt()
const secondError = await second.done
log(secondError === null, 'the retry behind a slow attempt starts cleanly')
log(offersOf(second).length === 1, 'and sends its own offer')

const strandedStream = new FakeStream()
slow.settle(strandedStream)
const firstError = await first.done
log(firstError === null, 'the attempt it replaced stays silent')
log(offersOf(first).length === 0, 'and sends no offer of its own')
log(strandedStream.track.stopped === true, "and its late capture is stopped rather than left running for nobody's screen")

/* ------------------------------ 4. a real failure is still worth saying */

stopMirror()
capture = async () => {
  throw new Error('permission denied')
}
const refused = attempt()
const refusedError = await refused.done
log(typeof refusedError === 'string' && refusedError.length > 0, 'a capture that fails outright still returns a sentence')

/* ------------------------- 5. signalling after a stop is not an exception */

stopMirror()
handleSignal(JSON.stringify({ kind: 'answer', sdp: 'v=0 answer' }))
handleSignal('not json at all')
log(true, 'a signal arriving with no mirror running is dropped without throwing')

/* ------------------------------ 6. the picture is tuned, and it says so */

/*
 * The quality half of the file. A mirror that negotiates perfectly and then
 * hands the television a soft 960-wide picture is the bug this guards: the
 * three settings below are the difference between readable text on a wall and
 * a blur, and none of them is visible in an SDP, a log line or a screenshot.
 * The stats frame is the other half — the only way anybody on a sofa can tell
 * a starved encoder from a busy desk from a lossy hop.
 */
stopMirror()
/** Kept, so the hint written onto its track can be read back. */
let tunedStream = null
capture = async () => {
  tunedStream = new FakeStream()
  return tunedStream
}
const tuned = attempt()
await tuned.done
const tunedPeer = peers[peers.length - 1]

log(tunedStream?.track.contentHint === 'text', 'the captured track is hinted as text, not as a camera')
const parameters = tunedPeer.parameters
log(parameters !== null, 'the sender is given explicit encoding parameters')
log(parameters?.degradationPreference === 'maintain-resolution', 'and told to spend frame rate rather than pixels')
log((parameters?.encodings?.[0]?.maxBitrate ?? 0) >= 4_000_000, 'and given a ceiling a LAN can actually fill')
log(parameters?.encodings?.[0]?.scaleResolutionDownBy === 1, 'and told not to scale the frame down')

// A second of real time, because the sample is on a real interval and the
// point of the assertion is that it fires by itself rather than on demand.
await new Promise((res) => setTimeout(res, 1200))
const statsOf = (record) => record.sent.filter((s) => s.kind === 'stats')
const sample = statsOf(tuned)[0]
log(sample !== undefined, 'a live mirror reports its own stats without being asked')
log(sample?.width === 1920 && sample?.height === 1080, 'and says what resolution actually left the desk')
log(sample?.srcWidth === 2560, 'and what the capture handed the encoder, so scaling is visible')
log(sample?.limit === 'none', "and Chromium's own verdict on what is limiting it")
log(sample?.codec === 'video/H264', 'and which codec won')

const before = statsOf(tuned).length
stopMirror()
await new Promise((res) => setTimeout(res, 1200))
log(statsOf(tuned).length === before, 'and stops reporting the moment the mirror is torn down')

console.log(failures === 0 ? '\nmirror-check: all good' : `\nmirror-check: ${failures} failed`)
process.exit(failures === 0 ? 0 : 1)
