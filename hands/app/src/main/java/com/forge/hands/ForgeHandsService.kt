package com.forge.hands

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import okhttp3.Headers
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import org.json.JSONObject
import java.util.concurrent.TimeUnit

/**
 * The always-on half: a specialUse foreground service that holds one OkHttp
 * WebSocket to the desk and runs the ops that arrive down it.
 *
 * specialUse, not dataSync: dataSync is capped at 6 h/day on target 35 and
 * would simply stop mid-afternoon; specialUse has no time limit and no runtime
 * prerequisite (it is reviewed only on Play, which this app is not on). The
 * ongoing notification is both the Android requirement and the honest signal
 * that Forge can drive the phone — with a Stop action that flips the master
 * switch off.
 *
 * It reads the desk address and token fresh from Forge Hands' own prefs on
 * every connect, so a new pairing on the setup screen is picked up at once
 * (the screen sends ACTION_RECONNECT). No token or origin means the phone is
 * not paired: it waits and retries every 60 s rather than hammering a desk
 * that was never set. A token the desk refuses is forgotten, and the setup
 * screen says to pair again.
 */
class ForgeHandsService : Service() {

  companion object {
    private const val CHANNEL = "forge_hands"
    private const val NOTIF_ID = 42
    private const val ACTION_STOP = "com.forge.hands.STOP"
    private const val ACTION_RECONNECT = "com.forge.hands.RECONNECT"

    private const val PING_MS = 15_000L
    private const val RETRY_UNPAIRED_MS = 60_000L
    private val BACKOFF_MS = longArrayOf(1_000, 2_000, 4_000, 8_000, 15_000, 30_000)
    private const val STATUS_THROTTLE_MS = 2_000L

    fun start(ctx: Context) {
      val intent = Intent(ctx, ForgeHandsService::class.java)
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) ctx.startForegroundService(intent)
      else ctx.startService(intent)
    }

    fun stop(ctx: Context) {
      ctx.stopService(Intent(ctx, ForgeHandsService::class.java))
    }

    /** True while the service is running (switched on, or started by accessibility). */
    @Volatile
    var alive = false
      private set

