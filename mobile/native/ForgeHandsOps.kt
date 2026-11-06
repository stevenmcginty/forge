package com.forge.mobile

import android.accessibilityservice.AccessibilityService
import android.app.KeyguardManager
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Bitmap
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.PowerManager
import android.provider.ContactsContract
import android.provider.Settings
import android.util.Base64
import android.view.accessibility.AccessibilityNodeInfo
import org.json.JSONObject
import java.io.ByteArrayOutputStream

/**
 * Shared state and policy for the phone hands: the master switch, the block
 * list, and the status snapshot the socket pushes. Kept in one object so the
 * accessibility service, the notification listener, the socket service and the
 * Capacitor plugin all read the same truth without a web of cross-references.
 */
object ForgeHands {

  private const val PREFS = "forge_hands"
  private const val KEY_ENABLED = "enabled"
  private const val KEY_DEVICE_ID = "handsDeviceId"
  private const val KEY_DEVICE_NAME = "handsDeviceName"

  /** Capacitor Preferences lands here; the WebView app saved the pairing. */
  const val CAPACITOR_PREFS = "CapacitorStorage"

  /** Packages Forge must never touch, even with everything else granted. */
  private val BLOCKED_EXACT = setOf(
    "co.uk.getmondo",
    "com.starlingbank.android",
    "com.revolut.revolut",
    "uk.co.hsbc.hsbcukmobilebanking",
    "com.barclays.android.barclaysmobilebanking",
    "com.grppl.android.shell.CMBlloydsTSB73",
    "com.rbs.mobile.android.natwest",
    "uk.co.santander.santanderUK",
    "com.nationwide.mobile.android.nationwide",
    "uk.co.tsb.newmobilebank",
    "com.paypal.android.p2pmobile",
    "com.google.android.apps.walletnfcrel",
    "com.x8bit.bitwarden",
    "com.lastpass.lpandroid",
    "com.onepassword.android",
    "com.coinbase.android",
    "com.google.android.gms",
    "com.android.vending"
  )

  fun isBlocked(pkg: String): Boolean {
    val p = pkg.lowercase()
    if (p.contains("bank") || p.contains("authenticator")) return true
    return BLOCKED_EXACT.contains(pkg)
  }

  /* --------------------------------------------------- the master switch */

  private fun prefs(ctx: Context) = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

  fun isEnabled(ctx: Context): Boolean = prefs(ctx).getBoolean(KEY_ENABLED, false)

  fun setEnabled(ctx: Context, on: Boolean) {
    prefs(ctx).edit().putBoolean(KEY_ENABLED, on).apply()
    if (on) {
      try { ForgeHandsService.start(ctx) } catch (_: Throwable) {}
    } else {
      ForgeHandsService.stop(ctx)
    }
    notifyStatus(ctx)
  }

  /**
   * A stable id/name for the hands socket, set by the plugin from the WebView's
   * own identity when the UI is open and falling back to a minted id so the
   * boot-started socket still has one. Auth is on the token alone
   * (electron/mobile/auth.ts), so this only names the device.
   */
  fun handsDeviceId(ctx: Context): String {
    val p = prefs(ctx)
    p.getString(KEY_DEVICE_ID, null)?.let { return it }
    val minted = "hands-" + java.util.UUID.randomUUID().toString()
    p.edit().putString(KEY_DEVICE_ID, minted).apply()
    return minted
  }

  fun deviceName(ctx: Context): String =
    prefs(ctx).getString(KEY_DEVICE_NAME, null) ?: "${Build.MODEL} (hands)"

  fun setIdentity(ctx: Context, id: String?, name: String?) {
    val e = prefs(ctx).edit()
    if (!id.isNullOrEmpty()) e.putString(KEY_DEVICE_ID, id)
    if (!name.isNullOrEmpty()) e.putString(KEY_DEVICE_NAME, name)
    e.apply()
  }

  /* --------------------------------------------- the paired desk address */

  fun origin(ctx: Context): String =
    ctx.getSharedPreferences(CAPACITOR_PREFS, Context.MODE_PRIVATE).getString("forge.origin", "").orEmpty()

