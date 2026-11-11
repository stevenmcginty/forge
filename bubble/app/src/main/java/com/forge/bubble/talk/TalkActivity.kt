package com.forge.bubble.talk

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import android.util.Log
import androidx.activity.ComponentActivity
import androidx.activity.compose.BackHandler
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.forge.bubble.BuildConfig
import com.forge.bubble.TAG
import com.forge.bubble.audio.Mic
import com.forge.bubble.setup.SetupActivity
import com.forge.bubble.ui.ForgeTheme
import com.forge.bubble.ui.MorphPanel
import com.forge.bubble.ui.TalkPanel
import kotlinx.coroutines.flow.MutableStateFlow

/**
 * The pop-out panel the bubble opens: a see-through activity with the panel at
 * the bottom. A tap outside the panel, Back, or "Close" dismisses it.
 *
 * Look: the panel grows out of the bubble's own spot ([EXTRA_FROM_X] /
 * [EXTRA_FROM_Y], the bubble's centre in screen px) and folds back into it on
 * the way out ([MorphPanel]); [open] tells the bubble to step aside meanwhile.
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
    const val EXTRA_FROM_X = "fromX"
    const val EXTRA_FROM_Y = "fromY"

    /** True while the panel is on screen: the bubble hides, as it has become the panel. */
    val open = MutableStateFlow(false)
  }

  /** False once a close has begun: the panel folds back into the bubble, then the activity finishes. */
  private var showing by mutableStateOf(true)

  private fun dismiss() {
    showing = false
  }

  private lateinit var driver: TalkDriver
  private var mic: Mic? = null

  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
    // The panel draws its own way in and out (the morph); no system slide or zoom on top.
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
      overrideActivityTransition(OVERRIDE_TRANSITION_OPEN, 0, 0)
      overrideActivityTransition(OVERRIDE_TRANSITION_CLOSE, 0, 0)
    } else {
      @Suppress("DEPRECATION") overridePendingTransition(0, 0)
    }
    driver = demoDriver(intent) ?: TalkDrivers.factory(applicationContext)
    driver.bindClose { runOnUiThread { if (!isFinishing) dismiss() } }
    val from = if (intent.hasExtra(EXTRA_FROM_X)) {
      Offset(intent.getFloatExtra(EXTRA_FROM_X, 0f), intent.getFloatExtra(EXTRA_FROM_Y, 0f))
    } else null
    setContent {
      ForgeTheme {
        val ui by driver.ui.collectAsStateWithLifecycle()
        val none = remember { MutableInteractionSource() }
        BackHandler(enabled = showing) { dismiss() }
        // The panel never passes about half the screen; its middle scrolls instead.
        val half = (LocalConfiguration.current.screenHeightDp * 0.5f).dp
        MorphPanel(
          from = from,
          open = showing,
          onClosed = {
            open.value = false
            if (!isFinishing) {
              finish()
              if (Build.VERSION.SDK_INT < Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
                @Suppress("DEPRECATION") overridePendingTransition(0, 0)
              }
            }
          },
          modifier = Modifier.fillMaxSize().clickable(interactionSource = none, indication = null) { dismiss() },
          // Eat taps on the panel itself so only taps outside it dismiss.
          panelModifier = Modifier.navigationBarsPadding().imePadding().padding(horizontal = 10.dp, vertical = 8.dp)
            .heightIn(max = half)
            .clickable(interactionSource = remember { MutableInteractionSource() }, indication = null) {},
        ) {
          TalkPanel(
            ui = ui,
            onMicTap = driver::onMicTap,
            onTyped = driver::onTyped,
            onCardAction = driver::onCardAction,
            onClose = { dismiss() },
            onOpenForge = driver::onOpenForge,
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
    open.value = true
  }

  override fun onStop() {
    open.value = false
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
