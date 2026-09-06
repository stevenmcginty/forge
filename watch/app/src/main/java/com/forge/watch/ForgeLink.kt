package com.forge.watch

import android.content.Context
import android.os.Build
import android.util.Log
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.collect
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch
import kotlinx.coroutines.withTimeoutOrNull
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import org.json.JSONArray
import org.json.JSONObject
import java.net.URLEncoder
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.TimeUnit

/**
 * The watch's end of the Forge Web wire (shared/web.ts), in Kotlin.
 *
 * The same three steps a browser takes: a Firebase ID token from ForgeAuth,
 * one GET against the Realtime Database to learn where the desktop is
 * (`users/<uid>/host`), then a WebSocket to `wss://<host>/web` opened with
 * `hello`. The desktop answers `pin-required` on a fresh connection; the PIN is
 * asked once per app process and held in RAM only, exactly as the web page
 * holds it — never written down.
 *
 * What the watch does with the link is deliberately small: read the project
 * list and the split trees, open a tab, and type. It never sends a size wish
 * (`attach` without cols/rows), so typing from the wrist never reshapes a pane
 * on the desk — see the grid-ownership note on `WebAttachFrame`.
 */
object ForgeLink {
    private const val TAG = "ForgeWatch"
    const val PROTO = 2
    private const val SUBPROTOCOL = "forge-web.v2"
    private const val WS_PATH = "/web"
    private const val HOST_STALE_MS = 3 * 60_000L
    private const val TOKEN_REFRESH_MS = 50 * 60_000L
    private const val CLIENT = "forge-watch/" + BuildConfig.VERSION_NAME
    private const val REQUEST_TIMEOUT_MS = 15_000L
    private const val ABSENT_RETRY_MS = 30_000L

    /** How long a pane must stay silent, after saying something, to count as ready. */
    private const val QUIET_MS = 1_500L
    /** The beat between the words and the Enter. Same as web's SETTLE_BEFORE_ENTER_MS. */
    private const val SETTLE_BEFORE_ENTER_MS = 120L

    enum class State { OFF, SIGNED_OUT, FINDING, ABSENT, CONNECTING, PIN, LIVE, REFUSED }

    data class Project(val id: String, val name: String, val defaultProfileId: String)
    data class Profile(val id: String, val name: String)
    data class Tab(val id: String, val title: String, val activePaneId: String, val paneIds: List<String>)
    data class Workspace(val tabs: List<Tab>, val activeTabId: String?)

    val state = MutableStateFlow(State.OFF)
    /** A sentence for the status line, when the state alone is not enough. */
    val detail = MutableStateFlow("")
    val desktopName = MutableStateFlow("")
    val projects = MutableStateFlow<List<Project>>(emptyList())
    val profiles = MutableStateFlow<List<Profile>>(emptyList())
    val workspaces = MutableStateFlow<Map<String, Workspace>>(emptyMap())
    val sessions = MutableStateFlow<Set<String>>(emptySet())
    /** The project voice commands act on. Chosen by "open <project>", never by the desk. */
    val currentProjectId = MutableStateFlow<String?>(null)
    /** True while the desktop is waiting on a PIN this process has not got. */
    val pinNeeded = MutableStateFlow(false)
    val pinWasWrong = MutableStateFlow(false)

    private lateinit var app: Context
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    private val http = OkHttpClient.Builder()
        .connectTimeout(8, TimeUnit.SECONDS)
        .readTimeout(0, TimeUnit.MILLISECONDS)
        .pingInterval(30, TimeUnit.SECONDS)
        .build()

    private val wanters = mutableSetOf<String>()
    private var loop: Job? = null
    @Volatile private var socket: WebSocket? = null
    private var closed: CompletableDeferred<Unit>? = null
    private val pending = ConcurrentHashMap<String, CompletableDeferred<JSONObject>>()
    @Volatile private var pin: String? = null
    private var pinArrived: CompletableDeferred<Unit>? = null
    /** From a `busy` refusal: the desktop said when to come back. */
    @Volatile private var retryAfterMs = 0L

