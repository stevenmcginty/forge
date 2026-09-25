package com.forge.watch

import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color
import androidx.wear.compose.material3.ColorScheme
import androidx.wear.compose.material3.MaterialTheme

/**
 * Forge on the wrist: black glass, white words, one lime accent.
 *
 * Lime is Forge's accent and the brightest hue there is, so it stands apart
 * from the greys by lightness, not by hue. Nothing here relies on it alone:
 * every state also has a word or a shape.
 */
object Forge {
    val Lime = Color(0xFFC6FF3D)
    val OnLime = Color(0xFF101600)
    val Ink = Color(0xFFF2F2F2)
    val Muted = Color(0xFF9EA3A8)
    val Faint = Color(0xFF5E6368)
    val Hairline = Color(0xFF2C2F32)
    val Well = Color(0xFF17181A)
}

private val scheme = ColorScheme(
    primary = Forge.Lime,
    primaryDim = Color(0xFFA6D92F),
    primaryContainer = Color(0xFF2B3A08),
    onPrimary = Forge.OnLime,
    onPrimaryContainer = Color(0xFFE3FFA6),
    secondary = Color(0xFFD9E6B8),
    secondaryDim = Color(0xFFB8C49A),
    secondaryContainer = Color(0xFF26291F),
    onSecondary = Color(0xFF1A1D12),
    onSecondaryContainer = Color(0xFFE6EDD2),
    tertiary = Color(0xFFD9E6B8),
    tertiaryDim = Color(0xFFB8C49A),
    tertiaryContainer = Color(0xFF26291F),
    onTertiary = Color(0xFF1A1D12),
    onTertiaryContainer = Color(0xFFE6EDD2),
    surfaceContainerLow = Color(0xFF0F1011),
    surfaceContainer = Forge.Well,
    surfaceContainerHigh = Color(0xFF232527),
    onSurface = Forge.Ink,
    onSurfaceVariant = Forge.Muted,
    outline = Forge.Faint,
    outlineVariant = Forge.Hairline,
    background = Color.Black,
    onBackground = Forge.Ink,
)

@Composable
fun ForgeTheme(content: @Composable () -> Unit) {
    MaterialTheme(colorScheme = scheme, content = content)
}
