package com.forge.mobile

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.PowerManager
import android.provider.Settings
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import com.getcapacitor.annotation.Permission
import com.getcapacitor.annotation.PermissionCallback

/**
 * The UI's hand onto the native phone-hands layer. The WebView settings card
 * (mobile/src) calls these to read status, flip the master switch, and open
 * the various Android settings screens a human has to visit once.
 *
 * It owns nothing of the socket or the ops — it only reads ForgeHands state and
 * launches the right Settings intents. The switch is stored natively here so
 * the service reads the same value with the WebView closed.
 */
@CapacitorPlugin(
  name = "ForgeHands",
  permissions = [
    Permission(alias = "contacts", strings = [Manifest.permission.READ_CONTACTS]),
    Permission(alias = "notifications", strings = [Manifest.permission.POST_NOTIFICATIONS])
  ]
)
class ForgeHandsPlugin : Plugin() {

  /** The whole picture the card draws: permissions, switch, link, screen. */
  @PluginMethod
  fun getStatus(call: PluginCall) {
    val ctx = context
    val s = ForgeHands.status(ctx)
    val out = JSObject()
      .put("accessibility", s.accessibility)
      .put("notifications", s.notifications)
      .put("contacts", s.contacts)
      .put("enabled", s.enabled)
      .put("screenOn", s.screenOn)
      .put("locked", s.locked)
      .put("app", s.app)
      .put("version", s.version)
      .put("postNotifications", hasPostNotifications())
      .put("batteryUnrestricted", isBatteryUnrestricted())
      .put("linked", ForgeHands.linked)
      .put("desktopName", ForgeHands.desktopName(ctx))
      .put("paired", ForgeHands.deviceToken(ctx).isNotEmpty())
    call.resolve(out)
  }

  @PluginMethod
  fun setEnabled(call: PluginCall) {
    ForgeHands.setEnabled(context, call.getBoolean("on", false) == true)
    getStatus(call)
  }

  /** The WebView's own device id/name, so the hands socket names the device
   *  the same way the app's socket does. */
  @PluginMethod
  fun syncIdentity(call: PluginCall) {
    ForgeHands.setIdentity(context, call.getString("id"), call.getString("name"))
    call.resolve()
  }

  @PluginMethod
  fun openAccessibilitySettings(call: PluginCall) = open(call, Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS))

  @PluginMethod
  fun openNotificationAccess(call: PluginCall) = open(call, Intent(Settings.ACTION_NOTIFICATION_LISTENER_SETTINGS))

  @PluginMethod
  fun openAppInfo(call: PluginCall) = open(
    call,
    Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:" + context.packageName))
  )

  @PluginMethod
  fun requestIgnoreBattery(call: PluginCall) {
    if (isBatteryUnrestricted()) { getStatus(call); return }
    @Suppress("BatteryLife")
    val intent = Intent(
      Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS,
      Uri.parse("package:" + context.packageName)
    )
    open(call, intent)
  }

  @PluginMethod
  fun requestContacts(call: PluginCall) {
    if (ForgeHands.hasContacts(context)) { getStatus(call); return }
    requestPermissionForAlias("contacts", call, "afterPermission")
  }

  @PluginMethod
  fun requestNotifications(call: PluginCall) {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU || hasPostNotifications()) { getStatus(call); return }
    requestPermissionForAlias("notifications", call, "afterPermission")
  }

  @PermissionCallback
  fun afterPermission(call: PluginCall) {
    getStatus(call)
  }

  /* ----------------------------------------------------------- helpers */

  private fun open(call: PluginCall, intent: Intent) {
    try {
      intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
      activity?.startActivity(intent) ?: context.startActivity(intent)
      call.resolve()
    } catch (e: Exception) {
      call.reject("Could not open that settings screen: ${e.message}")
    }
  }

  private fun hasPostNotifications(): Boolean {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) return true
    return context.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED
  }

  private fun isBatteryUnrestricted(): Boolean {
    val pm = context.getSystemService(PowerManager::class.java)
    return pm?.isIgnoringBatteryOptimizations(context.packageName) ?: false
  }
}
