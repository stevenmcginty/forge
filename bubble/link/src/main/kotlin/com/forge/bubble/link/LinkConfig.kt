package com.forge.bubble.link

/**
 * What the app tells the link about itself.
 *
 * [apiKey] and [databaseUrl] are the public Forge Web config (the PWA loads the
 * same two from /config.json; see wire spec 1.2). [directUrl] and
 * [staticIdToken] are for tests and the dev server: with [directUrl] set the
 * link skips the Realtime Database lookup and dials that `ws://` / `wss://` URL
 * as is; with [staticIdToken] set it skips Firebase and sends that JWT.
 */
data class LinkConfig(
    val apiKey: String,
    val databaseUrl: String,
    /** `client` in hello; logged on the desktop only. At most 32 chars. */
    val clientName: String = "forge-bubble/1.0",
    /** `deviceName` in hello, e.g. "Forge Bubble (Pixel 8)". At most 64 chars. */
    val deviceName: String = "Forge Bubble",
    val directUrl: String? = null,
    val staticIdToken: String? = null,
)

/**
 * Small string storage the app provides (SharedPreferences on Android).
 *
 * The link keeps here: the Firebase refresh token, uid and email; the stable
 * device id; and the PIN, only while "remember" is on. Keep it private to the
 * app (and encrypted where the platform offers it).
 */
interface KeyValueStore {
    fun get(key: String): String?
    fun put(key: String, value: String)
    fun remove(key: String)
}

/**
 * Plays one speech clip. `audio` is the decoded clip as the desktop sent it:
 * `audio/wav` (PCM16 mono, 24 kHz for OpenAI voices) or `audio/mpeg`.
 *
 * [play] suspends until the clip has finished (or [stop] was called) and
 * should return promptly when its coroutine is cancelled. [stop] cuts the
 * clip that is playing now, if any.
 */
interface ClipPlayer {
    suspend fun play(audio: ByteArray, mime: String)
    fun stop()
}

/** A [KeyValueStore] in memory: for tests, or an app that wants nothing kept. */
class MemoryStore : KeyValueStore {
    private val map = java.util.concurrent.ConcurrentHashMap<String, String>()
    override fun get(key: String): String? = map[key]
    override fun put(key: String, value: String) { map[key] = value }
    override fun remove(key: String) { map.remove(key) }
}
