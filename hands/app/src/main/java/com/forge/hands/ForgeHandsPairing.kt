package com.forge.hands

import android.content.Context
import android.net.Uri
import android.os.Handler
import android.os.Looper
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import org.json.JSONObject
import java.util.concurrent.TimeUnit

/**
 * Pairing by link (phone-hands contract v2).
 *
 * The desk mints a single-use, 5-minute hands pairing code and hands Steve
 *   forgehands://pair?host=<host>&scheme=wss&pt=<code>       (tunnel; no port)
 *   forgehands://pair?host=<lan ip>&port=<port>&pt=<code>    (no tunnel)
 * — the same params as shared/mobile.ts pairLink, under our own scheme.
 *
 * Pairing is one short socket, owned by the setup screen rather than the
 * always-on service: dial, send the same hello the Forge Mobile WebView sends
 * (mobile/src/lib/link.ts) with the code in `token` (the desk tells a code from
 * a device token by length, server.ts) plus role "hands", wait for hello-ok,
 * store the deviceToken it carries, hang up. The service then dials again with
 * the stored token — the only kind of credential it ever presents. Nothing is
 * stored unless the desk issued a token, so a failed pairing never clobbers a
 * working one.
 *
 * A link is only ever a proposal: the setup screen shows its desk address and
 * pairs only when Steve presses Pair. A pairing that replaces a different
 * desk turns "Let Forge use this phone" off before the new address is stored,
 * so a new PC never gets the phone without Steve switching it on by hand.
 */
object ForgeHandsPairing {

  /** The LAN port when a link names none and is not a tunnel link (MOBILE_PORT, shared/mobile.ts). */
  private const val MOBILE_PORT = 8420
  private const val TIMEOUT_MS = 20_000L
  /** A hostname or IPv4 (the desk mints only these), or a bracketed IPv6. Same rule as markdown.tsx handsLinkHost. */
  private val PLAIN_HOST = Regex("^[A-Za-z0-9](?:[A-Za-z0-9.-]{0,252})$")
  private val IPV6_HOST = Regex("^\\[[0-9A-Fa-f:.]+\\]$")

  data class Link(val origin: String, val code: String, val host: String)

  /** True for anything that looks like one of our links, valid or not. */
  fun looksLikeLink(text: String?): Boolean =
    text?.trim()?.startsWith("forgehands://", ignoreCase = true) == true

  /**
   * The origin and code out of a forgehands://pair link, or null. The origin
   * rule is toOrigin's for forge:// links (mobile/src/lib/secure.ts): a port
   * means ws://host:port; no port means the tunnel (wss://host) when
   * scheme=wss|https, else the LAN default port.
   */
  fun parse(text: String?): Link? {
    val raw = text?.trim().orEmpty()
    if (!looksLikeLink(raw)) return null
    val uri = try { Uri.parse(raw) } catch (_: Throwable) { return null }
    if (!"pair".equals(uri.host, ignoreCase = true)) return null
    val host = uri.getQueryParameter("host")?.trim().orEmpty()
    val code = uri.getQueryParameter("pt")?.trim().orEmpty()
    if (host.isEmpty() || code.isEmpty()) return null
    // The card shows this host as the desk address, so it must be the host
    // that is dialled: no userinfo `@`, path, query, escapes or line breaks.
    if (!PLAIN_HOST.matches(host) && !IPV6_HOST.matches(host)) return null
    val port = uri.getQueryParameter("port")?.trim().orEmpty()
    val scheme = uri.getQueryParameter("scheme")?.trim().orEmpty()
    val origin = when {
      port.isNotEmpty() -> {
        if (port.toIntOrNull()?.takeIf { it in 1..65535 } == null) return null
        "ws://$host:$port"
      }
      scheme.equals("wss", true) || scheme.equals("https", true) -> "wss://$host"
      else -> "ws://$host:$MOBILE_PORT"
    }
    return Link(origin, code, host)
  }

  /** The host of an origin or address: ws://host:port -> host. "" for "". */
  fun hostOf(origin: String): String =
    origin.substringAfter("://").substringBefore("/").replace(Regex(":\\d+$"), "")

