package com.forge.bubble.link

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.asCoroutineDispatcher
import kotlinx.coroutines.async
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.runBlocking
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.concurrent.Executors

/** The `refused` table of wire spec 1.7, against a fake desktop. PIN safety first. */
class RefusedTableTest {
    private val executor = Executors.newSingleThreadExecutor()
    private val scope = CoroutineScope(SupervisorJob() + executor.asCoroutineDispatcher())
    private val transport = FakeTransport()
    private val tokens = FakeTokens()
    private val store = MemoryStore()
    private val link = ForgeLink(
        LinkConfig(apiKey = "", databaseUrl = "", deviceName = "Test phone"),
        store, tokens, DirectLookup("ws://fake/web"), transport, scope,
        LinkTiming(backoffMs = listOf(50L, 100L), helloTimeoutMs = 2_000L, busyFallbackMs = 60_000L),
    )

    @After
    fun tearDown() {
        link.stop()
        scope.cancel()
        executor.shutdown()
    }

    private suspend fun conn(n: Int): FakeTransport.FakeConn {
        waitFor(2_000, "dial #$n") { transport.conns.size >= n && transport.conns[n - 1].hello() != null }
        return transport.conns[n - 1]
    }

    private fun helloOk() = JSONObject().put("type", "hello-ok").put("proto", 2).put("desktopName", "DESK")

    @Test
    fun helloCarriesWhatTheDesktopNeedsAndNoPinWhenNoneIsKnown() = runBlocking<Unit> {
        link.start()
        val hello = conn(1).hello()!!
        assertEquals(2, hello.getInt("proto"))
        assertEquals("jwt-0", hello.getString("idToken"))
        assertEquals("Test phone", hello.getString("deviceName"))
        assertTrue(hello.getString("deviceId").isNotBlank())
        assertFalse(hello.has("pin"))
        assertFalse(hello.has("resume"))
    }

    @Test
    fun pinRequiredWaitsForAPinAndDialsOnceItComes() = runBlocking<Unit> {
        link.start()
        conn(1).refuse("pin-required")
        link.status.await(2_000, "NEED_PIN") { it.state == LinkState.NEED_PIN && !it.pinWrong }
        delay(500)
        assertEquals("no redial without a PIN", 1, transport.conns.size)
        assertTrue(link.submitPin("1234", remember = false))
        assertEquals("1234", conn(2).hello()!!.getString("pin"))
    }

    @Test
    fun pinInvalidForgetsThePinAndNeverReplaysIt() = runBlocking<Unit> {
        store.put(ForgeLink.K_PIN, "1111")
        val l2 = ForgeLink(
            LinkConfig(apiKey = "", databaseUrl = ""), store, tokens, DirectLookup("ws://fake/web"), transport, scope,
            LinkTiming(backoffMs = listOf(50L)),
        )
        try {
            l2.start()
            assertEquals("the remembered PIN is sent", "1111", conn(1).hello()!!.getString("pin"))
            conn(1).refuse("pin-invalid", message = "Wrong PIN.")
            l2.status.await(2_000, "NEED_PIN after pin-invalid") { it.state == LinkState.NEED_PIN && it.pinWrong }
            assertNull("the stored PIN is gone", store.get(ForgeLink.K_PIN))
            delay(1_000)
            assertEquals("no dial until a new PIN", 1, transport.conns.size)
            l2.start() // even asked to, it waits
            delay(300)
            assertEquals(1, transport.conns.size)
            l2.submitPin("2222", remember = true)
            val c2 = conn(2)
            assertEquals("2222", c2.hello()!!.getString("pin"))
            assertNull("not kept until the desktop takes it", store.get(ForgeLink.K_PIN))
            c2.serverSend(helloOk())
            l2.status.await(2_000, "ONLINE") { it.state == LinkState.ONLINE }
            assertEquals("2222", store.get(ForgeLink.K_PIN))
        } finally {
            l2.stop()
        }
    }

    @Test
    fun busyWaitsExactlyRetryAfter() = runBlocking<Unit> {
        link.start()
        val refusedAt = System.currentTimeMillis()
        conn(1).refuse("busy", retryAfterMs = 700, message = "Too many failed attempts - try again in 1s.")
        val locked = link.status.await(2_000, "LOCKED") { it.state == LinkState.LOCKED }
        assertTrue(locked.retryAt >= refusedAt + 700)
        assertEquals("Too many failed attempts - try again in 1s.", locked.reason)
        delay(450)
        assertEquals("not before retryAfterMs", 1, transport.conns.size)
        conn(2)
        assertTrue(System.currentTimeMillis() - refusedAt >= 700)
    }

