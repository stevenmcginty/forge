package com.forge.bubble.ui

import android.view.HapticFeedbackConstants
import androidx.compose.animation.AnimatedContent
import androidx.compose.animation.core.Spring
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.spring
import androidx.compose.animation.core.tween
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.scaleIn
import androidx.compose.animation.scaleOut
import androidx.compose.animation.togetherWith
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.defaultMinSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Text
import androidx.compose.material3.ripple
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.drawWithCache
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.StrokeJoin
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.forge.bubble.talk.CardUi
import com.forge.bubble.talk.PanelUi
import com.forge.bubble.talk.TalkState
import kotlin.math.min
import kotlin.math.sqrt

/** The bubble face that stands for a talk state, so the panel and the bubble match. */
fun TalkState.face(): BubbleState = when (this) {
  TalkState.Idle -> BubbleState.Idle
  TalkState.Listening -> BubbleState.Listening
  TalkState.Thinking -> BubbleState.Thinking
  TalkState.Speaking -> BubbleState.Speaking
  TalkState.Offline -> BubbleState.Offline
}

private val GUTTER = 16.dp
private val HIT = 48.dp

/**
 * The pop-out panel, drawn inside the bubble's own glass (see [MorphPanel]):
 *  1. the live face and the state's word, the counts as shape + number + word,
 *     "Open Forge" and Close;
 *  2. what was heard ("You") and the reply ("Forge"), then up to three cards,
 *     scrolling if the panel would pass half the screen;
 *  3. the text box and the mic: on = a lime disc with bars that move with the
 *     voice, off = a hollow ring with the mic struck through.
 * Light haptics on "heard" and "done"; the opening one is the morph's.
 */
@Composable
fun TalkPanel(
  ui: PanelUi,
  onMicTap: () -> Unit,
  onTyped: (String) -> Unit,
  onCardAction: (cardId: String, action: String) -> Unit,
  onClose: () -> Unit,
  onOpenForge: () -> Unit,
  modifier: Modifier = Modifier,
) {
  Haptics(ui)
  Column(modifier.fillMaxWidth().padding(top = 12.dp, bottom = 12.dp)) {
    Header(ui, onOpenForge, onClose)
    val scroll = rememberScrollState()
    Column(
      Modifier
        .weight(1f, fill = false)
        .fadeBottomWhen { scroll.canScrollForward }
        .verticalScroll(scroll)
        .padding(horizontal = GUTTER),
      verticalArrangement = Arrangement.spacedBy(10.dp),
    ) {
      Spacer(Modifier.height(2.dp))
      Transcript(ui)
      ui.cards.take(3).forEach { Card(it, onCardAction) }
      Spacer(Modifier.height(2.dp))
    }
    Footer(ui, onMicTap, onTyped)
  }
}

/* ----------------------------------------------------------------- header */

@Composable
private fun Header(ui: PanelUi, onOpenForge: () -> Unit, onClose: () -> Unit) {
  Row(
    Modifier.fillMaxWidth().padding(start = GUTTER - 4.dp, end = GUTTER - 10.dp),
    verticalAlignment = Alignment.CenterVertically,
  ) {
    BubbleFace(ui.state.face(), ui.level, 0, 0, size = 44.dp)
    Spacer(Modifier.width(8.dp))
    Column(Modifier.weight(1f)) {
      AnimatedContent(
        targetState = ui.state.face().word(),
        transitionSpec = {
          (fadeIn(tween(ForgeMotion.BASE)) + scaleIn(tween(ForgeMotion.BASE), initialScale = 0.92f))
            .togetherWith(fadeOut(tween(ForgeMotion.FAST)))
        },
        label = "word",
      ) { w ->
        Text(w, style = TextStyle(color = ForgeColors.Text, fontSize = 20.sp, fontWeight = FontWeight.SemiBold, lineHeight = 24.sp))
      }
      Counts(ui.working, ui.needsYou)
    }
    Pill(onClick = onOpenForge, label = "Open Forge") {
      ForgeMark(size = 16.dp, color = ForgeColors.Accent, spark = ForgeColors.AccentCore)
      Spacer(Modifier.width(6.dp))
      Text("Open", style = TextStyle(color = ForgeColors.Text, fontSize = 14.sp, fontWeight = FontWeight.Medium))
    }
    IconHit(onClick = onClose, label = "Close") { CloseGlyph() }
  }
}

