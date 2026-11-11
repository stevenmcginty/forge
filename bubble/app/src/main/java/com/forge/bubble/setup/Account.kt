package com.forge.bubble.setup

import android.content.Context
import com.forge.bubble.store.Prefs
import com.forge.bubble.store.Secrets
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow

/** What the setup screen shows for steps 1 and 2. */
data class AccountStatus(
  val signedIn: Boolean = false,
  val email: String = "",
  val pinSet: Boolean = false,
  /** A short line for the user, e.g. why sign-in failed. Null = nothing to say. */
  val note: String? = null,
)

/**
 * Sign-in and PIN, as the setup screen sees them. [StubAccount] accepts
 * anything; the real Forge Web sign-in replaces it through [Accounts.factory].
 */
interface Account {
  suspend fun signIn(email: String, password: String): Result<Unit>
  fun submitPin(pin: String, remember: Boolean)
  val status: StateFlow<AccountStatus>
}

object Accounts {
  @Volatile
  var factory: (Context) -> Account = { StubAccount(it) }

  @Volatile
  private var instance: Account? = null

  fun get(ctx: Context): Account =
    instance ?: synchronized(this) { instance ?: factory(ctx.applicationContext).also { instance = it } }
}

/**
 * Accepts any email/password and any PIN, and only records that the steps were
 * done. A remembered PIN goes into [Secrets] (Keystore-encrypted); no network.
 */
class StubAccount(private val ctx: Context) : Account {
  private val state = MutableStateFlow(
    AccountStatus(signedIn = Prefs.signedIn(ctx), pinSet = Prefs.pinSet(ctx))
  )
  override val status: StateFlow<AccountStatus> = state

  override suspend fun signIn(email: String, password: String): Result<Unit> {
    Prefs.setSignedIn(ctx, true)
    state.value = state.value.copy(signedIn = true, email = email.trim(), note = null)
    return Result.success(Unit)
  }

  override fun submitPin(pin: String, remember: Boolean) {
    if (remember) Secrets.put(ctx, "pin", pin) else Secrets.remove(ctx, "pin")
    Prefs.setPinSet(ctx, true)
    state.value = state.value.copy(pinSet = true, note = null)
  }
}