    @Test
    fun badTokenRefreshesOnceThenSignsOut() = runBlocking<Unit> {
        link.start()
        conn(1).refuse("bad-token")
        val second = conn(2)
        assertEquals("a forced refresh before the silent redial", 1, tokens.forced)
        assertEquals("jwt-1", second.hello()!!.getString("idToken"))
        second.refuse("bad-token")
        link.status.await(2_000, "SIGNED_OUT") { it.state == LinkState.SIGNED_OUT }
        assertFalse(tokens.held)
        delay(300)
        assertEquals(2, transport.conns.size)
    }

    @Test
    fun badTokenStreakResetsOnHelloOk() = runBlocking<Unit> {
        link.start()
        conn(1).refuse("bad-token")
        conn(2).serverSend(helloOk())
        link.status.await(2_000, "ONLINE") { it.state == LinkState.ONLINE }
        conn(2).serverClose()
        conn(3).refuse("bad-token")
        conn(4)
        assertTrue(tokens.held)
    }

    @Test
    fun wrongAccountNotApprovedAndProtoStop() = runBlocking<Unit> {
        for ((reason, words) in listOf(
            "wrong-account" to "different account",
            "not-approved" to "did not let",
            "proto" to "Restart Forge",
        )) {
            val t = FakeTransport()
            val l = ForgeLink(LinkConfig(apiKey = "", databaseUrl = ""), MemoryStore(), FakeTokens(), DirectLookup("ws://fake/web"), t, scope, LinkTiming(backoffMs = listOf(50L)))
            l.start()
            waitFor(2_000, "dial") { t.conns.isNotEmpty() && t.conns[0].hello() != null }
            t.conns[0].refuse(reason, message = if (reason == "proto") "The desktop is old. Restart Forge on the desktop to update it." else "")
            val s = l.status.await(2_000, "STOPPED on $reason") { it.state == LinkState.STOPPED }
            assertTrue("$reason: ${s.reason}", s.reason.contains(words))
            delay(300)
            assertEquals("$reason: no redial", 1, t.conns.size)
            l.stop()
        }
    }

    @Test
    fun aDroppedSocketReconnectsAndRequestsMatchByRid() = runBlocking<Unit> {
        link.start()
        val c1 = conn(1)
        c1.serverSend(helloOk())
        link.status.await(2_000, "ONLINE") { it.state == LinkState.ONLINE && it.desktopName == "DESK" }
        val reply = scope.async { link.request(JSONObject().put("kind", "visibility").put("visible", true), 2_000) }
        waitFor(2_000, "request sent") { c1.sent.any { it.optString("type") == "request" } }
        val req = c1.sent.first { it.optString("type") == "request" }
        c1.serverSend(JSONObject().put("type", "something-new").put("x", 1)) // ignored
        c1.serverSend(JSONObject().put("type", "result").put("rid", "other").put("body", JSONObject().put("kind", "ok")))
        c1.serverSend(JSONObject().put("type", "result").put("rid", req.getString("rid")).put("body", JSONObject().put("kind", "ok").put("n", 7)))
        assertEquals(7, reply.await().getInt("n"))
        c1.serverClose(1001)
        link.status.await(2_000, "OFFLINE") { it.state == LinkState.OFFLINE }
        conn(2)
    }

    @Test
    fun shutdownDisabledStops() = runBlocking<Unit> {
        link.start()
        val c1 = conn(1)
        c1.serverSend(helloOk())
        link.status.await(2_000, "ONLINE") { it.state == LinkState.ONLINE }
        c1.serverSend(JSONObject().put("type", "shutdown").put("reason", "disabled").put("message", "Forge Web was turned off."))
        c1.serverClose(1001)
        link.status.await(2_000, "STOPPED") { it.state == LinkState.STOPPED }
        delay(300)
        assertEquals(1, transport.conns.size)
    }

    @Test
    fun noHelloOkInTimeHangsUpAndRetries() = runBlocking<Unit> {
        link.start()
        conn(1)
        link.status.await(4_000, "OFFLINE after hello timeout") { it.state == LinkState.OFFLINE && it.reason == "The desktop did not answer" }
        conn(2)
    }
}
