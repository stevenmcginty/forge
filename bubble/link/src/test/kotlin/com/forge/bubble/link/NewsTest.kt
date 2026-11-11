package com.forge.bubble.link

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class NewsTest {
    private fun item(id: String, text: String, urgency: String = "info", jobId: String? = null, at: Long = 0L) =
        News.Item(id, jobId, text, urgency, at)

    @Test
    fun theSameIdIsOneItem() {
        var q = News.queue(emptyList(), item("n1", "Build done."))
        q = News.queue(q, item("n1", "Build done."))
        assertEquals(1, q.size)
    }

    @Test
    fun aNewerItemForTheSameJobReplacesTheOlder() {
        var q = News.queue(emptyList(), item("n1", "Kess needs you.", "needs-you", "j1"))
        q = News.queue(q, item("n2", "Other."))
        q = News.queue(q, item("n3", "Kess is done.", "done", "j1"))
        assertEquals(listOf("n2", "n3"), q.map { it.id })
    }

    @Test
    fun blankNewsIsNotQueued() {
        assertTrue(News.queue(emptyList(), item("n1", "  ")).isEmpty())
    }

    @Test
    fun oneNeedsYouAloneFirst() {
        val q = listOf(item("a", "A done."), item("b", "B needs you.", "needs-you"), item("c", "C done."))
        val t = News.take(q)!!
        assertEquals("B needs you.", t.say)
        assertEquals(listOf("a", "c"), t.rest.map { it.id })
    }

    @Test
    fun elseUpToThreeJoined() {
        val q = (1..5).map { item("n$it", "Line $it.") }
        val t = News.take(q)!!
        assertEquals("Line 1. Line 2. Line 3.", t.say)
        assertEquals(listOf("n4", "n5"), t.rest.map { it.id })
        assertNull(News.take(emptyList()))
    }

    @Test
    fun spokenOnlyAtAGap() {
        assertTrue(News.gapOpen(5_000, hearing = false, heardEndAt = null, speaking = false, turnBusy = false))
        assertFalse(News.gapOpen(5_000, hearing = true, heardEndAt = null, speaking = false, turnBusy = false))
        assertFalse(News.gapOpen(5_000, hearing = false, heardEndAt = null, speaking = true, turnBusy = false))
        assertFalse(News.gapOpen(5_000, hearing = false, heardEndAt = null, speaking = false, turnBusy = true))
        assertFalse(News.gapOpen(5_000, hearing = false, heardEndAt = 4_500, speaking = false, turnBusy = false))
        assertTrue(News.gapOpen(5_000, hearing = false, heardEndAt = 4_000, speaking = false, turnBusy = false))
    }
}
