package com.forge.bubble.link

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.asCoroutineDispatcher
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import org.json.JSONArray
import org.json.JSONObject
import java.io.IOException
import java.util.concurrent.Executors

enum class TalkState { IDLE, LISTENING, THINKING, SPEAKING }

/**
 * Everything the bubble draws, in one value.
 *
 * [link] with [linkReason] (a plain sentence for OFFLINE / STOPPED / NEED_PIN)
 * and [lockedUntil] (epoch ms, LOCKED). [talk]: IDLE (mic off), LISTENING (mic
 * on; [hearing] while speech is detected), THINKING (heard, waiting for the
 * reply), SPEAKING (a clip is playing or queued). [heard] is the last thing the
 * desktop heard, [reply] the reply so far. [needsYou] counts needs-you cards
 * and confirms; [working] counts jobs running or queued. [notice] is a short
 * sentence about the last thing that went wrong ("" when nothing did).
 */
data class EngineState(
    val link: LinkState = LinkState.STOPPED,
    val linkReason: String = "",
    val lockedUntil: Long = 0L,
    val pinWrong: Boolean = false,
    val talk: TalkState = TalkState.IDLE,
    val listening: Boolean = false,
    val hearing: Boolean = false,
    val heard: String = "",
    val reply: String = "",
    val cards: List<Card> = emptyList(),
    val working: Int = 0,
    val needsYou: Int = 0,
    val desktopName: String = "",
    val notice: String = "",
    val email: String? = null,
)

/**
 * Forge Bubble's one entry point: the link, the Claude Live lane, hearing,
 * speech, news and cards, behind one [state].
 *
 * The app provides a [KeyValueStore], a [ClipPlayer], and mic frames
 * ([micFrame]: 100 ms of 16 kHz mono PCM16 with its RMS level). All work runs
 * on one private thread, so every method may be called from any thread.
 */
