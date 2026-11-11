package com.forge.bubble.link

import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.withTimeoutOrNull
import org.json.JSONObject
import java.io.IOException
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap

enum class LinkState { SIGNED_OUT, NEED_PIN, CONNECTING, ONLINE, OFFLINE, LOCKED, STOPPED }

/**
 * Where the link stands. [reason] is a plain sentence for OFFLINE / STOPPED /
 * NEED_PIN; [retryAt] is the epoch-ms the desktop said to come back (LOCKED).
 */
data class LinkStatus(
    val state: LinkState,
    val reason: String = "",
    val retryAt: Long = 0L,
    val pinWrong: Boolean = false,
    val desktopName: String = "",
)

/** The socket closed (or was never open) while a request waited. */
open class LinkDown(message: String) : IOException(message)

/** The desktop did not answer a request in time. */
class RequestTimeout(message: String) : LinkDown(message)

/** Frames the link does not consume itself. All calls arrive on the link's scope. */
interface LinkListener {
    fun onOnline(helloOk: JSONObject) {}
    fun onFrame(frame: JSONObject) {}
    fun onOffline() {}
}

/** Timings, injectable so the tests need not wait 15 s. Defaults are the PWA's (wire spec 1.12). */
data class LinkTiming(
    val backoffMs: List<Long> = listOf(500L, 1_000L, 2_000L, 4_000L, 8_000L, 15_000L),
    val helloTimeoutMs: Long = 10_000L,
    val tokenRefreshMs: Long = 50 * 60_000L,
    /** A `busy` refusal with no retryAfterMs (not expected): wait this long. */
    val busyFallbackMs: Long = 60_000L,
)

/**
 * Forge Bubble's end of the Forge Web wire (shared/web.ts; bubble/docs/wire-spec.md).
 *
 * Token → host lookup → `wss://HOST/web` with subprotocol `forge-web.v2` and no
 * Origin → `hello` → `hello-ok` or `refused`. Then request/result by `rid`, an
 * `auth` frame every 50 minutes, and reconnect with backoff 0.5 s → 15 s, the
 * host looked up again before every try (quick-tunnel names change).
 *
 * PIN safety comes first (spec 1.13): the lockout is per account and also locks
 * the owner's own PWA. A `pin-invalid` forgets the PIN — in RAM and in the
 * store — and the link does not dial again until [submitPin] gives a new one.
 * A `busy` is waited out exactly. A PIN is never invented or replayed after a
 * refusal; re-sending a still-good PIN on a plain reconnect is what both other
 * clients do and is fine.
 *
 * Everything runs on [scope], which must be single-threaded (BubbleEngine's).
 */
