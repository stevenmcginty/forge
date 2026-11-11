package com.forge.bubble.bubble

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.util.Log
import com.forge.bubble.TAG
import com.forge.bubble.store.Prefs

/**
 * Brings the bubble back after a reboot or an app update, with the app never
 * opened. BOOT_COMPLETED and MY_PACKAGE_REPLACED are exempt from the ban on
 * starting a foreground service from the background, and specialUse is not on
 * Android 15's list of types a BOOT_COMPLETED receiver may not start. An off
 * switch stays off.
 */
class BootReceiver : BroadcastReceiver() {
  override fun onReceive(context: Context, intent: Intent?) {
    val action = intent?.action ?: return
    if (action != Intent.ACTION_BOOT_COMPLETED && action != Intent.ACTION_MY_PACKAGE_REPLACED) return
    if (!Prefs.bubbleOn(context)) return
    Log.i(TAG, "boot: $action -> starting the bubble")
    try { BubbleService.start(context) } catch (t: Throwable) { Log.w(TAG, "boot: cannot start the bubble: $t") }
  }
}
