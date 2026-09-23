/**
 * AudioWorklet processors for Gemini Live (see ./gemini.ts, ./audio.ts).
 *
 * Plain JavaScript on purpose: it is loaded with audioWorklet.addModule() from
 * a URL, so the bundler copies it as an asset and nothing transpiles it.
 * `sampleRate`, `registerProcessor` and `AudioWorkletProcessor` are globals of
 * the worklet scope.
 *
 *   forge-pcm-capture  mic Float32 at the context rate → 16 kHz Int16 chunks
 *                      (~100 ms each) posted to the main thread, plus a level
 *   forge-pcm-player   24 kHz Int16 chunks from the main thread → speakers,
 *                      with a flush for barge-in and a "drained" notice
 */

/* global sampleRate, registerProcessor, AudioWorkletProcessor */

class ForgePcmCapture extends AudioWorkletProcessor {
  constructor(options) {
    super()
    this.target = (options && options.processorOptions && options.processorOptions.targetRate) || 16000
    this.step = sampleRate / this.target
    this.pos = 0
    this.chunk = new Int16Array(Math.round(this.target / 10))
    this.fill = 0
    this.sumSq = 0
    this.count = 0
  }

  process(inputs) {
    const input = inputs[0] && inputs[0][0]
    if (!input) return true
    // Linear-interpolated resample from the context rate to the target rate.
    while (this.pos < input.length) {
      const i = Math.floor(this.pos)
      const frac = this.pos - i
      const a = input[i]
      const b = i + 1 < input.length ? input[i + 1] : a
      const s = Math.max(-1, Math.min(1, a + (b - a) * frac))
      this.chunk[this.fill++] = s < 0 ? s * 0x8000 : s * 0x7fff
      this.sumSq += s * s
      this.count++
      if (this.fill === this.chunk.length) {
        const out = this.chunk
        this.port.postMessage({ pcm: out.buffer, level: Math.sqrt(this.sumSq / Math.max(1, this.count)) }, [out.buffer])
        this.chunk = new Int16Array(out.length)
        this.fill = 0
        this.sumSq = 0
        this.count = 0
      }
      this.pos += this.step
    }
    this.pos -= input.length
    return true
  }
}

class ForgePcmPlayer extends AudioWorkletProcessor {
  constructor(options) {
    super()
    this.source = (options && options.processorOptions && options.processorOptions.sourceRate) || 24000
    this.step = this.source / sampleRate
    this.queue = []
    this.current = null
    this.offset = 0
    this.playing = false
    this.levelAcc = 0
    this.levelN = 0
    this.frames = 0
    this.port.onmessage = (e) => {
      const msg = e.data
      if (msg && msg.flush) {
        this.queue = []
        this.current = null
        this.offset = 0
        return
      }
      if (msg && msg.pcm) this.queue.push(new Int16Array(msg.pcm))
    }
  }

  next() {
    if (this.current && this.offset < this.current.length) return true
    this.current = this.queue.shift() || null
    this.offset = 0
    return this.current !== null
  }

  process(_inputs, outputs) {
    const out = outputs[0] && outputs[0][0]
    if (!out) return true
    let wrote = false
    for (let i = 0; i < out.length; i++) {
      if (!this.next()) {
        out[i] = 0
        continue
      }
      const idx = Math.floor(this.offset)
      const s = this.current[idx] / 0x8000
      out[i] = s
      this.levelAcc += s * s
      this.levelN++
      wrote = true
      this.offset += this.step
    }
    for (let c = 1; c < outputs[0].length; c++) outputs[0][c].set(out)
    if (wrote && !this.playing) {
      this.playing = true
      this.port.postMessage({ started: true })
    } else if (!wrote && this.playing) {
      this.playing = false
      this.port.postMessage({ drained: true })
    }
    // A level about thirty times a second is plenty for an orb.
    if (++this.frames % 12 === 0) {
      this.port.postMessage({ level: Math.sqrt(this.levelAcc / Math.max(1, this.levelN)) })
      this.levelAcc = 0
      this.levelN = 0
    }
    return true
  }
}

registerProcessor('forge-pcm-capture', ForgePcmCapture)
registerProcessor('forge-pcm-player', ForgePcmPlayer)