/** "2 working · 1 needs you", each with its own shape: a ring for jobs, a "!" square for you. */
@Composable
private fun Counts(working: Int, needsYou: Int) {
  Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.height(18.dp)) {
    if (working == 0 && needsYou == 0) {
      Text("Forge", style = small(ForgeColors.TextFaint))
      return@Row
    }
    if (working > 0) {
      Box(Modifier.size(9.dp).border(1.8.dp, ForgeColors.Accent, CircleShape))
      Spacer(Modifier.width(5.dp))
      Text("$working working", style = small(ForgeColors.TextDim), maxLines = 1)
    }
    if (working > 0 && needsYou > 0) Text("  ·  ", style = small(ForgeColors.TextFaint))
    if (needsYou > 0) {
      Box(
        Modifier.size(13.dp).background(ForgeColors.Attn, RoundedCornerShape(3.dp)),
        contentAlignment = Alignment.Center,
      ) { Text("!", style = TextStyle(color = ForgeColors.OnAttn, fontSize = 10.sp, fontWeight = FontWeight.Black, lineHeight = 10.sp)) }
      Spacer(Modifier.width(5.dp))
      Text("$needsYou needs you", style = small(ForgeColors.TextDim), maxLines = 1)
    }
  }
}

/* ------------------------------------------------------------- transcript */

@Composable
private fun Transcript(ui: PanelUi) {
  ui.notice?.let { n ->
    Row(verticalAlignment = Alignment.CenterVertically) {
      Box(
        Modifier.size(20.dp).border(1.6.dp, ForgeColors.Attn, CircleShape),
        contentAlignment = Alignment.Center,
      ) { Text("!", style = TextStyle(color = ForgeColors.Attn, fontSize = 12.sp, fontWeight = FontWeight.Black, lineHeight = 12.sp)) }
      Spacer(Modifier.width(10.dp))
      Text(n, style = TextStyle(color = ForgeColors.Text, fontSize = 15.sp, lineHeight = 20.sp))
    }
  }
  if (ui.heard.isNotEmpty()) Said("You", ui.heard, mine = true, compact = ui.cards.isNotEmpty())
  if (ui.reply.isNotEmpty()) Said("Forge", ui.reply, mine = false, compact = ui.cards.isNotEmpty())
  if (ui.heard.isEmpty() && ui.reply.isEmpty() && ui.notice == null && ui.cards.isEmpty()) {
    val hint = when (ui.state) {
      TalkState.Listening -> "Go ahead. Forge is listening."
      TalkState.Idle -> "The mic is off. Tap the mic, or type."
      TalkState.Thinking -> "One moment."
      TalkState.Speaking -> ""
      TalkState.Offline -> "Forge can't be reached right now."
    }
    if (hint.isNotEmpty()) Text(hint, style = TextStyle(color = ForgeColors.TextFaint, fontSize = 15.sp, lineHeight = 20.sp))
  }
}

/** One line of the talk: a speaker tag (a word, never colour alone) and the words. */
@Composable
private fun Said(who: String, text: String, mine: Boolean, compact: Boolean) {
  Row(verticalAlignment = Alignment.Top) {
    Box(
      Modifier
        .padding(top = if (mine) 1.dp else 2.dp)
        .height(18.dp)
        .border(1.dp, if (mine) ForgeColors.Outline else ForgeColors.Accent.copy(alpha = 0.7f), CircleShape)
        .padding(horizontal = 7.dp),
      contentAlignment = Alignment.Center,
    ) { Text(who, style = TextStyle(color = ForgeColors.TextDim, fontSize = 11.sp, fontWeight = FontWeight.SemiBold, lineHeight = 11.sp)) }
    Spacer(Modifier.width(10.dp))
    Text(
      text,
      style = if (mine) TextStyle(color = ForgeColors.TextDim, fontSize = 15.sp, lineHeight = 20.sp)
      else TextStyle(color = ForgeColors.Text, fontSize = 17.sp, lineHeight = 23.sp),
      maxLines = if (compact) (if (mine) 1 else 2) else Int.MAX_VALUE,
      overflow = TextOverflow.Ellipsis,
    )
  }
}

/* ------------------------------------------------------------------ cards */