  /** Where [link] dials, as Steve should read it: host, and the port if there is one. */
  fun address(link: Link): String = link.origin.substringAfter("://")

  /**
   * True when pairing [link] would replace a desk already saved at
   * [savedOrigin] on a different host. Same host (any port) is a re-pair of
   * the same PC; nothing saved is a first pairing.
   */
  fun replacesDesk(savedOrigin: String, link: Link): Boolean {
    val saved = hostOf(savedOrigin)
    return saved.isNotEmpty() && !saved.equals(link.host, ignoreCase = true)
  }

  /**
   * Pair with the desk named in [link]. [done] runs on the main thread with
   * null on success, or a plain-words reason it failed.
   */
  fun pair(ctx: Context, link: Link, done: (String?) -> Unit) {
    val app = ctx.applicationContext
    val main = Handler(Looper.getMainLooper())
    var finished = false
    var socket: WebSocket? = null
    val timeoutToken = Any()

    fun finish(problem: String?) {
      main.post {
        if (finished) return@post
        finished = true
        main.removeCallbacksAndMessages(timeoutToken)
        socket?.close(1000, if (problem == null) "paired" else "pairing failed")
        done(problem)
      }
    }

    val wsUrl = ForgeHandsService.toWs(link.origin)
      ?: return done("That link has an address Forge Hands cannot use.")
    val client = OkHttpClient.Builder()
      .connectTimeout(15, TimeUnit.SECONDS)
      .readTimeout(0, TimeUnit.MILLISECONDS)
      .build()
    val request = Request.Builder()
      .url(wsUrl)
      .headers(ForgeHandsService.handshakeHeaders(wsUrl))
      .build()

    main.postAtTime(
      { finish("The desk at ${link.host} did not answer in 20 s. Check the PC is on and Forge is running, then try again.") },
      timeoutToken,
      android.os.SystemClock.uptimeMillis() + TIMEOUT_MS
    )

    socket = client.newWebSocket(request, object : WebSocketListener() {
      override fun onOpen(webSocket: WebSocket, response: Response) {
        val hello = JSONObject()
          .put("t", "hello")
          .put("proto", 1) // MOBILE_PROTO, shared/mobile.ts
          .put("deviceId", ForgeHands.handsDeviceId(app))
          .put("deviceName", ForgeHands.deviceName(app))
          .put("token", link.code)
          .put("role", "hands")
        webSocket.send(hello.toString())
      }

      override fun onMessage(webSocket: WebSocket, text: String) {
        val frame = try { JSONObject(text) } catch (_: Throwable) { return }
        when (frame.optString("t").ifEmpty { frame.optString("type") }) {
          "hello-ok" -> {
            val token = frame.optString("deviceToken")
            if (token.isEmpty()) {
              finish("The desk let this phone in but sent no key, so nothing was saved. Ask Forge for a new Forge Hands link.")
              return
            }
            // Stored before anything else can go wrong: the code is spent now.
            // desktopName is optional (an older desk does not say); deviceName
            // in hello-ok is OUR name as the desk lists it, so not a fallback.
            val desk = frame.optString("desktopName")
            // A different PC: the switch goes off first, so the service never
            // serves the new desk before Steve turns it on again by hand.
            if (replacesDesk(ForgeHands.origin(app), link)) ForgeHands.setEnabled(app, false)
            ForgeHands.savePairing(app, link.origin, token, desk)
            ForgeHands.linkNote = ""
            finish(null)
          }
          "err" -> {
            val msg = frame.optString("msg").ifEmpty { "The desk refused the link." }
            finish("$msg Links work once, for 5 minutes. Ask Forge for a new one.")
          }
        }
      }

      override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
        finish(if (reason.isNotEmpty()) "The desk closed the link: $reason" else "The desk closed the link before pairing.")
      }

      override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
        finish("Could not reach the desk at ${link.host} (${t.message ?: t.javaClass.simpleName}). Check the phone and PC are online, then try again.")
      }
    })
  }
}
