package com.forge.bubble.link

import kotlinx.coroutines.delay
import kotlinx.coroutines.runBlocking
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.FixMethodOrder
import org.junit.Test
import org.junit.runners.MethodSorters
import java.util.concurrent.TimeUnit

/**
 * BubbleEngine against scripts/bubble-dev-server.mjs: the real Forge Web server
 * and token door with a scripted Claude Live. Skipped unless FORGE_DEV_WS,
 * FORGE_DEV_TOKEN and FORGE_DEV_CONTROL are set (scripts/bubble-link-check.mjs
 * sets them). FORGE_DEV_PIN set = the server was started with that PIN and
 * `--confirm`, and only the PIN tests run; unset = only the no-PIN tests.
 */
@FixMethodOrder(MethodSorters.NAME_ASCENDING)
class DevServerTest {
    private val ws: String? = System.getenv("FORGE_DEV_WS")?.takeIf { it.isNotBlank() }
    private val token: String? = System.getenv("FORGE_DEV_TOKEN")?.takeIf { it.isNotBlank() }
    private val control: String? = System.getenv("FORGE_DEV_CONTROL")?.takeIf { it.isNotBlank() }
    private val pin: String? = System.getenv("FORGE_DEV_PIN")?.takeIf { it.isNotBlank() }
    private val http = OkHttpClient.Builder().readTimeout(15, TimeUnit.SECONDS).build()
    private val engines = mutableListOf<BubbleEngine>()

    @After
    fun tearDown() {
        engines.forEach { it.dispose() }
    }

    private fun needServer(withPin: Boolean) {
        assumeTrue("FORGE_DEV_WS / FORGE_DEV_TOKEN / FORGE_DEV_CONTROL not set", ws != null && token != null && control != null)
        assumeTrue(if (withPin) "server has no PIN" else "server has a PIN", (pin != null) == withPin)
    }

    private fun engine(player: ClipPlayer = FakePlayer(), store: KeyValueStore = MemoryStore()): BubbleEngine =
        BubbleEngine.forDev(ws!!, token!!, store, player).also { engines += it }

    private fun stats(): JSONObject = http.newCall(Request.Builder().url("$control/stats").get().build()).execute().use {
        JSONObject(it.body!!.string())
    }

    private fun hellosFor(deviceId: String): List<JSONObject> {
        val a = stats().getJSONArray("hellos")
        return (0 until a.length()).map { a.getJSONObject(it) }.filter { it.getString("deviceId") == deviceId }
    }

    private suspend fun speak(e: BubbleEngine, quiet: Int, loud: Int, after: Int) {
        var offset = 0
        fun frame(amp: Int) = pcmFrame(amp, offset).also { offset += it.size }
        repeat(quiet) { val f = frame(5); e.micFrame(f, Vad.rms(f)) }
        repeat(loud) { val f = frame(8000); e.micFrame(f, Vad.rms(f)) }
        repeat(after) { val f = frame(5); e.micFrame(f, Vad.rms(f)) }
        delay(10)
    }

    /* ------------------------------------------------------- no-PIN desktop */

    @Test
    fun a_helloGoesOnlineAndTheLaneOpens() = runBlocking<Unit> {
        needServer(withPin = false)
        val e = engine()
        e.start()
        val s = e.state.await(10_000, "ONLINE") { it.link == LinkState.ONLINE }
        assertEquals("BUBBLE-DEV", s.desktopName)
        // Lane open: the status and the ledger queued at open both arrived.
        e.state.await(5_000, "the open ledger (one running job)") { it.working == 1 }
        waitFor(5_000, "the open status") { e.liveStatus()?.optBoolean("ready") == true }
        // The asking pane, named from the workspace tab that holds it.
        val zeb = e.state.await(5_000, "the asking pane card") { st -> st.cards.any { it.id == "pane:pane-zeb" } }
            .cards.first { it.id == "pane:pane-zeb" }
        assertEquals("Zeb is asking", zeb.title)
        assertEquals("Allow edit to app.ts?", zeb.line)
    }

    @Test
    fun b_anUtteranceIsHeardAnsweredAndSpokenInOrder() = runBlocking<Unit> {
        needServer(withPin = false)
        val player = FakePlayer(playMs = 60)
        val e = engine(player)
        e.start()
        e.state.await(10_000, "ONLINE") { it.link == LinkState.ONLINE }
        e.state.await(5_000, "lane open") { it.working == 1 }
        val dones = stats().getInt("dones")
        e.setListening(true)
        speak(e, quiet = 5, loud = 20, after = 10)
        e.state.await(10_000, "heard text") { it.heard == "what is running" }
        e.state.await(10_000, "the whole reply") { it.reply == "Two agents are working. Kess needs you." }
        waitFor(10_000, "both reply clips played") { e.spoken().count { it.second == LineKind.REPLY } == 2 }
        assertEquals(
            listOf("Two agents are working.", "Kess needs you."),
            e.spoken().filter { it.second == LineKind.REPLY }.map { it.first },
        )
        assertTrue("clips were played", player.played.size >= 2)
        assertTrue("every clip is a WAV", player.played.all { it.mime == "audio/wav" && isWav(it.audio) })
        val st = stats()
        assertEquals("one done for one utterance", dones + 1, st.getInt("dones"))
        val say = st.getJSONArray("says").let { it.getJSONObject(it.length() - 1) }
        assertEquals("what is running", say.getString("text"))
        assertTrue("say carries our own turnId", say.getString("turnId").startsWith("bv"))

        // The needs-you news is a card at once; when the ledger names the job, the
        // two become one card for Kess's pane.
        val fromNews = e.state.await(5_000, "a card from the needs-you news") { s ->
            s.cards.any { it.id == "job:j-kess" }
        }.cards.first { it.id == "job:j-kess" }
        assertEquals(CardKind.NEEDS_YOU, fromNews.kind)
        assertEquals("Kess needs you to approve a file change.", fromNews.line)
        val merged = e.state.await(5_000, "the ledger's card for Kess") { s -> s.cards.any { it.id == "pane:pane-kess" } }
        assertFalse("one card per job", merged.cards.any { it.id == "job:j-kess" })
        assertEquals("Kess needs you", merged.cards.first { it.id == "pane:pane-kess" }.title)
        assertEquals(1, merged.working)
        assertTrue(merged.needsYou >= 2)
        // And the news is said at a gap, after the reply.
        waitFor(6_000, "the news spoken") { e.spoken().any { it.second == LineKind.NEWS } }
        val order = e.spoken().map { it.second }
        assertTrue(order.indexOf(LineKind.NEWS) > order.lastIndexOf(LineKind.REPLY))
    }

