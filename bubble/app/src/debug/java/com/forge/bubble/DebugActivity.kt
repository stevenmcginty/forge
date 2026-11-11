package com.forge.bubble

import android.app.Activity
import android.os.Bundle
import android.util.Log
import com.forge.bubble.bubble.BubbleService
import com.forge.bubble.engine.Engine
import com.forge.bubble.engine.SecretsStore
import com.forge.bubble.link.BubbleEngine
import com.forge.bubble.store.Prefs
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch
import kotlinx.coroutines.withTimeoutOrNull

/**
 * Debug builds only (src/debug): skip setup from adb for emulator smokes, and
 * point the engine at the dev server (scripts/bubble-dev-server.mjs).
 *
 *   adb shell am start -n com.forge.bubble/.DebugActivity --ez skipSetup true --ez bubbleOn true
 *   adb shell am start -n com.forge.bubble/.DebugActivity --es devWs ws://10.0.2.2:8493/web --es devToken <jwt> [--es devPin 1234]
 *   adb shell am start -n com.forge.bubble/.DebugActivity --es devSay "what is running"
 *
 * skipSetup marks every setup step done; bubbleOn sets the switch and starts
 * the bubble service (an activity in the foreground may start it). devWs +
 * devToken swap in a dev engine (no Firebase; its own store, the PIN is not
 * remembered) and connect it. devSay sends a typed turn once the lane is open.
 */
class DebugActivity : Activity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    if (intent.getBooleanExtra("skipSetup", false)) {
      Prefs.setSignedIn(this, true)
      Prefs.setPinSet(this, true)
      Prefs.setSetupDone(this, true)
      Log.i(TAG, "debug: setup skipped")
    }
    val ws = intent.getStringExtra("devWs")
    val token = intent.getStringExtra("devToken")
    if (ws != null && token != null) {
      val e = BubbleEngine.forDev(ws, token, SecretsStore(this, "dev."), Engine.player(this))
      Engine.install(e)
      intent.getStringExtra("devPin")?.let { e.submitPin(it, remember = false) }
      e.start()
      // Never the token or the PIN.
      Log.i(TAG, "debug: dev engine on $ws")
    }
    if (intent.hasExtra("bubbleOn")) {
      val on = intent.getBooleanExtra("bubbleOn", false)
      Prefs.setBubbleOn(this, on)
      if (on) BubbleService.start(this) else BubbleService.stop(this)
      Log.i(TAG, "debug: bubbleOn=$on")
    }
    intent.getStringExtra("devSay")?.let { text ->
      val app = applicationContext
      Engine.scope.launch {
        val open = withTimeoutOrNull(20_000L) { Engine.state.first { it.laneOpen } }
        if (open == null) Log.w(TAG, "debug: devSay - lane not open after 20 s; sending anyway")
        Engine.get(app).sayText(text)
        Log.i(TAG, "debug: devSay sent")
      }
    }
    finish()
  }
}
