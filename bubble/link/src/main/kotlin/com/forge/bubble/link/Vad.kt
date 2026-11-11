package com.forge.bubble.link

import kotlin.math.min
import kotlin.math.sqrt

/**
 * End-of-speech detection on 100 ms frame levels, with the PWA's numbers
 * (web/src/deck/live-ears.ts, wire spec 3.2B):
 *
 *  - a turn starts when the level is at or over max(0.02, floor × 3) for 2
 *    frames running; the floor follows quiet frames slowly (capped at 0.03);
 *  - inside a turn a frame is voiced while its level is at least 0.6 × the
 *    start level; the turn ends after 800 ms (8 frames) with none, or at 600
 *    frames (60 s);
 *  - a turn with fewer than 3 voiced frames is dropped, not sent;
 *  - the 3 frames before the start (this one included) are pre-roll.
 *
 * Pure: feed it levels, it says what happened. It never sees audio. No
 * barge-in rule: the bubble is half-duplex and does not listen while a clip
 * plays.
 */
class Vad {
    enum class Step {
        /** Not in a turn. Keep this frame as possible pre-roll. */
        QUIET,
        /** A turn began with this frame: send the last [PRE_ROLL_FRAMES] frames (this one included). */
        START,
        /** In a turn: send this frame. */
        CONTINUE,
        /** The turn is over and worth hearing: send this frame, then finish. */
        END,
        /** The turn is over and too short: drop it. */
        DROP,
    }

    var floor = FLOOR_START
        private set
    private var over = 0
    private var inTurn = false
    private var frames = 0
    private var voiced = 0
    private var quietMs = 0
    private var startLevel = 0f

    val speaking: Boolean get() = inTurn

    fun push(level: Float): Step {
        val start = maxOf(START_MIN, floor * START_RATIO)
        if (inTurn) {
            frames++
            if (level >= startLevel * HOLD_RATIO) {
                voiced++
                quietMs = 0
            } else {
                quietMs += FRAME_MS
            }
            if (quietMs >= END_SILENCE_MS || frames >= MAX_TURN_FRAMES) {
                inTurn = false
                return if (voiced >= MIN_VOICED_FRAMES) Step.END else Step.DROP
            }
            return Step.CONTINUE
        }
        if (level >= start) {
            over++
        } else {
            over = 0
            floor = min(FLOOR_MAX, floor * 0.95f + level * 0.05f)
        }
        if (over >= START_FRAMES) {
            inTurn = true
            startLevel = start
            frames = min(over, PRE_ROLL_FRAMES)
            voiced = over
            quietMs = 0
            over = 0
            return Step.START
        }
        return Step.QUIET
    }

    /** Forget any turn in progress (listening went off, or a clip began). The floor is kept. */
    fun reset() {
        inTurn = false
        over = 0
        frames = 0
        voiced = 0
        quietMs = 0
    }

    companion object {
        const val FRAME_MS = 100
        const val START_FRAMES = 2
        const val END_SILENCE_MS = 800
        const val MIN_VOICED_FRAMES = 3
        const val PRE_ROLL_FRAMES = 3
        const val MAX_TURN_FRAMES = 600
        const val START_RATIO = 3f
        const val START_MIN = 0.02f
        const val HOLD_RATIO = 0.6f
        const val FLOOR_MAX = 0.03f
        const val FLOOR_START = 0.005f

        /** A frame's level: RMS of the samples in 0..1. */
        fun rms(pcm: ShortArray): Float {
            if (pcm.isEmpty()) return 0f
            var sum = 0.0
            for (s in pcm) {
                val v = s / 32768.0
                sum += v * v
            }
            return min(1.0, sqrt(sum / pcm.size)).toFloat()
        }
    }
}
