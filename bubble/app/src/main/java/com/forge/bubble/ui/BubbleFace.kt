package com.forge.bubble.ui

import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.Spring
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.spring
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.State
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.drawWithCache
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.PathEffect
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.lerp
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import kotlin.math.PI
import kotlin.math.min
import kotlin.math.sin
import kotlin.math.sqrt

/**
 * What the bubble shows. Every state has its own shape (never colour alone):
 *  - Idle: dark glass orb with the Forge "F" and its spark; still
 *  - Listening: the orb floods lime, five dark bars ride the mic level, a halo
 *    ring and the orb itself swell with the voice
 *  - Thinking: three dots rising in turn, an arc running round the rim
 *  - Speaking: a lime core sending rings outward
 *  - Working: the "F" inside a dashed rim, a round count badge
 *  - NeedsYou: a big "!" inside a solid rim, a square count badge, three
 *    pulses on arrival then still
 *  - Offline: a dashed hollow rim, the "F" struck through
 *
 * Only Listening, Thinking and Speaking move for as long as they last; an
 * always-on bubble must not draw frames at rest. With "Remove animations" on
 * nothing moves and the shapes alone tell the states apart.
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

private val STILL = object : State<Float> { override val value = 0.3f }

/** One looping 0..1 phase, only composed while a moving state lasts. */
@Composable
private fun rememberPhase(periodMs: Int): State<Float> {
  val t = rememberInfiniteTransition(label = "face")
  return t.animateFloat(
    initialValue = 0f, targetValue = 1f,
    animationSpec = infiniteRepeatable(tween(periodMs, easing = LinearEasing), RepeatMode.Restart),
    label = "phase",
  )
}

/**
 * @param onRight the bubble sits on the screen's right edge, so the badges go
 *   on its left (inner) side; false mirrors them.
 */
