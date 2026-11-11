package com.forge.bubble.ui

import android.graphics.Paint
import android.graphics.RectF
import android.view.HapticFeedbackConstants
import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.Spring
import androidx.compose.animation.core.spring
import androidx.compose.foundation.layout.Box
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.draw.drawWithCache
import androidx.compose.ui.draw.drawWithContent
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Rect
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.drawscope.clipRect
import androidx.compose.ui.graphics.drawscope.drawIntoCanvas
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.graphics.lerp
import androidx.compose.ui.graphics.nativeCanvas
import androidx.compose.ui.graphics.toArgb
import androidx.compose.ui.layout.boundsInWindow
import androidx.compose.ui.layout.onGloballyPositioned
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.unit.dp
import kotlin.math.min

/** The bubble's radius and the panel's corner: equal, so a bubble IS a tiny panel. */
private val ORB = 28.dp

/**
 * The bubble opening into the panel. One glass shape is drawn from the
 * bubble's spot on screen ([from], screen px; null = the default right-edge
 * spot) out to this composable's own bounds; on the way it starts lime, the
 * bubble's "awake", and settles into dark glass, and the content fades up
 * inside it, clipped to it. Closing runs it back into the bubble's spot, then
 * [onClosed]. A critically damped spring, no overshoot; with "Remove
 * animations" on it simply appears and goes.
 *
 * A light shade rises from the bottom of the screen behind it, so the panel
 * reads on a white app while the top of the screen stays see-through.
 */
@Composable
fun MorphPanel(
  from: Offset?,
  open: Boolean,
  onClosed: () -> Unit,
  modifier: Modifier = Modifier,
  panelModifier: Modifier = Modifier,
  content: @Composable () -> Unit,
) {
  val view = LocalView.current
  val density = LocalDensity.current
  val orb = with(density) { ORB.toPx() }
  val t = remember { Animatable(0f) }
  var bounds by remember { mutableStateOf<Rect?>(null) }
  // The bubble's centre, in this window's coordinates.
  var origin by remember { mutableStateOf(Offset.Zero) }
  val closed = rememberUpdatedState(onClosed)
  val opening = rememberUpdatedState(open)

  LaunchedEffect(open, bounds != null) {
    if (bounds == null) return@LaunchedEffect
    val motion = ForgeMotion.enabled()
    if (open) {
      view.performHapticFeedback(HapticFeedbackConstants.CONTEXT_CLICK)
      if (motion) t.animateTo(1f, spring(Spring.DampingRatioNoBouncy, 380f)) else t.snapTo(1f)
    } else {
      if (motion) t.animateTo(0f, spring(Spring.DampingRatioNoBouncy, 650f)) else t.snapTo(0f)
      closed.value()
    }
  }

  val body = remember {
    Paint(Paint.ANTI_ALIAS_FLAG).apply {
      style = Paint.Style.FILL
      setShadowLayer(with(density) { 22.dp.toPx() }, 0f, with(density) { 8.dp.toPx() }, 0x73000000)
    }
  }
  val rim = remember {
    Paint(Paint.ANTI_ALIAS_FLAG).apply {
      style = Paint.Style.STROKE
      strokeWidth = with(density) { 1.dp.toPx() }
      color = 0x1FFFFFFF
    }
  }
  val box = remember { RectF() }
  val surface = remember { ForgeColors.Surface.toArgb() }

  // Where the glass is at progress p, in this composable's own coordinates.
  fun blob(p: Float, w: Float, h: Float, out: RectF) {
    val b = bounds ?: return
    val bx = origin.x - b.left
    val by = origin.y - b.top
    out.set(
      (bx - orb) + (0f - (bx - orb)) * p,
      (by - orb) + (0f - (by - orb)) * p,
      (bx + orb) + (w - (bx + orb)) * p,
      (by + orb) + (h - (by + orb)) * p,
    )
  }

  Box(
    modifier.drawWithCache {
      val shade = Brush.verticalGradient(
        0f to Color.Transparent, 0.38f to Color.Transparent, 1f to Color.Black.copy(alpha = 0.42f),
      )
      onDrawBehind { drawRect(shade, alpha = t.value.coerceIn(0f, 1f)) }
    },
    contentAlignment = Alignment.BottomCenter,
  ) {
    Box(
      panelModifier
        .onGloballyPositioned { c ->
          val r = c.boundsInWindow()
          // The panel's window fills the screen from (0, 0), so screen px are
          // window px. (Its on-screen location is not used: while a system
          // transition moves the window it reads hundreds of px off.)
          origin = if (from != null) {
            from
          } else {
            val dm = view.resources.displayMetrics
            Offset(view.width - 32f * dm.density, view.height * 0.35f + 32f * dm.density)
          }
          bounds = r
        }
        .drawBehind {
          if (bounds == null) return@drawBehind
          val p = t.value
          if (p <= 0f && !opening.value) return@drawBehind
          blob(p, size.width, size.height, box)
          val corner = min(orb, min(box.width(), box.height()) / 2f)
          // Opening: the bubble's lime wakes, then cools into glass by mid-flight.
          val lime = if (opening.value) (1f - p / 0.55f).coerceIn(0f, 1f) else 0f
          body.color = if (lime > 0f) lerp(ForgeColors.Surface, ForgeColors.Accent, lime).toArgb() else surface
          drawIntoCanvas { cv ->
            cv.nativeCanvas.drawRoundRect(box, corner, corner, body)
            cv.nativeCanvas.drawRoundRect(box, corner, corner, rim)
          }
        },
    ) {
      Box(
        Modifier
          .graphicsLayer {
            val a = ((t.value - 0.55f) / 0.45f).coerceIn(0f, 1f)
            alpha = a
            translationY = (1f - a) * 10.dp.toPx()
          }
          .drawWithContent {
            if (bounds == null) return@drawWithContent
            blob(t.value, size.width, size.height, box)
            clipRect(box.left, box.top, box.right, box.bottom) { this@drawWithContent.drawContent() }
          },
      ) { content() }
    }
  }
}
