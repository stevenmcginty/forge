package com.forge.bubble.ui

import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.size
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.drawWithCache
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.RoundRect
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import kotlin.math.cos
import kotlin.math.sin

/*
 * The Forge mark, from the PWA icon (web/public/icons/icon-512.png): a heavy
 * rounded "F" with a four-point spark on its top bar's end. Proportions are
 * the icon's own, measured on its 512 grid (F box 268 x 292, stem 96, bars 82,
 * middle bar from 128 down and 232 across, corners 16).
 */

private const val F_W = 268f / 292f
private const val F_STEM = 96f / 292f
private const val F_BAR = 82f / 292f
private const val F_MID_TOP = 128f / 292f
private const val F_MID_W = 232f / 292f
private const val F_CORNER = 16f / 292f

/** Width of an F drawn [height] tall. */
fun forgeFWidth(height: Float) = height * F_W

/** Adds the F, [height] tall, with its box centred on ([cx], [cy]). */
fun Path.addForgeF(cx: Float, cy: Float, height: Float) {
  val w = height * F_W
  val l = cx - w / 2f
  val t = cy - height / 2f
  val cr = CornerRadius(height * F_CORNER)
  addRoundRect(RoundRect(l, t, l + height * F_STEM, t + height, cr))
  addRoundRect(RoundRect(l, t, l + w, t + height * F_BAR, cr))
  val mt = t + height * F_MID_TOP
  addRoundRect(RoundRect(l, mt, l + height * F_MID_W, mt + height * F_BAR, cr))
}

/** Adds a four-point spark of outer radius [r] centred on ([cx], [cy]). */
fun Path.addSpark(cx: Float, cy: Float, r: Float) {
  val inner = r * 0.3f
  for (i in 0 until 8) {
    val a = Math.toRadians(-90.0 + i * 45.0)
    val rr = if (i % 2 == 0) r else inner
    val x = cx + (rr * cos(a)).toFloat()
    val y = cy + (rr * sin(a)).toFloat()
    if (i == 0) moveTo(x, y) else lineTo(x, y)
  }
  close()
}

/** The F alone, in [color], sized to [size] tall; the spark is optional. */
@Composable
fun ForgeMark(
  modifier: Modifier = Modifier,
  size: Dp = 18.dp,
  color: Color = ForgeColors.Accent,
  spark: Color? = null,
) {
  Spacer(
    modifier.size(size).drawWithCache {
      val h = this.size.minDimension * 0.86f
      val center = Offset(this.size.width / 2f, this.size.height / 2f)
      val f = Path().apply { addForgeF(center.x - h * 0.04f, center.y, h) }
      val s = spark?.let {
        Path().apply {
          addSpark(center.x - h * 0.04f + forgeFWidth(h) / 2f, center.y - h * 0.4f, h * 0.2f)
        }
      }
      onDrawBehind {
        drawPath(f, color)
        if (s != null && spark != null) drawPath(s, spark)
      }
    },
  )
}
