package com.forge.bubble.ui

import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import kotlin.math.min

/**
 * What the bubble shows. Every state has its own shape (never colour alone):
 *  - Idle: solid disc with a small centre dot
 *  - Listening: rings that grow with the mic level
 *  - Thinking: three dots
 *  - Speaking: four bars
 *  - Working: disc + round number badge
 *  - NeedsYou: disc + square "!" badge
 *  - Offline: hollow outline with a slash
 */
enum class BubbleState { Idle, Listening, Thinking, Speaking, Working, NeedsYou, Offline }

/** The word for a state, for the panel and accessibility. */
fun BubbleState.word(): String = when (this) {
  BubbleState.Idle -> "Idle"
  BubbleState.Listening -> "Listening"
  BubbleState.Thinking -> "Thinking"
  BubbleState.Speaking -> "Speaking"
  BubbleState.Working -> "Working"
  BubbleState.NeedsYou -> "Needs you"
  BubbleState.Offline -> "Offline"
}

@Composable
fun BubbleFace(
  state: BubbleState,
  level: Float,
  working: Int,
  needsYou: Int,
  modifier: Modifier = Modifier,
  size: Dp = 56.dp,
) {
  val pulse = rememberInfiniteTransition(label = "bubble")
  val phase = pulse.animateFloat(
    initialValue = 0f, targetValue = 1f,
    animationSpec = infiniteRepeatable(tween(900, easing = LinearEasing), RepeatMode.Restart),
    label = "phase",
  )
  Box(modifier.size(size)) {
    Canvas(Modifier.fillMaxSize()) {
      val r = min(this.size.width, this.size.height) / 2f * 0.82f
      val c = center
      val ink = ForgeColors.Text
      when (state) {
        BubbleState.Offline -> {
          drawCircle(ForgeColors.TextDim, r, c, style = Stroke(width = r * 0.12f))
          drawLine(
            ForgeColors.TextDim,
            Offset(c.x - r * 0.62f, c.y + r * 0.62f), Offset(c.x + r * 0.62f, c.y - r * 0.62f),
            strokeWidth = r * 0.12f,
          )
        }
        else -> {
          drawCircle(ForgeColors.Surface, r, c)
          drawCircle(ForgeColors.Outline, r, c, style = Stroke(width = r * 0.06f))
        }
      }
      when (state) {
        BubbleState.Idle, BubbleState.Working, BubbleState.NeedsYou ->
          drawCircle(ForgeColors.Accent, r * 0.22f, c)
        BubbleState.Listening -> {
          val l = level.coerceIn(0f, 1f)
          // RMS speech sits low on the scale; stretch it so rings visibly move.
          val grow = min(1f, l * 5f)
          drawCircle(ForgeColors.Accent, r * 0.2f, c)
          drawCircle(ForgeColors.Accent, r * (0.38f + 0.2f * grow), c, style = Stroke(width = r * 0.08f))
          drawCircle(ink, r * (0.58f + 0.3f * grow), c, style = Stroke(width = r * 0.05f), alpha = 0.6f)
        }
        BubbleState.Thinking -> {
          for (i in 0..2) {
            val lift = if (((phase.value * 3).toInt()) == i) r * 0.12f else 0f
            drawCircle(ink, r * 0.12f, Offset(c.x + (i - 1) * r * 0.4f, c.y - lift))
          }
        }
        BubbleState.Speaking -> {
          val w = r * 0.14f
          for (i in 0..3) {
            val wave = ((phase.value + i * 0.27f) % 1f)
            val h = r * (0.3f + 0.6f * (if (wave < 0.5f) wave * 2 else (1 - wave) * 2))
            val x = c.x + (i - 1.5f) * r * 0.28f - w / 2
            drawRoundRect(ink, Offset(x, c.y - h / 2), Size(w, h), CornerRadius(w / 2, w / 2))
          }
        }
        BubbleState.Offline -> {}
      }
    }
    if (state == BubbleState.Working || working > 0) {
      Box(
        Modifier.align(Alignment.BottomEnd).size(size * 0.36f).background(ForgeColors.Accent, CircleShape),
        contentAlignment = Alignment.Center,
      ) {
        Text(
          if (working > 0) working.coerceAtMost(9).toString() else "",
          color = ForgeColors.Bg, fontSize = (size.value * 0.2f).sp, fontWeight = FontWeight.Bold,
        )
      }
    }
    if (state == BubbleState.NeedsYou || needsYou > 0) {
      Box(
        Modifier.align(Alignment.TopEnd).size(size * 0.36f)
          .background(ForgeColors.Text, RoundedCornerShape(size * 0.06f)),
        contentAlignment = Alignment.Center,
      ) {
        Text("!", color = ForgeColors.Bg, fontSize = (size.value * 0.22f).sp, fontWeight = FontWeight.Black)
      }
    }
  }
}
