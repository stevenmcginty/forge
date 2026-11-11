package com.forge.bubble.link

import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Deferred
import kotlinx.coroutines.Job
import kotlinx.coroutines.async
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import org.json.JSONObject
import java.io.IOException
import java.util.Base64

/** What the lane tells the engine. All calls arrive on the engine's scope. */
interface LaneListener {
    fun onStatus(status: JSONObject) {}
    fun onLedger(jobs: List<LiveJob>) {}
    fun onNews(item: News.Item) {}
    /** The reply to the current turn, so far. */
    fun onReply(text: String) {}
    /** Something to show the human for a moment (a failed turn, a refusal). */
    fun onNotice(text: String) {}
    /** Speaking / turn-busy / ready changed: recompute the talk state. */
    fun onTalkChanged() {}
}

/** One decoded speech clip. */
class Clip(val audio: ByteArray, val mime: String)

enum class LineKind { REPLY, ACK, NEWS }

/**
 * The `voice-claude` lane to Claude Live (`agent: "claude-live"`, wire spec 3).
 *
 * Opened after every `hello-ok`, re-opened whenever an events result says
 * `open: false`. Events come only by the long poll: exactly one `events` in
 * flight, a 30 s deadline against the desktop's 20 s hold, re-issued at once; a
 * poll that gets no answer at all means a dead socket, so the link is dropped.
 *
 * A turn: [say] with this lane's own turnId; `say` pieces for that id are
 * joined into the reply and cut into clauses ([Clauses]); each clause is
 * fetched with `speak` and played in order, at most [SPEECH_AHEAD] fetched
 * ahead. A generation counter makes [interrupt] final: queued lines go,
 * late clips are dropped. If nothing has sounded [ACK_AFTER_MS] after the end
 * of speech, a cached ack ("Okay." ...) jumps the queue. After the last clip of
 * a turn one latency sample goes to the desktop's log.
 */
