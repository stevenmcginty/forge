package com.forge.bubble.engine

import android.content.Context
import android.os.Build
import android.util.Log
import com.forge.bubble.BuildConfig
import com.forge.bubble.TAG
import com.forge.bubble.audio.ClipPlayer
import com.forge.bubble.link.BubbleEngine
import com.forge.bubble.link.EngineState
import com.forge.bubble.link.KeyValueStore
import com.forge.bubble.link.LinkConfig
import com.forge.bubble.link.LinkState
import com.forge.bubble.store.Prefs
import com.forge.bubble.store.Secrets
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.filterNotNull
import kotlinx.coroutines.flow.flatMapLatest
import kotlinx.coroutines.launch
import java.util.concurrent.atomic.AtomicInteger
import com.forge.bubble.link.ClipPlayer as LinkClipPlayer

/**
 * The one process-wide [BubbleEngine] (bubble/link/API.md): built on first use
 * from BuildConfig (the public Forge Web apiKey + databaseUrl), with [Secrets]
 * as its store and [SpeechPlayer] as its clip player. Everyone reads [state],
 * which follows the engine even when a debug build swaps in a dev one.
 *
 * [BubbleService] owns when it is connected (start/stop); the talk panel and
 * setup screen only ask it things. Clips play here, in the process, so speech
 * goes on when the panel closes.
 */
object Engine {

  private val current = MutableStateFlow<BubbleEngine?>(null)
  @Volatile private var player: SpeechPlayer? = null

  /** A debug build is talking to a dev server (no Firebase account involved). */
  @Volatile
  var dev = false
    private set

