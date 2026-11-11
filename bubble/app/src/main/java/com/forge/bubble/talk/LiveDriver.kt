package com.forge.bubble.talk

import android.content.Context
import android.content.Intent
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.util.Log
import com.forge.bubble.TAG
import com.forge.bubble.engine.Engine
import com.forge.bubble.link.Card
import com.forge.bubble.link.CardAction
import com.forge.bubble.link.CardKind
import com.forge.bubble.link.EngineState
import com.forge.bubble.link.LinkState
import com.google.androidbrowserhelper.trusted.LauncherActivity
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import com.forge.bubble.link.TalkState as LinkTalk

/**
 * The talk panel on the real engine ([Engine]):
 *
 *  - panel shown: the mic listens; panel hidden: it stops (speech plays on).
 *  - never listening while Forge speaks; when the reply ends it listens again.
 *  - a mic tap while speaking interrupts, then listens; otherwise it toggles the mic.
 *  - typed text is a turn; card buttons go to the engine; "Open" (on a card, or
 *    the Open Forge button) opens Forge Web.
 *  - 20 s with no speech, no reply and no open card closes the panel.
 *
 * Every decision runs on the main thread; mic frames arrive on the mic's thread.
 */
class LiveDriver(ctx: Context) : TalkDriver {

  companion object {
    private const val QUIET_CLOSE_MS = 20_000L
    private const val TICK_MS = 1_000L
    const val OPEN = "Open"

    /** The mic level while listening, for the bubble's Listening rings. */
    val level = MutableStateFlow(0f)
  }

  private val app = ctx.applicationContext
  private val main = Handler(Looper.getMainLooper())
  private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
  private val state = MutableStateFlow(PanelUi(state = TalkState.Idle))
  override val ui: StateFlow<PanelUi> = state

  private var collector: Job? = null
  private var shown = false
  /** The user turned the mic off with a tap. */
  private var micOff = false
  /** What the engine was last told. */
  @Volatile private var listening = false
  private var last: EngineState? = null
  private var lastActive = 0L
  private var close: () -> Unit = {}

  private val engine get() = Engine.get(app)

  private val tick = object : Runnable {
    override fun run() {
      if (!shown) return
      val s = last
      val busy = s != null && (s.hearing || s.talk == LinkTalk.THINKING || s.talk == LinkTalk.SPEAKING || s.cards.isNotEmpty())
      val now = SystemClock.elapsedRealtime()
      if (busy) lastActive = now
      if (now - lastActive >= QUIET_CLOSE_MS) {
        Log.i(TAG, "talk: 20 s quiet; closing the panel")
        close()
        return
      }
      main.postDelayed(this, TICK_MS)
    }
  }

  override fun bindClose(close: () -> Unit) {
    this.close = close
  }

  override fun onPanelShown() {
    shown = true
    micOff = false
    lastActive = SystemClock.elapsedRealtime()
    engine.start() // already running: a no-op kick
    collector?.cancel()
    collector = scope.launch { Engine.state.collect { onEngine(it) } }
    main.removeCallbacks(tick)
    main.postDelayed(tick, TICK_MS)
    Log.i(TAG, "talk: panel shown")
  }

  override fun onPanelHidden() {
    shown = false
    collector?.cancel()
    collector = null
    main.removeCallbacks(tick)
    setListening(false)
    level.value = 0f
    Log.i(TAG, "talk: panel hidden")
  }

  private fun onEngine(s: EngineState) {
    val prev = last
    last = s
    if (prev == null || s.hearing || s.heard != prev.heard || s.reply != prev.reply) {
      lastActive = SystemClock.elapsedRealtime()
    }
    applyListening(s)
    state.value = panelOf(s)
  }

  private fun applyListening(s: EngineState) {
    setListening(shown && !micOff && s.talk != LinkTalk.SPEAKING)
  }

  private fun setListening(on: Boolean) {
    if (on == listening) return
    listening = on
    engine.setListening(on)
    if (!on) level.value = 0f
    Log.i(TAG, "talk: listening ${if (on) "on" else "off"}")
  }

  override fun onMicFrame(pcm: ShortArray, level: Float) {
    if (!listening) return
    engine.micFrame(pcm, level)
    LiveDriver.level.value = level
    state.update { it.copy(level = level) }
  }

  override fun onMicTap() {
    lastActive = SystemClock.elapsedRealtime()
    val s = last
    if (s?.talk == LinkTalk.SPEAKING) {
      Log.i(TAG, "talk: tap while speaking; interrupting")
      engine.interrupt()
      micOff = false
    } else {
      micOff = !micOff
    }
    s?.let { applyListening(it) }
  }

  override fun onTyped(text: String) {
    val words = text.trim()
    if (words.isEmpty()) return
    lastActive = SystemClock.elapsedRealtime()
    engine.sayText(words)
  }

  override fun onCardAction(cardId: String, action: String) {
    lastActive = SystemClock.elapsedRealtime()
    if (action == OPEN) {
      onOpenForge()
      return
    }
    val a = CardAction.entries.firstOrNull { it.name.equals(action, ignoreCase = true) } ?: return
    Log.i(TAG, "talk: card $cardId -> $a")
    engine.cardAction(cardId, a)
  }

  override fun onOpenForge() {
    Log.i(TAG, "talk: opening Forge Web")
    try {
      app.startActivity(Intent(app, LauncherActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
    } catch (t: Throwable) {
      Log.w(TAG, "talk: cannot open Forge Web: $t")
    }
    close()
  }

  /* ------------------------------------------------------------- mapping */

  private fun panelOf(s: EngineState): PanelUi {
    val online = s.link == LinkState.ONLINE
    val talk = when {
      !online -> TalkState.Offline
      s.talk == LinkTalk.SPEAKING -> TalkState.Speaking
      s.talk == LinkTalk.THINKING -> TalkState.Thinking
      s.talk == LinkTalk.LISTENING -> TalkState.Listening
      else -> TalkState.Idle
    }
    return PanelUi(
      state = talk,
      level = if (talk == TalkState.Listening) level.value else 0f,
      heard = s.heard,
      reply = s.reply,
      cards = s.cards.map(::cardOf),
      working = s.working,
      needsYou = s.needsYou,
      notice = when {
        !online -> Engine.linkWords(s)
        s.notice.isNotBlank() -> s.notice
        else -> null
      },
    )
  }

  private fun cardOf(c: Card): CardUi {
    val buttons = c.actions.map { a -> a.name.lowercase().replaceFirstChar { it.uppercase() } }
    return CardUi(
      id = c.id,
      kind = when (c.kind) {
        CardKind.CONFIRM -> "confirm"
        CardKind.NEEDS_YOU -> "needs-you"
        CardKind.JOB -> "job"
      },
      title = c.title,
      line = c.line,
      // A pane or job lives on the desktop: Open shows it in Forge Web.
      actions = if (c.kind == CardKind.CONFIRM) buttons else listOf(OPEN) + buttons,
      state = c.state,
    )
  }
}
