package com.forge.bubble.link

import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch
import kotlinx.coroutines.withTimeoutOrNull
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.io.IOException
import java.util.Base64

/**
 * One spoken turn on its way to the desktop's ears (wire spec 3.2B).
 *
 * PCM16 little-endian, 16 kHz, mono, no header, cut into 32000-byte (1 s)
 * slices sent as `append {turnId, seq, data}` while the human is still talking,
 * base64 standard alphabet with padding and no line breaks. [finish] sends the
 * last partial slice, waits for every append to be answered, then `done
 * {chunks}` and returns the heard text. Capped at 60 s.
 *
 * Slices wait (up to [waitForLaneMs]) for the lane to be open, so speech that
 * starts while the link is still coming up is not lost; the engine drops the
 * turn once more than 8 s of audio is waiting.
 */
class Utterance(
    val turnId: String,
    private val link: ForgeLink,
    private val scope: CoroutineScope,
    private val laneReady: StateFlow<Boolean>,
    private val waitForLaneMs: Long = OFFLINE_HOLD_MS,
) {
    sealed class Result {
        data class Heard(val text: String) : Result()
        data class Failed(val message: String) : Result()
    }

    private val pending = ByteArrayOutputStream()
    private val slices = Channel<ByteArray>(Channel.UNLIMITED)
    /** Slices handed to the sender (the next `seq`). */
    var sliceCount = 0
        private set
    /** Bytes of audio in this turn so far. */
    var totalBytes = 0L
        private set
    /** Bytes captured and not yet answered by the desktop. */
    var unsentBytes = 0L
        private set
    private var appended = 0
    private var failure: String? = null
    private var cancelled = false

    private val sender = scope.launch {
        for (slice in slices) {
            val open = withTimeoutOrNull(waitForLaneMs) { laneReady.first { it } }
            if (open == null) {
                failure = "Not connected to the desktop"
                return@launch
            }
            val body = JSONObject().put("kind", "voice-claude").put("op", "append")
                .put("turnId", turnId).put("seq", appended).put("data", Base64.getEncoder().encodeToString(slice))
            val res = try {
                link.request(body)
            } catch (e: IOException) {
                failure = e.message ?: "Not connected to the desktop"
                return@launch
            }
            if (res.optString("kind") == "failed") {
                failure = res.optString("message").ifBlank { "The desktop could not take the audio" }
                return@launch
            }
            appended++
            unsentBytes -= slice.size
        }
    }

    /** Seconds of audio in the turn, at 16 kHz mono PCM16. */
    val seconds: Double get() = totalBytes / BYTES_PER_SECOND.toDouble()

    /** True once the turn has reached its 60 s cap and must be finished. */
    val full: Boolean get() = totalBytes >= MAX_BYTES

    fun add(pcm: ShortArray) {
        if (cancelled || full) return
        val bytes = pcm16le(pcm)
        pending.write(bytes)
        totalBytes += bytes.size
        unsentBytes += bytes.size
        while (pending.size() >= SLICE_BYTES) {
            val all = pending.toByteArray()
            pending.reset()
            slices.trySend(all.copyOfRange(0, SLICE_BYTES))
            sliceCount++
            pending.write(all, SLICE_BYTES, all.size - SLICE_BYTES)
        }
    }

    /** The end of speech: last slice, every append answered, then `done`. */
    suspend fun finish(): Result {
        if (pending.size() > 0) {
            slices.trySend(pending.toByteArray())
            sliceCount++
            pending.reset()
        }
        slices.close()
        sender.join()
        failure?.let { return Result.Failed(it) }
        if (cancelled) return Result.Failed("Cancelled")
        if (appended == 0) return Result.Heard("")
        val res = try {
            link.request(JSONObject().put("kind", "voice-claude").put("op", "done").put("turnId", turnId).put("chunks", appended))
        } catch (e: IOException) {
            return Result.Failed(e.message ?: "Not connected to the desktop")
        }
        return when (res.optString("kind")) {
            "voice-heard" -> Result.Heard(res.optString("text", "").trim())
            else -> Result.Failed(res.optString("message").ifBlank { "That was not caught" })
        }
    }

    /** Drop the turn: nothing more is sent, and the desktop forgets what it holds. */
    fun cancel() {
        if (cancelled) return
        cancelled = true
        slices.close()
        sender.cancel()
        if (appended > 0 || sliceCount > 0) {
            scope.launch {
                try {
                    link.request(JSONObject().put("kind", "voice-claude").put("op", "cancel").put("turnId", turnId), 10_000L)
                } catch (e: CancellationException) {
                    throw e
                } catch (e: Exception) {
                    // Best effort: a new turnId on the next append discards it anyway.
                }
            }
        }
    }

    companion object {
        const val SAMPLE_RATE = 16_000
        const val BYTES_PER_SECOND = SAMPLE_RATE * 2
        /** One append: 10 frames of 100 ms = 1 s = 32000 raw bytes (under the 64 KiB slice cap). */
        const val SLICE_BYTES = 32_000
        /** The PWA caps a turn at 600 frames = 60 s. */
        const val MAX_BYTES = 60L * BYTES_PER_SECOND
        /** Audio held while the link is not up: 8 s, then the turn is dropped. */
        const val OFFLINE_HOLD_MS = 8_000L
        const val OFFLINE_HOLD_BYTES = 8L * BYTES_PER_SECOND

        fun pcm16le(pcm: ShortArray): ByteArray {
            val out = ByteArray(pcm.size * 2)
            for (i in pcm.indices) {
                val v = pcm[i].toInt()
                out[i * 2] = (v and 0xff).toByte()
                out[i * 2 + 1] = ((v shr 8) and 0xff).toByte()
            }
            return out
        }
    }
}