  fun deviceToken(ctx: Context): String =
    ctx.getSharedPreferences(CAPACITOR_PREFS, Context.MODE_PRIVATE).getString("forge.deviceToken", "").orEmpty()

  fun desktopName(ctx: Context): String =
    ctx.getSharedPreferences(CAPACITOR_PREFS, Context.MODE_PRIVATE).getString("forge.desktopName", "").orEmpty()

  /* ------------------------------------------------------------ status */

  data class Status(
    val accessibility: Boolean,
    val notifications: Boolean,
    val contacts: Boolean,
    val enabled: Boolean,
    val screenOn: Boolean,
    val locked: Boolean,
    val app: String,
    val version: String
  )

  @Volatile
  var statusListener: ((Status) -> Unit)? = null

  /** True while the socket has a live, hello-acked link to the desk. Set by
   *  ForgeHandsService; read by the plugin for the UI's "Desk link" row. */
  @Volatile
  var linked: Boolean = false

  fun notifyStatus(ctx: Context) {
    statusListener?.invoke(status(ctx))
  }

  fun status(ctx: Context): Status = Status(
    accessibility = ForgeHandsAccessibilityService.isLive,
    notifications = hasNotificationAccess(ctx),
    contacts = hasContacts(ctx),
    enabled = isEnabled(ctx),
    screenOn = isScreenOn(ctx),
    locked = isLocked(ctx),
    app = ForgeHandsAccessibilityService.instance?.foregroundPackage ?: "",
    version = version(ctx)
  )

  fun hasContacts(ctx: Context): Boolean =
    ctx.checkSelfPermission(android.Manifest.permission.READ_CONTACTS) == PackageManager.PERMISSION_GRANTED

  fun hasNotificationAccess(ctx: Context): Boolean {
    val flat = Settings.Secure.getString(ctx.contentResolver, "enabled_notification_listeners") ?: return false
    return flat.split(":").any { it.contains(ctx.packageName) }
  }

  fun isScreenOn(ctx: Context): Boolean =
    (ctx.getSystemService(Context.POWER_SERVICE) as PowerManager).isInteractive

  fun isLocked(ctx: Context): Boolean =
    (ctx.getSystemService(Context.KEYGUARD_SERVICE) as KeyguardManager).isKeyguardLocked

  fun version(ctx: Context): String = try {
    ctx.packageManager.getPackageInfo(ctx.packageName, 0).versionName ?: ""
  } catch (_: Throwable) { "" }

  fun appLabel(ctx: Context, pkg: String): String = try {
    val pm = ctx.packageManager
    pm.getApplicationLabel(pm.getApplicationInfo(pkg, 0)).toString()
  } catch (_: Throwable) { pkg }
}

/**
 * Runs one hands:req op and hands back a Result. Every op the wire contract
 * lists is here; the socket service (ForgeHandsService) only turns the Result
 * into a frame. Callbacks, not return values, because screenshots and gestures
 * finish on another thread.
 *
 * Safety is enforced here, not trusted to the desk: the master switch, the
 * blocked-app list, and the locked-screen rule all gate ops before anything
 * happens, because the desk tool text repeating a rule is not the same as the
 * phone obeying it.
 */
object ForgeHandsOps {

  data class Result(
    val ok: Boolean,
    val text: String = "",
    val imageBase64: String? = null,
    val error: String? = null
  )

  private fun ok(text: String, image: String? = null) = Result(true, text, image)
  private fun err(message: String) = Result(false, error = message)

  private const val SWITCHED_OFF = "Phone hands are switched off on the phone."
  private const val LOCKED = "The phone is locked. Ask Steve to unlock it, then try again."
  private const val BLOCKED = "That app is blocked for Forge."
  private const val NO_A11Y = "Accessibility is not granted for Forge, so it cannot see the screen."

  /** Ops that read or drive the screen: wake it, refuse while locked. */
  private val SCREEN_OPS = setOf("look", "read", "tap", "type", "scroll", "key", "open_app")

  /** Ops whose work is refused while a blocked app is in front. */
  private val BLOCKED_GUARD_OPS = setOf("look", "read", "tap", "type", "scroll")