    private val lastDataAt = ConcurrentHashMap<String, Long>()
    private val dataSeen = ConcurrentHashMap<String, Int>()

    fun init(ctx: Context) {
        app = ctx.applicationContext
        currentProjectId.value = app.getSharedPreferences("forge-link", Context.MODE_PRIVATE)
            .getString("projectId", null)
        scope.launch {
            currentProjectId.collect { id ->
                app.getSharedPreferences("forge-link", Context.MODE_PRIVATE).edit()
                    .putString("projectId", id).apply()
            }
        }
    }

    private fun deviceId(): String {
        val p = app.getSharedPreferences("forge-link", Context.MODE_PRIVATE)
        return p.getString("deviceId", null) ?: UUID.randomUUID().toString().also {
            p.edit().putString("deviceId", it).apply()
        }
    }

    /**
     * Who wants the link up. The voice screen while it is showing, the
     * dictation service while it is listening. Nobody: the socket closes.
     */
    @Synchronized
    fun setWanted(who: String, wanted: Boolean) {
        if (wanted) wanters += who else wanters -= who
        if (wanters.isNotEmpty() && loop?.isActive != true) {
            loop = scope.launch { runLoop() }
        } else if (wanters.isEmpty()) {
            loop?.cancel()
            loop = null
            socket?.close(1000, "idle")
            socket = null
            state.value = State.OFF
        }
    }

    /** Sign-in just happened, or the PIN arrived: try again now rather than after the backoff. */
    fun kick() {
        synchronized(this) {
            if (wanters.isEmpty()) return
            loop?.cancel()
            loop = scope.launch { runLoop() }
        }
    }

    fun providePin(p: String) {
        pin = p
        pinNeeded.value = false
        pinWasWrong.value = false
        pinArrived?.complete(Unit)
    }

    private suspend fun runLoop() {
        var backoffMs = 1_000L
        while (true) {
            val outcome = runCatching { connectOnce() }
            if (outcome.isFailure) Log.i(TAG, "link: ${outcome.exceptionOrNull()?.message}")
            // Whatever happened, the socket is gone by now: a state that still
            // says otherwise is a status line telling a lie during the backoff.
            if (state.value == State.LIVE || state.value == State.CONNECTING) {
                state.value = State.FINDING
                if (outcome.isFailure) detail.value = outcome.exceptionOrNull()?.message ?: "Connection lost"
            }
            when (state.value) {
                State.SIGNED_OUT, State.REFUSED, State.OFF -> return
                State.PIN -> {
                    val gate = CompletableDeferred<Unit>().also { pinArrived = it }
                    gate.await()
                    backoffMs = 1_000L
                    continue
                }
                State.ABSENT -> delay(ABSENT_RETRY_MS)
                else -> {
                    // A `busy` refusal names its own wait — the desktop's lockout
                    // counts strikes, and dialling early is how a strike is earned.
                    val wait = retryAfterMs.takeIf { it > 0 } ?: backoffMs
                    retryAfterMs = 0L
                    delay(wait)
                    backoffMs = (backoffMs * 2).coerceAtMost(30_000L)
                }
            }
        }
    }

    /** One full attempt: token, rendezvous, dial, and then the life of that socket. */
    private suspend fun connectOnce() {
        if (!ForgeAuth.configured) {
            state.value = State.REFUSED
            detail.value = "Not configured"
            return
        }
        state.value = State.FINDING
        detail.value = ""
        val token = ForgeAuth.idToken(app)
        if (token == null) {
            state.value = State.SIGNED_OUT
            return
        }
        val uid = ForgeAuth.uid(app).orEmpty()
        val host = readHost(uid, token)
        if (host == null) {
            state.value = State.ABSENT
            if (detail.value.isBlank()) detail.value = "Desktop is off"
            return
        }
        dial(host, token)
    }

