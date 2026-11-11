package com.forge.bubble.setup

import android.Manifest
import android.annotation.SuppressLint
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Bundle
import android.os.PowerManager
import android.provider.Settings
import android.util.Log
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.runtime.mutableStateOf
import androidx.lifecycle.lifecycleScope
import com.forge.bubble.TAG
import com.forge.bubble.bubble.BubbleService
import com.forge.bubble.store.Prefs
import com.forge.bubble.ui.ForgeTheme
import com.google.androidbrowserhelper.trusted.LauncherActivity
import kotlinx.coroutines.launch

/** What the device grants, re-read every time the screen comes back. */
data class SetupChecks(
  val overlay: Boolean = false,
  val mic: Boolean = false,
  val notifications: Boolean = false,
  val battery: Boolean = false,
  val bubbleOn: Boolean = false,
)

/**
 * The setup screen: sign in, PIN, the three permissions, battery, and the
 * "Bubble on" switch. Each settings page it opens returns here, and onResume
 * re-reads the checks, so the Done/Needed marks are always current.
 */
class SetupActivity : ComponentActivity() {

  private val checks = mutableStateOf(SetupChecks())
  private val askPermission = registerForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
    Log.i(TAG, "setup: permission result granted=$granted")
    refresh()
  }

  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
    val account = Accounts.get(this)
    setContent {
      ForgeTheme {
        SetupScreen(
          account = account,
          checks = checks.value,
          onSignIn = { email, password, done ->
            lifecycleScope.launch { done(account.signIn(email, password)) }
          },
          onPin = { pin, remember -> account.submitPin(pin, remember) },
          onOverlay = { open(Intent(Settings.ACTION_MANAGE_OVERLAY_PERMISSION, packageUri())) },
          onAppInfo = { open(Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, packageUri())) },
          onMic = { ask(Manifest.permission.RECORD_AUDIO) },
          onNotifications = { ask(Manifest.permission.POST_NOTIFICATIONS) },
          onBattery = { requestBattery() },
          onBubble = { on -> setBubble(on) },
          onFinish = { finishSetup() },
        )
      }
    }
  }

  override fun onResume() {
    super.onResume()
    refresh()
  }

  private fun refresh() {
    checks.value = SetupChecks(
      overlay = Settings.canDrawOverlays(this),
      mic = granted(Manifest.permission.RECORD_AUDIO),
      notifications = granted(Manifest.permission.POST_NOTIFICATIONS),
      battery = getSystemService(PowerManager::class.java).isIgnoringBatteryOptimizations(packageName),
      bubbleOn = Prefs.bubbleOn(this),
    )
    BubbleService.refresh(this)
  }

  private fun granted(p: String) = checkSelfPermission(p) == PackageManager.PERMISSION_GRANTED

  private fun packageUri() = Uri.parse("package:$packageName")

  /** A permission denied twice is no longer asked by the system: send them to App info. */
  private fun ask(permission: String) {
    if (granted(permission)) return
    val asked = getSharedPreferences("forge_bubble_asked", MODE_PRIVATE)
    if (asked.getBoolean(permission, false) && !shouldShowRequestPermissionRationale(permission)) {
      open(Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, packageUri()))
      return
    }
    asked.edit().putBoolean(permission, true).apply()
    askPermission.launch(permission)
  }

  @SuppressLint("BatteryLife") // a sideloaded always-on helper; the user is asked
  private fun requestBattery() {
    open(Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS, packageUri()))
  }

  private fun open(intent: Intent) {
    try {
      startActivity(intent)
    } catch (t: Throwable) {
      Log.w(TAG, "setup: cannot open ${intent.action}: $t")
    }
  }

  private fun setBubble(on: Boolean) {
    Prefs.setBubbleOn(this, on)
    if (on) BubbleService.start(this) else BubbleService.stop(this)
    refresh()
  }

  private fun finishSetup() {
    Prefs.setSetupDone(this, true)
    startActivity(Intent(this, LauncherActivity::class.java))
    finish()
  }
}
