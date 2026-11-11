package com.forge.bubble.setup

import android.content.Context
import android.util.Log
import com.forge.bubble.TAG
import com.forge.bubble.engine.Engine
import com.forge.bubble.link.EngineState
import com.forge.bubble.link.LinkState
import com.forge.bubble.store.Prefs
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.launch

/**
 * Sign-in and PIN on the engine. The engine keeps every PIN rule (a refused PIN
 * is forgotten and never re-sent; a lockout is waited out exactly): this only
 * says what happened. A wrong PIN shows the engine's words once, with the PIN
 * step open again; a lockout counts down in words, once a second.
 *
 * "PIN entered" ([AccountStatus.pinSet]) means the desktop let this phone in;
 * the desktop asking for a PIN again clears it.
 */
class RealAccount(ctx: Context) : Account {

  private val app = ctx.applicationContext
  private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
  private val state = MutableStateFlow(AccountStatus(pinSet = Prefs.pinSet(app)))
  override val status: StateFlow<AccountStatus> = state

  private var last: EngineState? = null
  private var shapeNote: String? = null

  init {
    Engine.get(app)
    scope.launch { Engine.state.collect { s -> last = s; publish(s) } }
    scope.launch {
      while (true) {
        delay(1_000)
        last?.let { if (it.link == LinkState.LOCKED) publish(it) }
      }
    }
  }

  private fun publish(s: EngineState) {
    when (s.link) {
      LinkState.ONLINE -> Prefs.setPinSet(app, true)
      LinkState.NEED_PIN -> Prefs.setPinSet(app, false)
      else -> {}
    }
    if (s.link != LinkState.NEED_PIN) shapeNote = null
    val note = when {
      !Engine.configured && !Engine.dev -> "This build has no Forge Web config, so it cannot sign in."
      shapeNote != null -> shapeNote
      s.link == LinkState.NEED_PIN && s.pinWrong -> "${s.linkReason.ifBlank { "Wrong PIN" }.trimEnd('.')}. Enter the PIN again."
      s.link == LinkState.LOCKED -> Engine.linkWords(s)
      s.link == LinkState.STOPPED && s.linkReason.isNotBlank() -> s.linkReason
      s.link == LinkState.SIGNED_OUT && s.linkReason == "Sign in again" -> "Sign in again."
      else -> null
    }
    state.value = AccountStatus(
      signedIn = Engine.signedIn(),
      email = s.email.orEmpty(),
      pinSet = Prefs.pinSet(app),
      note = note,
    )
  }

  override suspend fun signIn(email: String, password: String): Result<Unit> {
    if (!Engine.configured && !Engine.dev) {
      return Result.failure(IllegalStateException("This build has no Forge Web config, so it cannot sign in."))
    }
    val engine = Engine.get(app)
    val err = engine.signIn(email.trim(), password)
    if (err != null) {
      Log.i(TAG, "setup: sign-in refused")
      return Result.failure(IllegalStateException(err))
    }
    Log.i(TAG, "setup: signed in")
    engine.start()
    return Result.success(Unit)
  }

  override fun submitPin(pin: String, remember: Boolean) {
    val engine = Engine.get(app)
    if (!engine.submitPin(pin, remember)) {
      shapeNote = "A PIN is 4 to 12 digits."
      last?.let { publish(it) }
      return
    }
    shapeNote = null
    Log.i(TAG, "setup: PIN sent (remember=$remember)")
    engine.start()
  }
}