    /** `users/<uid>/host` over REST. The hostname to dial, or null when the desktop is not there. */
    private fun readHost(uid: String, token: String): String? {
        if (uid.isBlank()) return null
        val url = "${BuildConfig.FORGE_DB_URL}/users/$uid/host.json?auth=${URLEncoder.encode(token, "UTF-8")}"
        val req = Request.Builder().url(url).get().build()
        http.newCall(req).execute().use { resp ->
            val text = resp.body?.string().orEmpty()
            if (!resp.isSuccessful) {
                detail.value = if (resp.code == 401 || resp.code == 403) "Firebase refused the lookup" else "Firebase answered ${resp.code}"
                return null
            }
            if (text.isBlank() || text == "null") return null
            val j = runCatching { JSONObject(text) }.getOrNull() ?: return null
            val host = normaliseHost(j.optString("host", ""))
            if (host.isBlank()) return null
            desktopName.value = j.optString("name", "")
            if (j.optInt("proto", -1) != PROTO) {
                detail.value = "Desktop speaks another version"
                return null
            }
            val at = j.optLong("at", 0L)
            if (System.currentTimeMillis() - at >= HOST_STALE_MS) return null
            return host
        }
    }

    /** Same rule as `normaliseHost` in shared/web.ts: a bare lowercase hostname or nothing. */
    private fun normaliseHost(raw: String): String {
        val host = raw.trim().lowercase()
            .replace(Regex("^wss?://"), "")
            .replace(Regex("^https?://"), "")
            .replace(Regex("[/?#].*$"), "")
            .replace(Regex(":\\d+$"), "")
        return if (Regex("^[a-z0-9]([a-z0-9-]{0,62})?(\\.[a-z0-9]([a-z0-9-]{0,62})?)+$").matches(host)) host else ""
    }

    private suspend fun dial(host: String, token: String) {
        state.value = State.CONNECTING
        val done = CompletableDeferred<Unit>().also { closed = it }
        val req = Request.Builder()
            .url("wss://$host$WS_PATH")
            .header("Sec-WebSocket-Protocol", SUBPROTOCOL)
            .build()
        val ws = http.newWebSocket(req, object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: Response) {
                Log.i(TAG, "socket open to $host, pin=${if (pin != null) "yes" else "no"}")
                val hello = JSONObject()
                    .put("type", "hello")
                    .put("proto", PROTO)
                    .put("idToken", token)
                    .put("client", CLIENT)
                    .put("deviceId", deviceId())
                    .put("deviceName", "Forge Watch (${Build.MODEL})")
                pin?.let { hello.put("pin", it) }
                webSocket.send(hello.toString())
            }

            override fun onMessage(webSocket: WebSocket, text: String) {
                runCatching { onFrame(JSONObject(text)) }
                    .onFailure { Log.i(TAG, "bad frame: ${it.message}") }
            }

            override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
                webSocket.close(1000, null)
            }

