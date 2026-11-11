package com.forge.bubble.setup

import android.content.Context
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
 * Sign-in and PIN, as the setup screen sees them. [RealAccount] does both
 * through the engine; [Accounts.get] hands out the one instance.
 */
interface Account {
  suspend fun signIn(email: String, password: String): Result<Unit>
  fun submitPin(pin: String, remember: Boolean)
  val status: StateFlow<AccountStatus>
}

object Accounts {
  @Volatile
  var factory: (Context) -> Account = { RealAccount(it) }

  @Volatile
  private var instance: Account? = null

  fun get(ctx: Context): Account =
    instance ?: synchronized(this) { instance ?: factory(ctx.applicationContext).also { instance = it } }
}