@Composable
fun BubbleFace(
  state: BubbleState,
  level: Float,
  working: Int,
  needsYou: Int,
  modifier: Modifier = Modifier,
  size: Dp = 56.dp,
  onRight: Boolean = true,
) {
  val motion = remember(state) { ForgeMotion.enabled() }
  val moving = motion && (state == BubbleState.Listening || state == BubbleState.Thinking || state == BubbleState.Speaking)
  val phase: State<Float> = if (moving) {
    rememberPhase(if (state == BubbleState.Thinking) 1100 else if (state == BubbleState.Speaking) 1400 else 1600)
  } else STILL

  // RMS speech sits low on the 0..1 scale; a square-root stretch makes a quiet
  // voice still move the orb. Smoothed between the 100 ms mic frames.
  val stretched = if (motion) sqrt(min(1f, level.coerceIn(0f, 1f) * 4f)) else 0.45f
  val voice = animateFloatAsState(
    stretched, spring(dampingRatio = Spring.DampingRatioNoBouncy, stiffness = 260f), label = "voice",
  )
  val awake = animateFloatAsState(
    if (state == BubbleState.Listening) 1f else 0f,
    if (motion) tween(ForgeMotion.BASE, easing = ForgeMotion.Ease) else tween(0), label = "awake",
  )
  // Needs you: three pulses when it arrives, then it holds still.
  val pulse = remember { Animatable(1f) }
  LaunchedEffect(state, needsYou) {
    if (state == BubbleState.NeedsYou && motion) {
      repeat(3) {
        pulse.snapTo(0f)
        pulse.animateTo(1f, tween(1100, easing = ForgeMotion.Ease))
      }
    } else pulse.snapTo(1f)
  }
  val st = rememberUpdatedState(state)

  Box(modifier.size(size)) {
    Spacer(
      Modifier.matchParentSize().drawWithCache {
        val c = Offset(this.size.width / 2f, this.size.height / 2f)
        val r0 = this.size.minDimension / 2f * 0.82f
        val px = this.size.minDimension / 56f // one design dp at 56
        val fH = r0 * 0.86f
        val f = Path().apply { addForgeF(c.x - fH * 0.05f, c.y, fH) }
        val spark = Path().apply {
          addSpark(c.x - fH * 0.05f + forgeFWidth(fH) / 2f + px * 0.5f, c.y - fH * 0.42f, fH * 0.22f)
        }
        val sheen = Brush.radialGradient(
          0f to Color.White.copy(alpha = 0.16f), 1f to Color.Transparent,
          center = Offset(c.x - r0 * 0.35f, c.y - r0 * 0.6f), radius = r0 * 1.15f,
        )
        val hair = Stroke(width = 1f * px)
        val ring = Stroke(width = 2f * px)
        val arc = Stroke(width = 2.2f * px, cap = StrokeCap.Round)
        val dashLen = (2f * PI.toFloat() * r0) / 24f
        val dashed = Stroke(
          width = 1.8f * px, cap = StrokeCap.Round,
          pathEffect = PathEffect.dashPathEffect(floatArrayOf(dashLen * 0.45f, dashLen * 0.55f)),
        )
        val slash = Stroke(width = 2.2f * px, cap = StrokeCap.Round)
        val slashGap = Stroke(width = 5f * px, cap = StrokeCap.Round)
        val barW = r0 * 0.13f
        val barGap = r0 * 0.11f

        onDrawBehind {
          val s = st.value
          val ph = phase.value
          val g = voice.value
          val a = awake.value
          val bodyR = r0 * (1f + 0.11f * g * a)

          // A soft contact shade so the glass holds on white as well as black.
          drawCircle(ForgeColors.Shade, bodyR + 2.5f * px, Offset(c.x, c.y + 1f * px), alpha = 0.35f)
          drawCircle(ForgeColors.Shade, bodyR + 1f * px, Offset(c.x, c.y + 0.5f * px), alpha = 0.6f)

          // Listening: a halo of its own light, wider and brighter with the voice.
          if (a > 0f) {
            drawCircle(
              // Kept inside the 64 dp window: at full voice it reaches 31 dp.
              ForgeColors.Accent, bodyR * (1.08f + 0.12f * g), c,
              style = ring, alpha = a * (0.22f + 0.5f * g),
            )
          }

          val offline = s == BubbleState.Offline
          drawCircle(lerp(ForgeColors.Surface, ForgeColors.Accent, a), bodyR, c, alpha = if (offline) 0.82f else 1f)
          drawCircle(sheen, bodyR, c)

          when (s) {
            BubbleState.Offline -> drawCircle(ForgeColors.TextFaint, bodyR - 1f * px, c, style = dashed)
            BubbleState.Working -> drawCircle(ForgeColors.Accent, bodyR - 1.5f * px, c, style = dashed)
            BubbleState.NeedsYou -> drawCircle(ForgeColors.Attn, bodyR - 1f * px, c, style = ring)
            else -> drawCircle(ForgeColors.Rim, bodyR - 0.5f * px, c, style = hair)
          }

          when (s) {
            BubbleState.Idle -> {
              drawPath(f, ForgeColors.Accent)
              drawPath(spark, ForgeColors.AccentCore)
            }
            BubbleState.Working -> drawPath(f, ForgeColors.Accent)
            BubbleState.Offline -> {
              drawPath(f, ForgeColors.TextDim, alpha = 0.6f)
              val d = r0 * 0.5f
              val from = Offset(c.x - d, c.y + d)
              val to = Offset(c.x + d, c.y - d)
              drawLine(ForgeColors.Surface, from, to, slashGap.width, StrokeCap.Round)
              drawLine(ForgeColors.TextDim, from, to, slash.width, StrokeCap.Round)
            }
            BubbleState.NeedsYou -> {
              val p = pulse.value
              if (p < 1f) {
                drawCircle(ForgeColors.Attn, bodyR * (1f + 0.3f * p), c, style = ring, alpha = (1f - p) * 0.85f)
              }
              val w = r0 * 0.2f
              drawRoundRect(
                ForgeColors.Attn, Offset(c.x - w / 2f, c.y - r0 * 0.5f), Size(w, r0 * 0.62f),
                CornerRadius(w / 2f),
              )
              drawCircle(ForgeColors.Attn, w * 0.6f, Offset(c.x, c.y + r0 * 0.42f))
            }
            BubbleState.Listening -> {
              val total = 5 * barW + 4 * barGap
              for (i in 0 until 5) {
                val weight = when (i) { 0, 4 -> 0.5f; 1, 3 -> 0.82f; else -> 1f }
                val wob = 0.72f + 0.28f * sin(2f * PI.toFloat() * (ph + i * 0.23f))
                val rest = 0.26f + 0.06f * sin(2f * PI.toFloat() * (ph + i * 0.17f))
                val h = r0 * (rest + 0.78f * g * weight * wob)
                val x = c.x - total / 2f + i * (barW + barGap)
                drawRoundRect(
                  ForgeColors.OnAccent, Offset(x, c.y - h / 2f), Size(barW, h), CornerRadius(barW / 2f),
                  alpha = a.coerceAtLeast(0.001f),
                )
              }
            }
            BubbleState.Thinking -> {
              val inset = 1.5f * px
              drawArc(
                ForgeColors.Accent, startAngle = ph * 360f - 90f, sweepAngle = 72f, useCenter = false,
                topLeft = Offset(c.x - bodyR + inset, c.y - bodyR + inset),
                size = Size((bodyR - inset) * 2f, (bodyR - inset) * 2f), style = arc,
              )
              for (i in 0..2) {
                // Each dot rises in turn: a raised-cosine bump per third of the loop.
                val local = ((ph - i * 0.16f) % 1f + 1f) % 1f
                val bump = if (local < 0.5f) sin(local * 2f * PI.toFloat()).coerceAtLeast(0f) else 0f
                val lift = if (motion) bump * r0 * 0.16f else 0f
                drawCircle(
                  ForgeColors.Accent, r0 * 0.11f, Offset(c.x + (i - 1) * r0 * 0.36f, c.y - lift),
                  alpha = if (motion) 0.5f + 0.5f * bump else 1f,
                )
              }
            }
            BubbleState.Speaking -> {
              for (k in 0..1) {
                val p = if (motion) (ph + k * 0.5f) % 1f else 0.25f + k * 0.4f
                drawCircle(
                  ForgeColors.Accent, r0 * (0.32f + 0.56f * p), c,
                  style = ring, alpha = if (motion) (1f - p) * 0.9f else 0.8f - k * 0.3f,
                )
              }
              val beat = if (motion) 1f + 0.08f * sin(2f * PI.toFloat() * ph * 2f) else 1f
              drawCircle(ForgeColors.Accent, r0 * 0.24f * beat, c)
              drawCircle(ForgeColors.AccentCore, r0 * 0.09f * beat, c)
            }
          }
        }
      },
    )

    // Count badges sit on the rim at 45 degrees, on the side facing the screen.
    val b = size * (18f / 56f)
    val edge = size * (2.7f / 56f)
    val far = size - edge - b
    val x = if (onRight) edge else far
    if (needsYou > 0 || state == BubbleState.NeedsYou) {
      Badge(
        text = if (needsYou > 0) count(needsYou) else "!",
        bg = ForgeColors.Attn, ink = ForgeColors.OnAttn,
        shape = RoundedCornerShape(b * 0.28f), size = b, fontScale = size.value / 56f,
        modifier = Modifier.offset(x, edge),
      )
    }
    if (working > 0) {
      Badge(
        text = count(working), bg = ForgeColors.Accent, ink = ForgeColors.OnAccent,
        shape = CircleShape, size = b, fontScale = size.value / 56f,
        modifier = Modifier.offset(x, far),
      )
    }
  }
}

private fun count(n: Int) = if (n > 9) "9+" else n.toString()

@Composable
private fun Badge(
  text: String,
  bg: Color,
  ink: Color,
  shape: androidx.compose.ui.graphics.Shape,
  size: Dp,
  fontScale: Float,
  modifier: Modifier,
) {
  Box(
    modifier.size(size).border(1.5.dp, ForgeColors.Surface, shape).background(bg, shape),
    contentAlignment = androidx.compose.ui.Alignment.Center,
  ) {
    Text(
      text,
      style = TextStyle(
        color = ink, fontSize = (11f * fontScale).sp, fontWeight = FontWeight.Black,
        textAlign = TextAlign.Center, lineHeight = (11f * fontScale).sp,
      ),
    )
  }
}
