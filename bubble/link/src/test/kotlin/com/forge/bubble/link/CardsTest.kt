package com.forge.bubble.link

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class CardsTest {
    private val now = 10_000_000L

    private fun job(id: String, state: String, updatedAt: Long, paneId: String? = null, paneName: String? = null, owner: String = "conductor") =
        LiveJob(id, "Job $id", paneId, paneName, owner, state, updatedAt, null, "step of $id")

    @Test
    fun confirmsThenNeedsYouNewestFirstThenRecentDone() {
        val jobs = listOf(
            job("old-need", "needs-you", now - 5_000),
            job("new-need", "needs-you", now - 1_000),
            job("done", "done", now - 60_000),
            job("failed", "failed", now - 10_000),
            job("stale", "done", now - Cards.DONE_KEEP_MS - 1),
            job("run", "running", now),
        )
        val confirms = listOf(Confirm("c1", "run_app_action", "close the tab Zeb", "medium", now))
        val cards = Cards.build(confirms, jobs, emptyList(), emptyList(), now, emptySet())
        assertEquals(listOf("confirm:c1", "job:new-need", "job:old-need", "job:failed", "job:done"), cards.map { it.id })
        assertEquals(listOf(CardAction.YES, CardAction.NO), cards[0].actions)
        assertEquals("Some risk", cards[0].state)
        assertEquals(1, Cards.working(jobs))
    }

    @Test
    fun oneNeedsYouCardPerPane() {
        val jobs = listOf(job("j1", "needs-you", now - 1_000, paneId = "p1", paneName = "Kess", owner = "pane"))
        val asking = listOf(Asking("p1", "Kess", "Allow edit?", now), Asking("p2", "Zeb", "Run tests?", now - 2_000))
        val cards = Cards.build(emptyList(), jobs, asking, emptyList(), now, emptySet())
        assertEquals(listOf("pane:p1", "pane:p2"), cards.map { it.id })
        assertEquals("Kess needs you", cards[0].title)
        assertEquals(listOf(CardAction.DISMISS), cards[0].actions)
        assertEquals("Zeb is asking", cards[1].title)
        assertEquals("Run tests?", cards[1].line)
    }

    @Test
    fun needsYouNewsMakesACardUntilItsJobArrives() {
        val news = listOf(News.Item("n1", "j1", "Kess needs you to approve a file change.", "needs-you", now))
        val alone = Cards.build(emptyList(), emptyList(), emptyList(), news, now, emptySet())
        assertEquals(listOf("job:j1"), alone.map { it.id })
        assertEquals(CardKind.NEEDS_YOU, alone[0].kind)
        assertEquals("Kess needs you to approve a file change.", alone[0].line)

        val jobs = listOf(job("j1", "needs-you", now, paneId = "p1", paneName = "Kess"))
        val merged = Cards.build(emptyList(), jobs, emptyList(), news, now, emptySet())
        assertEquals(listOf("pane:p1"), merged.map { it.id })
    }

    @Test
    fun stopOnlyForAConductorJob() {
        val cards = Cards.build(emptyList(), listOf(job("j1", "needs-you", now)), emptyList(), emptyList(), now, emptySet())
        assertEquals(listOf(CardAction.STOP, CardAction.DISMISS), cards[0].actions)
    }

    @Test
    fun aDismissedJobComesBackWhenItMovesAgain() {
        val first = listOf(job("j1", "done", now - 1_000))
        val key = Cards.build(emptyList(), first, emptyList(), emptyList(), now, emptySet()).single().dismissKey
        assertEquals("j1:${now - 1_000}", key)
        assertTrue(Cards.build(emptyList(), first, emptyList(), emptyList(), now, setOf(key)).isEmpty())
        val moved = listOf(job("j1", "failed", now))
        assertEquals(1, Cards.build(emptyList(), moved, emptyList(), emptyList(), now, setOf(key)).size)
    }

    @Test
    fun parsesTheWireShapes() {
        val jobs = Cards.parseJobs(
            JSONArray().put(
                JSONObject().put("id", "j1").put("title", "T").put("owner", "pane").put("state", "needs-you")
                    .put("updatedAt", 5L).put("paneId", "p1").put("paneName", "Kess")
                    .put("steps", JSONArray().put(JSONObject().put("at", 1L).put("text", "asked")))
            )
        )
        assertEquals(LiveJob("j1", "T", "p1", "Kess", "pane", "needs-you", 5L, null, "asked"), jobs.single())
        val confirms = Cards.parseConfirms(
            JSONObject().put("confirms", JSONArray().put(JSONObject().put("id", "c1").put("tool", "t").put("summary", "s").put("risk", "high").put("at", 3L)))
        )
        assertEquals(Confirm("c1", "t", "s", "high", 3L), confirms.single())
    }
}
