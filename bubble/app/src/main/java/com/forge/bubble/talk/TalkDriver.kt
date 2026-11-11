package com.forge.bubble.talk

import android.content.Context
import android.os.Handler
import android.os.Looper
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.update

/**
 * The seam between the talk panel and whatever does the talking. The panel
 * draws [ui] and reports what the user does; the driver owns every decision.
 * [DemoDriver] fakes a conversation; the real one (the voice link to the desk)
 * plugs in through [TalkDrivers.factory].
 */
interface TalkDriver {
  val ui: StateFlow<PanelUi>
  /** 100 ms of 16 kHz mono PCM16 and its RMS level 0..1. Called on the mic thread. */
  fun onMicFrame(pcm: ShortArray, level: Float)
  fun onMicTap()
  fun onTyped(text: String)
  fun onCardAction(cardId: String, action: String)
  fun onPanelShown()
  fun onPanelHidden()
}

enum class TalkState { Idle, Listening, Thinking, Speaking, Offline }

data class CardUi(
  val id: String,
  val kind: String,
  val title: String,
  val line: String,
  val actions: List<String>,
)

data class PanelUi(
  val state: TalkState = TalkState.Idle,
  val level: Float = 0f,
  val heard: String = "",
  val reply: String = "",
  val cards: List<CardUi> = emptyList(),
  val working: Int = 0,
  val needsYou: Int = 0,
  val notice: String? = null,
)

/** Where TalkActivity gets its driver. A3 swaps the factory for the real link. */
object TalkDrivers {
  @Volatile
  var factory: (Context) -> TalkDriver = { DemoDriver() }
}

/**
 * A pretend conversation, for building and screenshotting the panel with no
 * desk: Listening (with the real mic level) → after 1.2 s of quiet that follows
 * some sound, heard = "Demo: what is running?" → Thinking 1 s → Speaking 2.5 s
 * with a reply and one "needs you" card → Listening again.
 *
 * [force] pins a state with sample content and stops the cycle (the debug
 * `demoState` extra uses it). All timing runs on main-thread timers.
 */
class DemoDriver : TalkDriver {

  companion object {
    private const val SOUND_LEVEL = 0.02f
    private const val QUIET_MS = 1_200L
    private const val THINK_MS = 1_000L
    private const val SPEAK_MS = 2_500L
    private const val FRAME_MS = 100L

    private val SAMPLE_CARD = CardUi(
      id = "demo-1",
      kind = "needs-you",
      title = "forge: approve a command",
      line = "Claude wants to run npm test in forge.",
      actions = listOf("Yes", "No"),
    )
  }

  private val main = Handler(Looper.getMainLooper())
  private val state = MutableStateFlow(PanelUi(state = TalkState.Listening))
  override val ui: StateFlow<PanelUi> = state

  private var heardSound = false
  private var quietMs = 0L
  private var forced = false
  private var paused = false

  fun force(s: TalkState) {
    forced = true
    main.removeCallbacksAndMessages(null)
    state.value = when (s) {
      TalkState.Idle -> PanelUi(state = s)
      TalkState.Listening -> PanelUi(state = s, level = 0.3f)
      TalkState.Thinking -> PanelUi(state = s, heard = "Demo: what is running?", working = 2)
      TalkState.Speaking -> PanelUi(
        state = s, heard = "Demo: what is running?",
        reply = "Two agents are working. One needs you.",
        cards = listOf(SAMPLE_CARD), working = 2, needsYou = 1,
      )
      TalkState.Offline -> PanelUi(state = s, notice = "The desk is offline.")
    }
  }

  override fun onMicFrame(pcm: ShortArray, level: Float) {
    main.post { frame(level) }
  }

  private fun frame(level: Float) {
    if (forced) return
    val now = state.value
    if (now.state != TalkState.Listening || paused) return
    state.update { it.copy(level = level) }
    if (level >= SOUND_LEVEL) {
      heardSound = true
      quietMs = 0
    } else if (heardSound) {
      quietMs += FRAME_MS
      if (quietMs >= QUIET_MS) heard("Demo: what is running?")
    }
  }

  private fun heard(text: String) {
    heardSound = false
    quietMs = 0
    state.update { it.copy(state = TalkState.Thinking, level = 0f, heard = text, reply = "") }
    main.postDelayed({
      state.update {
        it.copy(
          state = TalkState.Speaking,
          reply = "Two agents are working. One needs you.",
          cards = listOf(SAMPLE_CARD), working = 2, needsYou = 1,
        )
      }
      main.postDelayed({ state.update { it.copy(state = TalkState.Listening) } }, SPEAK_MS)
    }, THINK_MS)
  }

  override fun onMicTap() {
    if (forced) return
    paused = !paused
    state.update {
      if (paused) it.copy(state = TalkState.Idle, level = 0f)
      else it.copy(state = TalkState.Listening)
    }
  }

  override fun onTyped(text: String) {
    if (forced || text.isBlank()) return
    main.removeCallbacksAndMessages(null)
    heard(text.trim())
  }

  override fun onCardAction(cardId: String, action: String) {
    state.update { s ->
      val cards = s.cards.filterNot { it.id == cardId }
      s.copy(cards = cards, needsYou = cards.count { it.kind == "needs-you" })
    }
  }

  override fun onPanelShown() {}

  override fun onPanelHidden() {
    main.removeCallbacksAndMessages(null)
  }
}