class LiveLane(
    private val link: ForgeLink,
    private val scope: CoroutineScope,
    private val player: ClipPlayer,
    private val listener: LaneListener,
    private val now: () -> Long = System::currentTimeMillis,
) {
    private val _ready = MutableStateFlow(false)
    /** The lane is open and the events loop is running. */
    val ready: StateFlow<Boolean> = _ready.asStateFlow()

    private var loop: Job? = null
    private var wanted = false

    private class Turn(val id: String, val eosAt: Long, val voice: Boolean) {
        var sentAt = 0L
        var firstTextAt = 0L
        var firstAudioAt = 0L
        var reply = ""
        var buffer = ""
        var chunks = 0
        var linesLeft = 0
        var ended = false
        var acked = false
        var latencySent = false
    }

    private var turn: Turn? = null
    private var turnSeq = 0
    private var interrupting: Job? = null

    private class Line(val text: String, val kind: LineKind, val turnId: String?) {
        var audio: Deferred<Clip?>? = null
    }

    private val queue = ArrayDeque<Line>()
    private var pump: Job? = null
    private var gen = 0
    private var playing = false
    private val acks = mutableListOf<Pair<String, Clip>>()
    private var acksFetched = false
    private var ackNext = 0

    /** What was played, in order (text, kind). For tests and debugging. */
    internal val spokenLog = mutableListOf<Pair<String, LineKind>>()

    /** A clip is playing, or lines are waiting to. The bubble does not listen then. */
    val speaking: Boolean get() = playing || queue.isNotEmpty()

    /** A turn is out and its turn-end has not come. */
    val turnBusy: Boolean get() = turn?.ended == false

    /* ----------------------------------------------------------- open/close */

    /** Open (or re-open) the lane and run the events loop. Call after every hello-ok. */
    fun open() {
        wanted = true
        loop?.cancel()
        loop = scope.launch { runLane() }
    }

    /** Listen off: close the lane on the desktop (jobs run on). */
    fun close() {
        wanted = false
        loop?.cancel()
        loop = null
        setReady(false)
        dropTurnAndSpeech()
        if (link.isOnline) {
            scope.launch { quietly { link.request(JSONObject().put("kind", "voice-claude").put("op", "close"), 10_000L) } }
        }
    }

    /** The socket went: the session died with it. The engine re-opens after the next hello-ok. */
    fun onLinkDown() {
        loop?.cancel()
        loop = null
        setReady(false)
        dropTurnAndSpeech()
    }

    val isWanted: Boolean get() = wanted

    private fun setReady(on: Boolean) {
        if (_ready.value != on) {
            _ready.value = on
            listener.onTalkChanged()
        }
    }

    private suspend fun runLane() {
        var failures = 0
        while (scope.isActive && link.isOnline) {
            val opened = try {
                link.request(JSONObject().put("kind", "voice-claude").put("op", "open").put("agent", AGENT))
            } catch (e: RequestTimeout) {
                link.drop("open got no answer")
                return
            } catch (e: IOException) {
                return
            }
            if (opened.optString("kind") != "ok") {
                listener.onNotice(opened.optString("message").ifBlank { "Claude Live did not open" })
                delay(minOf(2_000L shl failures.coerceAtMost(4), 30_000L))
                failures++
                continue
            }
            failures = 0
            setReady(true)
            fetchAcks()
            // The events loop: one poll in flight, re-issued the instant it returns.
            while (true) {
                val res = try {
                    link.request(JSONObject().put("kind", "voice-claude").put("op", "events"), EVENTS_TIMEOUT_MS)
                } catch (e: RequestTimeout) {
                    // The desktop answers within 20 s, always. Silence is a dead socket.
                    setReady(false)
                    link.drop("events poll got no answer")
                    return
                } catch (e: IOException) {
                    setReady(false)
                    return
                }
                if (res.optString("kind") != "voice-claude-events") {
                    delay(1_000L)
                    continue
                }
                var gone = !res.optBoolean("open", true)
                val events = res.optJSONArray("events")
                if (events != null) for (i in 0 until events.length()) {
                    val e = events.optJSONObject(i) ?: continue
                    when (e.optString("type")) {
                        "live" -> e.optJSONObject("event")?.let { onLiveEvent(it) }
                        "closed" -> gone = true
                    }
                }
                if (gone) {
                    // The lane is gone (the session closed on the desktop): open it again.
                    setReady(false)
                    dropTurnAndSpeech()
                    break
                }
            }
        }
    }

    private fun onLiveEvent(e: JSONObject) {
        when (e.optString("type")) {
            "say" -> onSayPiece(e.optString("turnId"), e.optString("text", ""), e.optBoolean("final", false))
            "turn-end" -> onTurnEnd(e.optString("turnId"), e.optBoolean("ok", true), e.optStringOrNull("error"))
            "news" -> {
                val id = e.optString("id")
                if (id.isNotBlank()) {
                    listener.onNews(News.Item(id, e.optStringOrNull("jobId"), e.optString("text", ""), e.optString("urgency", "info"), now()))
                }
            }
            "ledger" -> listener.onLedger(Cards.parseJobs(e.optJSONObject("snapshot")?.optJSONArray("jobs")))
            "status" -> e.optJSONObject("status")?.let { listener.onStatus(it) }
            else -> {} // `show` and anything newer: not for a phone.
        }
    }

    /* ----------------------------------------------------------------- turns */

    /**
     * Send one turn. [eosAt] is when the human stopped talking (for the ack and
     * the latency sample); [voice] false for typed text (no ack). A turn still
     * in flight, or speech still playing, is interrupted first.
     */
    suspend fun say(text: String, eosAt: Long, voice: Boolean) {
        val words = text.trim()
        if (words.isEmpty()) return
        if (turnBusy || speaking) interrupt()
        interrupting?.join()
        val t = Turn("bv${now().toString(36)}-${++turnSeq}", eosAt, voice)
        turn = t
        listener.onReply("")
        listener.onTalkChanged()
        if (voice) scheduleAck(t)
        t.sentAt = now()
        val res = try {
            link.request(JSONObject().put("kind", "voice-claude").put("op", "say").put("text", words).put("turnId", t.id))
        } catch (e: IOException) {
            failTurn(t, "Not connected to the desktop")
            return
        }
        if (res.optString("kind") == "failed") failTurn(t, res.optString("message").ifBlank { "Claude Live did not take that" })
    }

    private fun failTurn(t: Turn, why: String) {
        if (turn !== t) return
        turn = null
        listener.onNotice(why)
        listener.onTalkChanged()
    }

    private fun onSayPiece(turnId: String, piece: String, final: Boolean) {
        val t = turn ?: return
        if (t.id != turnId) return
        if (t.firstTextAt == 0L && piece.isNotBlank()) t.firstTextAt = now()
        t.reply = Clauses.appendCaption(t.reply, piece)
        listener.onReply(t.reply)
        t.buffer += piece
        val taken = Clauses.take(t.buffer, t.chunks == 0)
        t.buffer = taken.rest
        for (c in taken.chunks) speakReply(t, c)
        if (final) flushTail(t)
    }

    private fun onTurnEnd(turnId: String, ok: Boolean, error: String?) {
        val t = turn ?: return
        if (t.id != turnId) return
        flushTail(t)
        t.ended = true
        if (!ok) listener.onNotice(error ?: "Claude Live could not answer")
        listener.onTalkChanged()
        maybeLatency(t)
    }

    private fun flushTail(t: Turn) {
        val tail = t.buffer.trim()
        t.buffer = ""
        if (tail.isNotEmpty()) speakReply(t, tail)
    }

    private fun speakReply(t: Turn, chunk: String) {
        val line = Clauses.speakable(chunk)
        if (line.isEmpty()) return
        t.chunks++
        t.linesLeft++
        enqueue(Line(line, LineKind.REPLY, t.id))
    }

    /**
     * Stop now: the clip playing, every queued line, and the turn in flight
     * (later pieces for it are ignored). The desktop is told with `interrupt`;
     * jobs keep running.
     */
    fun interrupt() {
        val had = turn != null || speaking
        turn = null
        clearSpeech()
        listener.onTalkChanged()
        if (had && link.isOnline && _ready.value) {
            interrupting = scope.launch {
                quietly { link.request(JSONObject().put("kind", "voice-claude").put("op", "interrupt"), 10_000L) }
            }
        }
    }

    /** News at a gap, as its own line. */
    fun speakNews(text: String) {
        val line = Clauses.speakable(text)
        if (line.isNotEmpty()) enqueue(Line(line, LineKind.NEWS, null))
    }

    private fun dropTurnAndSpeech() {
        turn = null
        clearSpeech()
        listener.onTalkChanged()
    }

    /* ---------------------------------------------------------------- speech */

    private fun enqueue(line: Line) {
        queue.addLast(line)
        prefetch()
        ensurePump()
        listener.onTalkChanged()
    }

    private fun prefetch() {
        for (line in queue.take(SPEECH_AHEAD)) {
            if (line.audio == null) line.audio = scope.async { fetch(line.text) }
        }
    }

    private suspend fun fetch(text: String): Clip? {
        val res = try {
            link.request(JSONObject().put("kind", "voice-claude").put("op", "speak").put("text", text))
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            return null
        }
        if (res.optString("kind") != "voice-speech") return null
        val audio = runCatching { Base64.getDecoder().decode(res.optString("audio", "")) }.getOrNull() ?: return null
        if (audio.isEmpty()) return null
        return Clip(audio, res.optString("mime", "audio/wav").ifBlank { "audio/wav" })
    }

    private fun ensurePump() {
        if (pump?.isActive == true) return
        val myGen = gen
        pump = scope.launch { pumpLoop(myGen) }
    }

    private suspend fun pumpLoop(myGen: Int) {
        while (myGen == gen) {
            val line = queue.firstOrNull() ?: break
            prefetch()
            val clip = line.audio?.await()
            if (myGen != gen || queue.firstOrNull() !== line) continue
            queue.removeFirst()
            prefetch()
            if (clip != null) {
                playing = true
                onClipStart(line)
                listener.onTalkChanged()
                try {
                    player.play(clip.audio, clip.mime)
                } catch (e: CancellationException) {
                    throw e
                } catch (e: Exception) {
                    // A clip the player could not play is skipped, not fatal.
                }
                playing = false
            }
            onLineDone(line)
            listener.onTalkChanged()
        }
    }

    private fun clearSpeech() {
        gen++
        for (line in queue) line.audio?.cancel()
        queue.clear()
        pump?.cancel()
        pump = null
        if (playing) player.stop()
        playing = false
    }

    private fun onClipStart(line: Line) {
        spokenLog += line.text to line.kind
        val t = turn
        if (t != null && line.turnId == t.id && t.firstAudioAt == 0L) t.firstAudioAt = now()
    }

    private fun onLineDone(line: Line) {
        val t = turn ?: return
        if (line.kind == LineKind.REPLY && line.turnId == t.id) {
            t.linesLeft--
            maybeLatency(t)
        }
    }

    /* ------------------------------------------------------------ ack, latency */

    private fun fetchAcks() {
        if (acksFetched) return
        acksFetched = true
        scope.launch {
            for (text in Clauses.ACK_LINES) {
                fetch(text)?.let { acks += text to it }
            }
        }
    }

    private fun scheduleAck(t: Turn) {
        scope.launch {
            delay(maxOf(0L, t.eosAt + ACK_AFTER_MS - now()))
            if (turn !== t || t.acked || t.firstAudioAt != 0L || playing || acks.isEmpty()) return@launch
            t.acked = true
            val (text, clip) = acks[ackNext++ % acks.size]
            val line = Line(text, LineKind.ACK, t.id)
            line.audio = CompletableDeferred(clip)
            queue.addFirst(line)
            ensurePump()
            listener.onTalkChanged()
        }
    }

    private fun maybeLatency(t: Turn) {
        if (!t.ended || t.linesLeft > 0 || t.latencySent || !t.voice || t.firstAudioAt == 0L) return
        t.latencySent = true
        val sample = JSONObject()
            .put("turnId", t.id)
            .put("eosToSendMs", (t.sentAt - t.eosAt).coerceAtLeast(0L))
            .put("eosToAudioMs", (t.firstAudioAt - t.eosAt).coerceAtLeast(0L))
            .put("ack", t.acked)
        if (t.firstTextAt > 0) {
            sample.put("sendToFirstTextMs", (t.firstTextAt - t.sentAt).coerceAtLeast(0L))
            sample.put("firstTextToAudioMs", (t.firstAudioAt - t.firstTextAt).coerceAtLeast(0L))
        }
        scope.launch {
            quietly { link.request(JSONObject().put("kind", "voice-claude").put("op", "latency").put("sample", sample), 10_000L) }
        }
    }

    private suspend fun quietly(block: suspend () -> Unit) {
        try {
            block()
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            // Best effort.
        }
    }

    companion object {
        const val AGENT = "claude-live"
        const val SPEECH_AHEAD = 2
        const val ACK_AFTER_MS = 600L
        /** Must exceed the desktop's 20 s hold (VOICE_CLAUDE_POLL_MS). */
        const val EVENTS_TIMEOUT_MS = 30_000L
    }
}