class ForgeLink(
    private val config: LinkConfig,
    private val store: KeyValueStore,
    private val tokens: TokenSource,
    private val lookup: HostLookup,
    private val transport: Transport,
    private val scope: CoroutineScope,
    private val timing: LinkTiming = LinkTiming(),
    private val now: () -> Long = System::currentTimeMillis,
) {
    private val _status = MutableStateFlow(LinkStatus(LinkState.STOPPED))
    val status: StateFlow<LinkStatus> = _status.asStateFlow()

    var listener: LinkListener? = null

    private var loop: Job? = null
    private val kicks = Channel<Unit>(Channel.CONFLATED)
    @Volatile private var conn: Conn? = null
    @Volatile private var online = false
    private val pending = ConcurrentHashMap<String, CompletableDeferred<JSONObject>>()
    private var ridSeq = 0L

    @Volatile private var pin: String? = store.get(K_PIN)
    private var rememberPin = pin != null
    /** The desktop asked for a PIN; until one is submitted the link waits rather than dials. */
    private var needPin = false
    private var pinWrong = false
    private var badTokens = 0
    private var forceRefresh = false
    private var desktopName = ""

    val isOnline: Boolean get() = online

    fun deviceId(): String = store.get(K_DEVICE) ?: UUID.randomUUID().toString().also { store.put(K_DEVICE, it) }

    /** Begin (or keep) trying to be online. */
    fun start() {
        if (loop?.isActive == true) {
            kick()
            return
        }
        loop = scope.launch { runLoop() }
    }

    /** Drop the socket and stop trying; credentials and a remembered PIN stay. */
    fun stop(reason: String = "") {
        loop?.cancel()
        loop = null
        conn?.close(1000, "stopped")
        set(LinkStatus(LinkState.STOPPED, reason))
    }

    /** Wake a loop waiting on sign-in or a PIN. */
    fun kick() {
        kicks.trySend(Unit)
    }

    /** A PIN typed by the human. False when it is not 4 to 12 digits. */
    fun submitPin(digits: String, remember: Boolean): Boolean {
        val clean = digits.trim()
        if (!PIN_RE.matches(clean)) return false
        pin = clean
        rememberPin = remember
        if (!remember) store.remove(K_PIN)
        kick()
        return true
    }

    /** Forget the PIN everywhere (sign-out, or the human said so). */
    fun forgetPin() {
        pin = null
        rememberPin = false
        store.remove(K_PIN)
    }

    /** Close the socket now (a dead long poll); the loop reconnects. */
    fun drop(reason: String) {
        conn?.close(4000, reason.take(100))
    }

    fun send(frame: JSONObject): Boolean = if (online) conn?.send(frame.toString()) ?: false else false

    /**
     * A `request`, answered on its `rid`. Returns the result body (which may be
     * `kind: failed`). Throws [LinkDown] when the link is down or closes, and
     * [RequestTimeout] after [timeoutMs].
     */
    suspend fun request(body: JSONObject, timeoutMs: Long = REQUEST_TIMEOUT_MS): JSONObject {
        val c = conn
        if (c == null || !online) throw LinkDown("Not connected")
        val rid = "b${++ridSeq}"
        val reply = CompletableDeferred<JSONObject>()
        pending[rid] = reply
        try {
            if (!c.send(JSONObject().put("type", "request").put("rid", rid).put("body", body).toString())) {
                throw LinkDown("Not connected")
            }
            return withTimeoutOrNull(timeoutMs) { reply.await() } ?: throw RequestTimeout("The desktop did not answer")
        } finally {
            pending.remove(rid)
        }
    }

    /* ------------------------------------------------------------- the loop */

    private sealed class Outcome {
        object SignedOut : Outcome()
        data class Absent(val reason: String) : Outcome()
        data class Dropped(val wasOnline: Boolean, val reason: String, val shutdown: JSONObject?) : Outcome()
        data class Refused(val reason: String, val message: String, val retryAfterMs: Long) : Outcome()
    }

    private fun set(s: LinkStatus) {
        _status.value = s.copy(desktopName = s.desktopName.ifBlank { desktopName })
    }

    private suspend fun waitUntil(ready: () -> Boolean) {
        while (!ready()) kicks.receive()
    }

    private fun backoff(attempt: Int): Long = timing.backoffMs[attempt.coerceIn(0, timing.backoffMs.size - 1)]

    private suspend fun runLoop() {
        var attempt = 0
        while (true) {
            if (!tokens.signedIn()) {
                set(LinkStatus(LinkState.SIGNED_OUT, "Sign in to Forge"))
                waitUntil { tokens.signedIn() }
                attempt = 0
                continue
            }
            if (needPin && pin == null) {
                set(LinkStatus(LinkState.NEED_PIN, if (pinWrong) "Wrong PIN" else "Enter the desktop's PIN", pinWrong = pinWrong))
                waitUntil { pin != null || !tokens.signedIn() }
                continue
            }
            when (val o = connectOnce()) {
                Outcome.SignedOut -> continue
                is Outcome.Absent -> {
                    set(LinkStatus(LinkState.OFFLINE, o.reason))
                    delay(backoff(attempt++))
                }
                is Outcome.Dropped -> {
                    if (o.wasOnline) attempt = 0
                    val shut = o.shutdown
                    if (shut?.optString("reason") == "disabled") {
                        set(LinkStatus(LinkState.STOPPED, "Forge Web is turned off on the desktop"))
                        return
                    }
                    val said = shut?.optString("message").orEmpty()
                    set(LinkStatus(LinkState.OFFLINE, said.ifBlank { o.reason }))
                    val asked = shut?.optLong("retryAfterMs", 0L) ?: 0L
                    delay(maxOf(backoff(attempt++), asked))
                }
                is Outcome.Refused -> when (o.reason) {
                    "pin-required" -> {
                        // Not a strike: the desktop has a PIN and none was sent.
                        needPin = true
                        pin = null
                    }
                    "pin-invalid" -> {
                        // A strike. Forget it everywhere; never replay it.
                        needPin = true
                        pinWrong = true
                        forgetPin()
                    }
                    "bad-token" -> {
                        badTokens++
                        if (badTokens >= 2) {
                            badTokens = 0
                            tokens.signOut()
                            set(LinkStatus(LinkState.SIGNED_OUT, "Sign in again"))
                        } else {
                            // Silently, once: a fresh token and straight back.
                            forceRefresh = true
                        }
                    }
                    "busy" -> {
                        val wait = o.retryAfterMs.takeIf { it > 0 } ?: timing.busyFallbackMs
                        set(LinkStatus(LinkState.LOCKED, o.message.ifBlank { "The desktop is busy" }, retryAt = now() + wait))
                        // Exactly as long as the desktop said: dialling early is how a strike is earned.
                        delay(wait)
                    }
                    "wrong-account" -> {
                        set(LinkStatus(LinkState.STOPPED, "This phone is signed in to a different account than the desktop"))
                        return
                    }
                    "not-approved" -> {
                        set(LinkStatus(LinkState.STOPPED, o.message.ifBlank { "The desktop did not let this phone in" }))
                        return
                    }
                    "proto" -> {
                        set(LinkStatus(LinkState.STOPPED, o.message.ifBlank { "Forge Bubble and the desktop speak different versions" }))
                        return
                    }
                    else -> {
                        set(LinkStatus(LinkState.STOPPED, o.message.ifBlank { "The desktop refused: ${o.reason}" }))
                        return
                    }
                }
            }
        }
    }

    private suspend fun connectOnce(): Outcome {
        set(LinkStatus(LinkState.CONNECTING))
        val token = try {
            tokens.idToken(forceRefresh)
        } catch (e: IOException) {
            return Outcome.Absent("Could not reach Firebase")
        }
        forceRefresh = false
        if (token == null) return Outcome.SignedOut
        val found = try {
            lookup.find(tokens.uid().orEmpty(), token)
        } catch (e: IOException) {
            Lookup.Absent("No network")
        }
        return when (found) {
            is Lookup.Absent -> Outcome.Absent(found.reason)
            is Lookup.Found -> dial(found.url, token)
        }
    }

    private suspend fun dial(url: String, token: String): Outcome {
        val closed = CompletableDeferred<String>()
        var refused: JSONObject? = null
        var shutdown: JSONObject? = null
        var helloTimer: Job? = null
        var refresher: Job? = null
        var c: Conn? = null
        var dropReason = ""

        val handler = object : TransportListener {
            override fun onOpen() {
                scope.launch {
                    val socket = c ?: return@launch
                    val hello = JSONObject()
                        .put("type", "hello")
                        .put("proto", PROTO)
                        .put("idToken", token)
                        .put("client", config.clientName.take(32))
                        .put("deviceId", deviceId())
                        .put("deviceName", config.deviceName.take(64))
                    pin?.let { hello.put("pin", it) }
                    socket.send(hello.toString())
                    helloTimer = scope.launch {
                        delay(timing.helloTimeoutMs)
                        if (!online && refused == null) {
                            dropReason = "The desktop did not answer"
                            socket.close(4000, "no hello-ok")
                        }
                    }
                }
            }

            override fun onMessage(text: String) {
                scope.launch {
                    val f = runCatching { JSONObject(text) }.getOrNull() ?: return@launch
                    when (f.optString("type")) {
                        "hello-ok" -> {
                            helloTimer?.cancel()
                            online = true
                            badTokens = 0
                            needPin = false
                            pinWrong = false
                            desktopName = f.optString("desktopName", desktopName)
                            val p = pin
                            if (p != null && rememberPin) store.put(K_PIN, p)
                            set(LinkStatus(LinkState.ONLINE))
                            if (tokens.refreshes) refresher = scope.launch { refreshLoop(c) }
                            listener?.onOnline(f)
                        }
                        "refused" -> refused = f
                        "shutdown" -> shutdown = f
                        "result" -> pending[f.optString("rid")]?.complete(f.optJSONObject("body") ?: JSONObject())
                        else -> if (online) listener?.onFrame(f)
                    }
                }
            }

            // Hopped like the frames, so a `refused` read just before the close is handled first.
            override fun onClosed(code: Int, reason: String) {
                scope.launch { closed.complete(reason.ifBlank { "Connection closed ($code)" }) }
            }

            override fun onFailure(message: String) {
                scope.launch { closed.complete(message) }
            }
        }

        c = transport.open(url, handler)
        conn = c
        try {
            val why = closed.await()
            val r = refused
            if (r != null) {
                return Outcome.Refused(r.optString("reason"), r.optString("message"), r.optLong("retryAfterMs", 0L))
            }
            val wasOnline = online
            val reason = dropReason.ifBlank { if (wasOnline) "Connection lost" else why.ifBlank { "Could not reach the desktop" } }
            return Outcome.Dropped(wasOnline, reason, shutdown)
        } finally {
            helloTimer?.cancel()
            refresher?.cancel()
            val wasOnline = online
            online = false
            if (conn === c) conn = null
            c.close(1000, "bye")
            pending.values.forEach { it.completeExceptionally(LinkDown("Connection closed")) }
            pending.clear()
            if (wasOnline) listener?.onOffline()
        }
    }

    private suspend fun refreshLoop(socket: Conn?) {
        var n = 0
        while (true) {
            delay(timing.tokenRefreshMs)
            if (!online) continue
            // A failed refresh does nothing: the next bad-token refusal re-authenticates.
            val fresh = try {
                tokens.idToken(force = true)
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                null
            } ?: continue
            socket?.send(JSONObject().put("type", "auth").put("rid", "a${++n}").put("idToken", fresh).toString())
        }
    }

    companion object {
        const val PROTO = 2
        const val REQUEST_TIMEOUT_MS = 30_000L
        const val K_PIN = "link.pin"
        const val K_DEVICE = "link.deviceId"
        private val PIN_RE = Regex("^\\d{4,12}$")
    }
}
