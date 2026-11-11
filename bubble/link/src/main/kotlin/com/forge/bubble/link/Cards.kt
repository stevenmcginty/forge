package com.forge.bubble.link

import org.json.JSONArray
import org.json.JSONObject

enum class CardKind { CONFIRM, NEEDS_YOU, JOB }

enum class CardAction { YES, NO, STOP, DISMISS }

/**
 * One card for the bubble's list. [title] and [line] are ready to show;
 * [state] is one plain word ("Needs you", "Done", "Some risk" ...); [actions]
 * are the buttons, in order.
 */
data class Card(
    val id: String,
    val kind: CardKind,
    val title: String,
    val line: String,
    val state: String,
    val at: Long,
    val actions: List<CardAction>,
    val jobId: String? = null,
    val paneId: String? = null,
    /** What a dismiss remembers: a job's `id:updatedAt`, so a job that moves again comes back. */
    val dismissKey: String,
)

/** A Claude Live ledger job, phone-trimmed (wire spec 6.1). */
data class LiveJob(
    val id: String,
    val title: String,
    val paneId: String?,
    val paneName: String?,
    val owner: String,
    val state: String,
    val updatedAt: Long,
    val summary: String?,
    val lastStep: String?,
)

/** Forge Brain wants a yes (BrainStatus.confirms). */
data class Confirm(val id: String, val tool: String, val summary: String, val risk: String, val at: Long)

/** A pane settled on a question (`attention` frame). */
data class Asking(val paneId: String, val name: String, val prompt: String, val since: Long)

/**
 * Which cards show, in order — the PWA's rules (web/src/deck/live-words.ts
 * `liveCardsOf`, LiveCards.tsx) plus Forge Brain's confirms and asking panes:
 *
 *  1. confirms, oldest first (each has Yes / No);
 *  2. needs-you, newest first, one per pane: ledger jobs in `needs-you`, then
 *     asking panes no job already covers, then needs-you news no job covers;
 *  3. done / failed jobs updated within the last 30 minutes, newest first.
 *
 * Minus whatever was dismissed (by [Card.dismissKey]).
 */
object Cards {
    const val DONE_KEEP_MS = 30 * 60_000L

    private val RISK_WORD = mapOf("low" to "Low risk", "medium" to "Some risk", "high" to "High risk")
    private val STATE_WORD = mapOf(
        "queued" to "Waiting", "running" to "Working", "needs-you" to "Needs you",
        "done" to "Done", "failed" to "Failed", "stopped" to "Stopped",
    )

    fun stateWord(state: String): String = STATE_WORD[state] ?: state

