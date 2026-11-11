package com.forge.bubble.link

/**
 * Claude Live's news, queued and said at a gap — the rules of
 * src/lib/live/turns.ts (`queueNews`, `newsGapOpen`, `takeNews`; wire spec 4).
 * Pure: the engine holds the list and asks.
 */
object News {
    /** News waits this long after the human stops talking: a gap, not a breath. */
    const val GAP_MS = 1_000L
    /** Lines said in one go; the rest wait for the next gap. */
    const val BATCH_MAX = 3

    data class Item(val id: String, val jobId: String?, val text: String, val urgency: String, val at: Long)

    /** The same id twice is one item; a newer item about the same job replaces the older. */
    fun queue(queue: List<Item>, item: Item): List<Item> {
        if (item.text.isBlank() || queue.any { it.id == item.id }) return queue
        val kept = if (item.jobId != null) queue.filter { it.jobId != item.jobId } else queue
        return kept + item
    }

    /** Never over the human, never within [GAP_MS] of them stopping, never over a reply. */
    fun gapOpen(now: Long, hearing: Boolean, heardEndAt: Long?, speaking: Boolean, turnBusy: Boolean): Boolean {
        if (hearing || speaking || turnBusy) return false
        return heardEndAt == null || now - heardEndAt >= GAP_MS
    }

    data class Taken(val say: String, val ids: List<String>, val rest: List<Item>)

    /** The oldest needs-you alone, first; otherwise up to [BATCH_MAX] of the rest, oldest first, as one line. */
    fun take(queue: List<Item>): Taken? {
        if (queue.isEmpty()) return null
        val urgent = queue.firstOrNull { it.urgency == "needs-you" }
        val picked = if (urgent != null) listOf(urgent) else queue.take(BATCH_MAX)
        val ids = picked.map { it.id }
        val say = picked.map { it.text.trim() }.filter { it.isNotEmpty() }.joinToString(" ")
        return Taken(say, ids, queue.filter { it.id !in ids })
    }
}
