package com.forge.bubble.audio

import android.Manifest
import android.annotation.SuppressLint
import android.content.Context
import android.content.pm.PackageManager
import android.media.AudioFormat
import android.media.AudioRecord
import android.media.MediaRecorder
import android.util.Log
import com.forge.bubble.TAG
import kotlin.math.sqrt

/**
 * The microphone while the talk panel is on screen: 16 kHz, mono, PCM16, from
 * the VOICE_RECOGNITION source (no echo-cancel/AGC tuned for calls), cut into
 * 100 ms frames of 1600 samples.
 *
 * Android only lets a capture start from something visible, so TalkActivity
 * starts this in onStart and stops it in onStop; there is no microphone
 * foreground service. Frames arrive on the mic's own thread.
 *
 * `level` is the frame's RMS as a fraction of full scale, 0..1 (speech at a
 * normal distance sits around 0.02-0.2).
 */
class Mic(private val ctx: Context, private val onFrame: (pcm: ShortArray, level: Float) -> Unit) {

  companion object {
    const val SAMPLE_RATE = 16_000
    const val FRAME_SAMPLES = 1_600 // 100 ms
    private const val LOG_EVERY = 20
  }

  @Volatile
  private var running = false
  private var thread: Thread? = null

  val isRunning get() = running

  /** False when the permission is missing or the device refused the recorder. */
  @SuppressLint("MissingPermission") // checked on the first line
  fun start(): Boolean {
    if (running) return true
    if (ctx.checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
      Log.w(TAG, "mic: no RECORD_AUDIO permission")
      return false
    }
    val minBuf = AudioRecord.getMinBufferSize(SAMPLE_RATE, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT)
    val record = try {
      AudioRecord(
        MediaRecorder.AudioSource.VOICE_RECOGNITION,
        SAMPLE_RATE,
        AudioFormat.CHANNEL_IN_MONO,
        AudioFormat.ENCODING_PCM_16BIT,
        maxOf(minBuf, FRAME_SAMPLES * 2 * 4),
      )
    } catch (t: Throwable) {
      Log.w(TAG, "mic: cannot create recorder: $t")
      return false
    }
    if (record.state != AudioRecord.STATE_INITIALIZED) {
      Log.w(TAG, "mic: recorder did not initialise")
      record.release()
      return false
    }
    try {
      record.startRecording()
    } catch (t: Throwable) {
      Log.w(TAG, "mic: startRecording failed: $t")
      record.release()
      return false
    }
    running = true
    thread = Thread({ loop(record) }, "forge-mic").apply { start() }
    Log.d(TAG, "mic: started")
    return true
  }

  fun stop() {
    if (!running) return
    running = false
    thread?.join(500)
    thread = null
    Log.d(TAG, "mic: stopped")
  }

  private fun loop(record: AudioRecord) {
    var frames = 0
    try {
      while (running) {
        val frame = ShortArray(FRAME_SAMPLES)
        var filled = 0
        while (filled < FRAME_SAMPLES && running) {
          val n = record.read(frame, filled, FRAME_SAMPLES - filled)
          if (n < 0) {
            Log.w(TAG, "mic: read error $n")
            running = false
            break
          }
          filled += n
        }
        if (filled < FRAME_SAMPLES) break
        frames++
        if (frames % LOG_EVERY == 0) Log.d(TAG, "mic: frames=$frames")
        onFrame(frame, rms(frame))
      }
    } catch (t: Throwable) {
      Log.w(TAG, "mic: capture stopped: $t")
      running = false
    } finally {
      try { record.stop() } catch (_: Throwable) {}
      record.release()
    }
  }

  private fun rms(pcm: ShortArray): Float {
    var sum = 0.0
    for (s in pcm) sum += s.toDouble() * s
    return (sqrt(sum / pcm.size) / 32768.0).toFloat().coerceIn(0f, 1f)
  }
}