    fun build(
        confirms: List<Confirm>,
        jobs: List<LiveJob>,
        asking: Collection<Asking>,
        needsNews: List<News.Item>,
        now: Long,
        dismissed: Set<String>,
    ): List<Card> {
        val out = mutableListOf<Card>()
        for (c in confirms.sortedBy { it.at }) {
            val card = Card(
                id = "confirm:${c.id}", kind = CardKind.CONFIRM, title = "Forge Brain asks",
                line = c.summary.ifBlank { c.tool }, state = RISK_WORD[c.risk] ?: "Asks first", at = c.at,
                actions = listOf(CardAction.YES, CardAction.NO), dismissKey = "confirm:${c.id}",
            )
            if (card.dismissKey !in dismissed) out += card
        }

        val needs = LinkedHashMap<String, Card>()
        for (j in jobs.filter { it.state == "needs-you" }) {
            val id = j.paneId?.let { "pane:$it" } ?: "job:${j.id}"
            if (needs.containsKey(id)) continue
            needs[id] = Card(
                id = id, kind = CardKind.NEEDS_YOU,
                title = j.paneName?.takeIf { it.isNotBlank() }?.let { "$it needs you" } ?: j.title,
                line = j.summary ?: j.lastStep ?: j.title, state = stateWord(j.state), at = j.updatedAt,
                actions = if (j.owner == "conductor") listOf(CardAction.STOP, CardAction.DISMISS) else listOf(CardAction.DISMISS),
                jobId = j.id, paneId = j.paneId, dismissKey = "${j.id}:${j.updatedAt}",
            )
        }
        for (a in asking) {
            val id = "pane:${a.paneId}"
            if (needs.containsKey(id)) continue
            needs[id] = Card(
                id = id, kind = CardKind.NEEDS_YOU, title = "${a.name} is asking",
                line = a.prompt.ifBlank { "Waiting for an answer" }, state = "Needs you", at = a.since,
                actions = listOf(CardAction.DISMISS), paneId = a.paneId, dismissKey = "pane:${a.paneId}:${a.since}",
            )
        }
        val coveredJobs = needs.values.mapNotNull { it.jobId }.toSet()
        for (n in needsNews) {
            if (n.jobId != null && n.jobId in coveredJobs) continue
            val id = n.jobId?.let { "job:$it" } ?: "news:${n.id}"
            if (needs.containsKey(id)) continue
            needs[id] = Card(
                id = id, kind = CardKind.NEEDS_YOU, title = "Needs you", line = n.text, state = "Needs you",
                at = n.at, actions = listOf(CardAction.DISMISS), jobId = n.jobId, dismissKey = "news:${n.id}",
            )
        }
        out += needs.values.filter { it.dismissKey !in dismissed }.sortedByDescending { it.at }

        out += jobs
            .filter { (it.state == "done" || it.state == "failed") && now - it.updatedAt <= DONE_KEEP_MS }
            .sortedByDescending { it.updatedAt }
            .map { j ->
                Card(
                    id = "job:${j.id}", kind = CardKind.JOB, title = j.title,
                    line = j.summary ?: j.lastStep ?: "", state = stateWord(j.state), at = j.updatedAt,
                    actions = listOf(CardAction.DISMISS), jobId = j.id, paneId = j.paneId,
                    dismissKey = "${j.id}:${j.updatedAt}",
                )
            }
            .filter { it.dismissKey !in dismissed }
        return out
    }

    /** Jobs running or queued. */
    fun working(jobs: List<LiveJob>): Int = jobs.count { it.state == "running" || it.state == "queued" }

    /* --------------------------------------------------------------- parsing */

    fun parseJobs(a: JSONArray?): List<LiveJob> {
        val out = mutableListOf<LiveJob>()
        if (a == null) return out
        for (i in 0 until a.length()) {
            val j = a.optJSONObject(i) ?: continue
            val id = j.optString("id")
            if (id.isBlank()) continue
            val steps = j.optJSONArray("steps")
            val last = steps?.optJSONObject(steps.length() - 1)?.optString("text")?.takeIf { it.isNotBlank() }
            out += LiveJob(
                id = id,
                title = j.optString("title", id),
                paneId = j.optStringOrNull("paneId"),
                paneName = j.optStringOrNull("paneName"),
                owner = j.optString("owner", "conductor"),
                state = j.optString("state"),
                updatedAt = j.optLong("updatedAt", 0L),
                summary = j.optStringOrNull("summary"),
                lastStep = last,
            )
        }
        return out
    }

    fun parseConfirms(status: JSONObject?): List<Confirm> {
        val a = status?.optJSONArray("confirms") ?: return emptyList()
        val out = mutableListOf<Confirm>()
        for (i in 0 until a.length()) {
            val c = a.optJSONObject(i) ?: continue
            val id = c.optString("id")
            if (id.isBlank()) continue
            out += Confirm(id, c.optString("tool"), c.optString("summary"), c.optString("risk"), c.optLong("at", 0L))
        }
        return out
    }
}

internal fun JSONObject.optStringOrNull(key: String): String? =
    if (has(key) && !isNull(key)) optString(key).takeIf { it.isNotBlank() } else null
