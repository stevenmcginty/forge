package com.forge.bubble.bubble

import android.animation.ValueAnimator
import android.annotation.SuppressLint
import android.app.KeyguardManager
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.ServiceInfo
import android.content.res.Configuration
import android.graphics.PixelFormat
import android.media.AudioManager
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.os.PowerManager
import android.provider.Settings
import android.util.Log
import android.view.Gravity
import android.view.HapticFeedbackConstants
import android.view.MotionEvent
import android.view.View
import android.view.ViewConfiguration
import android.view.WindowManager
import android.widget.FrameLayout
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.TransformOrigin
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.platform.ComposeView
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.forge.bubble.BuildConfig
import com.forge.bubble.HomeActivity
import com.forge.bubble.TAG
import com.forge.bubble.setup.SetupActivity
import com.forge.bubble.store.Prefs
import com.forge.bubble.talk.TalkActivity
import com.forge.bubble.ui.BubbleFace
import com.forge.bubble.ui.BubbleState
import com.forge.bubble.ui.ForgeColors
import com.forge.bubble.ui.ForgeTheme
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.launch
import kotlin.math.hypot
import kotlin.math.roundToInt

/**
 * The always-on floating bubble: a specialUse foreground service (the type a
 * BOOT_COMPLETED receiver may still start on Android 15+) that holds a
 * TYPE_APPLICATION_OVERLAY window with a ComposeView drawing [BubbleFace].
 *
 * The bubble shows only while ALL hold: overlay permission granted, "Bubble
 * on", screen on, keyguard not locked, and no call (audio mode not IN_CALL or
 * IN_COMMUNICATION). Screen on/off, unlock and audio-mode changes re-check.
 *
 * Touch: drag anywhere and it snaps to the nearest side on release (position
 * kept per orientation); while dragging an "X" target shows at the bottom, and
 * a drop on it hides the bubble for an hour or until the next unlock; long
 * press opens a small menu; tap opens [TalkActivity]. After 6 s untouched it
 * shrinks to ~70% and dims. All timing is Handler timers, never frame callbacks.
 *
 * Debug builds accept `--es demoState <BubbleState name>` to pin the face.
 */
class BubbleService : Service() {

  /** What the bubble draws. The voice link (A3) pushes into [face]. */
  data class BubbleUi(
    val state: BubbleState = BubbleState.Idle,
    val level: Float = 0f,
    val working: Int = 0,
    val needsYou: Int = 0,
  )

  companion object {
    private const val CHANNEL = "forge_bubble"
    private const val NOTIF_ID = 51
    private const val ACTION_HIDE = "com.forge.bubble.HIDE"
    private const val ACTION_SHOW = "com.forge.bubble.SHOW"
    private const val ACTION_STOP = "com.forge.bubble.STOP"
    private const val ACTION_REFRESH = "com.forge.bubble.REFRESH"
    const val EXTRA_DEMO_STATE = "demoState"

    private const val IDLE_MS = 6_000L
    private const val HIDE_FOR_MS = 60 * 60 * 1000L
    private const val IN_CALL_POLL_MS = 5_000L // API 30 only; 31+ has a listener
    private const val BUBBLE_DP = 56
    private const val WINDOW_DP = 64
    private const val TARGET_DP = 72
    private const val TARGET_BOTTOM_DP = 48
    private const val TARGET_HOT_DP = 96

    val face = MutableStateFlow(BubbleUi())

    fun start(ctx: Context) {
      ctx.startForegroundService(Intent(ctx, BubbleService::class.java))
    }

    fun stop(ctx: Context) {
      ctx.stopService(Intent(ctx, BubbleService::class.java))
    }

    /** Re-check the show conditions now (after a setup change), if running. */
    fun refresh(ctx: Context) {
      if (!running) return
      ctx.startService(Intent(ctx, BubbleService::class.java).setAction(ACTION_REFRESH))
    }

    @Volatile
    var running = false
      private set
  }

  private val main = Handler(Looper.getMainLooper())
  private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
  private val owner = OverlayOwner()
  private lateinit var wm: WindowManager
  private lateinit var audio: AudioManager

  private val idle = MutableStateFlow(false)
  private val onRight = MutableStateFlow(true)
  private val targetHot = MutableStateFlow(false)

  private var bubble: View? = null
  private var bubbleParams: WindowManager.LayoutParams? = null
  private var target: View? = null
  private var menu: View? = null
  private var snap: ValueAnimator? = null
  private var modeListener: Any? = null