    @Test
    fun c_interruptDropsQueuedClips() = runBlocking<Unit> {
        needServer(withPin = false)
        val player = FakePlayer(playMs = 3_000)
        val e = engine(player)
        e.speakNews = false
        e.start()
        e.state.await(10_000, "ONLINE") { it.link == LinkState.ONLINE }
        e.state.await(5_000, "lane open") { it.working == 1 }
        val interrupts = stats().getInt("interrupts")
        e.sayText("what is running")
        e.state.await(5_000, "the whole reply") { it.reply == "Two agents are working. Kess needs you." }
        waitFor(5_000, "the first clip playing") { player.played.size == 1 }
        assertEquals(TalkState.SPEAKING, e.state.value.talk)
        e.interrupt()
        e.state.await(2_000, "not speaking") { it.talk != TalkState.SPEAKING }
        assertEquals("the clip playing was stopped", 1, player.stops)
        delay(1_500)
        assertEquals("the queued clip never played", 1, player.played.size)
        assertEquals(listOf("Two agents are working."), e.spoken().map { it.first })
        waitFor(3_000, "interrupt reached the desktop") { stats().getInt("interrupts") == interrupts + 1 }
    }

    @Test
    fun z_aServerRestartReconnectsAndReopensTheLane() = runBlocking<Unit> {
        needServer(withPin = false)
        val e = engine()
        e.start()
        e.state.await(10_000, "ONLINE") { it.link == LinkState.ONLINE }
        e.state.await(5_000, "lane open") { it.working == 1 }
        val device = e.link.deviceId()
        val hellos = hellosFor(device).size
        val opens = stats().getInt("opens")
        val restarted = http.newCall(Request.Builder().url("$control/restart").post("".toRequestBody("text/plain".toMediaType())).build())
            .execute().use { it.isSuccessful }
        assertTrue(restarted)
        waitFor(10_000, "a second hello") { hellosFor(device).size == hellos + 1 }
        e.state.await(10_000, "ONLINE again") { it.link == LinkState.ONLINE }
        waitFor(5_000, "the lane opened again") { stats().getInt("opens") > opens }
        e.state.await(5_000, "the ledger again") { it.working == 1 }
    }

    /* ------------------------------------------------------------ PIN desktop */

    @Test
    fun a_pinRequiredThenWrongThenRight() = runBlocking<Unit> {
        needServer(withPin = true)
        val store = MemoryStore()
        val e = engine(store = store)
        e.start()
        e.state.await(10_000, "NEED_PIN") { it.link == LinkState.NEED_PIN }
        val device = e.link.deviceId()
        val first = hellosFor(device)
        assertEquals(1, first.size)
        assertFalse("no PIN was invented", first[0].getBoolean("pin"))

        val wrong = if (pin == "0000") "1111" else "0000"
        assertTrue(e.submitPin(wrong, remember = true))
        e.state.await(10_000, "pin-invalid") { it.link == LinkState.NEED_PIN && it.pinWrong }
        assertFalse("the wrong PIN is not kept", e.storedPin())
        delay(3_000)
        val after = hellosFor(device)
        assertEquals("exactly one hello after the wrong PIN", 2, after.size)
        assertTrue(after[1].getBoolean("pin"))
        assertEquals(LinkState.NEED_PIN, e.state.value.link)

        assertTrue(e.submitPin(pin!!, remember = true))
        e.state.await(10_000, "ONLINE") { it.link == LinkState.ONLINE }
        assertTrue("the right PIN is remembered", e.storedPin())
        assertEquals(3, hellosFor(device).size)
    }

    @Test
    fun b_aConfirmCardAnswersForgeBrain() = runBlocking<Unit> {
        needServer(withPin = true)
        val e = engine()
        e.start()
        e.state.await(10_000, "NEED_PIN") { it.link == LinkState.NEED_PIN }
        e.submitPin(pin!!, remember = false)
        e.state.await(10_000, "ONLINE") { it.link == LinkState.ONLINE }
        val card = e.state.await(5_000, "the confirm card") { s -> s.cards.any { it.kind == CardKind.CONFIRM } }
            .cards.first { it.kind == CardKind.CONFIRM }
        assertEquals("confirm:c-close-tab", card.id)
        assertEquals("close the tab Zeb", card.line)
        assertEquals(listOf(CardAction.YES, CardAction.NO), card.actions)
        e.cardAction(card.id, CardAction.YES)
        waitFor(5_000, "brain-confirm at the desktop") {
            val c = stats().getJSONArray("confirms")
            (0 until c.length()).any { c.getJSONObject(it).getString("id") == "c-close-tab" && c.getJSONObject(it).getBoolean("allow") }
        }
        e.state.await(5_000, "the card gone") { s -> s.cards.none { it.kind == CardKind.CONFIRM } }
    }
}