            override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
                done.complete(Unit)
            }

            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                Log.i(TAG, "socket failed: ${t.message}")
                if (state.value == State.CONNECTING) detail.value = "Could not reach the desktop"
                done.complete(Unit)
            }
        })
        socket = ws
        val refresher = scope.launch {
            while (true) {
                delay(TOKEN_REFRESH_MS)
                if (state.value != State.LIVE) continue
                val fresh = runCatching { ForgeAuth.idToken(app, force = true) }.getOrNull() ?: continue
                val rid = UUID.randomUUID().toString()
                ws.send(JSONObject().put("type", "auth").put("rid", rid).put("idToken", fresh).toString())
            }
        }
        try {
            done.await()
        } finally {
            refresher.cancel()
            if (socket === ws) socket = null
            pending.values.forEach { it.completeExceptionally(IllegalStateException("Connection closed")) }
            pending.clear()
            sessions.value = emptySet()
            if (state.value == State.LIVE) {
                state.value = State.FINDING
                detail.value = "Reconnecting"
            }
        }
    }

    private fun onFrame(f: JSONObject) {
        when (f.optString("type")) {
            "hello-ok" -> {
                desktopName.value = f.optString("desktopName", desktopName.value)
                projects.value = parseProjects(f.optJSONArray("projects"))
                profiles.value = parseProfiles(f.optJSONArray("profiles"))
                workspaces.value = parseWorkspaces(f.optJSONObject("workspaces"))
                sessions.value = parseSessions(f.optJSONArray("sessions"))
                // A project that has gone is forgotten; none is never guessed.
                // Landing the wrist in the first project on the rail meant
                // talking to an agent nobody chose.
                if (projects.value.none { it.id == currentProjectId.value }) currentProjectId.value = null
                pinNeeded.value = false
                detail.value = ""
                state.value = State.LIVE
                Log.i(TAG, "live on ${desktopName.value}: projects=${projects.value.map { it.name }} profiles=${profiles.value.map { it.name }} sessions=${sessions.value.size}")
                // A socket that never says is treated as hidden and gets no
                // `data`, and quiet-after-banner is how the watch tells a pane
                // is ready to be typed into.
                send(JSONObject().put("type", "request").put("rid", UUID.randomUUID().toString())
                    .put("body", JSONObject().put("kind", "visibility").put("visible", true)))
            }
            "refused" -> onRefused(f)
            "sessions" -> sessions.value = parseSessions(f.optJSONArray("sessions"))
            "session-started" -> f.optJSONObject("session")?.optString("id")?.let { id ->
                if (id.isNotBlank()) sessions.value = sessions.value + id
            }
            "exit" -> f.optString("sessionId").let { id ->
                sessions.value = sessions.value - id
                lastDataAt.remove(id)
                dataSeen.remove(id)
            }
            "data", "replay" -> {
                val id = f.optString("sessionId")
                val len = f.optString("data", "").length
                if (len > 0) {
                    lastDataAt[id] = System.currentTimeMillis()
                    dataSeen[id] = (dataSeen[id] ?: 0) + len
                }
            }
            "projects" -> {
                projects.value = parseProjects(f.optJSONArray("projects"))
                if (projects.value.none { it.id == currentProjectId.value }) currentProjectId.value = null
            }
            "workspace" -> {
                val id = f.optString("projectId")
                val ws = parseWorkspace(f.optJSONObject("workspace"))
                if (id.isNotBlank() && ws != null) workspaces.value = workspaces.value + (id to ws)
            }
            "result" -> {
                val rid = f.optString("rid")
                pending.remove(rid)?.complete(f.optJSONObject("body") ?: JSONObject())
            }
            "error" -> Log.i(TAG, "desktop error: ${f.optString("code")} ${f.optString("message")}")
            "shutdown" -> {
                detail.value = when (f.optString("reason")) {
                    "sleep" -> "Desktop is asleep"
                    "disabled" -> "Forge Web is off"
                    else -> "Desktop is going away"
                }
            }
            "desktop" -> if (f.optString("state") == "recovering") detail.value = "Desktop is restarting its window"
            else -> {}
        }
    }

    private fun onRefused(f: JSONObject) {
        val reason = f.optString("reason")
        Log.i(TAG, "refused: $reason")
        when (reason) {
            "pin-required", "pin-invalid" -> {
                if (reason == "pin-invalid") {
                    pin = null
                    pinWasWrong.value = true
                }
                state.value = State.PIN
                pinNeeded.value = true
                detail.value = if (reason == "pin-invalid") "Wrong PIN" else "PIN needed"
            }
            "bad-token" -> {
                state.value = State.FINDING
                detail.value = "Signing in again"
                scope.launch { runCatching { ForgeAuth.idToken(app, force = true) } }
            }
            "busy" -> {
                state.value = State.FINDING
                retryAfterMs = f.optLong("retryAfterMs", 0L)
                detail.value = "Desktop is busy"
            }
            "wrong-account" -> {
                state.value = State.REFUSED
                detail.value = "Wrong account for this desktop"
            }
            "proto" -> {
                state.value = State.REFUSED
                detail.value = "Update the watch app"
            }
            else -> {
                state.value = State.REFUSED
                detail.value = "Refused: $reason"
            }
        }
    }

    /* ------------------------------------------------------------ parsing */

    private fun parseProjects(a: JSONArray?): List<Project> {
        val out = mutableListOf<Project>()
        if (a == null) return out
        for (i in 0 until a.length()) {
            val p = a.optJSONObject(i) ?: continue
            val id = p.optString("id")
            if (id.isBlank()) continue
            out += Project(id, p.optString("name", id), p.optString("defaultProfileId", ""))
        }
        return out
    }

    private fun parseProfiles(a: JSONArray?): List<Profile> {
        val out = mutableListOf<Profile>()
        if (a == null) return out
        for (i in 0 until a.length()) {
            val p = a.optJSONObject(i) ?: continue
            val id = p.optString("id")
            if (id.isBlank()) continue
            out += Profile(id, p.optString("name", id))
        }
        return out
    }

    private fun parseSessions(a: JSONArray?): Set<String> {
        val out = mutableSetOf<String>()
        if (a == null) return out
        for (i in 0 until a.length()) {
            val id = a.optJSONObject(i)?.optString("id").orEmpty()
            if (id.isNotBlank()) out += id
        }
        return out
    }

    private fun parseWorkspaces(o: JSONObject?): Map<String, Workspace> {
        val out = mutableMapOf<String, Workspace>()
        if (o == null) return out
        for (key in o.keys()) {
            parseWorkspace(o.optJSONObject(key))?.let { out[key] = it }
        }
        return out
    }

    private fun parseWorkspace(o: JSONObject?): Workspace? {
        if (o == null) return null
        val tabs = mutableListOf<Tab>()
        val arr = o.optJSONArray("tabs")
        if (arr != null) for (i in 0 until arr.length()) {
            val t = arr.optJSONObject(i) ?: continue
            val panes = mutableListOf<String>()
            leaves(t.optJSONObject("root"), panes)
            tabs += Tab(
                id = t.optString("id"),
                title = t.optString("title", ""),
                activePaneId = t.optString("activePaneId", panes.firstOrNull().orEmpty()),
                paneIds = panes,
            )
        }
        val active = o.optString("activeTabId", "").ifBlank { null }
        return Workspace(tabs, active)
    }

    /** Pane ids of a split tree, left to right. A leaf's id is its PTY session id. */
    private fun leaves(node: JSONObject?, into: MutableList<String>) {
        if (node == null) return
        when (node.optString("type")) {
            "leaf" -> node.optString("id").let { if (it.isNotBlank()) into += it }
            "split" -> {
                leaves(node.optJSONObject("a"), into)
                leaves(node.optJSONObject("b"), into)
            }
        }
    }

    /* ------------------------------------------------------------- actions */

    private fun send(frame: JSONObject): Boolean = socket?.send(frame.toString()) ?: false

    /** A `request`, answered on its `rid`. Throws when the link is down or the desktop stays silent. */
    suspend fun request(body: JSONObject): JSONObject {
        val rid = UUID.randomUUID().toString()
        val reply = CompletableDeferred<JSONObject>()
        pending[rid] = reply
        if (!send(JSONObject().put("type", "request").put("rid", rid).put("body", body))) {
            pending.remove(rid)
            throw IllegalStateException("Not connected")
        }
        return withTimeoutOrNull(REQUEST_TIMEOUT_MS) { reply.await() }
            ?: run { pending.remove(rid); throw IllegalStateException("The desktop did not answer") }
    }

    fun write(sessionId: String, data: String): Boolean =
        send(JSONObject().put("type", "write").put("sessionId", sessionId).put("data", data))

    /** Attach with no size wish, so the pane's grid stays with whoever typed there last. */
    fun attach(sessionId: String) {
        send(JSONObject().put("type", "attach").put("sessionId", sessionId))
    }

    fun detach(sessionId: String) {
        send(JSONObject().put("type", "detach").put("sessionId", sessionId))
    }

    fun currentProject(): Project? = projects.value.firstOrNull { it.id == currentProjectId.value }

    /** The pane voice input goes to: the active pane of the active tab of the current project. */
    fun currentPaneId(): String? {
        val ws = workspaces.value[currentProjectId.value ?: return null] ?: return null
        val tab = ws.tabs.firstOrNull { it.id == ws.activeTabId } ?: ws.tabs.firstOrNull() ?: return null
        return tab.activePaneId.ifBlank { tab.paneIds.firstOrNull() }
    }

    fun currentTab(): Tab? {
        val ws = workspaces.value[currentProjectId.value ?: return null] ?: return null
        return ws.tabs.firstOrNull { it.id == ws.activeTabId } ?: ws.tabs.firstOrNull()
    }

    suspend fun selectProject(projectId: String) {
        currentProjectId.value = projectId
        val body = JSONObject().put("kind", "layout")
            .put("op", JSONObject().put("op", "select-project").put("projectId", projectId))
        request(body).let { if (it.optString("kind") == "failed") throw IllegalStateException(it.optString("message")) }
    }

    suspend fun selectTab(projectId: String, tabId: String) {
        val body = JSONObject().put("kind", "layout")
            .put("op", JSONObject().put("op", "select-tab").put("projectId", projectId).put("tabId", tabId))
        request(body).let { if (it.optString("kind") == "failed") throw IllegalStateException(it.optString("message")) }
    }

    suspend fun closeTab(projectId: String, tabId: String) {
        val body = JSONObject().put("kind", "layout")
            .put("op", JSONObject().put("op", "close-tab").put("projectId", projectId).put("tabId", tabId))
        request(body).let { if (it.optString("kind") == "failed") throw IllegalStateException(it.optString("message")) }
    }

    /**
     * Open a tab and return the id of the pane in it. The desktop's renderer
     * performs the op and the `workspace` frame that follows is how the watch
     * learns the new tab's id — so a dead renderer shows up here as a timeout.
     */
    suspend fun createTab(projectId: String, profileId: String?): String? {
        val before = workspaces.value[projectId]?.tabs?.map { it.id }?.toSet() ?: emptySet()
        val op = JSONObject().put("op", "create-tab").put("projectId", projectId)
        if (!profileId.isNullOrBlank()) op.put("profileId", profileId)
        val reply = request(JSONObject().put("kind", "layout").put("op", op))
        if (reply.optString("kind") == "failed") throw IllegalStateException(reply.optString("message"))
        val tab = withTimeoutOrNull(10_000L) {
            workspaces.first { m -> m[projectId]?.tabs?.any { it.id !in before } == true }
                .let { m -> m[projectId]!!.tabs.first { it.id !in before } }
        } ?: return null
        return tab.activePaneId.ifBlank { tab.paneIds.firstOrNull() }
    }

    /**
     * Wait until the pane has said something and then gone quiet — the agent's
     * banner has landed and it is waiting on a prompt. False when it never
     * spoke in time: a pane that is still PowerShell would *run* whatever is
     * pasted into it, so the caller must not type.
     */
    suspend fun awaitReady(sessionId: String, timeoutMs: Long = 25_000L): Boolean {
        lastDataAt.remove(sessionId)
        dataSeen.remove(sessionId)
        attach(sessionId)
        try {
            val started = System.currentTimeMillis()
            while (System.currentTimeMillis() - started < timeoutMs) {
                val seen = dataSeen[sessionId] ?: 0
                val last = lastDataAt[sessionId] ?: 0L
                // A banner is hundreds of bytes; a lone cursor blink is not a banner.
                if (seen > 200 && System.currentTimeMillis() - last > QUIET_MS) return true
                delay(150)
            }
            return false
        } finally {
            detach(sessionId)
        }
    }

    /** Type the words, then Enter as its own keystroke a beat later. */
    suspend fun sendPrompt(sessionId: String, text: String): Boolean {
        val clean = text.trim()
        if (clean.isEmpty()) return false
        if (!write(sessionId, clean)) return false
        delay(SETTLE_BEFORE_ENTER_MS)
        return write(sessionId, "\r")
    }
}
