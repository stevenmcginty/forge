package com.forge.watch

import android.content.Context
import android.util.Log
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.withContext
import okhttp3.FormBody
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONObject
import java.util.concurrent.TimeUnit

/**
 * Email/password sign-in against Firebase Identity Toolkit, over plain REST.
 *
 * The same two endpoints and the same contract as web/src/lib/auth.ts — Forge
 * Web signs in exactly this way, and this desktop admits any browser (or
 * watch) holding a verified ID token for its one configured account plus its
 * PIN. No Firebase SDK: it is two POSTs.
 *
 * The refresh token is the only thing kept. ID tokens live an hour and are
 * minted on demand, with a five-minute margin so a refresh never races the
 * expiry it was meant to be ahead of.
 */
object ForgeAuth {
    private const val TAG = "ForgeWatch"
    private const val PREFS = "forge-auth"
    private const val EXPIRY_MARGIN_MS = 300_000L

    private const val AUTH_BASE = "https://identitytoolkit.googleapis.com/v1"
    private const val TOKEN_BASE = "https://securetoken.googleapis.com/v1"

    private val http = OkHttpClient.Builder()
        .connectTimeout(8, TimeUnit.SECONDS)
        .readTimeout(15, TimeUnit.SECONDS)
        .build()

    /** The signed-in address, or null. What the screen shows. */
    val email = MutableStateFlow<String?>(null)

    @Volatile private var idToken: String? = null
    @Volatile private var tokenExpiresAt = 0L
    private val lock = Any()

    val configured: Boolean
        get() = BuildConfig.FORGE_API_KEY.isNotBlank() && BuildConfig.FORGE_DB_URL.isNotBlank()

    private fun prefs(ctx: Context) = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    fun load(ctx: Context) {
        val p = prefs(ctx)
        email.value = if (p.getString("refreshToken", null) != null) p.getString("email", null) else null
    }

    fun signedIn(ctx: Context): Boolean = prefs(ctx).getString("refreshToken", null) != null

    fun uid(ctx: Context): String? = prefs(ctx).getString("uid", null)

    fun signOut(ctx: Context) {
        prefs(ctx).edit().clear().apply()
        synchronized(lock) { idToken = null; tokenExpiresAt = 0L }
        email.value = null
    }

    /** Returns null on success, or a sentence for the screen. */
    suspend fun signIn(ctx: Context, mail: String, password: String): String? = withContext(Dispatchers.IO) {
        if (!configured) return@withContext "Forge Web is not configured in this build"
        val body = JSONObject()
            .put("email", mail)
            .put("password", password)
            .put("returnSecureToken", true)
        val (ok, json) = post("$AUTH_BASE/accounts:signInWithPassword?key=${BuildConfig.FORGE_API_KEY}", body)
        if (!ok) return@withContext friendly(errorCode(json))
        val refresh = json.optString("refreshToken", "")
        val token = json.optString("idToken", "")
        val uid = json.optString("localId", "")
        if (refresh.isBlank() || token.isBlank() || uid.isBlank()) {
            return@withContext "Firebase answered without a sign-in. Try again."
        }
        prefs(ctx).edit()
            .putString("refreshToken", refresh)
            .putString("uid", uid)
            .putString("email", json.optString("email", mail))
            .apply()
        synchronized(lock) {
            idToken = token
            tokenExpiresAt = System.currentTimeMillis() + json.optLong("expiresIn", 3600) * 1000 - EXPIRY_MARGIN_MS
        }
        email.value = json.optString("email", mail)
        null
    }

    /**
     * A valid ID token, or null when signed out. Throws on a network failure
     * so the caller can tell "no account" from "no signal".
     */
    suspend fun idToken(ctx: Context, force: Boolean = false): String? = withContext(Dispatchers.IO) {
        val rt = prefs(ctx).getString("refreshToken", null) ?: return@withContext null
        synchronized(lock) {
            val t = idToken
            if (!force && t != null && System.currentTimeMillis() < tokenExpiresAt) return@withContext t
        }
        val form = FormBody.Builder()
            .add("grant_type", "refresh_token")
            .add("refresh_token", rt)
            .build()
        val req = Request.Builder()
            .url("$TOKEN_BASE/token?key=${BuildConfig.FORGE_API_KEY}")
            .post(form)
            .build()
        http.newCall(req).execute().use { resp ->
            val text = resp.body?.string().orEmpty()
            if (!resp.isSuccessful) {
                val code = runCatching { errorCode(JSONObject(text)) }.getOrDefault("")
                // Revoked or a changed password: the credentials are gone for
                // good, and keeping them would loop on a refusal forever.
                if (resp.code == 400 && (code.startsWith("TOKEN_EXPIRED") || code.startsWith("USER_DISABLED") ||
                        code.startsWith("USER_NOT_FOUND") || code.startsWith("INVALID_REFRESH_TOKEN"))) {
                    Log.i(TAG, "refresh refused ($code) — signing out")
                    signOut(ctx)
                    return@withContext null
                }
                throw IllegalStateException("Token refresh failed (${resp.code})")
            }
            val j = JSONObject(text)
            val token = j.getString("id_token")
            val newRt = j.optString("refresh_token", "")
            if (newRt.isNotBlank() && newRt != rt) prefs(ctx).edit().putString("refreshToken", newRt).apply()
            synchronized(lock) {
                idToken = token
                tokenExpiresAt = System.currentTimeMillis() + j.optLong("expires_in", 3600) * 1000 - EXPIRY_MARGIN_MS
            }
            token
        }
    }

    private fun post(url: String, body: JSONObject): Pair<Boolean, JSONObject> {
        val req = Request.Builder()
            .url(url)
            .post(body.toString().toRequestBody("application/json".toMediaType()))
            .build()
        http.newCall(req).execute().use { resp ->
            val text = resp.body?.string().orEmpty()
            val json = runCatching { JSONObject(text) }.getOrDefault(JSONObject())
            return resp.isSuccessful to json
        }
    }

    private fun errorCode(json: JSONObject): String =
        json.optJSONObject("error")?.optString("message", "").orEmpty()

    private fun friendly(code: String): String = when {
        code.startsWith("INVALID_LOGIN_CREDENTIALS") || code.startsWith("INVALID_PASSWORD") ||
            code.startsWith("EMAIL_NOT_FOUND") -> "Wrong email or password"
        code.startsWith("INVALID_EMAIL") -> "That is not an email address"
        code.startsWith("TOO_MANY_ATTEMPTS") -> "Too many tries. Wait a bit."
        code.isBlank() -> "Could not reach Firebase"
        else -> code.lowercase().replace('_', ' ')
    }
}
