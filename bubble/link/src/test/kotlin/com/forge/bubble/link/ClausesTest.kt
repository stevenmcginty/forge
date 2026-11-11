package com.forge.bubble.link

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class ClausesTest {
    @Test
    fun sentencesAreCutAndTheTailKept() {
        val t = Clauses.take("Two agents are working. Kess needs", firstClause = false)
        assertEquals(listOf("Two agents are working."), t.chunks)
        assertEquals(" Kess needs", t.rest)
    }

    @Test
    fun aSentenceEndNeedsWhitespaceAfterIt() {
        val t = Clauses.take("Version 1.5 is out.", firstClause = false)
        assertEquals(emptyList<String>(), t.chunks)
        assertEquals("Version 1.5 is out.", t.rest)
    }

    @Test
    fun aClosingQuoteStaysWithItsSentence() {
        val t = Clauses.take("He said \"go.\" Then", firstClause = false)
        assertEquals(listOf("He said \"go.\""), t.chunks)
    }

    @Test
    fun theFirstChunkMayEndAtAClauseOfFourWords() {
        val t = Clauses.take("Okay so the build is green, and the tests pass. Next", firstClause = true)
        assertEquals(listOf("Okay so the build is green,", "and the tests pass."), t.chunks)
        assertEquals(" Next", t.rest)
    }

    @Test
    fun aClauseOfFewerWordsDoesNotCut() {
        val t = Clauses.take("Sure, I will check that now. More", firstClause = true)
        assertEquals(listOf("Sure, I will check that now."), t.chunks)
    }

    @Test
    fun laterChunksAreSentencesOnly() {
        val t = Clauses.take("Okay so the build is green, and more", firstClause = false)
        assertEquals(emptyList<String>(), t.chunks)
    }

    @Test
    fun aSpacedDashIsAClause() {
        val t = Clauses.take("The tests all passed on Windows - and on the phone. ", firstClause = true)
        assertEquals("The tests all passed on Windows -", t.chunks.first())
    }

    @Test
    fun aLongRunIsCutSoftlyInsideTheMax() {
        val words = (1..80).joinToString(" ") { "word$it" }
        val t = Clauses.take(words, firstClause = false)
        assertTrue(t.chunks.isNotEmpty())
        assertTrue(t.chunks.all { it.length <= Clauses.CHUNK_MAX })
        assertEquals(words, (t.chunks + t.rest.trim()).joinToString(" "))
    }

    @Test
    fun speakableDropsMarkdownAndCode() {
        assertEquals("Run it now.", Clauses.speakable("Run ```npm test``` it now.").replace("  ", " "))
        assertEquals("Open app.ts please", Clauses.speakable("Open `app.ts` please"))
        assertEquals("Title", Clauses.speakable("## Title"))
        assertEquals("first second", Clauses.speakable("- first\n* second"))
        assertEquals("very important", Clauses.speakable("**very** important"))
        assertEquals("See a link for more", Clauses.speakable("See https://example.com/x?y=1 for more"))
    }

    @Test
    fun speakableCapsAtASentenceEnd() {
        val long = "This sentence is here to be long enough. ".repeat(12)
        val out = Clauses.speakable(long)
        assertTrue(out.length <= 340)
        assertTrue(out.endsWith("."))
    }

    @Test
    fun captionPiecesJoinAsWritten() {
        assertEquals("Sure, I'll check", Clauses.appendCaption(Clauses.appendCaption("Sure", ", I'll"), " check"))
        assertEquals("a b", Clauses.appendCaption("a ", " b"))
        assertEquals("hi", Clauses.appendCaption(null, "  hi"))
        assertEquals("Two agents are working. Kess needs you.", Clauses.appendCaption("Two agents are working. ", "Kess needs you."))
    }
}
