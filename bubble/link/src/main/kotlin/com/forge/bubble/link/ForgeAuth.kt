package com.forge.bubble.link

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.FormBody
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONObject
import java.io.IOException
import java.util.concurrent.TimeUnit

/** Where the link gets its Firebase ID token and uid. */
interface TokenSource {
    /** True while credentials are held (they may still turn out to be revoked). */
    fun signedIn(): Boolean
    fun uid(): String?
    /**
     * A valid ID token, or null when signed out. Throws [IOException] on a
     * network failure, so "no account" and "no signal" stay different.
     */
    suspend fun idToken(force: Boolean = false): String?
    /** Forget the credentials (a second bad-token in a row: sign in again). */
    fun signOut()
    /** False for a fixed test token: nothing to refresh, so no `auth` frames. */
    val refreshes: Boolean get() = true
}

/** A fixed JWT, for tests and the dev server (LinkConfig.staticIdToken). */
class StaticTokens(private val token: String, private val uid: String = "dev") : TokenSource {
    @Volatile private var held = true
    override fun signedIn() = held
    override fun uid() = uid
    override suspend fun idToken(force: Boolean): String? = if (held) token else null
    override fun signOut() { held = false }
    override val refreshes: Boolean get() = false
}

/**
 * Email/password sign-in against Firebase Identity Toolkit over REST — the same
 * two endpoints as web/src/lib/auth.ts and watch/.../ForgeAuth.kt (wire spec 1.2).
 *
 * Only the refresh token, uid and email are kept, in the app's [KeyValueStore].
 * ID tokens live an hour and are minted on demand with a five-minute margin.
 * Unlike the PWA there is no account auto-create: an unknown email is just
 * "wrong email or password".
 */
class ForgeAuth(
    private val apiKey: String,
    private val store: KeyValueStore,
    private val http: OkHttpClient = OkHttpClient.Builder()
        .connectTimeout(8, TimeUnit.SECONDS)
        .readTimeout(15, TimeUnit.SECONDS)
        .build(),
) : TokenSource {
    @Volatile private var token: String? = null
    @Volatile private var expiresAt = 0L
    private val lock = Any()

    fun email(): String? = if (signedIn()) store.get(K_EMAIL) else null

    override fun signedIn(): Boolean = store.get(K_REFRESH) != null

    override fun uid(): String? = store.get(K_UID)

    override fun signOut() {
        store.remove(K_REFRESH)
        store.remove(K_UID)
        store.remove(K_EMAIL)
        synchronized(lock) { token = null; expiresAt = 0L }
    }

    /** Null on success, else a sentence for the screen. */
    suspend fun signIn(email: String, password: String): String? = withContext(Dispatchers.IO) {
        if (apiKey.isBlank()) return@withContext "Forge Web is not configured in this build"
        val body = JSONObject().put("email", email).put("password", password).put("returnSecureToken", true)
        val (ok, json) = try {
            post("$AUTH_BASE/accounts:signInWithPassword?key=$apiKey", body)
        } catch (e: IOException) {
            return@withContext "Could not reach Firebase"
        }
        if (!ok) return@withContext friendly(errorCode(json))
        val refresh = json.optString("refreshToken", "")
        val id = json.optString("idToken", "")
        val uid = json.optString("localId", "")
        if (refresh.isBlank() || id.isBlank() || uid.isBlank()) return@withContext "Firebase answered without a sign-in. Try again."
        store.put(K_REFRESH, refresh)
        store.put(K_UID, uid)
        store.put(K_EMAIL, json.optString("email", email))
        synchronized(lock) {
            token = id
            expiresAt = System.currentTimeMillis() + json.optLong("expiresIn", 3600) * 1000 - EXPIRY_MARGIN_MS
        }
        null
    }

    override suspend fun idToken(force: Boolean): String? = withContext(Dispatchers.IO) {
        val rt = store.get(K_REFRESH) ?: return@withContext null
        synchronized(lock) {
            val t = token
            if (!force && t != null && System.currentTimeMillis() < expiresAt) return@withContext t
        }
        val form = FormBody.Builder().add("grant_type", "refresh_token").add("refresh_token", rt).build()
        val req = Request.Builder().url("$TOKEN_BASE/token?key=$apiKey").post(form).build()
        http.newCall(req).execute().use { resp ->
            val text = resp.body?.string().orEmpty()
            if (!resp.isSuccessful) {
                val code = runCatching { errorCode(JSONObject(text)) }.getOrDefault("")
                // Revoked, disabled or a changed password: gone for good, and
                // keeping them would loop on a refusal forever.
                if (resp.code == 400 && PERMANENT.any { code.startsWith(it) }) {
                    signOut()
                    return@withContext null
                }
                throw IOException("Token refresh failed (${resp.code})")
            }
            val j = JSONObject(text)
            val id = j.getString("id_token")
            // The refresh token rotates: keep the new one.
            val next = j.optString("refresh_token", "")
            if (next.isNotBlank() && next != rt) store.put(K_REFRESH, next)
            synchronized(lock) {
                token = id
                expiresAt = System.currentTimeMillis() + j.optLong("expires_in", 3600) * 1000 - EXPIRY_MARGIN_MS
            }
            id
        }
    }

    private fun post(url: String, body: JSONObject): Pair<Boolean, JSONObject> {
        val req = Request.Builder().url(url)
            .post(body.toString().toRequestBody("application/json".toMediaType()))
            .build()
        http.newCall(req).execute().use { resp ->
            val text = resp.body?.string().orEmpty()
            return resp.isSuccessful to runCatching { JSONObject(text) }.getOrDefault(JSONObject())
        }
    }

    private fun errorCode(json: JSONObject): String = json.optJSONObject("error")?.optString("message", "").orEmpty()

    private fun friendly(code: String): String = when {
        code.startsWith("INVALID_LOGIN_CREDENTIALS") || code.startsWith("INVALID_PASSWORD") ||
            code.startsWith("EMAIL_NOT_FOUND") -> "Wrong email or password"
        code.startsWith("INVALID_EMAIL") -> "That is not an email address"
        code.startsWith("USER_DISABLED") -> "This account is turned off"
        code.startsWith("TOO_MANY_ATTEMPTS") -> "Too many tries. Wait a bit."
        code.isBlank() -> "Could not reach Firebase"
        else -> code.lowercase().replace('_', ' ')
    }

    companion object {
        private const val AUTH_BASE = "https://identitytoolkit.googleapis.com/v1"
        private const val TOKEN_BASE = "https://securetoken.googleapis.com/v1"
        private const val EXPIRY_MARGIN_MS = 300_000L
        private val PERMANENT = listOf("TOKEN_EXPIRED", "USER_DISABLED", "USER_NOT_FOUND", "INVALID_REFRESH_TOKEN")
        const val K_REFRESH = "auth.refreshToken"
        const val K_UID = "auth.uid"
        const val K_EMAIL = "auth.email"
    }
}
