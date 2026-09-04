package com.forge.watch

/**
 * The words the watch listens for, and what they mean.
 *
 * Everything is a phrase said on its own — the recogniser ends an utterance on
 * a pause, so "new tab" *pause* "fix the login bug" is two phrases, and the
 * first is a command. A phrase that is not a command is prompt text.
 *
 * Kept as pure functions so the grammar can be read in one place and tested
 * without a microphone.
 */
object VoiceCommands {

    sealed class Command {
        /** Type the prompt so far into the pane and press Enter. */
        object Send : Command()
        /** Throw the prompt so far away. */
        object Cancel : Command()
        /** Stop listening. The prompt stays on screen. */
        object Stop : Command()
        /** Switch which project we are talking to. */
        data class OpenProject(val name: String) : Command()
        /** Open a new tab in the current project, optionally with a named agent. */
        data class NewTab(val profile: String?) : Command()
        /** Bring a tab to the front: by number (1-based), by name, or by step. */
        data class SelectTab(val index: Int?, val name: String?, val step: Int) : Command()
        /** Press Enter on its own — answer a yes/no prompt, or nudge the agent. */
        object Enter : Command()
        /** Send Escape — interrupt the agent's current turn. */
        object Escape : Command()
        /** Nothing matched: this is prompt text. */
        data class Text(val text: String) : Command()
    }

    private val SEND = Regex("""^(?:send(?: it| that| this| now)?|go(?: ahead)?|submit(?: it)?|fire(?: it)?|do it|run it)$""", RegexOption.IGNORE_CASE)
    private val CANCEL = Regex("""^(?:cancel(?: that| it)?|scrap (?:it|that)|clear(?: it| that)?|start (?:over|again)|never ?mind|forget (?:it|that))$""", RegexOption.IGNORE_CASE)
    private val STOP = Regex("""^(?:stop|stop listening|stop dictation|end note|i'?m done|that'?s all)$""", RegexOption.IGNORE_CASE)
    private val ENTER = Regex("""^(?:press enter|hit enter|enter|say yes|yes)$""", RegexOption.IGNORE_CASE)
    private val ESCAPE = Regex("""^(?:escape|press escape|interrupt|stop it|stop the agent)$""", RegexOption.IGNORE_CASE)
    private val OPEN = Regex("""^(?:open|go to|switch to|use|select)(?: the)?(?: project)? (.+?)(?: project)?$""", RegexOption.IGNORE_CASE)
    private val NEW_TAB = Regex("""^(?:new|open a new|open new|start a new|start new|create a new|create new|make a new|make new|add a new|add new|add) (?:tab|pane|session|window|terminal)(?: (?:with|using|for|running|in) (.+))?$""", RegexOption.IGNORE_CASE)
    private val TAB = Regex("""^(?:tab|go to tab|switch to tab|select tab|open tab|show tab) (.+)$""", RegexOption.IGNORE_CASE)
    private val NEXT_TAB = Regex("""^(?:next tab|tab right)$""", RegexOption.IGNORE_CASE)
    private val PREV_TAB = Regex("""^(?:previous tab|last tab|tab left|back a tab)$""", RegexOption.IGNORE_CASE)

    private val NUMBERS = mapOf(
        "one" to 1, "1" to 1, "first" to 1,
        "two" to 2, "to" to 2, "too" to 2, "2" to 2, "second" to 2,
        "three" to 3, "3" to 3, "third" to 3,
        "four" to 4, "for" to 4, "4" to 4, "fourth" to 4,
        "five" to 5, "5" to 5, "fifth" to 5,
        "six" to 6, "6" to 6, "sixth" to 6,
        "seven" to 7, "7" to 7, "seventh" to 7,
        "eight" to 8, "8" to 8, "eighth" to 8,
        "nine" to 9, "9" to 9, "ninth" to 9,
    )

    /** Trailing punctuation the recogniser adds, and the spare spaces around a phrase. */
    fun clean(raw: String): String = raw.trim().trimEnd('.', ',', '!', '?', ';', ':').trim()

