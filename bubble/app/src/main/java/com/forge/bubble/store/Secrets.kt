package com.forge.bubble.store

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import android.util.Log
import com.forge.bubble.TAG
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/**
 * Small secret strings (the remembered PIN, tokens), encrypted with an AES-GCM
 * key that never leaves the Android Keystore. The ciphertext sits in its own
 * SharedPreferences file as base64(iv || ciphertext+tag).
 *
 * No extra library: the platform Keystore and javax.crypto are enough. A value
 * that no longer decrypts (key wiped by a security reset) reads as null and is
 * dropped, so the caller simply asks again.
 */
object Secrets {
  private const val FILE = "forge_bubble_secrets"
  private const val KEY_ALIAS = "forge_bubble_secrets_v1"
  private const val TRANSFORM = "AES/GCM/NoPadding"
  private const val IV_BYTES = 12
  private const val TAG_BITS = 128

  private fun sp(ctx: Context) =
    ctx.applicationContext.getSharedPreferences(FILE, Context.MODE_PRIVATE)

  @Synchronized
  private fun key(): SecretKey {
    val ks = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
    (ks.getEntry(KEY_ALIAS, null) as? KeyStore.SecretKeyEntry)?.let { return it.secretKey }
    val gen = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore")
    gen.init(
      KeyGenParameterSpec.Builder(KEY_ALIAS, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
        .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
        .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
        .setKeySize(256)
        .build()
    )
    return gen.generateKey()
  }

  fun put(ctx: Context, name: String, value: String) {
    val cipher = Cipher.getInstance(TRANSFORM)
    cipher.init(Cipher.ENCRYPT_MODE, key())
    val sealed = cipher.iv + cipher.doFinal(value.toByteArray(Charsets.UTF_8))
    sp(ctx).edit().putString(name, Base64.encodeToString(sealed, Base64.NO_WRAP)).apply()
  }

  fun get(ctx: Context, name: String): String? {
    val stored = sp(ctx).getString(name, null) ?: return null
    return try {
      val sealed = Base64.decode(stored, Base64.NO_WRAP)
      val cipher = Cipher.getInstance(TRANSFORM)
      cipher.init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(TAG_BITS, sealed, 0, IV_BYTES))
      String(cipher.doFinal(sealed, IV_BYTES, sealed.size - IV_BYTES), Charsets.UTF_8)
    } catch (t: Throwable) {
      // Never log the value; the name and the failure kind are enough.
      Log.w(TAG, "secrets: '$name' no longer decrypts (${t.javaClass.simpleName}); dropping it")
      remove(ctx, name)
      null
    }
  }

  fun remove(ctx: Context, name: String) {
    sp(ctx).edit().remove(name).apply()
  }
}
