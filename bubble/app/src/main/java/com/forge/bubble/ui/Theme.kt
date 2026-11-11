package com.forge.bubble.ui

import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color

/** Placeholder palette (dark). A designer restyles this file and the two faces. */
object ForgeColors {
  val Bg = Color(0xFF0F1115)
  val Surface = Color(0xFF15171C)
  val SurfaceHigh = Color(0xFF1E2128)
  val Accent = Color(0xFFF2A541)
  val Text = Color(0xFFE8EAED)
  val TextDim = Color(0xFF9AA0A6)
  val Outline = Color(0xFF3C4048)
}

@Composable
fun ForgeTheme(content: @Composable () -> Unit) {
  MaterialTheme(
    colorScheme = darkColorScheme(
      primary = ForgeColors.Accent,
      onPrimary = ForgeColors.Bg,
      background = ForgeColors.Bg,
      onBackground = ForgeColors.Text,
      surface = ForgeColors.Surface,
      onSurface = ForgeColors.Text,
      surfaceVariant = ForgeColors.SurfaceHigh,
      onSurfaceVariant = ForgeColors.TextDim,
      outline = ForgeColors.Outline,
    ),
    content = content,
  )
}
