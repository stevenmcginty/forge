// Forge's Kokoro speech engine, the page half. electron/kokoro-tts.ts owns the
// hidden window this runs in and calls the three functions on window.kokoro
// with executeJavaScript, one job at a time.
//
// Kokoro-82M (kokoro-js 1.2.1, Apache-2.0, see LICENSE-kokoro-js.txt) runs on
// the GPU through WebGPU, fp32. NOT fp16: on Steve's Intel GPU (xe-2lpg) fp16
// comes out distorted (3x the sample-to-sample roughness of fp32 and of the CPU
// q8 reference, clipped peaks; heard as a growl), while fp32 matches the CPU
// reference and is about as fast (~1.2 s vs ~1.0 s for a short line), measured
// 2026-11-04. Measured on Steve's Arc 140V: load 5-8 s, the
// first generate after load ~5 s (shader compile), then ~1 s to the audio of a
// short sentence. warm() pays both once so a reply never does.
//
// The model and voices are fetched from Hugging Face the first time and kept in
// this origin's Cache API ("transformers-cache", "kokoro-voices"), which lives
// on disk in the window's persistent partition, so a restart loads from disk.
//
// No CPU fallback on purpose: Kokoro on the CPU is slower than real time here,
// and main falls back to Edge instead, which never goes silent.
import { KokoroTTS } from './kokoro.web.js'

const MODEL = 'onnx-community/Kokoro-82M-v1.0-ONNX'
const SAMPLE_RATE = 24000

let tts = null
let loading = null
const state = { status: 'cold', reason: '', adapter: '', loadMs: 0, warmMs: 0 }

async function load(voice) {
  if (tts) return tts
  if (loading) return loading
  loading = (async () => {
    state.status = 'loading'
    try {
      const adapter = navigator.gpu ? await navigator.gpu.requestAdapter() : null
      if (!adapter) throw new Error('no WebGPU adapter in this window')
      const info = adapter.info || {}
      state.adapter = [info.vendor, info.architecture, info.description].filter(Boolean).join(' ')
      let t = performance.now()
      const model = await KokoroTTS.from_pretrained(MODEL, { dtype: 'fp32', device: 'webgpu' })
      state.loadMs = Math.round(performance.now() - t)
      t = performance.now()
      // The GPU compiles its kernels per input size, so a first sentence of a
      // new length is slow (~2 s for 30 characters, ~1 s once seen). Two
      // lengths here take most of that off the first real reply.
      await model.generate('Ready.', { voice })
      await model.generate('I have had a look, and everything is building cleanly.', { voice })
      state.warmMs = Math.round(performance.now() - t)
      tts = model
      state.status = 'ready'
      state.reason = ''
      return model
    } catch (err) {
      state.status = 'failed'
      state.reason = String((err && err.message) || err).slice(0, 300)
      throw err
    } finally {
      loading = null
    }
  })()
  return loading
}

/** Float32 [-1, 1] to little-endian PCM16, base64. Chunked: btoa takes a string. */
function pcm16Base64(samples) {
  const bytes = new Uint8Array(samples.length * 2)
  const view = new DataView(bytes.buffer)
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]))
    view.setInt16(i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true)
  }
  let bin = ''
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000))
  }
  return btoa(bin)
}

window.kokoro = {
  status() {
    return { ...state }
  },
  async warm(voice) {
    try {
      await load(voice)
      return { ok: true, ...state }
    } catch {
      return { ok: false, ...state }
    }
  },
  async speak(text, voice, speed) {
    try {
      const model = await load(voice)
      const t = performance.now()
      const out = await model.generate(String(text), { voice, speed: speed || 1 })
      const samples = out.audio
      return {
        ok: true,
        audio: pcm16Base64(samples),
        sampleRate: out.sampling_rate || SAMPLE_RATE,
        seconds: samples.length / (out.sampling_rate || SAMPLE_RATE),
        ms: Math.round(performance.now() - t)
      }
    } catch (err) {
      return { ok: false, error: String((err && err.message) || err).slice(0, 300) }
    }
  }
}
