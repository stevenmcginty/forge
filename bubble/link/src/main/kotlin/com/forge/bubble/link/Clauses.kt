package com.forge.bubble.link

/**
 * How a streamed reply is cut into lines to speak. Kotlin ports of
 * `takeClauses` (web/src/deck/live-words.ts), `speakable` (src/lib/speech.ts)
 * and `appendCaption` (src/lib/live/turns.ts), kept rule for rule.
 */
object Clauses {
    /** Longest run allowed to wait for a clause or a full stop. */
    const val CHUNK_MAX = 220
    /** A first chunk cut at a clause has at least this many words. */
    const val FIRST_CLAUSE_MIN_WORDS = 4
    /** The spoken acks, fetched once and played when a reply is slow. */
    val ACK_LINES: List<String> = listOf("Okay.", "Sure.", "One sec.", "Let me check.")

    private val SENTENCE_END = Regex("[.!?][\"')\\]]?(?=\\s)")
    private val CLAUSE_END = Regex("(?:[,;:]|\\s[—–-])(?=\\s)")
    private val WORD = Regex("\\w")
    private val SPACES = Regex("\\s+")

    data class Taken(val chunks: List<String>, val rest: String)

    private fun clauseCut(text: String, limit: Int): Int {
        for (m in CLAUSE_END.findAll(text)) {
            val end = m.range.first + m.value.length
            if (limit >= 0 && end >= limit) return -1
            val words = text.substring(0, end).split(SPACES).count { WORD.containsMatchIn(it) }
            if (words >= FIRST_CLAUSE_MIN_WORDS) return end
        }
        return -1
    }

    /**
     * The finished chunks at the front of a growing reply, and the rest to keep.
     * With [firstClause] the first chunk may end at a clause of four words or
     * more, so speech starts before the full stop is written; every later
     * chunk is a sentence. A run past [max] with no cut is cut softly.
     */
    fun take(buffer: String, firstClause: Boolean, max: Int = CHUNK_MAX): Taken {
        val chunks = mutableListOf<String>()
        var rest = buffer
        while (true) {
            val hit = SENTENCE_END.find(rest)
            var cut = if (hit != null) hit.range.first + hit.value.length else -1
            if (firstClause && chunks.isEmpty()) {
                val clause = clauseCut(rest, cut)
                if (clause > 0 && clause <= max) cut = clause
            }
            if (cut < 0) {
                if (rest.length <= max) break
                val window = rest.substring(0, max)
                val soft = maxOf(window.lastIndexOf(", "), window.lastIndexOf("; "), window.lastIndexOf(' '))
                cut = if (soft > 0) soft + 1 else max
            }
            val head = rest.substring(0, cut).trim()
            rest = rest.substring(cut)
            if (head.isNotEmpty()) chunks += head
        }
        return Taken(chunks, rest)
    }

    private val FENCE = Regex("```[\\s\\S]*?```")
    private val TICKS = Regex("`([^`]*)`")
    private val HEADING = Regex("(?m)^#{1,6}\\s*")
    private val BULLET = Regex("(?m)^[-*]\\s+")
    private val BOLD = Regex("\\*\\*?([^*]+)\\*\\*?")
    private val URL = Regex("https?://\\S+")

    /** A line fit to be read aloud: no code, no markdown, links as "a link", at most [limit] chars. */
    fun speakable(text: String?, limit: Int = 340): String {
        var out = (text ?: "")
            .replace(FENCE, " ")
            .replace(TICKS, "$1")
            .replace(HEADING, "")
            .replace(BULLET, "")
            .replace(BOLD, "$1")
            .replace(URL, "a link")
            .replace(SPACES, " ")
            .trim()
        if (out.length <= limit) return out
        out = out.substring(0, limit)
        val stop = maxOf(out.lastIndexOf(". "), out.lastIndexOf("! "), out.lastIndexOf("? "))
        return (if (stop > 80) out.substring(0, stop + 1) else out).trim()
    }

    /** A streamed piece onto the caption: joined as written, a doubled space at the seam folded. */
    fun appendCaption(prev: String?, delta: String?): String {
        val head = prev ?: ""
        val piece = delta ?: ""
        if (head.isEmpty()) return piece.trimStart()
        if (head.last().isWhitespace() && piece.isNotEmpty() && piece.first().isWhitespace()) return head + piece.trimStart()
        return head + piece
    }
}