  /** Process-lifetime work that is nobody's in particular (logging, debug turns). */
  val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)

  @OptIn(ExperimentalCoroutinesApi::class)
  val state: Flow<EngineState> = current.filterNotNull().flatMapLatest { it.state }

  /** False when the build had no web/public/config.json: it cannot sign in. */
  val configured: Boolean
    get() = BuildConfig.FORGE_API_KEY.isNotBlank() && BuildConfig.FORGE_DB_URL.isNotBlank()

  init {
    scope.launch {
      var last: EngineState? = null
      state.collect { s -> logChange(last, s); last = s }
    }
  }

  fun get(ctx: Context): BubbleEngine {
    current.value?.let { return it }
    synchronized(this) {
      current.value?.let { return it }
      val app = ctx.applicationContext
      val config = LinkConfig(
        apiKey = BuildConfig.FORGE_API_KEY,
        databaseUrl = BuildConfig.FORGE_DB_URL,
        clientName = "forge-bubble/${BuildConfig.VERSION_NAME}".take(32),
        deviceName = "Forge Bubble (${Build.MODEL})".take(64),
      )
      val e = BubbleEngine(config, SecretsStore(app, "link."), player(app))
      current.value = e
      if (!configured) Log.w(TAG, "engine: this build has no Forge Web config; it cannot sign in")
      return e
    }
  }

  /** The engine if one was built; never builds one. */
  fun currentOrNull(): BubbleEngine? = current.value

  /** Debug builds' dev override only: replace the engine (the old one is disposed). */
  fun install(e: BubbleEngine) {
    check(BuildConfig.DEBUG) { "dev engines are for debug builds" }
    val old = synchronized(this) {
      val o = current.value
      dev = true
      current.value = e
      o
    }
    old?.dispose()
  }

  /** Signed in to a Forge account (or on a dev server). */
  fun signedIn(): Boolean {
    if (dev) return true
    val s = current.value?.state?.value ?: return false
    return s.email != null && s.link != LinkState.SIGNED_OUT
  }

  fun player(ctx: Context): SpeechPlayer =
    player ?: synchronized(this) { player ?: SpeechPlayer(ctx.applicationContext).also { player = it } }

  /** Where the link stands, in words, for the bubble, the panel and setup. */
  fun linkWords(s: EngineState, now: Long = System.currentTimeMillis()): String = when {
    !configured && !dev -> "This build has no Forge Web config"
    s.link == LinkState.SIGNED_OUT -> "Sign in needed"
    s.link == LinkState.NEED_PIN -> "PIN needed"
    s.link == LinkState.LOCKED -> "${s.linkReason.ifBlank { "The desktop is busy" }.trimEnd('.')}. Try again ${waitWords(s.lockedUntil - now)}."
    s.link == LinkState.CONNECTING -> "Connecting"
    s.link == LinkState.ONLINE -> "Online"
    else -> s.linkReason.ifBlank { "Offline" }
  }

  /** "in 4 minutes", "in 30 seconds", "now". */
  fun waitWords(ms: Long): String {
    val secs = (ms + 999) / 1000
    return when {
      secs <= 0 -> "now"
      secs < 60 -> "in $secs second${if (secs == 1L) "" else "s"}"
      else -> {
        val mins = (secs + 59) / 60
        "in $mins minute${if (mins == 1L) "" else "s"}"
      }
    }
  }

  /* ---------------------------------------------------------------- logcat */

  private fun logChange(a: EngineState?, b: EngineState) {
    if (a?.link != b.link || a.linkReason != b.linkReason) {
      val desk = if (b.link == LinkState.ONLINE && b.desktopName.isNotBlank()) " desktop=${b.desktopName}" else ""
      val why = if (b.linkReason.isNotBlank()) " (${b.linkReason})" else ""
      Log.i(TAG, "link ${b.link}$why$desk")
    }
    if (a?.laneOpen != b.laneOpen) Log.i(TAG, if (b.laneOpen) "lane open" else "lane closed")
    if (a?.talk != b.talk) Log.i(TAG, "talk ${b.talk}")
    if (a?.working != b.working || a.needsYou != b.needsYou) Log.i(TAG, "working=${b.working} needsYou=${b.needsYou}")
    if (a?.notice != b.notice && b.notice.isNotBlank()) Log.i(TAG, "notice: ${b.notice}")
    // What was said and the card titles are the owner's words: debug builds only.
    if (!BuildConfig.DEBUG) return
    if (a?.heard != b.heard && b.heard.isNotBlank()) Log.d(TAG, "heard: ${b.heard}")
    if (a?.reply != b.reply && b.reply.isNotBlank()) Log.d(TAG, "reply: ${b.reply}")
    if (a?.cards != b.cards) {
      val list = b.cards.joinToString("; ") { c ->
        "${c.kind} '${c.title}' [${c.state}] ${c.actions.joinToString("/")}"
      }
      Log.d(TAG, "cards ${b.cards.size}: $list")
    }
  }
}

/** [Secrets] (Keystore-encrypted) as the engine's store, under its own key prefix. */
class SecretsStore(ctx: Context, private val prefix: String) : KeyValueStore {
  private val app = ctx.applicationContext
  override fun get(key: String): String? = Secrets.get(app, prefix + key)
  override fun put(key: String, value: String) = Secrets.put(app, prefix + key, value)
  override fun remove(key: String) = Secrets.remove(app, prefix + key)
}

/**
 * The engine's clip player: the app's [ClipPlayer]. "Mute voice" (the bubble's
 * menu) skips the clip, so the turn moves on and the captions still show.
 */
class SpeechPlayer(ctx: Context) : LinkClipPlayer {
  private val app = ctx.applicationContext
  private val player = ClipPlayer(app)
  private val seq = AtomicInteger()

  override suspend fun play(audio: ByteArray, mime: String) {
    val n = seq.incrementAndGet()
    if (Prefs.muted(app)) {
      Log.i(TAG, "clip $n muted, not played ($mime, ${audio.size} bytes)")
      return
    }
    Log.i(TAG, "clip $n playing ($mime, ${audio.size} bytes)")
    player.play(audio, mime)
    Log.i(TAG, "clip $n ended")
  }

  override fun stop() = player.stop()
}