  fun execute(ctx: Context, op: String, args: JSONObject, done: (Result) -> Unit) {
    // status always answers, even switched off.
    if (op != "status" && !ForgeHands.isEnabled(ctx)) {
      done(err(SWITCHED_OFF)); return
    }

    try {
      if (op in SCREEN_OPS) {
        wakeScreen(ctx)
        if (ForgeHands.isLocked(ctx)) { done(err(LOCKED)); return }
      }
      if (op in BLOCKED_GUARD_OPS) {
        val front = ForgeHandsAccessibilityService.instance?.foregroundPackage ?: ""
        if (front.isNotEmpty() && ForgeHands.isBlocked(front)) { done(err(BLOCKED)); return }
      }

      when (op) {
        "status" -> done(ok(statusText(ctx)))
        "look" -> look(ctx, done)
        "read" -> done(ok(readText(ctx) ?: return done(err(NO_A11Y))))
        "tap" -> tap(ctx, args, done)
        "type" -> type(ctx, args, done)
        "scroll" -> scroll(ctx, args, done)
        "key" -> key(args, done)
        "open_app" -> done(openApp(ctx, args))
        "open_link" -> done(openLink(ctx, args))
        // An empty list must still be words: the desk turns "" into "The phone did that."
        "apps" -> done(ok(apps(ctx, args.optString("query", null)).ifEmpty { "No apps matched." }))
        "notifications" -> done(notifications(ctx, args))
        "reply" -> done(reply(ctx, args))
        "find_contact" -> done(findContact(ctx, args))
        else -> done(err("Unknown op \"$op\"."))
      }
    } catch (e: Throwable) {
      done(err("That failed: ${e.message ?: "unknown error"}"))
    }
  }

  /* ------------------------------------------------------------ status */

  private fun statusText(ctx: Context): String {
    val s = ForgeHands.status(ctx)
    val appLine = if (s.app.isEmpty()) "none" else "${ForgeHands.appLabel(ctx, s.app)} (${s.app})"
    return buildString {
      appendLine("Phone hands: ${if (s.enabled) "switched ON" else "switched OFF"}")
      appendLine("Accessibility: ${onOff(s.accessibility)}, Notifications: ${onOff(s.notifications)}, Contacts: ${onOff(s.contacts)}")
      appendLine("Screen: ${if (s.screenOn) "on" else "off"}, ${if (s.locked) "locked" else "unlocked"}")
      append("Foreground app: $appLine")
    }
  }

  private fun onOff(b: Boolean) = if (b) "on" else "off"

  /* -------------------------------------------------------------- look */

  private fun appHeader(ctx: Context): String {
    val pkg = ForgeHandsAccessibilityService.instance?.foregroundPackage ?: ""
    return if (pkg.isEmpty()) "App: (unknown)" else "App: ${ForgeHands.appLabel(ctx, pkg)} ($pkg)"
  }

  private fun look(ctx: Context, done: (Result) -> Unit) {
    val svc = ForgeHandsAccessibilityService.instance ?: return done(err(NO_A11Y))
    svc.shoot { bmp ->
      if (bmp == null) { done(err("The screenshot failed (a secure screen, or no screenshot permission).")); return@shoot }
      val b64 = encodeJpeg(bmp)
      done(ok(appHeader(ctx), b64))
    }
  }

  private fun readText(ctx: Context): String? {
    val svc = ForgeHandsAccessibilityService.instance ?: return null
    return appHeader(ctx) + "\n" + svc.readNodes()
  }

  /* --------------------------------------------------------------- tap */

