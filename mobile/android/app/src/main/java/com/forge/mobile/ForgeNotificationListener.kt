package com.forge.mobile

import android.app.Notification
import android.app.PendingIntent
import android.app.RemoteInput
import android.content.Intent
import android.os.Bundle
import android.service.notification.NotificationListenerService
import android.service.notification.StatusBarNotification

/**
 * Reads the notification shade and fires reply RemoteInputs.
 *
 * A NotificationListenerService is bound by the system when Steve grants
 * "Notification access" (a restricted setting, like accessibility). It stays
 * bound with the app closed, which is the whole point: a WhatsApp notification
 * can be answered without any Forge UI on screen.
 *
 * The numbering rule mirrors read: the list handed back by `list()` is valid
 * only until the next `list()` call, and `replyTo(n, ...)` resolves against
 * that last list.
 */
class ForgeNotificationListener : NotificationListenerService() {

  companion object {
    @Volatile
    var instance: ForgeNotificationListener? = null
      private set
  }

  /** The last listing, index -> notification key. Valid until the next list(). */
  private val lastKeys = ArrayList<String>()

  override fun onListenerConnected() {
    super.onListenerConnected()
    instance = this
    ForgeHands.notifyStatus(this)
  }

  override fun onListenerDisconnected() {
    instance = null
    ForgeHands.notifyStatus(this)
    // Ask to be rebound; the system drops listeners on updates and low memory.
    requestRebind(android.content.ComponentName(this, ForgeNotificationListener::class.java))
    super.onListenerDisconnected()
  }

  override fun onNotificationPosted(sbn: StatusBarNotification?) {
    ForgeHands.notifyStatus(this)
  }

  /**
   * One line per active notification: `[n] <app> - <title>: <text> (can reply)`.
   * Blocked apps (banks, authenticators, wallets) are never listed. An
   * optional appFilter keeps only notifications whose package or app label
   * contains the query, case-insensitive.
   */
  fun list(appFilter: String?): String {
    lastKeys.clear()
    val lines = ArrayList<String>()
    val active = try { activeNotifications } catch (_: Throwable) { return "" } ?: return ""
    val needle = appFilter?.trim()?.lowercase().orEmpty()
    for (sbn in active) {
      val pkg = sbn.packageName ?: continue
      if (ForgeHands.isBlocked(pkg)) continue
      val label = ForgeHands.appLabel(this, pkg)
      if (needle.isNotEmpty() && !label.lowercase().contains(needle) && !pkg.lowercase().contains(needle)) continue
      val extras = sbn.notification?.extras ?: Bundle()
      val title = extras.getCharSequence(Notification.EXTRA_TITLE)?.toString().orEmpty()
      val text = extras.getCharSequence(Notification.EXTRA_TEXT)?.toString().orEmpty()
      val canReply = replyAction(sbn) != null
      val n = lastKeys.size
      lastKeys.add(sbn.key)
      val reply = if (canReply) " (can reply)" else ""
      lines.add("[$n] $label - $title: $text$reply")
    }
    return lines.joinToString("\n")
  }

  /**
   * Fill notification n's reply box and fire its PendingIntent.
   * Returns null on success, or a plain-words error.
   */
  fun replyTo(n: Int, text: String): String? {
    val key = lastKeys.getOrNull(n) ?: return "There is no notification [$n]. List them again first."
    val sbn = try { activeNotifications?.firstOrNull { it.key == key } } catch (_: Throwable) { null }
      ?: return "That notification is gone. List them again first."
    if (ForgeHands.isBlocked(sbn.packageName ?: "")) return "That app is blocked for Forge."
    val action = replyAction(sbn) ?: return "That notification has no reply box."
    val remoteInput = action.remoteInputs?.firstOrNull() ?: return "That notification has no reply box."
    return try {
      val fillIn = Intent()
      val bundle = Bundle()
      bundle.putCharSequence(remoteInput.resultKey, text)
      RemoteInput.addResultsToIntent(action.remoteInputs, fillIn, bundle)
      action.actionIntent.send(this, 0, fillIn)
      null
    } catch (_: PendingIntent.CanceledException) {
      "The reply could not be sent — the notification was dismissed."
    } catch (e: Throwable) {
      "The reply failed: ${e.message ?: "unknown error"}"
    }
  }

  private fun replyAction(sbn: StatusBarNotification): Notification.Action? {
    val actions = sbn.notification?.actions ?: return null
    return actions.firstOrNull { it.remoteInputs?.any { ri -> ri.resultKey != null } == true }
  }
}