class BubbleEngine internal constructor(
    private val config: LinkConfig,
    private val store: KeyValueStore,
    player: ClipPlayer,
    transport: Transport,
    tokenSource: TokenSource?,
    hostLookup: HostLookup?,
    timing: LinkTiming,
) {
    constructor(config: LinkConfig, store: KeyValueStore, player: ClipPlayer) :
        this(config, store, player, OkHttpTransport(), null, null, LinkTiming())

    private val executor = Executors.newSingleThreadExecutor { r -> Thread(r, "forge-bubble-engine").apply { isDaemon = true } }
    private val dispatcher = executor.asCoroutineDispatcher()
    private val scope = CoroutineScope(SupervisorJob() + dispatcher)

    private val auth: ForgeAuth? = if (tokenSource == null && config.staticIdToken == null) ForgeAuth(config.apiKey, store) else null
    private val tokens: TokenSource = tokenSource ?: config.staticIdToken?.let { StaticTokens(it) } ?: auth!!
    private val lookup: HostLookup = hostLookup ?: config.directUrl?.let { DirectLookup(it) } ?: RtdbHostLookup(config.databaseUrl)

    internal val link = ForgeLink(config, store, tokens, lookup, transport, scope, timing)
    private val laneEvents = LaneEvents()
    internal val lane = LiveLane(link, scope, player, laneEvents)

    private val _state = MutableStateFlow(EngineState(email = auth?.email()))
    val state: StateFlow<EngineState> = _state.asStateFlow()

    /** Say Claude Live's news out loud at a gap. Off: news only makes cards. */
    @Volatile var speakNews: Boolean = true

    /* ---------------------------------------------- engine-thread state only */

    private var listening = false
    private val vad = Vad()
    private val preRoll = ArrayDeque<ShortArray>()
    private var utterance: Utterance? = null
    private var utteranceSeq = 0
    private var hearing = false
    private var awaitingHeard = false
    private var heardEndAt: Long? = null
    private var heard = ""
    private var reply = ""
    private var notice = ""
    private var audioDropped = false

    private var jobs: List<LiveJob> = emptyList()
    private var confirms: List<Confirm> = emptyList()
    private val asking = LinkedHashMap<String, Asking>()
    private val paneNames = HashMap<String, String>()
    private var needsNews: List<News.Item> = emptyList()
    private var newsQueue: List<News.Item> = emptyList()
    private val dismissed = HashSet<String>()
    private var liveStatus: JSONObject? = null

    init {
        link.listener = LinkEvents()
        scope.launch { link.status.collect { publish() } }
        scope.launch { newsTicker() }
    }

    /* ------------------------------------------------------------ the surface */

    /** Firebase email/password sign-in. Null on success, else a sentence for the screen. */
    suspend fun signIn(email: String, password: String): String? {
        val a = auth ?: return null
        val err = a.signIn(email, password)
        if (err == null) withContext(dispatcher) {
            link.kick()
            publish()
        }
        return err
    }

    /** The desktop's PIN. False when it is not 4 to 12 digits. With [remember] it is kept in the store. */
    fun submitPin(pin: String, remember: Boolean): Boolean {
        if (!Regex("^\\d{4,12}$").matches(pin.trim())) return false
        scope.launch { link.submitPin(pin, remember) }
        return true
    }

    /** Forget the account and the PIN, and drop the socket. */
    fun signOut() {
        scope.launch {
            link.stop()
            lane.onLinkDown()
            tokens.signOut()
            link.forgetPin()
            clearDesk()
            link.start() // waits, showing SIGNED_OUT, until signIn
            publish()
        }
    }

    /** Connect (and stay connected, reconnecting as needed). */
    fun start() {
        scope.launch { link.start() }
    }

    /** Drop the socket and stop reconnecting. Credentials and a remembered PIN stay. */
    fun stop() {
        scope.launch {
            dropUtterance()
            link.stop()
            lane.onLinkDown()
            publish()
        }
    }

    /** Release the engine's thread. The engine cannot be used after. */
    fun dispose() {
        stop()
        scope.launch { scope.cancel() }
        executor.shutdown()
    }

    /** Mic on or off. Off drops any speech in progress. */
    fun setListening(on: Boolean) {
        scope.launch {
            listening = on
            if (!on) dropUtterance()
            publish()
        }
    }

    /**
     * One 100 ms mic frame: 1600 samples of 16 kHz mono PCM16, and its level
     * (RMS in 0..1; [Vad.rms] computes it). Ignored while not listening and
     * while a clip plays (half-duplex).
     */
    fun micFrame(pcm: ShortArray, level: Float) {
        val frame = pcm.copyOf()
        scope.launch { onMic(frame, level) }
    }

    /** A typed turn, as if it had been heard. */
    fun sayText(text: String) {
        val words = text.trim()
        if (words.isEmpty()) return
        scope.launch {
            if (!lane.ready.value) {
                setNotice("Not connected to the desktop")
                return@launch
            }
            heard = words
            publish()
            lane.say(words, System.currentTimeMillis(), voice = false)
            publish()
        }
    }

    /** Stop Forge talking now (a tap): queued speech goes, the turn is cancelled, jobs run on. */
    fun interrupt() {
        scope.launch {
            lane.interrupt()
            publish()
        }
    }

    /** A card button. Confirm Yes/No answers Forge Brain; Stop stops a job; Dismiss hides the card. */
    fun cardAction(cardId: String, action: CardAction) {
        scope.launch {
            val card = _state.value.cards.firstOrNull { it.id == cardId } ?: return@launch
            when {
                action == CardAction.DISMISS -> {
                    dismissed += card.dismissKey
                    publish()
                }
                card.kind == CardKind.CONFIRM && (action == CardAction.YES || action == CardAction.NO) -> {
                    val id = card.id.removePrefix("confirm:")
                    val res = ask(JSONObject().put("kind", "brain-confirm").put("id", id).put("allow", action == CardAction.YES))
                    // Answered, or no longer waiting: either way it is not a question any more.
                    confirms = confirms.filter { it.id != id }
                    if (res != null && res.optString("kind") == "failed") setNotice(res.optString("message"))
                    publish()
                }
                action == CardAction.STOP && card.jobId != null -> {
                    val res = ask(
                        JSONObject().put("kind", "voice-claude").put("op", "job").put("jobId", card.jobId).put("action", "stop")
                    )
                    if (res != null && res.optString("kind") == "failed") setNotice(res.optString("message"))
                }
                else -> {}
            }
        }
    }

    /* --------------------------------------------------------------- hearing */

    private fun onMic(pcm: ShortArray, level: Float) {
        if (!listening) return
        if (lane.speaking) {
            // Half-duplex: the bubble does not listen to itself.
            if (utterance != null || vad.speaking) dropUtterance()
            vad.reset()
            preRoll.clear()
            return
        }
        val step = vad.push(level)
        if (step == Vad.Step.QUIET || step == Vad.Step.START) {
            preRoll.addLast(pcm)
            while (preRoll.size > Vad.PRE_ROLL_FRAMES) preRoll.removeFirst()
        }
        when (step) {
            Vad.Step.QUIET -> {}
            Vad.Step.START -> {
                val u = Utterance("bt${System.currentTimeMillis().toString(36)}-${++utteranceSeq}", link, scope, lane.ready)
                for (f in preRoll) u.add(f)
                preRoll.clear()
                utterance = u
                hearing = true
                notice = ""
                publish()
            }
            Vad.Step.CONTINUE -> {
                val u = utterance ?: return
                u.add(pcm)
                if (!lane.ready.value && u.unsentBytes > Utterance.OFFLINE_HOLD_BYTES) {
                    dropUtterance()
                    audioDropped = true
                    setNotice("Not connected - that was not sent")
                } else if (u.full) {
                    vad.reset()
                    endUtterance()
                }
            }
            Vad.Step.END -> {
                utterance?.add(pcm)
                endUtterance()
            }
            Vad.Step.DROP -> {
                dropUtterance()
                heardEndAt = System.currentTimeMillis()
            }
        }
    }

    private fun dropUtterance() {
        utterance?.cancel()
        utterance = null
        vad.reset()
        preRoll.clear()
        if (hearing) {
            hearing = false
            publish()
        }
    }

    private fun endUtterance() {
        val u = utterance ?: return
        utterance = null
        hearing = false
        preRoll.clear()
        val eosAt = System.currentTimeMillis()
        heardEndAt = eosAt
        awaitingHeard = true
        publish()
        scope.launch {
            val result = u.finish()
            awaitingHeard = false
            when (result) {
                is Utterance.Result.Heard -> {
                    if (result.text.isEmpty()) {
                        setNotice("Didn't catch that")
                    } else {
                        heard = result.text
                        publish()
                        lane.say(result.text, eosAt, voice = true)
                    }
                }
                is Utterance.Result.Failed -> setNotice(result.message)
            }
            publish()
        }
    }

    /* ------------------------------------------------------------------ news */

    private suspend fun newsTicker() {
        while (scope.isActive) {
            delay(NEWS_TICK_MS)
            if (newsQueue.isEmpty()) continue
            if (!speakNews) {
                newsQueue = emptyList()
                continue
            }
            if (!lane.ready.value) continue
            val open = News.gapOpen(System.currentTimeMillis(), hearing, heardEndAt, lane.speaking, lane.turnBusy || awaitingHeard)
            if (!open) continue
            val taken = News.take(newsQueue) ?: continue
            newsQueue = taken.rest
            if (taken.say.isNotBlank()) lane.speakNews(taken.say)
        }
    }

    /* ---------------------------------------------------------------- frames */

    private inner class LinkEvents : LinkListener {
        override fun onOnline(helloOk: JSONObject) {
            audioDropped = false
            paneNames.clear()
            readWorkspaces(helloOk.optJSONObject("workspaces"))
            readSessions(helloOk.optJSONArray("sessions"))
            // Panes still asking are replayed right after hello-ok.
            asking.clear()
            confirms = Cards.parseConfirms(helloOk.optJSONObject("brain"))
            lane.open()
            publish()
        }

        override fun onFrame(frame: JSONObject) {
            when (frame.optString("type")) {
                "attention" -> {
                    val pane = frame.optString("sessionId")
                    if (pane.isBlank()) return
                    if (frame.optBoolean("asking", false)) {
                        val prompt = frame.optString("prompt", "")
                        val old = asking[pane]
                        val since = if (old != null && old.prompt == prompt) old.since else System.currentTimeMillis()
                        asking[pane] = Asking(pane, paneNames[pane] ?: "A pane", prompt, since)
                    } else {
                        asking.remove(pane)
                    }
                    publish()
                }
                "sessions" -> {
                    readSessions(frame.optJSONArray("sessions"), prune = true)
                    publish()
                }
                "exit" -> {
                    asking.remove(frame.optString("sessionId"))
                    publish()
                }
                "workspace" -> {
                    frame.optJSONObject("workspace")?.let { readWorkspace(it) }
                    publish()
                }
                "brain" -> {
                    confirms = Cards.parseConfirms(frame.optJSONObject("status"))
                    publish()
                }
                else -> {} // Everything else on the wire is for other clients.
            }
        }

        override fun onOffline() {
            lane.onLinkDown()
            publish()
        }
    }

    private inner class LaneEvents : LaneListener {
        override fun onStatus(status: JSONObject) {
            liveStatus = status
            status.optStringOrNull("error")?.let { setNotice(it) }
        }

        override fun onLedger(jobs: List<LiveJob>) {
            this@BubbleEngine.jobs = jobs
            val stillNeeds = jobs.filter { it.state == "needs-you" }.map { it.id }.toSet()
            val known = jobs.map { it.id }.toSet()
            // News about a job the ledger says has moved on is not a question any more.
            needsNews = needsNews.filter { n -> n.jobId == null || n.jobId !in known || n.jobId in stillNeeds }
            publish()
        }

        override fun onNews(item: News.Item) {
            newsQueue = News.queue(newsQueue, item)
            if (item.urgency == "needs-you" && needsNews.none { it.id == item.id }) {
                needsNews = (needsNews.filter { item.jobId == null || it.jobId != item.jobId } + item).takeLast(NEEDS_NEWS_MAX)
            }
            publish()
        }

        override fun onReply(text: String) {
            reply = text
            publish()
        }

        override fun onNotice(text: String) = setNotice(text)

        override fun onTalkChanged() = publish()
    }

    private fun readSessions(a: JSONArray?, prune: Boolean = false) {
        if (a == null) return
        val live = HashSet<String>()
        for (i in 0 until a.length()) {
            val s = a.optJSONObject(i) ?: continue
            val id = s.optString("id")
            if (id.isBlank()) continue
            live += id
            if (!paneNames.containsKey(id)) {
                val folder = s.optString("cwd", "").trimEnd('/', '\\').substringAfterLast('/').substringAfterLast('\\')
                if (folder.isNotBlank()) paneNames[id] = folder
            }
        }
        if (prune) asking.keys.retainAll(live)
    }

    private fun readWorkspaces(o: JSONObject?) {
        if (o == null) return
        for (key in o.keys()) o.optJSONObject(key)?.let { readWorkspace(it) }
    }

    /** A tab's title names the panes in it; a leaf's id is its PTY session id. */
    private fun readWorkspace(ws: JSONObject) {
        val tabs = ws.optJSONArray("tabs") ?: return
        for (i in 0 until tabs.length()) {
            val t = tabs.optJSONObject(i) ?: continue
            val title = t.optString("title", "")
            if (title.isBlank()) continue
            val leaves = mutableListOf<String>()
            collectLeaves(t.optJSONObject("root"), leaves)
            for (id in leaves) paneNames[id] = title
        }
    }

    private fun collectLeaves(node: JSONObject?, into: MutableList<String>) {
        if (node == null) return
        when (node.optString("type")) {
            "leaf" -> node.optString("id").takeIf { it.isNotBlank() }?.let { into += it }
            "split" -> {
                collectLeaves(node.optJSONObject("a"), into)
                collectLeaves(node.optJSONObject("b"), into)
            }
        }
    }

    private fun clearDesk() {
        jobs = emptyList()
        confirms = emptyList()
        asking.clear()
        needsNews = emptyList()
        newsQueue = emptyList()
        heard = ""
        reply = ""
    }

    /* ------------------------------------------------------------ the state */

    private suspend fun ask(body: JSONObject): JSONObject? = try {
        link.request(body)
    } catch (e: IOException) {
        setNotice(e.message ?: "Not connected to the desktop")
        null
    }

    private fun setNotice(text: String) {
        notice = text
        publish()
    }

    private fun publish() {
        val now = System.currentTimeMillis()
        needsNews = needsNews.filter { now - it.at <= Cards.DONE_KEEP_MS }
        val s = link.status.value
        val (linkState, reason) = if (audioDropped && s.state != LinkState.ONLINE) {
            LinkState.OFFLINE to "Not connected - speech was not sent"
        } else {
            s.state to s.reason
        }
        val cards = Cards.build(confirms, jobs, asking.values, needsNews, now, dismissed)
        val talk = when {
            lane.speaking -> TalkState.SPEAKING
            hearing -> TalkState.LISTENING
            awaitingHeard || lane.turnBusy -> TalkState.THINKING
            listening -> TalkState.LISTENING
            else -> TalkState.IDLE
        }
        _state.value = EngineState(
            link = linkState,
            linkReason = reason,
            lockedUntil = if (s.state == LinkState.LOCKED) s.retryAt else 0L,
            pinWrong = s.pinWrong,
            talk = talk,
            listening = listening,
            hearing = hearing,
            heard = heard,
            reply = reply,
            cards = cards,
            working = Cards.working(jobs),
            needsYou = cards.count { it.kind == CardKind.NEEDS_YOU || it.kind == CardKind.CONFIRM },
            desktopName = s.desktopName,
            notice = notice,
            email = auth?.email(),
        )
    }

    /* ------------------------------------------------------------- for tests */

    internal suspend fun spoken(): List<Pair<String, LineKind>> = withContext(dispatcher) { lane.spokenLog.toList() }

    internal suspend fun liveStatus(): JSONObject? = withContext(dispatcher) { liveStatus }

    internal suspend fun storedPin(): Boolean = withContext(dispatcher) { store.get(ForgeLink.K_PIN) != null }

    companion object {
        private const val NEWS_TICK_MS = 500L
        private const val NEEDS_NEWS_MAX = 20

        /** An engine on a dev server or test desktop: no Firebase, no lookup. */
        fun forDev(url: String, idToken: String, store: KeyValueStore, player: ClipPlayer, deviceName: String = "Forge Bubble (dev)"): BubbleEngine =
            BubbleEngine(LinkConfig(apiKey = "", databaseUrl = "", deviceName = deviceName, directUrl = url, staticIdToken = idToken), store, player)
    }
}