  private fun tap(ctx: Context, args: JSONObject, done: (Result) -> Unit) {
    val svc = ForgeHandsAccessibilityService.instance ?: return done(err(NO_A11Y))
    val long = args.optBoolean("long", false)
    if (args.has("n")) {
      val node = svc.nodeAt(args.getInt("n")) ?: return done(err("There is no node [${args.getInt("n")}]. Read the screen again first."))
      val target = clickableAncestor(node)
      if (target != null && !long) {
        val acted = target.performAction(AccessibilityNodeInfo.ACTION_CLICK)
        return done(if (acted) ok("Tapped node [${args.getInt("n")}].") else err("That node did not take the tap."))
      }
      // long press, or nothing clickable: fall back to a gesture at its centre.
      val r = android.graphics.Rect(); node.getBoundsInScreen(r)
      svc.tapAt(r.exactCenterX(), r.exactCenterY(), long) { okg ->
        done(if (okg) ok("Tapped node [${args.getInt("n")}].") else err("The tap gesture failed."))
      }
      return
    }
    val m = svc.metrics()
    val x = (args.getDouble("x") * m.widthPixels).toFloat()
    val y = (args.getDouble("y") * m.heightPixels).toFloat()
    svc.tapAt(x, y, long) { okg -> done(if (okg) ok("Tapped at ${pct(args, "x")},${pct(args, "y")}.") else err("The tap gesture failed.")) }
  }

  private fun pct(args: JSONObject, k: String) = "${Math.round(args.getDouble(k) * 100)}%"

  private fun clickableAncestor(node: AccessibilityNodeInfo): AccessibilityNodeInfo? {
    var cur: AccessibilityNodeInfo? = node
    var hops = 0
    while (cur != null && hops < 8) {
      if (cur.isClickable) return cur
      cur = cur.parent
      hops++
    }
    return null
  }

  /* -------------------------------------------------------------- type */

