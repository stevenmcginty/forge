package com.forge.bubble.link

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class VadTest {
    private fun Vad.feed(level: Float, n: Int): List<Vad.Step> = (1..n).map { push(level) }

    @Test
    fun silenceStaysQuiet() {
        val v = Vad()
        assertTrue(v.feed(0.001f, 30).all { it == Vad.Step.QUIET })
    }

    @Test
    fun twoLoudFramesStartATurnAndEightQuietOnesEndIt() {
        val v = Vad()
        v.feed(0.001f, 5)
        assertEquals(Vad.Step.QUIET, v.push(0.2f))
        assertEquals(Vad.Step.START, v.push(0.2f))
        assertTrue(v.feed(0.2f, 5).all { it == Vad.Step.CONTINUE })
        val tail = v.feed(0.001f, 8)
        assertTrue(tail.dropLast(1).all { it == Vad.Step.CONTINUE })
        assertEquals(Vad.Step.END, tail.last())
        assertEquals(Vad.Step.QUIET, v.push(0.001f))
    }

    @Test
    fun aVoicedFrameResetsTheSilenceClock() {
        val v = Vad()
        v.feed(0.2f, 2)
        v.feed(0.001f, 7)
        assertEquals(Vad.Step.CONTINUE, v.push(0.2f))
        assertTrue(v.feed(0.001f, 7).all { it == Vad.Step.CONTINUE })
        assertEquals(Vad.Step.END, v.push(0.001f))
    }

    @Test
    fun aBlipShorterThanThreeVoicedFramesIsDropped() {
        val v = Vad()
        assertEquals(listOf(Vad.Step.QUIET, Vad.Step.START), v.feed(0.2f, 2))
        val tail = v.feed(0.001f, 8)
        assertEquals(Vad.Step.DROP, tail.last())
    }

    @Test
    fun holdIsSixTenthsOfTheStartLevel() {
        val v = Vad()
        v.feed(0.2f, 2) // start level = max(0.02, 0.005 x 3) = 0.02; hold = 0.012
        assertTrue(v.feed(0.013f, 20).all { it == Vad.Step.CONTINUE })
        val tail = v.feed(0.011f, 8)
        assertEquals(Vad.Step.END, tail.last())
    }

    @Test
    fun aNoisyRoomRaisesTheBar() {
        val v = Vad()
        v.feed(0.012f, 200) // the floor follows the room up
        assertTrue(v.floor > 0.01f)
        // 0.03 would start a turn in a quiet room; here the bar is floor x 3.
        assertTrue(v.feed(0.03f, 5).all { it == Vad.Step.QUIET })
        assertTrue(v.feed(0.2f, 2).contains(Vad.Step.START))
    }

    @Test
    fun aTurnEndsAtSixtySeconds() {
        val v = Vad()
        v.feed(0.2f, 2)
        val steps = v.feed(0.2f, Vad.MAX_TURN_FRAMES)
        assertTrue(steps.contains(Vad.Step.END))
        assertTrue(steps.indexOf(Vad.Step.END) < Vad.MAX_TURN_FRAMES)
    }

    @Test
    fun rmsOfATone() {
        val loud = Vad.rms(pcmFrame(8000))
        assertTrue(loud > 0.15f && loud < 0.2f)
        assertTrue(Vad.rms(pcmFrame(5)) < 0.001f)
    }
}
