package com.forge.bubble.ui

import android.animation.ValueAnimator
import androidx.compose.animation.core.CubicBezierEasing
import androidx.compose.animation.core.Spring
import androidx.compose.animation.core.spring
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color

/**
 * "Night glass, lime spark": the bubble family's palette, on the Forge Web
 * phone tokens (web/src/phone-tokens.css). Dark glass that sits on any app,
 * light or dark; one decisive lime from the Forge mark (the desk's agent lime,
 * --p-agent) meaning "awake / act here"; amber only for "waiting on you"
 * (--p-attn). Never colour alone: every state is also a shape or a word.
 */
object ForgeColors {
  /** Screens (setup). */
  val Bg = Color(0xFF0B0C0E)
  /** The glass of the bubble and the panel. */
  val Surface = Color(0xFF14161A)
  /** Cards, the text box, menu. */
  val SurfaceHigh = Color(0xFF1D2026)
  val Press = Color(0xFF262A31)

  /** Lime: the Forge mark, "awake", act here. */
  val Accent = Color(0xFFB6F04A)
  val Accent2 = Color(0xFFE3F36B)
  val AccentCore = Color(0xFFFBFFE8)
  /** Ink drawn on lime. */
  val OnAccent = Color(0xFF0C0E10)

  /** Amber: something is waiting on you. */
  val Attn = Color(0xFFE6A23C)
  val OnAttn = Color(0xFF0B0C0E)

  val Text = Color(0xFFF2F4F6)
  val TextDim = Color(0xFFA9AFB8)
  val TextFaint = Color(0xFF6E747D)

  /** The one hairline, and the glass rim's light. */
  val Outline = Color(0xFF2C3037)
  val Rim = Color(0x33FFFFFF)
  val Shade = Color(0x59000000)
}

/** Motion: ease out, no overshoot (phone-tokens.css rule 9). */
object ForgeMotion {
  val Ease = CubicBezierEasing(0.22f, 0.61f, 0.36f, 1f)
  const val FAST = 120
  const val BASE = 180
  /** The desk's glide: a critically damped spring (--p-glide). */
  fun <T> glide() = spring<T>(dampingRatio = Spring.DampingRatioNoBouncy, stiffness = 420f)
  fun <T> snap() = spring<T>(dampingRatio = Spring.DampingRatioNoBouncy, stiffness = 900f)

  /**
   * False when the system "Remove animations" (animator duration scale 0) is
   * on: every face then stands still on its own shape.
   */
  fun enabled(): Boolean = ValueAnimator.areAnimatorsEnabled()
}

@Composable
fun ForgeTheme(content: @Composable () -> Unit) {
  MaterialTheme(
    colorScheme = darkColorScheme(
      primary = ForgeColors.Accent,
      onPrimary = ForgeColors.OnAccent,
      secondary = ForgeColors.Accent2,
      onSecondary = ForgeColors.OnAccent,
      background = ForgeColors.Bg,
      onBackground = ForgeColors.Text,
      surface = ForgeColors.Surface,
      onSurface = ForgeColors.Text,
      surfaceVariant = ForgeColors.SurfaceHigh,
      onSurfaceVariant = ForgeColors.TextDim,
      surfaceContainerHighest = ForgeColors.SurfaceHigh,
      outline = ForgeColors.Outline,
      outlineVariant = ForgeColors.Outline,
      error = ForgeColors.Attn,
      onError = ForgeColors.OnAttn,
    ),
    content = content,
  )
}