  private fun type(ctx: Context, args: JSONObject, done: (Result) -> Unit) {
    val svc = ForgeHandsAccessibilityService.instance ?: return done(err(NO_A11Y))
    val text = args.optString("text", "")
    val node = if (args.has("n")) svc.nodeAt(args.getInt("n"))
      else svc.rootInActiveWindow?.findFocus(AccessibilityNodeInfo.FOCUS_INPUT)
    if (node == null || !node.isEditable) return done(err("No editable field — give an n from read, or tap a text box first."))
    val bundle = Bundle()
    bundle.putCharSequence(AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE, text)
    val set = node.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT, bundle)
    if (!set) return done(err("The field did not accept the text."))
    if (args.optBoolean("enter", false) && Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
      node.performAction(AccessibilityNodeInfo.AccessibilityAction.ACTION_IME_ENTER.id)
    }
    done(ok("Typed into the field."))
  }

  /* ------------------------------------------------------------ scroll */

  private fun scroll(ctx: Context, args: JSONObject, done: (Result) -> Unit) {
    val svc = ForgeHandsAccessibilityService.instance ?: return done(err(NO_A11Y))
    val direction = args.optString("direction", "down")
    val node = if (args.has("n")) svc.nodeAt(args.getInt("n")) else largestScrollable(svc.rootInActiveWindow)
    if (node != null && node.isScrollable) {
      val action = if (direction == "up" || direction == "left")
        AccessibilityNodeInfo.ACTION_SCROLL_BACKWARD else AccessibilityNodeInfo.ACTION_SCROLL_FORWARD
      val acted = node.performAction(action)
      if (acted) return done(ok("Scrolled $direction."))
    }
    // No scrollable node took it: swipe across the middle of the screen.
    val m = svc.metrics()
    val cx = m.widthPixels / 2f; val cy = m.heightPixels / 2f
    val dx = m.widthPixels * 0.3f; val dy = m.heightPixels * 0.3f
    val (x1, y1, x2, y2) = when (direction) {
      "up" -> arrayOf(cx, cy - dy, cx, cy + dy)
      "down" -> arrayOf(cx, cy + dy, cx, cy - dy)
      "left" -> arrayOf(cx - dx, cy, cx + dx, cy)
      else -> arrayOf(cx + dx, cy, cx - dx, cy)
    }
    svc.swipe(x1, y1, x2, y2) { okg -> done(if (okg) ok("Scrolled $direction.") else err("The scroll gesture failed.")) }
  }

  private operator fun <T> Array<T>.component4() = this[3]

  private fun largestScrollable(root: AccessibilityNodeInfo?): AccessibilityNodeInfo? {
    if (root == null) return null
    var best: AccessibilityNodeInfo? = null
    var bestArea = 0
    val stack = ArrayDeque<AccessibilityNodeInfo>()
    stack.add(root)
    while (stack.isNotEmpty()) {
      val n = stack.removeLast()
      if (n.isScrollable) {
        val r = android.graphics.Rect(); n.getBoundsInScreen(r)
        val area = r.width() * r.height()
        if (area > bestArea) { bestArea = area; best = n }
      }
      for (i in 0 until n.childCount) n.getChild(i)?.let { stack.add(it) }
    }
    return best
  }

  /* --------------------------------------------------------------- key */

  private fun key(args: JSONObject, done: (Result) -> Unit) {
    val svc = ForgeHandsAccessibilityService.instance ?: return done(err(NO_A11Y))
    val action = when (args.optString("key", "")) {
      "back" -> AccessibilityService.GLOBAL_ACTION_BACK
      "home" -> AccessibilityService.GLOBAL_ACTION_HOME
      "recents" -> AccessibilityService.GLOBAL_ACTION_RECENTS
      "notifications" -> AccessibilityService.GLOBAL_ACTION_NOTIFICATIONS
      "quick_settings" -> AccessibilityService.GLOBAL_ACTION_QUICK_SETTINGS
      else -> return done(err("Unknown key \"${args.optString("key", "")}\"."))
    }
    val acted = svc.performGlobalAction(action)
    done(if (acted) ok("Pressed ${args.optString("key")}.") else err("The key press failed."))
  }

  /* ----------------------------------------------------------- launching */

  private fun openApp(ctx: Context, args: JSONObject): Result {
    val pkg = args.optString("package", "").ifEmpty { matchApp(ctx, args.optString("name", "")) }
      ?: return err("No app matched \"${args.optString("name")}\".")
    if (ForgeHands.isBlocked(pkg)) return err(BLOCKED)
    val intent = ctx.packageManager.getLaunchIntentForPackage(pkg)
      ?: return err("\"$pkg\" cannot be launched.")
    intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
    ctx.startActivity(intent)
    return ok("Opened ${ForgeHands.appLabel(ctx, pkg)} ($pkg).")
  }

  private fun matchApp(ctx: Context, name: String): String? {
    if (name.isBlank()) return null
    val needle = name.trim().lowercase()
    val launchers = launcherActivities(ctx)
    // Exact label first, then starts-with, then contains.
    return launchers.firstOrNull { it.second.lowercase() == needle }?.first
      ?: launchers.firstOrNull { it.second.lowercase().startsWith(needle) }?.first
      ?: launchers.firstOrNull { it.second.lowercase().contains(needle) }?.first
  }

  private fun openLink(ctx: Context, args: JSONObject): Result {
    val url = args.optString("url", "")
    if (url.isBlank()) return err("open_link needs a url.")
    val intent = Intent(Intent.ACTION_VIEW, Uri.parse(url)).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
    return try {
      ctx.startActivity(intent)
      ok("Opened $url.")
    } catch (_: Throwable) {
      err("Nothing on the phone can open \"$url\".")
    }
  }

  private fun launcherActivities(ctx: Context): List<Pair<String, String>> {
    val main = Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_LAUNCHER)
    val pm = ctx.packageManager
    val seen = HashMap<String, String>()
    for (ri in pm.queryIntentActivities(main, 0)) {
      val pkg = ri.activityInfo?.packageName ?: continue
      if (seen.containsKey(pkg)) continue
      seen[pkg] = ri.loadLabel(pm).toString()
    }
    return seen.map { it.key to it.value }.sortedBy { it.second.lowercase() }
  }

  private fun apps(ctx: Context, query: String?): String {
    val needle = query?.trim()?.lowercase().orEmpty()
    return launcherActivities(ctx)
      .filter { needle.isEmpty() || it.second.lowercase().contains(needle) || it.first.lowercase().contains(needle) }
      .joinToString("\n") { "${it.second} (${it.first})" }
  }

  /* ---------------------------------------------------- notifications */

  private fun notifications(ctx: Context, args: JSONObject): Result {
    if (!ForgeHands.hasNotificationAccess(ctx)) return err("Notification access is not granted for Forge.")
    val listener = ForgeNotificationListener.instance ?: return err("The notification reader is not running yet.")
    return ok(listener.list(args.optString("app", null)).ifEmpty { "No notifications." })
  }

  private fun reply(ctx: Context, args: JSONObject): Result {
    if (!ForgeHands.hasNotificationAccess(ctx)) return err("Notification access is not granted for Forge.")
    val listener = ForgeNotificationListener.instance ?: return err("The notification reader is not running yet.")
    val problem = listener.replyTo(args.optInt("n", -1), args.optString("text", ""))
    return if (problem == null) ok("Reply sent.") else err(problem)
  }

  /* -------------------------------------------------------- contacts */

  private fun findContact(ctx: Context, args: JSONObject): Result {
    if (!ForgeHands.hasContacts(ctx)) return err("Contacts permission is not granted for Forge.")
    val name = args.optString("name", "")
    if (name.isBlank()) return err("find_contact needs a name.")
    val cr = ctx.contentResolver
    val projection = arrayOf(
      ContactsContract.CommonDataKinds.Phone.DISPLAY_NAME,
      ContactsContract.CommonDataKinds.Phone.NUMBER,
      ContactsContract.CommonDataKinds.Phone.NORMALIZED_NUMBER
    )
    val lines = ArrayList<String>()
    cr.query(
      ContactsContract.CommonDataKinds.Phone.CONTENT_URI,
      projection,
      "${ContactsContract.CommonDataKinds.Phone.DISPLAY_NAME} LIKE ?",
      arrayOf("%$name%"),
      ContactsContract.CommonDataKinds.Phone.DISPLAY_NAME + " ASC"
    )?.use { c ->
      while (c.moveToNext() && lines.size < 30) {
        val dn = c.getString(0) ?: ""
        val num = c.getString(1) ?: ""
        val norm = c.getString(2)
        lines.add("$dn - $num (wa.me: ${waDigits(num, norm)})")
      }
    }
    if (lines.isEmpty()) return err("No contact matched \"$name\".")
    return ok(lines.joinToString("\n"))
  }

  /** wa.me wants full international digits, no +, no leading 0. UK 07 -> 447. */
  private fun waDigits(number: String, normalized: String?): String {
    if (!normalized.isNullOrBlank()) return normalized.filter { it.isDigit() }
    var d = number.filter { it.isDigit() }
    if (d.startsWith("0")) d = "44" + d.drop(1)
    return d
  }

  /* --------------------------------------------------------- helpers */

  private fun wakeScreen(ctx: Context) {
    val pm = ctx.getSystemService(Context.POWER_SERVICE) as PowerManager
    if (pm.isInteractive) return
    // Deprecated but still the only way a service with no Activity can turn the
    // screen on. Guarded so a missing WAKE_LOCK or a vendor refusal is a no-op,
    // never a crash — the op that follows reports the locked/blank screen.
    try {
      @Suppress("DEPRECATION")
      val lock = pm.newWakeLock(
        PowerManager.SCREEN_BRIGHT_WAKE_LOCK or PowerManager.ACQUIRE_CAUSES_WAKEUP or PowerManager.ON_AFTER_RELEASE,
        "forge:hands-wake"
      )
      @Suppress("DEPRECATION")
      lock.acquire(3000)
    } catch (_: Throwable) {
      /* no WAKE_LOCK, or the platform refused: leave the screen as it is */
    }
  }

  private fun encodeJpeg(bitmap: Bitmap): String {
    val scaled = scaleLongSide(bitmap, 1400)
    var quality = 85
    while (true) {
      val out = ByteArrayOutputStream()
      scaled.compress(Bitmap.CompressFormat.JPEG, quality, out)
      val b64 = Base64.encodeToString(out.toByteArray(), Base64.NO_WRAP)
      if (b64.length < 700_000 || quality <= 30) return b64
      quality -= 15
    }
  }

  private fun scaleLongSide(bitmap: Bitmap, maxLong: Int): Bitmap {
    val long = maxOf(bitmap.width, bitmap.height)
    if (long <= maxLong) return bitmap
    val factor = maxLong.toFloat() / long
    return Bitmap.createScaledBitmap(bitmap, (bitmap.width * factor).toInt(), (bitmap.height * factor).toInt(), true)
  }
}