@Composable
private fun Card(card: CardUi, onAction: (String, String) -> Unit) {
  Row(
    Modifier
      .fillMaxWidth()
      .background(ForgeColors.SurfaceHigh, RoundedCornerShape(18.dp))
      .border(
        1.dp,
        if (card.kind == "needs-you") ForgeColors.Attn.copy(alpha = 0.45f) else ForgeColors.Outline,
        RoundedCornerShape(18.dp),
      )
      .padding(start = 12.dp, end = 8.dp, top = 8.dp, bottom = 8.dp),
    verticalAlignment = Alignment.CenterVertically,
  ) {
    KindMark(card.kind)
    Spacer(Modifier.width(10.dp))
    Column(Modifier.weight(1f)) {
      Text(
        card.title, maxLines = 1, overflow = TextOverflow.Ellipsis,
        style = TextStyle(color = ForgeColors.Text, fontSize = 15.sp, fontWeight = FontWeight.SemiBold, lineHeight = 20.sp),
      )
      val line = if (card.state.isNotEmpty()) "${card.state} · ${card.line}" else card.line
      Text(
        line, maxLines = 2, overflow = TextOverflow.Ellipsis,
        style = TextStyle(color = ForgeColors.TextDim, fontSize = 13.sp, lineHeight = 17.sp),
      )
    }
    Spacer(Modifier.width(6.dp))
    Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
      card.actions.take(2).forEachIndexed { i, a ->
        ActionButton(a, primary = i == 0) { onAction(card.id, a) }
      }
    }
  }
}

/** The card's kind as a shape: "!" square = needs you, "?" circle = a yes/no, a ring = a job. */
@Composable
private fun KindMark(kind: String) {
  when (kind) {
    "needs-you" -> Box(
      Modifier.size(26.dp).background(ForgeColors.Attn, RoundedCornerShape(7.dp)),
      contentAlignment = Alignment.Center,
    ) { Text("!", style = TextStyle(color = ForgeColors.OnAttn, fontSize = 15.sp, fontWeight = FontWeight.Black, lineHeight = 15.sp)) }
    "confirm" -> Box(
      Modifier.size(26.dp).border(1.8.dp, ForgeColors.Accent, CircleShape),
      contentAlignment = Alignment.Center,
    ) { Text("?", style = TextStyle(color = ForgeColors.Accent, fontSize = 14.sp, fontWeight = FontWeight.Black, lineHeight = 14.sp)) }
    else -> Box(Modifier.size(26.dp), contentAlignment = Alignment.Center) {
      Box(Modifier.size(16.dp).border(2.dp, ForgeColors.TextDim, CircleShape))
    }
  }
}

@Composable
private fun ActionButton(label: String, primary: Boolean, onClick: () -> Unit) {
  val danger = label.equals("Stop", true) || label.equals("No", true) || label.equals("Dismiss", true)
  val fill = primary && !danger
  Box(
    Modifier
      .defaultMinSize(minWidth = 52.dp, minHeight = HIT)
      .clip(CircleShape)
      .clickable(role = Role.Button, onClick = onClick)
      .padding(vertical = 4.dp),
    contentAlignment = Alignment.Center,
  ) {
    Box(
      Modifier
        .height(40.dp)
        .defaultMinSize(minWidth = 52.dp)
        .then(
          if (fill) Modifier.background(ForgeColors.Accent, CircleShape)
          else Modifier.border(1.dp, ForgeColors.Outline, CircleShape).background(ForgeColors.Press.copy(alpha = 0.6f), CircleShape),
        )
        .padding(horizontal = 14.dp),
      contentAlignment = Alignment.Center,
    ) {
      Text(
        label, maxLines = 1,
        style = TextStyle(
          color = if (fill) ForgeColors.OnAccent else ForgeColors.Text,
          fontSize = 14.sp, fontWeight = FontWeight.SemiBold, lineHeight = 16.sp,
        ),
      )
    }
  }
}

/* ----------------------------------------------------------------- footer */

