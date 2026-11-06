package com.forge.mobile

import android.accessibilityservice.AccessibilityService
import android.accessibilityservice.GestureDescription
import android.graphics.Bitmap
import android.graphics.Path
import android.graphics.Rect
import android.os.Build
import android.util.DisplayMetrics
import android.view.Display
import android.view.accessibility.AccessibilityEvent
import android.view.accessibility.AccessibilityNodeInfo
import android.view.inputmethod.InputMethodManager
import java.util.concurrent.Executors

/**
 * The hands' eyes and fingers.
 *
 * This is the one component that outlives the app: once Steve turns it on in
 * Android's accessibility settings it stays bound and running with the WebView
 * closed, through Doze, and (after it is re-enabled) across a reboot. So it is
 * also where the socket service is kicked from — onServiceConnected starts
 * ForgeHandsService, which is the only reliable "the app is alive again" signal
 * we get when nothing else of ours is running.
 *
 * Starting a foreground service from here is wrapped in a try: on Android 12+
 * a background start can throw ForegroundServiceStartNotAllowedException, and
 * if it does the boot receiver and the UI switch are the other two doors in.
 * specialUse is not on Android 15's BOOT_COMPLETED-restricted list, so the
 * boot door is the dependable one; this one is the fast path for "Steve just
 * flipped accessibility on".
 *
 * All capabilities (window content, gestures, screenshot) come from the
 * meta-data XML (res/xml/forge_hands_accessibility.xml); they cannot be set at
 * runtime.
 */
class ForgeHandsAccessibilityService : AccessibilityService() {

  companion object {
    @Volatile
    var instance: ForgeHandsAccessibilityService? = null
      private set

    /** True when Steve has granted accessibility AND the service is bound. */
    val isLive: Boolean get() = instance != null
  }

  private val screenshotExecutor = Executors.newSingleThreadExecutor()

  /** The last read's nodes, index -> node. Valid until the next read. */
  private val lastNodes = ArrayList<AccessibilityNodeInfo>()

  /** The foreground package, learned from window-state events. */
  @Volatile
  var foregroundPackage: String = ""
    private set

  override fun onServiceConnected() {
    super.onServiceConnected()
    instance = this
    try {
      ForgeHandsService.start(this)
    } catch (_: Throwable) {
      // Boot receiver / UI switch will start it instead; see the class comment.
    }
    // No window event comes until the screen changes: start from what is in front now.
    rootInActiveWindow?.packageName?.toString()?.takeUnless { it.isEmpty() || isOverlay(it) }
      ?.let { foregroundPackage = it }
    ForgeHands.notifyStatus(this)
  }

  override fun onAccessibilityEvent(event: AccessibilityEvent?) {
    if (event?.eventType == AccessibilityEvent.TYPE_WINDOW_STATE_CHANGED) {
      val pkg = event.packageName?.toString().orEmpty()
      // Ignore the keyboard and the system UI (shade, heads-up) as "the app":
      // they sit over it, and counting them would let a blocked app be read
      // while its keyboard or a heads-up notification is showing.
      if (pkg.isNotEmpty() && pkg != foregroundPackage && !isOverlay(pkg)) {
        foregroundPackage = pkg
        ForgeHands.notifyStatus(this)
      }
    }
  }

  private fun isOverlay(pkg: String): Boolean {
    if (pkg == "com.android.systemui") return true
    val imm = getSystemService(InputMethodManager::class.java) ?: return false
    return try { imm.enabledInputMethodList.any { it.packageName == pkg } } catch (_: Throwable) { false }
  }

  override fun onInterrupt() {}

  override fun onUnbind(intent: android.content.Intent?): Boolean {
    instance = null
    ForgeHands.notifyStatus(this)
    return super.onUnbind(intent)
  }

  override fun onDestroy() {
    instance = null
    super.onDestroy()
  }

  /* ----------------------------------------------------------- reading */

  /**
   * One line of "App:" then one line per useful on-screen node, numbered.
   * Populates lastNodes so tap/type by n can resolve the same numbering.
   *
   * "Useful" keeps any visible, sized node that carries text or a
   * content-description, or that can be acted on (clickable, editable,
   * scrollable, checkable). The text test is what keeps Chrome and other
   * WebView content: web text nodes are usually neither important nor
   * clickable, so a filter that demanded either would read a web page as
   * blank.
   */
  fun readNodes(max: Int = 150): String {
    lastNodes.clear()
    val roots = collectRoots()
    val lines = ArrayList<String>()
    for (root in roots) {
      walk(root) { node ->
        if (lastNodes.size >= max) return@walk false
        if (!isUseful(node)) return@walk true
        val n = lastNodes.size
        lastNodes.add(node)
        lines.add(describe(n, node))
        true
      }
      if (lastNodes.size >= max) break
    }
    return lines.joinToString("\n")
  }

