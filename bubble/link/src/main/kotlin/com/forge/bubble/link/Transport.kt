package com.forge.bubble.link

import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import org.json.JSONObject
import java.io.IOException
import java.net.URLEncoder
import java.util.concurrent.TimeUnit

/** One WebSocket, as the link needs it. A seam so tests can play the desktop. */
interface Transport {
    fun open(url: String, listener: TransportListener): Conn
}

interface Conn {
    fun send(text: String): Boolean
    fun close(code: Int, reason: String)
}

/** Called on the transport's own thread; the link hops to its own. */
interface TransportListener {
    fun onOpen()
    fun onMessage(text: String)
    fun onClosed(code: Int, reason: String)
    fun onFailure(message: String)
}

/**
 * The real socket: OkHttp, with the `forge-web.v2` subprotocol (else HTTP 400)
 * and NO `Origin` header (wire spec 1.4) — OkHttp sends none unless asked, and
 * this never asks. permessage-deflate is negotiated by OkHttp itself.
 */
class OkHttpTransport(
    private val http: OkHttpClient = defaultSocketClient(),
) : Transport {
    override fun open(url: String, listener: TransportListener): Conn {
        val req = Request.Builder().url(url).header("Sec-WebSocket-Protocol", SUBPROTOCOL).build()
        val ws = http.newWebSocket(req, object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: Response) = listener.onOpen()
            override fun onMessage(webSocket: WebSocket, text: String) = listener.onMessage(text)
            override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
                webSocket.close(1000, null)
            }
            override fun onClosed(webSocket: WebSocket, code: Int, reason: String) = listener.onClosed(code, reason)
            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                val why = when (response?.code) {
                    400 -> "The desktop refused the connection (400)"
                    403 -> "The desktop refused this address (403)"
                    null -> "Could not reach the desktop"
                    else -> "The desktop answered ${response.code}"
                }
                listener.onFailure(why)
            }
        })
        return object : Conn {
            override fun send(text: String) = ws.send(text)
            override fun close(code: Int, reason: String) {
                if (!ws.close(code, reason)) ws.cancel()
            }
        }
    }

    companion object {
        const val SUBPROTOCOL = "forge-web.v2"

        /** Dial deadline 8 s like the PWA; no read timeout on a long-lived socket; ping so a dead one is noticed. */
        fun defaultSocketClient(): OkHttpClient = OkHttpClient.Builder()
            .connectTimeout(8, TimeUnit.SECONDS)
            .readTimeout(0, TimeUnit.MILLISECONDS)
            .pingInterval(20, TimeUnit.SECONDS)
            .build()
    }
}

/** Where the desktop is right now. */
sealed class Lookup {
    data class Found(val url: String) : Lookup()
    /** Not there (off, asleep, stale, other version) or not readable; [reason] is for people. */
    data class Absent(val reason: String) : Lookup()
}

fun interface HostLookup {
    /** Throws [IOException] when the network itself failed. */
    suspend fun find(uid: String, idToken: String): Lookup
}

/** Tests and the dev server: always this URL, no lookup. */
class DirectLookup(private val url: String) : HostLookup {
    override suspend fun find(uid: String, idToken: String): Lookup = Lookup.Found(url)
}

/**
 * `GET <databaseUrl>/users/<uid>/host.json?auth=<idToken>` (wire spec 1.3): a
 * bare hostname, protocol 2, heartbeat younger than 3 minutes — else the
 * desktop is absent and is not dialled.
 */
class RtdbHostLookup(
    private val databaseUrl: String,
    private val http: OkHttpClient = OkHttpClient.Builder()
        .connectTimeout(8, TimeUnit.SECONDS)
        .readTimeout(8, TimeUnit.SECONDS)
        .build(),
    private val now: () -> Long = System::currentTimeMillis,
) : HostLookup {
    override suspend fun find(uid: String, idToken: String): Lookup = kotlinx.coroutines.withContext(kotlinx.coroutines.Dispatchers.IO) {
        if (uid.isBlank()) return@withContext Lookup.Absent("Not signed in")
        if (databaseUrl.isBlank()) return@withContext Lookup.Absent("Forge Web is not configured in this build")
        val url = "${databaseUrl.trimEnd('/')}/users/$uid/host.json?auth=${URLEncoder.encode(idToken, "UTF-8")}"
        http.newCall(Request.Builder().url(url).get().build()).execute().use { resp ->
            val text = resp.body?.string().orEmpty()
            if (!resp.isSuccessful) {
                return@withContext Lookup.Absent(
                    if (resp.code == 401 || resp.code == 403) "Firebase refused the lookup" else "Firebase answered ${resp.code}"
                )
            }
            parseHost(text, now())
        }
    }

    companion object {
        const val PROTO = 2
        const val HOST_STALE_MS = 3 * 60_000L
        private val HOST_RE = Regex("^[a-z0-9]([a-z0-9-]{0,62})?(\\.[a-z0-9]([a-z0-9-]{0,62})?)+$")

        /** The host record to a URL to dial, or why not. */
        fun parseHost(text: String, now: Long): Lookup {
            if (text.isBlank() || text == "null") return Lookup.Absent("The desktop is off")
            val j = runCatching { JSONObject(text) }.getOrNull() ?: return Lookup.Absent("The desktop is off")
            val host = normaliseHost(j.optString("host", ""))
            if (host.isBlank()) return Lookup.Absent("The desktop is off")
            if (j.optInt("proto", -1) != PROTO) return Lookup.Absent("The desktop speaks another version")
            if (now - j.optLong("at", 0L) >= HOST_STALE_MS) return Lookup.Absent("The desktop is off or asleep")
            return Lookup.Found("wss://$host/web")
        }

        /** shared/web.ts `normaliseHost`: a bare lowercase hostname, or "". */
        fun normaliseHost(raw: String): String {
            val host = raw.trim().lowercase()
                .replace(Regex("^wss?://"), "")
                .replace(Regex("^https?://"), "")
                .replace(Regex("[/?#].*$"), "")
                .replace(Regex(":\\d+$"), "")
            return if (HOST_RE.matches(host)) host else ""
        }
    }
}
