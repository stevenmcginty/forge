package com.forge.bubble.store

import android.content.Context
import android.content.SharedPreferences

/**
 * Plain, non-secret settings. Secrets (the PIN, tokens) live in [Secrets].
 *
 * Every read goes to SharedPreferences, which caches in memory, so callers can
 * read fresh values on every check without holding copies that go stale.
 */
object Prefs {
  private const val FILE = "forge_bubble"

  private const val BUBBLE_ON = "bubble_on"
  private const val MUTED = "muted"
  private const val HIDDEN_UNTIL = "hidden_until"
  private const val HIDDEN_MANUAL = "hidden_manual"
  private const val SIGNED_IN = "setup_signed_in"
  private const val PIN_SET = "setup_pin_set"
  private const val SETUP_DONE = "setup_done"

  private fun sp(ctx: Context): SharedPreferences =
    ctx.applicationContext.getSharedPreferences(FILE, Context.MODE_PRIVATE)

  /** The master "Bubble on" switch. Off survives reboots. */
  fun bubbleOn(ctx: Context) = sp(ctx).getBoolean(BUBBLE_ON, false)
  fun setBubbleOn(ctx: Context, on: Boolean) = sp(ctx).edit().putBoolean(BUBBLE_ON, on).apply()

  /** "Mute voice" from the bubble's long-press menu: the agent's replies stay silent. */
  fun muted(ctx: Context) = sp(ctx).getBoolean(MUTED, false)
  fun setMuted(ctx: Context, on: Boolean) = sp(ctx).edit().putBoolean(MUTED, on).apply()

  /**
   * Dropped on the "X": hidden until this wall-clock time (ms), or until the
   * next unlock, whichever comes first. 0 = not hidden.
   */
  fun hiddenUntil(ctx: Context) = sp(ctx).getLong(HIDDEN_UNTIL, 0L)
  fun setHiddenUntil(ctx: Context, at: Long) = sp(ctx).edit().putLong(HIDDEN_UNTIL, at).apply()

  /** "Hide bubble" from the notification or the menu: hidden until "Show bubble". */
  fun hiddenManual(ctx: Context) = sp(ctx).getBoolean(HIDDEN_MANUAL, false)
  fun setHiddenManual(ctx: Context, on: Boolean) = sp(ctx).edit().putBoolean(HIDDEN_MANUAL, on).apply()

  /** Where the bubble sits, kept per orientation: which side, and how far down (px). */
  data class Position(val right: Boolean, val y: Int)

  fun position(ctx: Context, landscape: Boolean, default: Position): Position {
    val key = if (landscape) "land" else "port"
    val p = sp(ctx)
    if (!p.contains("pos_y_$key")) return default
    return Position(p.getBoolean("pos_right_$key", default.right), p.getInt("pos_y_$key", default.y))
  }

  fun setPosition(ctx: Context, landscape: Boolean, pos: Position) {
    val key = if (landscape) "land" else "port"
    sp(ctx).edit().putBoolean("pos_right_$key", pos.right).putInt("pos_y_$key", pos.y).apply()
  }

  /* ------------------------------------------------------------ setup flags */

  fun signedIn(ctx: Context) = sp(ctx).getBoolean(SIGNED_IN, false)
  fun setSignedIn(ctx: Context, on: Boolean) = sp(ctx).edit().putBoolean(SIGNED_IN, on).apply()

  fun pinSet(ctx: Context) = sp(ctx).getBoolean(PIN_SET, false)
  fun setPinSet(ctx: Context, on: Boolean) = sp(ctx).edit().putBoolean(PIN_SET, on).apply()

  /** Set by the setup screen's "Open Forge": from then on the launcher opens Forge Web. */
  fun setupDone(ctx: Context) = sp(ctx).getBoolean(SETUP_DONE, false)
  fun setSetupDone(ctx: Context, on: Boolean) = sp(ctx).edit().putBoolean(SETUP_DONE, on).apply()
}
