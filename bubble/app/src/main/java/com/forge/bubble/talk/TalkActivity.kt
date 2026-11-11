package com.forge.bubble.talk

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Bundle
import android.util.Log
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.imePadding
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.forge.bubble.BuildConfig
import com.forge.bubble.TAG
import com.forge.bubble.audio.Mic
import com.forge.bubble.setup.SetupActivity
import com.forge.bubble.ui.ForgeTheme
import com.forge.bubble.ui.TalkPanel

/**
 * The pop-out panel the bubble opens: a see-through activity with the panel at
 * the bottom. A tap outside the panel, Back, or "Close" dismisses it.
 *
 * It is an Activity, not an overlay, because Android only lets a microphone
 * capture start from something visible: the mic runs from onStart to onStop.
 * Without the permission it sends the user to setup instead.
 *
 * Debug builds accept `--es demoState <Idle|Listening|Thinking|Speaking|Offline>`
 * to pin the demo driver in one state for screenshots.
 */
class TalkActivity : ComponentActivity() {

  companion object {
    const val EXTRA_DEMO_STATE = "demoState"
  }

  private lateinit var driver: TalkDriver
  private var mic: Mic? = null

  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
    driver = demoDriver(intent) ?: TalkDrivers.factory(applicationContext)
    driver.bindClose { runOnUiThread { if (!isFinishing) finish() } }
    setContent {
      ForgeTheme {
        val ui by driver.ui.collectAsStateWithLifecycle()
        val none = remember { MutableInteractionSource() }
        Box(
          Modifier.fillMaxSize().clickable(interactionSource = none, indication = null) { finish() },
        ) {
          TalkPanel(
            ui = ui,
            onMicTap = driver::onMicTap,
            onTyped = driver::onTyped,
            onCardAction = driver::onCardAction,
            onClose = { finish() },
            // Eat taps on the panel itself so only taps outside it dismiss.
            modifier = Modifier.align(Alignment.BottomCenter).imePadding()
              .clickable(interactionSource = remember { MutableInteractionSource() }, indication = null) {},
          )
        }
      }
    }
  }

  override fun onNewIntent(intent: Intent) {
    super.onNewIntent(intent)
    demoState(intent)?.let { s -> (driver as? DemoDriver)?.force(s) }
  }

  override fun onStart() {
    super.onStart()
    if (checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
      Log.i(TAG, "talk: no microphone permission; opening setup")
      startActivity(Intent(this, SetupActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
      finish()
      return
    }
    val m = Mic(applicationContext) { pcm, level -> driver.onMicFrame(pcm, level) }
    if (m.start()) mic = m
    driver.onPanelShown()
  }

  override fun onStop() {
    mic?.stop()
    mic = null
    driver.onPanelHidden()
    super.onStop()
    // A panel that left the screen is done; it must not linger as a hidden task.
    if (!isChangingConfigurations && !isFinishing) finish()
  }

  private fun demoState(i: Intent?): TalkState? {
    if (!BuildConfig.DEBUG) return null
    val name = i?.getStringExtra(EXTRA_DEMO_STATE) ?: return null
    return TalkState.entries.firstOrNull { it.name.equals(name, ignoreCase = true) }
  }

  private fun demoDriver(i: Intent?): TalkDriver? =
    demoState(i)?.let { s -> DemoDriver().also { it.force(s) } }
}