@Composable
private fun Footer(ui: PanelUi, onMicTap: () -> Unit, onTyped: (String) -> Unit) {
  var typed by remember { mutableStateOf("") }
  val send = { if (typed.isNotBlank()) { onTyped(typed); typed = "" } }
  Row(
    Modifier.fillMaxWidth().padding(start = GUTTER - 4.dp, end = GUTTER - 6.dp, top = 8.dp),
    verticalAlignment = Alignment.CenterVertically,
  ) {
    BasicTextField(
      value = typed,
      onValueChange = { typed = it },
      singleLine = true,
      textStyle = TextStyle(color = ForgeColors.Text, fontSize = 16.sp),
      cursorBrush = SolidColor(ForgeColors.Accent),
      keyboardOptions = KeyboardOptions(imeAction = ImeAction.Send),
      keyboardActions = KeyboardActions(onSend = { send() }),
      modifier = Modifier.weight(1f).height(52.dp),
      decorationBox = { field ->
        Box(
          Modifier
            .background(ForgeColors.SurfaceHigh, CircleShape)
            .border(1.dp, ForgeColors.Outline, CircleShape)
            .padding(horizontal = 18.dp),
          contentAlignment = Alignment.CenterStart,
        ) {
          if (typed.isEmpty()) Text("Type to Forge", style = TextStyle(color = ForgeColors.TextFaint, fontSize = 16.sp))
          field()
        }
      },
    )
    Spacer(Modifier.width(6.dp))
    if (typed.isNotBlank()) {
      RoundHit(onClick = send, label = "Send") {
        Box(Modifier.size(48.dp).background(ForgeColors.Accent, CircleShape), contentAlignment = Alignment.Center) {
          SendGlyph()
        }
      }
    } else {
      MicButton(on = ui.state == TalkState.Listening, level = ui.level, onClick = onMicTap)
    }
  }
}

/** On: a lime disc, dark mic, a halo that swells with the voice. Off: a hollow ring, the mic struck through. */
@Composable
private fun MicButton(on: Boolean, level: Float, onClick: () -> Unit) {
  val motion = remember(on) { ForgeMotion.enabled() }
  val v = animateFloatAsState(
    if (on && motion) sqrt(min(1f, level.coerceIn(0f, 1f) * 4f)) else 0f,
    spring(Spring.DampingRatioNoBouncy, 260f), label = "mic",
  )
  RoundHit(onClick = onClick, label = if (on) "Mic on. Tap to pause." else "Mic off. Tap to listen.") {
    Box(
      Modifier.size(52.dp).drawWithCache {
        val r = size.minDimension / 2f - 2.dp.toPx()
        val ring = Stroke(width = 2.dp.toPx())
        onDrawBehind {
          if (on) {
            drawCircle(ForgeColors.Accent, r * (1.02f + 0.1f * v.value), style = ring, alpha = 0.25f + 0.55f * v.value)
          }
        }
      },
      contentAlignment = Alignment.Center,
    ) {
      AnimatedContent(
        targetState = on,
        transitionSpec = { fadeIn(tween(ForgeMotion.BASE)) + scaleIn(initialScale = 0.8f) togetherWith fadeOut(tween(ForgeMotion.FAST)) + scaleOut(targetScale = 0.9f) },
        label = "mic",
      ) { isOn ->
        Box(
          Modifier
            .size(46.dp)
            .then(
              if (isOn) Modifier.background(ForgeColors.Accent, CircleShape)
              else Modifier.border(1.5.dp, ForgeColors.TextFaint, CircleShape),
            ),
          contentAlignment = Alignment.Center,
        ) { MicGlyph(ink = if (isOn) ForgeColors.OnAccent else ForgeColors.TextDim, struck = !isOn) }
      }
    }
  }
}

/* ---------------------------------------------------------------- pieces */

/** A 48 dp round touch target around a smaller drawing. */
@Composable
private fun RoundHit(onClick: () -> Unit, label: String, content: @Composable () -> Unit) {
  Box(
    Modifier
      .size(52.dp)
      .semantics { contentDescription = label }
      .clickable(role = Role.Button, onClick = onClick, interactionSource = null, indication = ripple(bounded = false, radius = 26.dp)),
    contentAlignment = Alignment.Center,
  ) { content() }
}

@Composable
private fun IconHit(onClick: () -> Unit, label: String, content: @Composable () -> Unit) {
  Box(
    Modifier.size(HIT).semantics { contentDescription = label }
      .clickable(role = Role.Button, onClick = onClick, interactionSource = null, indication = ripple(bounded = false, radius = 22.dp)),
    contentAlignment = Alignment.Center,
  ) {
    Box(Modifier.size(36.dp).background(ForgeColors.SurfaceHigh, CircleShape), contentAlignment = Alignment.Center) { content() }
  }
}

@Composable
private fun Pill(onClick: () -> Unit, label: String, content: @Composable () -> Unit) {
  Box(
    Modifier
      .height(HIT)
      .semantics(mergeDescendants = true) { contentDescription = label }
      .clip(CircleShape)
      .clickable(role = Role.Button, onClick = onClick),
    contentAlignment = Alignment.Center,
  ) {
    Row(
      Modifier
        .height(36.dp)
        .background(ForgeColors.SurfaceHigh, CircleShape)
        .border(1.dp, ForgeColors.Outline, CircleShape)
        .padding(start = 10.dp, end = 13.dp),
      verticalAlignment = Alignment.CenterVertically,
    ) { content() }
  }
}

