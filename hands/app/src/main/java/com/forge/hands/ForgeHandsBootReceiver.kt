package com.forge.hands

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

/**
 * Brings the socket back after a reboot, with the app never opened.
 *
 * ACTION_BOOT_COMPLETED is an explicit exemption from the Android 12+ ban on
 * starting a foreground service from the background, and specialUse is not on
 * Android 15's list of service types a BOOT_COMPLETED receiver may not start —
 * so this is the dependable door in. It only starts the service if the master
 * switch is on; an off switch stays off across reboots.
 *
 * (The accessibility service itself must be re-enabled by hand after a reboot
 * on most devices — that is Android's rule, not ours — so the socket may run
 * before the eyes are back. status reports accessibility:false until then.)
 */
class ForgeHandsBootReceiver : BroadcastReceiver() {
  override fun onReceive(context: Context, intent: Intent?) {
    val action = intent?.action ?: return
    if (action != Intent.ACTION_BOOT_COMPLETED && action != Intent.ACTION_LOCKED_BOOT_COMPLETED) return
    if (!ForgeHands.isEnabled(context)) return
    try { ForgeHandsService.start(context) } catch (_: Throwable) {}
  }
}
