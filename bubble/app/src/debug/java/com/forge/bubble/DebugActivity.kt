package com.forge.bubble

import android.app.Activity
import android.os.Bundle
import android.util.Log
import com.forge.bubble.bubble.BubbleService
import com.forge.bubble.store.Prefs

/**
 * Debug builds only (src/debug): skip setup from adb for emulator smokes.
 *
 *   adb shell am start -n com.forge.bubble/.DebugActivity --ez skipSetup true --ez bubbleOn true
 *
 * skipSetup marks every setup step done; bubbleOn sets the switch and starts
 * the bubble service (an activity in the foreground may start it).
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
    if (intent.hasExtra("bubbleOn")) {
      val on = intent.getBooleanExtra("bubbleOn", false)
      Prefs.setBubbleOn(this, on)
      if (on) BubbleService.start(this) else BubbleService.stop(this)
      Log.i(TAG, "debug: bubbleOn=$on")
    }
    finish()
  }
}
