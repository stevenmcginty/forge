package com.forge.bubble.link

import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.withTimeoutOrNull
import org.json.JSONObject
import java.util.Collections
import kotlin.math.PI
import kotlin.math.sin

/** Plays the desktop's end of a socket: the test pushes frames and closes. */
class FakeTransport : Transport {
    inner class FakeConn(val url: String, val listener: TransportListener) : Conn {
        val sent: MutableList<JSONObject> = Collections.synchronizedList(mutableListOf())
        @Volatile var closed = false

        override fun send(text: String): Boolean {
            if (closed) return false
            sent += JSONObject(text)
            return true
        }

        override fun close(code: Int, reason: String) {
            if (closed) return
            closed = true
            listener.onClosed(code, reason)
        }

        fun hello(): JSONObject? = synchronized(sent) { sent.firstOrNull { it.optString("type") == "hello" } }

        fun serverSend(frame: JSONObject) = listener.onMessage(frame.toString())

        fun refuse(reason: String, retryAfterMs: Long = 0L, message: String = "") {
            val f = JSONObject().put("type", "refused").put("reason", reason)
            if (retryAfterMs > 0) f.put("retryAfterMs", retryAfterMs)
            if (message.isNotEmpty()) f.put("message", message)
            serverSend(f)
            serverClose(4001)
        }

        fun serverClose(code: Int = 1001) {
            if (closed) return
            closed = true
            listener.onClosed(code, "")
        }
    }

    val conns: MutableList<FakeConn> = Collections.synchronizedList(mutableListOf())

    override fun open(url: String, listener: TransportListener): Conn {
        val c = FakeConn(url, listener)
        conns += c
        listener.onOpen()
        return c
    }
}

class FakeTokens : TokenSource {
    @Volatile var held = true
    @Volatile var forced = 0
    override fun signedIn() = held
    override fun uid() = "uid"
    override suspend fun idToken(force: Boolean): String? {
        if (force) forced++
        return if (held) "jwt-${forced}" else null
    }
    override fun signOut() { held = false }
    override val refreshes: Boolean get() = false
}

/** Records every clip; each play lasts [playMs] unless stopped. */
class FakePlayer(private val playMs: Long = 50L) : ClipPlayer {
    data class Played(val audio: ByteArray, val mime: String)
    val played: MutableList<Played> = Collections.synchronizedList(mutableListOf())
    @Volatile var stops = 0
    @Volatile private var current: CompletableDeferred<Unit>? = null

    override suspend fun play(audio: ByteArray, mime: String) {
        played += Played(audio, mime)
        val done = CompletableDeferred<Unit>()
        current = done
        withTimeoutOrNull(playMs) { done.await() }
    }

    override fun stop() {
        stops++
        current?.complete(Unit)
    }
}

suspend fun <T> StateFlow<T>.await(timeoutMs: Long, what: String, test: (T) -> Boolean): T =
    withTimeoutOrNull(timeoutMs) { first(test) } ?: throw AssertionError("timed out after $timeoutMs ms waiting for $what; last: $value")

suspend fun waitFor(timeoutMs: Long, what: String, test: suspend () -> Boolean) {
    val until = System.currentTimeMillis() + timeoutMs
    while (System.currentTimeMillis() < until) {
        if (test()) return
        kotlinx.coroutines.delay(25)
    }
    throw AssertionError("timed out after $timeoutMs ms waiting for $what")
}

/** 100 ms of 16 kHz mono PCM16: a 300 Hz tone at [amplitude], or near-silence. */
fun pcmFrame(amplitude: Int, offset: Int = 0): ShortArray =
    ShortArray(1600) { i -> (sin(2 * PI * 300 * (offset + i) / 16_000.0) * amplitude).toInt().toShort() }

fun isWav(audio: ByteArray): Boolean =
    audio.size > 44 && String(audio, 0, 4, Charsets.US_ASCII) == "RIFF" && String(audio, 8, 4, Charsets.US_ASCII) == "WAVE"