    /**
     * Read one finished phrase.
     *
     * `draftEmpty` says whether prompt text has already been said. Project and
     * tab commands are only honoured before the prompt starts — mid-sentence,
     * "open the settings page" is a sentence, not a command. Send, cancel and
     * stop are honoured any time, because they are how a prompt ends.
     */
    fun parse(raw: String, draftEmpty: Boolean, projectNames: List<String>, profileNames: List<String>): Command {
        val text = clean(raw)
        if (text.isEmpty()) return Command.Text("")
        if (SEND.matches(text)) return Command.Send
        if (CANCEL.matches(text)) return Command.Cancel
        if (STOP.matches(text)) return Command.Stop
        if (draftEmpty) {
            if (ENTER.matches(text)) return Command.Enter
            if (ESCAPE.matches(text)) return Command.Escape
            if (NEXT_TAB.matches(text)) return Command.SelectTab(null, null, 1)
            if (PREV_TAB.matches(text)) return Command.SelectTab(null, null, -1)
            NEW_TAB.matchEntire(text)?.let { m ->
                val want = m.groupValues[1].trim()
                // A named agent has to be one we know; otherwise the words are
                // prompt text that happened to start with "new tab".
                if (want.isEmpty()) return Command.NewTab(null)
                val hit = bestMatch(want, profileNames)
                return if (hit != null) Command.NewTab(hit) else Command.Text(text)
            }
            TAB.matchEntire(text)?.let { m ->
                val what = m.groupValues[1].trim().lowercase()
                NUMBERS[what]?.let { return Command.SelectTab(it, null, 0) }
                return Command.SelectTab(null, what, 0)
            }
            OPEN.matchEntire(text)?.let { m ->
                val want = m.groupValues[1].trim()
                val hit = bestMatch(want, projectNames)
                if (hit != null) return Command.OpenProject(hit)
            }
        }
        return Command.Text(text)
    }

    /**
     * The name that best fits what was heard, or null when none does. Exact
     * first, then a name that starts with or contains the words, then one that
     * shares most of them. Recognisers hear "forge" as "fudge" often enough
     * that a first-letters fallback is worth having.
     */
    fun bestMatch(heard: String, names: List<String>): String? {
        val h = norm(heard)
        if (h.isEmpty() || names.isEmpty()) return null
        names.firstOrNull { norm(it) == h }?.let { return it }
        names.firstOrNull { norm(it).startsWith(h) || h.startsWith(norm(it)) }?.let { return it }
        names.firstOrNull { norm(it).contains(h) || h.contains(norm(it)) }?.let { return it }
        val hw = h.split(' ').filter { it.isNotBlank() }.toSet()
        var best: String? = null
        var bestScore = 0
        for (n in names) {
            val nw = norm(n).split(' ').filter { it.isNotBlank() }.toSet()
            val score = (hw intersect nw).size
            if (score > bestScore) { best = n; bestScore = score }
        }
        if (best != null) return best
        // Same first letter and a similar length: "fudge" for "forge".
        return names.firstOrNull { val n = norm(it); n.isNotEmpty() && n[0] == h[0] && kotlin.math.abs(n.length - h.length) <= 2 && n.length <= 8 }
    }

    private fun norm(s: String): String =
        s.lowercase().replace(Regex("[^a-z0-9 ]"), " ").replace(Regex("\\s+"), " ").trim()

    /** True when a partial result already reads as a whole command, so listening can end early. */
    fun isTerminal(partial: String): Boolean {
        val t = clean(partial)
        return SEND.matches(t) || CANCEL.matches(t) || STOP.matches(t)
    }

    /** Strip a trailing send/cancel/stop phrase from text that was ended by one. */
    fun stripTerminal(text: String): String {
        val words = clean(text).split(' ')
        for (take in 1..minOf(3, words.size)) {
            val tail = words.takeLast(take).joinToString(" ")
            if (SEND.matches(tail) || CANCEL.matches(tail) || STOP.matches(tail)) {
                return words.dropLast(take).joinToString(" ").trim()
            }
        }
        return clean(text)
    }
}