    /**
     * Drop the socket and dial again now, with whatever address and token are
     * stored: used right after pairing. Starts nothing when the switch is off
     * and the service is not already running.
     */
    fun reconnect(ctx: Context) {
      if (!alive && !ForgeHands.isEnabled(ctx)) return
      val intent = Intent(ctx, ForgeHandsService::class.java).setAction(ACTION_RECONNECT)
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) ctx.startForegroundService(intent)
      else ctx.startService(intent)
    }

    /** http(s)/ws(s)://host[:port] -> ws(s)://host[:port]/link. */
    internal fun toWs(origin: String): String? {
      val trimmed = origin.trim().trimEnd('/')
      val ws = when {
        trimmed.startsWith("https://") -> "wss://" + trimmed.removePrefix("https://")
        trimmed.startsWith("http://") -> "ws://" + trimmed.removePrefix("http://")
        trimmed.startsWith("wss://") || trimmed.startsWith("ws://") -> trimmed
        else -> return null
      }
      return "$ws/link"
    }

    /**
     * The server checks Origin matches Host (electron/mobile/server.ts:468). A
     * phone loading the bundle has an Origin of this very server; we have no
     * page, so we set one that matches: the http(s) form of the same authority.
     */
    internal fun handshakeHeaders(wsUrl: String): Headers {
      val authority = wsUrl.removePrefix("wss://").removePrefix("ws://").substringBefore("/")
      val scheme = if (wsUrl.startsWith("wss://")) "https" else "http"
      return Headers.Builder()
        .add("Origin", "$scheme://$authority")
        .add("ngrok-skip-browser-warning", "1")
        .build()
    }
  }

  private val client = OkHttpClient.Builder()
    .readTimeout(0, TimeUnit.MILLISECONDS)
    .build()

  private val main = Handler(Looper.getMainLooper())
  @Volatile
  private var socket: WebSocket? = null
  private var attempt = 0
  private var running = false
  private var helloAcked = false
  private var lastStatusAt = 0L
  private var lastStatusJson = ""

  private val pinger = object : Runnable {
    override fun run() {
      socket?.send(JSONObject().put("t", "ping").toString())
      main.postDelayed(this, PING_MS)
    }
  }

  override fun onBind(intent: Intent?): IBinder? = null

  override fun onCreate() {
    super.onCreate()
    alive = true
    createChannel()
    ForgeHands.statusListener = { pushStatus(it) }
  }

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    if (intent?.action == ACTION_STOP) {
      ForgeHands.setEnabled(this, false)
      stopSelf()
      return START_NOT_STICKY
    }
    startInForeground(ForgeHands.isEnabled(this))
    if (!running) {
      running = true
      connect()
    } else if (intent?.action == ACTION_RECONNECT) {
      redial()
    }
    return START_STICKY
  }

  override fun onDestroy() {
    running = false
    alive = false
    ForgeHands.linked = false
    main.removeCallbacksAndMessages(null)
    socket?.close(1000, "service stopping")
    socket = null
    if (ForgeHands.statusListener != null) ForgeHands.statusListener = null
    super.onDestroy()
  }

  /* --------------------------------------------------------- the socket */

  private fun connect() {
    if (!running) return
    helloAcked = false
    val origin = ForgeHands.origin(this)
    val token = ForgeHands.deviceToken(this)
    if (origin.isEmpty() || token.isEmpty()) {
      updateNotification("Not paired yet — open Forge Hands to pair.")
      main.postDelayed({ connect() }, RETRY_UNPAIRED_MS)
      return
    }
    val wsUrl = toWs(origin) ?: run {
      main.postDelayed({ connect() }, RETRY_UNPAIRED_MS); return
    }
    updateNotification("Linking to ${ForgeHands.desktopName(this).ifEmpty { "the desk" }}…")
    val request = Request.Builder()
      .url(wsUrl)
      .headers(handshakeHeaders(wsUrl))
      .build()
    socket = client.newWebSocket(request, listener)
  }

  /** A new pairing: forget the old socket and its backoff, dial now. */
  private fun redial() {
    main.removeCallbacksAndMessages(null)
    val old = socket
    socket = null
    ForgeHands.linked = false
    helloAcked = false
    attempt = 0
    old?.close(1000, "re-pairing")
    connect()
  }

  private val listener = object : WebSocketListener() {
    override fun onOpen(webSocket: WebSocket, response: Response) {
      val hello = JSONObject()
        .put("t", "hello")
        .put("proto", 1) // MOBILE_PROTO, shared/mobile.ts:84
        .put("deviceId", ForgeHands.handsDeviceId(this@ForgeHandsService))
        .put("deviceName", ForgeHands.deviceName(this@ForgeHandsService))
        .put("token", ForgeHands.deviceToken(this@ForgeHandsService))
        .put("role", "hands")
      webSocket.send(hello.toString())
    }

    // A callback from a socket that redial() already replaced is ignored, so
    // an old socket closing cannot schedule a second dial.
    override fun onMessage(webSocket: WebSocket, text: String) {
      if (webSocket === socket) handle(text)
    }

    override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
      webSocket.close(1000, null)
    }

    override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
      if (webSocket === socket) scheduleReconnect()
    }

    override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
      if (webSocket === socket) scheduleReconnect()
    }
  }

  private fun handle(text: String) {
    val frame = try { JSONObject(text) } catch (_: Throwable) { return }
    // Named by `t` or by `type`: the desk sends both (shared/mobile.ts), the
    // contract doc writes `type`, and either reading must work.
    val kind = frame.optString("t").ifEmpty { frame.optString("type") }
    when (kind) {
      "hands:req" -> onRequest(frame)
      "hello-ok" -> onHelloOk()
      "err" -> onRefused(frame.optString("code"), frame.optString("msg"))
      // pong and any desk push are ignored: a hands socket gets no pushes.
    }
  }

  /**
   * The desk refused the hello. `auth` means it does not know (or no longer
   * trusts) this token: forget it so we stop knocking, and let the setup
   * screen say "pair again". Lockouts and cooldowns keep the token; the
   * normal backoff tries again after the close that follows.
   */
  private fun onRefused(code: String, msg: String) {
    val words = msg.ifEmpty { "The desk refused this phone." }
    if (code == "auth") {
      ForgeHands.forgetToken(this)
      ForgeHands.linkNote = "$words Pair again with a new link from Forge."
      updateNotification("Not paired — open Forge Hands to pair again.")
    } else {
      ForgeHands.linkNote = words
    }
  }

  private fun onHelloOk() {
    helloAcked = true
    ForgeHands.linked = true
    ForgeHands.linkNote = ""
    attempt = 0
    updateNotification("Forge can use this phone")
    main.removeCallbacks(pinger)
    main.postDelayed(pinger, PING_MS)
    // Status right after hello-ok, then only on change.
    lastStatusJson = ""
    pushStatus(ForgeHands.status(this))
  }

  private fun onRequest(frame: JSONObject) {
    val id = frame.optString("id")
    val op = frame.optString("op")
    val args = frame.optJSONObject("args") ?: JSONObject()
    // Ops touch the accessibility tree and dispatch gestures; run on main.
    main.post {
      ForgeHandsOps.execute(this, op, args) { result ->
        socket?.send(resultFrame(id, result).toString())
      }
    }
  }

  private fun resultFrame(id: String, r: ForgeHandsOps.Result): JSONObject {
    // Both keys: shared/mobile.ts parses by `t`, the contract doc reads `type`.
    val out = JSONObject().put("t", "hands:res").put("type", "hands:res").put("id", id).put("ok", r.ok)
    if (r.ok) {
      out.put("text", r.text)
      if (r.imageBase64 != null) out.put("image", r.imageBase64).put("mime", "image/jpeg")
    } else {
      out.put("error", r.error ?: "Unknown error.")
    }
    return out
  }

  private fun scheduleReconnect() {
    if (!running) return
    ForgeHands.linked = false
    helloAcked = false
    socket = null
    main.removeCallbacks(pinger)
    val delay = BACKOFF_MS[minOf(attempt, BACKOFF_MS.size - 1)]
    attempt++
    main.postDelayed({ connect() }, delay)
  }

  /* --------------------------------------------------------- status push */

  private fun pushStatus(s: ForgeHands.Status) {
    if (!helloAcked) return
    val json = JSONObject()
      .put("t", "hands:status")
      .put("type", "hands:status")
      .put("accessibility", s.accessibility)
      .put("notifications", s.notifications)
      .put("contacts", s.contacts)
      .put("enabled", s.enabled)
      .put("screenOn", s.screenOn)
      .put("locked", s.locked)
      .put("app", s.app)
      .put("version", s.version)
      .toString()
    if (json == lastStatusJson) return
    val now = System.currentTimeMillis()
    val wait = STATUS_THROTTLE_MS - (now - lastStatusAt)
    if (wait > 0) {
      main.postDelayed({ pushStatus(ForgeHands.status(this)) }, wait)
      return
    }
    lastStatusAt = now
    lastStatusJson = json
    socket?.send(json)
  }

  /* ------------------------------------------------------- the notification */

  private fun createChannel() {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
    val mgr = getSystemService(NotificationManager::class.java)
    if (mgr.getNotificationChannel(CHANNEL) != null) return
    val channel = NotificationChannel(CHANNEL, "Phone hands", NotificationManager.IMPORTANCE_LOW)
    channel.description = "Shows while Forge can operate this phone."
    mgr.createNotificationChannel(channel)
  }

  private fun startInForeground(enabled: Boolean) {
    val notif = buildNotification(if (enabled) "Forge can use this phone" else "Phone hands are off")
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
      startForeground(NOTIF_ID, notif, ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE)
    } else {
      startForeground(NOTIF_ID, notif)
    }
  }

  private fun updateNotification(text: String) {
    getSystemService(NotificationManager::class.java).notify(NOTIF_ID, buildNotification(text))
  }

  private fun buildNotification(text: String): Notification {
    val stopIntent = Intent(this, ForgeHandsService::class.java).setAction(ACTION_STOP)
    val flags = PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
    val stop = PendingIntent.getService(this, 1, stopIntent, flags)
    val open = PendingIntent.getActivity(this, 2, Intent(this, SetupActivity::class.java), flags)
    val builder = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O)
      Notification.Builder(this, CHANNEL) else @Suppress("DEPRECATION") Notification.Builder(this)
    return builder
      .setContentTitle("Forge Hands")
      .setContentText(text)
      .setContentIntent(open)
      .setSmallIcon(android.R.drawable.ic_menu_manage)
      .setOngoing(true)
      .addAction(Notification.Action.Builder(null, "Stop", stop).build())
      .build()
  }

}
