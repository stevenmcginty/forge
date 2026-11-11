package com.forge.bubble.audio

import android.content.Context
import android.media.AudioAttributes
import android.media.AudioFocusRequest
import android.media.AudioFormat
import android.media.AudioManager
import android.media.AudioTrack
import android.media.MediaDataSource
import android.media.MediaPlayer
import android.os.Handler
import android.os.Looper
import android.util.Log
import com.forge.bubble.TAG
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import java.nio.ByteBuffer
import java.nio.ByteOrder
import kotlin.coroutines.resume

/**
 * Plays one spoken clip at a time from memory.
 *
 *  - `audio/wav`: the RIFF header is parsed (PCM16, mono or stereo, any sample
 *    rate) and the samples go to an [AudioTrack].
 *  - `audio/mpeg`: [MediaPlayer] reading the bytes through a [MediaDataSource].
 *
 * [play] suspends until the clip ends (or [stop] / cancellation cuts it). A new
 * [play] stops whatever is playing first. While a clip plays the player holds
 * transient audio focus that lets other audio duck, and gives it back after.
 */
class ClipPlayer(ctx: Context) {

  private val audio = ctx.getSystemService(AudioManager::class.java)
  private val attrs = AudioAttributes.Builder()
    .setUsage(AudioAttributes.USAGE_ASSISTANT)
    .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
    .build()
  private val focus = AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN_TRANSIENT_MAY_DUCK)
    .setAudioAttributes(attrs)
    .setOnAudioFocusChangeListener { }
    .build()

  private val lock = Mutex()
  @Volatile private var track: AudioTrack? = null
  @Volatile private var player: MediaPlayer? = null
  @Volatile private var stopped = false

  suspend fun play(bytes: ByteArray, mime: String) {
    stop()
    lock.withLock {
      stopped = false
      audio.requestAudioFocus(focus)
      try {
        when (mime.substringBefore(';').trim().lowercase()) {
          "audio/wav", "audio/wave", "audio/x-wav" -> playWav(bytes)
          "audio/mpeg", "audio/mp3" -> playMpeg(bytes)
          else -> Log.w(TAG, "clip: unsupported type $mime")
        }
      } finally {
        audio.abandonAudioFocusRequest(focus)
      }
    }
  }

  /** Cuts the current clip; its [play] returns. */
  fun stop() {
    stopped = true
    track?.let { t -> try { t.pause(); t.flush() } catch (_: Throwable) {} }
    player?.let { p -> try { p.stop() } catch (_: Throwable) {} }
  }

  /* ------------------------------------------------------------------ wav */

  private class Wav(val rate: Int, val channels: Int, val dataOffset: Int, val dataLength: Int)

  private fun parseWav(b: ByteArray): Wav {
    val buf = ByteBuffer.wrap(b).order(ByteOrder.LITTLE_ENDIAN)
    require(b.size >= 12 && String(b, 0, 4, Charsets.US_ASCII) == "RIFF" && String(b, 8, 4, Charsets.US_ASCII) == "WAVE") {
      "not a RIFF/WAVE file"
    }
    var pos = 12
    var rate = 0
    var channels = 0
    var bits = 0
    var format = 0
    while (pos + 8 <= b.size) {
      val id = String(b, pos, 4, Charsets.US_ASCII)
      val size = buf.getInt(pos + 4)
      val body = pos + 8
      when (id) {
        "fmt " -> {
          format = buf.getShort(body).toInt() and 0xFFFF
          channels = buf.getShort(body + 2).toInt()
          rate = buf.getInt(body + 4)
          bits = buf.getShort(body + 14).toInt()
        }
        "data" -> {
          require(format == 1 || format == 0xFFFE) { "wav is not PCM (format $format)" }
          require(bits == 16) { "wav is $bits-bit, not 16-bit" }
          require(channels == 1 || channels == 2) { "wav has $channels channels" }
          // Streamed WAVs may carry 0 or 0xFFFFFFFF as the length: take the rest.
          val len = if (size <= 0 || body + size > b.size) b.size - body else size
          return Wav(rate, channels, body, len)
        }
      }
      pos = body + size + (size and 1)
    }
    throw IllegalArgumentException("wav has no data chunk")
  }

  private suspend fun playWav(bytes: ByteArray) = withContext(Dispatchers.IO) {
    val wav = try { parseWav(bytes) } catch (e: IllegalArgumentException) {
      Log.w(TAG, "clip: ${e.message}"); return@withContext
    }
    val mask = if (wav.channels == 2) AudioFormat.CHANNEL_OUT_STEREO else AudioFormat.CHANNEL_OUT_MONO
    val minBuf = AudioTrack.getMinBufferSize(wav.rate, mask, AudioFormat.ENCODING_PCM_16BIT)
    val t = AudioTrack.Builder()
      .setAudioAttributes(attrs)
      .setAudioFormat(
        AudioFormat.Builder().setSampleRate(wav.rate).setChannelMask(mask)
          .setEncoding(AudioFormat.ENCODING_PCM_16BIT).build()
      )
      .setBufferSizeInBytes(maxOf(minBuf, wav.rate / 5 * 2 * wav.channels))
      .setTransferMode(AudioTrack.MODE_STREAM)
      .build()
    track = t
    val totalFrames = wav.dataLength / (2 * wav.channels)
    try {
      t.play()
      var off = wav.dataOffset
      val end = wav.dataOffset + wav.dataLength
      while (off < end && !stopped) {
        val n = t.write(bytes, off, minOf(8192, end - off))
        if (n <= 0) break
        off += n
      }
      // write() returns once the samples are buffered; wait for them to sound.
      while (!stopped && t.playbackHeadPosition < totalFrames) delay(20)
    } finally {
      track = null
      try { t.stop() } catch (_: Throwable) {}
      t.release()
    }
  }

  /* ----------------------------------------------------------------- mpeg */

  private class Bytes(private val data: ByteArray) : MediaDataSource() {
    override fun readAt(position: Long, buffer: ByteArray, offset: Int, size: Int): Int {
      if (position >= data.size) return -1
      val n = minOf(size.toLong(), data.size - position).toInt()
      System.arraycopy(data, position.toInt(), buffer, offset, n)
      return n
    }
    override fun getSize(): Long = data.size.toLong()
    override fun close() {}
  }

  private suspend fun playMpeg(bytes: ByteArray) = withContext(Dispatchers.Main) {
    val p = MediaPlayer()
    player = p
    try {
      suspendCancellableCoroutine { cont ->
        cont.invokeOnCancellation { try { p.stop() } catch (_: Throwable) {} }
        p.setAudioAttributes(attrs)
        p.setDataSource(Bytes(bytes))
        p.setOnPreparedListener { if (stopped) cont.resume(Unit) else it.start() }
        p.setOnCompletionListener { if (cont.isActive) cont.resume(Unit) }
        p.setOnErrorListener { _, what, extra ->
          Log.w(TAG, "clip: mpeg error $what/$extra")
          if (cont.isActive) cont.resume(Unit)
          true
        }
        p.prepareAsync()
        // stop() calls p.stop(), which fires no completion: watch the flag too.
        val main = Handler(Looper.getMainLooper())
        val watch = object : Runnable {
          override fun run() {
            if (!cont.isActive) return
            if (stopped) cont.resume(Unit) else main.postDelayed(this, 50)
          }
        }
        main.postDelayed(watch, 50)
      }
    } finally {
      player = null
      p.release()
    }
  }
}