  fun nodeAt(index: Int): AccessibilityNodeInfo? = lastNodes.getOrNull(index)

  private fun collectRoots(): List<AccessibilityNodeInfo> {
    val roots = ArrayList<AccessibilityNodeInfo>()
    rootInActiveWindow?.let { roots.add(it) }
    // Other interactive windows (dialogs, the IME, split panes) carry text too.
    for (w in windows) {
      val r = w.root ?: continue
      if (roots.none { it == r }) roots.add(r)
    }
    return roots
  }

  private fun walk(node: AccessibilityNodeInfo, visit: (AccessibilityNodeInfo) -> Boolean) {
    if (!visit(node)) return
    for (i in 0 until node.childCount) {
      val child = node.getChild(i) ?: continue
      walk(child, visit)
    }
  }

  private fun isUseful(node: AccessibilityNodeInfo): Boolean {
    if (!node.isVisibleToUser) return false
    val bounds = Rect()
    node.getBoundsInScreen(bounds)
    if (bounds.width() <= 0 || bounds.height() <= 0) return false
    val text = node.text?.toString()?.trim().orEmpty()
    val desc = node.contentDescription?.toString()?.trim().orEmpty()
    return text.isNotEmpty() || desc.isNotEmpty() ||
      node.isClickable || node.isEditable || node.isScrollable || node.isCheckable
  }

  private fun describe(n: Int, node: AccessibilityNodeInfo): String {
    val role = shortRole(node)
    val label = (node.text?.toString()?.trim().takeUnless { it.isNullOrEmpty() }
      ?: node.contentDescription?.toString()?.trim().orEmpty())
    val flags = ArrayList<String>()
    if (node.isClickable) flags.add("clickable")
    if (node.isEditable) flags.add("editable")
    if (node.isScrollable) flags.add("scrollable")
    if (node.isCheckable && node.isChecked) flags.add("checked")
    if (node.isSelected) flags.add("selected")
    val tail = if (flags.isEmpty()) "" else " (${flags.joinToString(", ")})"
    return "[$n] $role \"$label\"$tail"
  }

  private fun shortRole(node: AccessibilityNodeInfo): String {
    if (node.isEditable) return "field"
    val cls = node.className?.toString()?.substringAfterLast('.').orEmpty()
    return when {
      cls.isEmpty() -> "node"
      cls.contains("Button") -> "button"
      cls.contains("EditText") -> "field"
      cls.contains("Image") -> "image"
      else -> cls
    }
  }

  /* ------------------------------------------------------- acting */

  /** A tap (or long press) at pixel x,y via a one-finger gesture. */
  fun tapAt(x: Float, y: Float, long: Boolean, done: (Boolean) -> Unit) {
    val path = Path().apply { moveTo(x, y) }
    val duration = if (long) 700L else 50L
    val stroke = GestureDescription.StrokeDescription(path, 0, duration)
    dispatch(GestureDescription.Builder().addStroke(stroke).build(), done)
  }

  /** A swipe from (x1,y1) to (x2,y2) for scrolling. */
  fun swipe(x1: Float, y1: Float, x2: Float, y2: Float, done: (Boolean) -> Unit) {
    val path = Path().apply { moveTo(x1, y1); lineTo(x2, y2) }
    val stroke = GestureDescription.StrokeDescription(path, 0, 300L)
    dispatch(GestureDescription.Builder().addStroke(stroke).build(), done)
  }

  private fun dispatch(gesture: GestureDescription, done: (Boolean) -> Unit) {
    val ok = dispatchGesture(gesture, object : GestureResultCallback() {
      override fun onCompleted(d: GestureDescription?) = done(true)
      override fun onCancelled(d: GestureDescription?) = done(false)
    }, null)
    if (!ok) done(false)
  }

  fun metrics(): DisplayMetrics = resources.displayMetrics

  /** A JPEG-ready bitmap of the screen, or null on any failure. */
  fun shoot(done: (Bitmap?) -> Unit) {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.R) {
      done(null)
      return
    }
    takeScreenshot(Display.DEFAULT_DISPLAY, screenshotExecutor, object : TakeScreenshotCallback {
      override fun onSuccess(result: ScreenshotResult) {
        try {
          val buffer = result.hardwareBuffer
          val bmp = Bitmap.wrapHardwareBuffer(buffer, result.colorSpace)
            ?.copy(Bitmap.Config.ARGB_8888, false)
          buffer.close()
          done(bmp)
        } catch (_: Throwable) {
          done(null)
        }
      }

      override fun onFailure(errorCode: Int) = done(null)
    })
  }
}