@Composable
private fun CloseGlyph() {
  Box(
    Modifier.size(14.dp).drawWithCache {
      val s = Stroke(width = 2.dp.toPx(), cap = StrokeCap.Round)
      onDrawBehind {
        drawLine(ForgeColors.TextDim, Offset(0f, 0f), Offset(size.width, size.height), s.width, StrokeCap.Round)
        drawLine(ForgeColors.TextDim, Offset(size.width, 0f), Offset(0f, size.height), s.width, StrokeCap.Round)
      }
    },
  )
}

@Composable
private fun SendGlyph() {
  Box(
    Modifier.size(20.dp).drawWithCache {
      val w = size.width
      val p = Path().apply {
        moveTo(w * 0.5f, w * 0.85f); lineTo(w * 0.5f, w * 0.15f)
        moveTo(w * 0.2f, w * 0.45f); lineTo(w * 0.5f, w * 0.15f); lineTo(w * 0.8f, w * 0.45f)
      }
      val s = Stroke(width = 2.4.dp.toPx(), cap = StrokeCap.Round, join = StrokeJoin.Round)
      onDrawBehind { drawPath(p, ForgeColors.OnAccent, style = s) }
    },
  )
}

@Composable
private fun MicGlyph(ink: Color, struck: Boolean) {
  Box(
    Modifier.size(22.dp).drawWithCache {
      val w = size.width
      val s = Stroke(width = 2.dp.toPx(), cap = StrokeCap.Round, join = StrokeJoin.Round)
      val cup = Path().apply {
        moveTo(w * 0.22f, w * 0.46f)
        cubicTo(w * 0.22f, w * 0.78f, w * 0.78f, w * 0.78f, w * 0.78f, w * 0.46f)
        moveTo(w * 0.5f, w * 0.74f); lineTo(w * 0.5f, w * 0.92f)
      }
      onDrawBehind {
        drawRoundRect(ink, Offset(w * 0.36f, w * 0.06f), Size(w * 0.28f, w * 0.52f), CornerRadius(w * 0.14f))
        drawPath(cup, ink, style = s)
        if (struck) {
          drawLine(ForgeColors.SurfaceHigh, Offset(w * 0.1f, w * 0.1f), Offset(w * 0.9f, w * 0.9f), 5.dp.toPx(), StrokeCap.Round)
          drawLine(ink, Offset(w * 0.12f, w * 0.12f), Offset(w * 0.88f, w * 0.88f), 2.dp.toPx(), StrokeCap.Round)
        }
      }
    },
  )
}

/** Fades the last 20 dp out while there is more to scroll, so the cut reads as "more below". */
private fun Modifier.fadeBottomWhen(more: () -> Boolean): Modifier = this
  .graphicsLayer { compositingStrategy = androidx.compose.ui.graphics.CompositingStrategy.Offscreen }
  .drawWithCache {
    val fade = Brush.verticalGradient(
      0f to Color.Black, 1f to Color.Transparent,
      startY = size.height - 20.dp.toPx(), endY = size.height,
    )
    onDrawWithContent {
      drawContent()
      if (more()) drawRect(fade, blendMode = androidx.compose.ui.graphics.BlendMode.DstIn)
    }
  }

private fun small(c: Color) = TextStyle(color = c, fontSize = 13.sp, lineHeight = 16.sp)

/* ---------------------------------------------------------------- haptics */

/** Light haptics: a tick when Forge has heard you, a confirm when it finishes speaking. */
@Composable
private fun Haptics(ui: PanelUi) {
  val view = LocalView.current
  val heard = rememberUpdatedState(ui.heard)
  var lastHeard by remember { mutableStateOf(ui.heard) }
  var lastState by remember { mutableStateOf(ui.state) }
  LaunchedEffect(ui.heard) {
    if (heard.value.isNotEmpty() && heard.value != lastHeard) view.performHapticFeedback(HapticFeedbackConstants.CLOCK_TICK)
    lastHeard = heard.value
  }
  LaunchedEffect(ui.state) {
    if (lastState == TalkState.Speaking && ui.state != TalkState.Speaking) {
      view.performHapticFeedback(HapticFeedbackConstants.CONFIRM)
    }
    lastState = ui.state
  }
}