  private val goIdle = Runnable { idle.value = true }
  private val recheck = Runnable { evaluate() }
  private val inCallPoll = object : Runnable {
    override fun run() {
      evaluate()
      main.postDelayed(this, IN_CALL_POLL_MS)
    }
  }

  private val screenReceiver = object : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
      // An unlock ends an "X" hide early.
      if (intent.action == Intent.ACTION_USER_PRESENT) Prefs.setHiddenUntil(context, 0L)
      Log.d(TAG, "bubble: ${intent.action}")
      evaluate()
    }
  }

  override fun onBind(intent: Intent?): IBinder? = null

  override fun onCreate() {
    super.onCreate()
    running = true
    wm = getSystemService(WindowManager::class.java)
    audio = getSystemService(AudioManager::class.java)
    owner.start()
    createChannel()
    startForegroundNow()
    val filter = IntentFilter().apply {
      addAction(Intent.ACTION_SCREEN_ON)
      addAction(Intent.ACTION_SCREEN_OFF)
      addAction(Intent.ACTION_USER_PRESENT)
    }
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
      registerReceiver(screenReceiver, filter, RECEIVER_NOT_EXPORTED)
    } else {
      registerReceiver(screenReceiver, filter)
    }
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
      val l = AudioManager.OnModeChangedListener { evaluate() }
      audio.addOnModeChangedListener(mainExecutor, l)
      modeListener = l
    } else {
      main.postDelayed(inCallPoll, IN_CALL_POLL_MS)
    }
    // A non-Idle face (needs you, speaking...) wakes a dimmed bubble.
    scope.launch { face.collect { if (it.state != BubbleState.Idle) wake() } }
    Log.i(TAG, "bubble: service created")
  }

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    startForegroundNow()
    when (intent?.action) {
      ACTION_STOP -> {
        Prefs.setBubbleOn(this, false)
        stopSelf()
        return START_NOT_STICKY
      }
      ACTION_HIDE -> Prefs.setHiddenManual(this, true)
      ACTION_SHOW -> {
        Prefs.setHiddenManual(this, false)
        Prefs.setHiddenUntil(this, 0L)
      }
    }
    if (!Prefs.bubbleOn(this)) {
      Log.i(TAG, "bubble: switched off; stopping")
      stopSelf()
      return START_NOT_STICKY
    }
    if (BuildConfig.DEBUG) {
      intent?.getStringExtra(EXTRA_DEMO_STATE)?.let { name ->
        BubbleState.entries.firstOrNull { it.name.equals(name, ignoreCase = true) }?.let { s ->
          face.value = BubbleUi(
            state = s, level = 0.3f,
            working = if (s == BubbleState.Working) 2 else 0,
            needsYou = if (s == BubbleState.NeedsYou) 1 else 0,
          )
        }
      }
    }
    evaluate()
    return START_STICKY
  }

  override fun onDestroy() {
    running = false
    main.removeCallbacksAndMessages(null)
    snap?.cancel()
    try { unregisterReceiver(screenReceiver) } catch (_: Throwable) {}
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
      (modeListener as? AudioManager.OnModeChangedListener)?.let { audio.removeOnModeChangedListener(it) }
    }
    removeBubble()
    scope.cancel()
    owner.destroy()
    Log.i(TAG, "bubble: service destroyed")
    super.onDestroy()
  }

  override fun onConfigurationChanged(newConfig: Configuration) {
    super.onConfigurationChanged(newConfig)
    // Each orientation keeps its own spot.
    closeMenu()
    val p = bubbleParams ?: return
    placeFromPrefs(p)
    bubble?.let { wm.updateViewLayout(it, p) }
  }

  /* ------------------------------------------------------- show or hide */

  private fun inCall(): Boolean =
    audio.mode == AudioManager.MODE_IN_CALL || audio.mode == AudioManager.MODE_IN_COMMUNICATION

  private fun shouldShow(): Boolean {
    val now = System.currentTimeMillis()
    return Settings.canDrawOverlays(this) &&
      Prefs.bubbleOn(this) &&
      !Prefs.hiddenManual(this) &&
      now >= Prefs.hiddenUntil(this) &&
      getSystemService(PowerManager::class.java).isInteractive &&
      !getSystemService(KeyguardManager::class.java).isKeyguardLocked &&
      !inCall()
  }

  private fun evaluate() {
    main.removeCallbacks(recheck)
    val until = Prefs.hiddenUntil(this)
    val now = System.currentTimeMillis()
    if (until > now) main.postDelayed(recheck, until - now + 50)
    if (shouldShow()) addBubble() else removeBubble()
    updateNotification()
  }

  /* --------------------------------------------------------- the bubble */

  private fun px(dp: Int): Int = (dp * resources.displayMetrics.density).roundToInt()

  private fun screen() = wm.currentWindowMetrics.bounds

  private fun landscape() = resources.configuration.orientation == Configuration.ORIENTATION_LANDSCAPE

  private fun overlayParams(w: Int, h: Int, extraFlags: Int = 0) = WindowManager.LayoutParams(
    w, h,
    WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY,
    WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE or WindowManager.LayoutParams.FLAG_LAYOUT_IN_SCREEN or extraFlags,
    PixelFormat.TRANSLUCENT,
  )

  private fun placeFromPrefs(p: WindowManager.LayoutParams) {
    val s = screen()
    val pos = Prefs.position(this, landscape(), Prefs.Position(right = true, y = (s.height() * 0.35f).toInt()))
    p.x = if (pos.right) s.width() - p.width else 0
    p.y = pos.y.coerceIn(0, maxOf(0, s.height() - p.height))
    onRight.value = pos.right
  }

  private fun addBubble() {
    if (bubble != null) return
    val size = px(WINDOW_DP)
    val p = overlayParams(size, size).apply { gravity = Gravity.TOP or Gravity.START }
    placeFromPrefs(p)
    val root = TouchFrame(this)
    owner.attach(root)
    root.addView(ComposeView(this).apply {
      setContent {
        ForgeTheme {
          val ui by face.collectAsState()
          val dim by idle.collectAsState()
          val right by onRight.collectAsState()
          val scale by animateFloatAsState(if (dim) 0.7f else 1f, label = "scale")
          val alpha by animateFloatAsState(if (dim) 0.55f else 1f, label = "alpha")
          Box(Modifier.size(WINDOW_DP.dp), contentAlignment = Alignment.Center) {
            BubbleFace(
              ui.state, ui.level, ui.working, ui.needsYou,
              size = BUBBLE_DP.dp,
              modifier = Modifier.graphicsLayer {
                scaleX = scale; scaleY = scale; this.alpha = alpha
                transformOrigin = TransformOrigin(if (right) 1f else 0f, 0.5f)
              },
            )
          }
        }
      }
    })
    try {
      wm.addView(root, p)
    } catch (t: Throwable) {
      Log.w(TAG, "bubble: cannot add overlay: $t")
      return
    }
    bubble = root
    bubbleParams = p
    wake()
    Log.i(TAG, "bubble: shown at ${p.x},${p.y}")
  }

  private fun removeBubble() {
    closeMenu()
    hideTarget()
    main.removeCallbacks(goIdle)
    val v = bubble ?: return
    try { wm.removeView(v) } catch (_: Throwable) {}
    bubble = null
    bubbleParams = null
    Log.i(TAG, "bubble: hidden")
  }

  private fun wake() {
    idle.value = false
    main.removeCallbacks(goIdle)
    if (bubble != null) main.postDelayed(goIdle, IDLE_MS)
  }

  /** Takes every touch before Compose sees it: the window itself is the control. */
  @SuppressLint("ViewConstructor")
  private inner class TouchFrame(ctx: Context) : FrameLayout(ctx) {
    private val slop = ViewConfiguration.get(ctx).scaledTouchSlop
    private var downX = 0f
    private var downY = 0f
    private var startX = 0
    private var startY = 0
    private var dragging = false
    private var longPressed = false
    private val longPress = Runnable {
      longPressed = true
      performHapticFeedback(HapticFeedbackConstants.LONG_PRESS)
      openMenu()
    }

    override fun onInterceptTouchEvent(ev: MotionEvent) = true

    @SuppressLint("ClickableViewAccessibility")
    override fun onTouchEvent(ev: MotionEvent): Boolean {
      val p = bubbleParams ?: return true
      when (ev.actionMasked) {
        MotionEvent.ACTION_DOWN -> {
          snap?.cancel()
          downX = ev.rawX; downY = ev.rawY
          startX = p.x; startY = p.y
          dragging = false; longPressed = false
          closeMenu()
          wake()
          main.postDelayed(longPress, ViewConfiguration.getLongPressTimeout().toLong())
        }
        MotionEvent.ACTION_MOVE -> {
          val dx = ev.rawX - downX
          val dy = ev.rawY - downY
          if (!dragging && !longPressed && hypot(dx, dy) > slop) {
            dragging = true
            main.removeCallbacks(longPress)
            showTarget()
          }
          if (dragging) {
            val s = screen()
            p.x = (startX + dx).toInt().coerceIn(0, s.width() - p.width)
            p.y = (startY + dy).toInt().coerceIn(0, s.height() - p.height)
            wm.updateViewLayout(this, p)
            targetHot.value = overTarget(p)
            wake()
          }
        }
        MotionEvent.ACTION_UP, MotionEvent.ACTION_CANCEL -> {
          main.removeCallbacks(longPress)
          if (dragging) {
            val drop = targetHot.value
            hideTarget()
            if (drop) hideForAnHour() else snapToEdge(p)
          } else if (!longPressed && ev.actionMasked == MotionEvent.ACTION_UP) {
            openTalk()
          }
          dragging = false
          wake()
        }
      }
      return true
    }
  }

  private fun snapToEdge(p: WindowManager.LayoutParams) {
    val s = screen()
    val right = p.x + p.width / 2 > s.width() / 2
    val toX = if (right) s.width() - p.width else 0
    onRight.value = right
    Prefs.setPosition(this, landscape(), Prefs.Position(right, p.y))
    snap = ValueAnimator.ofInt(p.x, toX).apply {
      duration = 180
      addUpdateListener {
        val v = bubble ?: return@addUpdateListener
        p.x = it.animatedValue as Int
        try { wm.updateViewLayout(v, p) } catch (_: Throwable) {}
      }
      start()
    }
  }

  private fun openTalk() {
    Log.i(TAG, "bubble: tap -> talk panel")
    try {
      startActivity(Intent(this, TalkActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
    } catch (t: Throwable) {
      Log.w(TAG, "bubble: cannot open the talk panel: $t")
    }
  }

  private fun hideForAnHour() {
    Prefs.setHiddenUntil(this, System.currentTimeMillis() + HIDE_FOR_MS)
    Log.i(TAG, "bubble: dropped on X; hidden for an hour or until unlock")
    evaluate()
  }

  /* ---------------------------------------------------------- the X target */

  private fun targetCentre(): Pair<Float, Float> {
    val s = screen()
    return s.width() / 2f to (s.height() - px(TARGET_BOTTOM_DP) - px(TARGET_DP + 20) / 2f)
  }

  private fun overTarget(p: WindowManager.LayoutParams): Boolean {
    val (tx, ty) = targetCentre()
    return hypot(p.x + p.width / 2f - tx, p.y + p.height / 2f - ty) < px(TARGET_HOT_DP)
  }

  private fun showTarget() {
    if (target != null) return
    targetHot.value = false
    val p = overlayParams(
      WindowManager.LayoutParams.WRAP_CONTENT, WindowManager.LayoutParams.WRAP_CONTENT,
      WindowManager.LayoutParams.FLAG_NOT_TOUCHABLE,
    ).apply {
      gravity = Gravity.BOTTOM or Gravity.CENTER_HORIZONTAL
      y = px(TARGET_BOTTOM_DP)
    }
    val root = FrameLayout(this)
    owner.attach(root)
    root.addView(ComposeView(this).apply {
      setContent {
        ForgeTheme {
          val hot by targetHot.collectAsState()
          val grow by animateFloatAsState(if (hot) 1.15f else 1f, label = "grow")
          Column(horizontalAlignment = Alignment.CenterHorizontally) {
            Box(
              Modifier.size(TARGET_DP.dp)
                .graphicsLayer { scaleX = grow; scaleY = grow }
                .background(if (hot) ForgeColors.Text else ForgeColors.Surface, CircleShape)
                .border(2.dp, ForgeColors.Text, CircleShape),
              contentAlignment = Alignment.Center,
            ) {
              Text("X", color = if (hot) ForgeColors.Bg else ForgeColors.Text, fontSize = 28.sp, fontWeight = FontWeight.Bold)
            }
            Text(if (hot) "Let go to hide" else "Hide", color = ForgeColors.Text, fontSize = 13.sp)
          }
        }
      }
    })
    try { wm.addView(root, p); target = root } catch (t: Throwable) { Log.w(TAG, "bubble: target: $t") }
  }

  private fun hideTarget() {
    val v = target ?: return
    try { wm.removeView(v) } catch (_: Throwable) {}
    target = null
    targetHot.value = false
  }

  /* -------------------------------------------------------- long-press menu */

  /** Closes itself on any touch outside it. */
  @SuppressLint("ViewConstructor")
  private inner class MenuFrame(ctx: Context) : FrameLayout(ctx) {
    override fun dispatchTouchEvent(ev: MotionEvent): Boolean {
      if (ev.actionMasked == MotionEvent.ACTION_OUTSIDE) { closeMenu(); return true }
      return super.dispatchTouchEvent(ev)
    }
  }

  private fun openMenu() {
    if (menu != null) return
    val bp = bubbleParams ?: return
    val right = onRight.value
    val p = overlayParams(
      WindowManager.LayoutParams.WRAP_CONTENT, WindowManager.LayoutParams.WRAP_CONTENT,
      WindowManager.LayoutParams.FLAG_WATCH_OUTSIDE_TOUCH,
    ).apply {
      gravity = Gravity.TOP or if (right) Gravity.END else Gravity.START
      x = bp.width
      y = bp.y
    }
    val muted = Prefs.muted(this)
    val root = MenuFrame(this)
    owner.attach(root)
    root.addView(ComposeView(this).apply {
      setContent {
        ForgeTheme {
          Column(
            Modifier.width(200.dp)
              .background(ForgeColors.SurfaceHigh, RoundedCornerShape(12.dp))
              .border(1.dp, ForgeColors.Outline, RoundedCornerShape(12.dp))
              .padding(vertical = 4.dp),
            verticalArrangement = Arrangement.spacedBy(0.dp),
          ) {
            MenuItem("Hide") { closeMenu(); Prefs.setHiddenManual(this@BubbleService, true); evaluate() }
            MenuItem(if (muted) "Unmute voice" else "Mute voice") {
              closeMenu(); Prefs.setMuted(this@BubbleService, !muted)
            }
            MenuItem("Open Forge") { closeMenu(); launch(HomeActivity::class.java) }
            MenuItem("Settings") { closeMenu(); launch(SetupActivity::class.java) }
          }
        }
      }
    })
    try { wm.addView(root, p); menu = root } catch (t: Throwable) { Log.w(TAG, "bubble: menu: $t") }
  }

  @Composable
  private fun MenuItem(label: String, onClick: () -> Unit) {
    Text(
      label, color = ForgeColors.Text, fontSize = 16.sp,
      modifier = Modifier.fillMaxWidth().clickable(onClick = onClick).padding(horizontal = 16.dp, vertical = 12.dp),
    )
  }

  private fun closeMenu() {
    val v = menu ?: return
    try { wm.removeView(v) } catch (_: Throwable) {}
    menu = null
  }

  private fun launch(cls: Class<*>) {
    try {
      startActivity(Intent(this, cls).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
    } catch (t: Throwable) {
      Log.w(TAG, "bubble: cannot open ${cls.simpleName}: $t")
    }
  }

  /* ------------------------------------------------------ the notification */

  private fun createChannel() {
    val mgr = getSystemService(NotificationManager::class.java)
    if (mgr.getNotificationChannel(CHANNEL) != null) return
    val channel = NotificationChannel(CHANNEL, "Floating bubble", NotificationManager.IMPORTANCE_LOW)
    channel.description = "Shows while the Forge bubble is on."
    channel.setShowBadge(false)
    mgr.createNotificationChannel(channel)
  }

  private fun startForegroundNow() {
    val n = buildNotification()
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
      startForeground(NOTIF_ID, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE)
    } else {
      startForeground(NOTIF_ID, n)
    }
  }

  private fun updateNotification() {
    getSystemService(NotificationManager::class.java).notify(NOTIF_ID, buildNotification())
  }

  private fun buildNotification(): Notification {
    val flags = PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
    fun service(action: String, code: Int) =
      PendingIntent.getService(this, code, Intent(this, BubbleService::class.java).setAction(action), flags)
    val hidden = Prefs.hiddenManual(this) || Prefs.hiddenUntil(this) > System.currentTimeMillis()
    val toggle = if (hidden)
      Notification.Action.Builder(null, "Show bubble", service(ACTION_SHOW, 1)).build()
    else
      Notification.Action.Builder(null, "Hide bubble", service(ACTION_HIDE, 2)).build()
    val settings = PendingIntent.getActivity(
      this, 3, Intent(this, SetupActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK), flags,
    )
    val open = PendingIntent.getActivity(
      this, 4, Intent(this, HomeActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK), flags,
    )
    return Notification.Builder(this, CHANNEL)
      .setContentTitle("Forge")
      .setContentText(if (hidden) "Bubble hidden" else "Bubble on")
      .setContentIntent(open)
      .setSmallIcon(android.R.drawable.sym_action_chat)
      .setOngoing(true)
      .setShowWhen(false)
      .addAction(toggle)
      .addAction(Notification.Action.Builder(null, "Settings", settings).build())
      .addAction(Notification.Action.Builder(null, "Stop", service(ACTION_STOP, 5)).build())
      .build()
  }
}
