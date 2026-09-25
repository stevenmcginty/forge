package com.forge.watch

import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.Spring
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.spring
import androidx.compose.animation.core.tween
import androidx.compose.animation.expandHorizontally
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.shrinkHorizontally
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.wrapContentHeight
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.Send
import androidx.compose.material.icons.filled.ArrowDropDown
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.clipToBounds
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.draw.drawWithContent
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.BlendMode
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.CompositingStrategy
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.layout.onSizeChanged
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.wear.compose.foundation.CurvedDirection
import androidx.wear.compose.foundation.CurvedLayout
import androidx.wear.compose.foundation.LocalReduceMotion
import androidx.wear.compose.foundation.curvedComposable
import androidx.wear.compose.material3.ButtonDefaults
import androidx.wear.compose.material3.CompactButton
import androidx.wear.compose.material3.Icon
import androidx.wear.compose.material3.Text
import androidx.wear.compose.material3.curvedText

/** The microphone as the screen shows it. Each one has its own word and its own shape. */
enum class Mic { LISTENING, IDLE, OFF }

/** Everything the voice screen shows, already in words. */
data class VoiceUi(
    /** Where the words go, or why they can't: the top rim. */
    val status: String,
    /** True when a desktop pane is on the other end. */
    val live: Boolean,
    val mic: Mic,
    /** Mic level 0..1. */
    val level: Float,
    /** Caught and in the draft. */
    val draft: String,
    /** Being spoken right now, not caught yet. */
    val partial: String,
    /** One line about the last thing that happened. */
    val notice: String,
) {
    val words: Int get() = Regex("""\S+""").findAll(draft).count()
}

/**
 * The voice screen on a round face.
 *
 * The two rims are state: the top says where the words go, the bottom says
 * whether the mic is hearing. Between them are the words, then the controls.
 * Nothing scrolls; a long draft keeps its newest lines and fades out at the top.
 */
@Composable
fun VoiceScreen(
    ui: VoiceUi,
    onMic: () -> Unit,
    onSend: () -> Unit,
    onClear: () -> Unit,
    onStatus: () -> Unit,
    onSettings: () -> Unit,
) {
    Box(Modifier.fillMaxSize().background(Color.Black)) {
        StatusRim(ui.status, ui.live)
        // The rim is too thin to hit; this is its tap target.
        Box(
            Modifier
                .align(Alignment.TopCenter)
                .size(width = 136.dp, height = 48.dp)
                .clip(RoundedCornerShape(bottomStart = 22.dp, bottomEnd = 22.dp))
                .combinedClickable(
                    onClickLabel = stringResource(R.string.status_tap),
                    onLongClickLabel = stringResource(R.string.settings),
                    onLongClick = onSettings,
                    onClick = onStatus,
                ),
        )
        Column(
            Modifier.fillMaxSize().padding(top = 42.dp, bottom = 24.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            Words(ui, Modifier.weight(1f).fillMaxWidth(0.78f))
            Text(
                text = ui.notice,
                modifier = Modifier.fillMaxWidth(0.74f).padding(top = 2.dp),
                color = Forge.Lime,
                fontSize = 11.sp,
                lineHeight = 13.sp,
                fontWeight = FontWeight.Medium,
                textAlign = TextAlign.Center,
                maxLines = 2,
                overflow = TextOverflow.Ellipsis,
            )
            Row(
                Modifier.height(58.dp),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.Center,
            ) {
                MicButton(ui.mic, ui.level, onMic)
                AnimatedVisibility(
                    visible = ui.words > 0,
                    enter = fadeIn() + expandHorizontally(expandFrom = Alignment.Start),
                    exit = fadeOut() + shrinkHorizontally(shrinkTowards = Alignment.Start),
                ) {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Spacer(Modifier.width(6.dp))
                        SendButton(ui.words, onSend, onClear)
                    }
                }
            }
        }
        MicRim(ui.mic)
    }
}

/** Desktop · project · tab along the top of the bezel. A solid dot is live, a hollow ring is not. */
@Composable
private fun StatusRim(status: String, live: Boolean) {
    CurvedLayout(Modifier.fillMaxSize().padding(6.dp), anchor = 270f) {
        curvedComposable(rotationLocked = true) {
            Box(
                Modifier
                    .padding(end = 4.dp)
                    .size(6.dp)
                    .clip(CircleShape)
                    .then(
                        if (live) Modifier.background(Forge.Lime)
                        else Modifier.border(1.2.dp, Forge.Muted, CircleShape),
                    ),
            )
        }
        curvedText(
            text = status,
            color = if (live) Forge.Ink else Forge.Muted,
            fontSize = 11.sp,
            fontWeight = FontWeight.Medium,
            maxSweepAngle = 92f,
            overflow = TextOverflow.Ellipsis,
        )
        if (live) {
            curvedComposable(rotationLocked = true) {
                Icon(
                    Icons.Filled.ArrowDropDown,
                    contentDescription = null,
                    tint = Forge.Muted,
                    modifier = Modifier.size(14.dp),
                )
            }
        }
    }
}

/** The mic's state in a word, along the bottom of the bezel. */
@Composable
private fun MicRim(mic: Mic) {
    val (word, color) = when (mic) {
        Mic.LISTENING -> stringResource(R.string.mic_listening) to Forge.Lime
        Mic.IDLE -> stringResource(R.string.mic_paused) to Forge.Muted
        Mic.OFF -> stringResource(R.string.mic_off) to Forge.Muted
    }
    CurvedLayout(
        Modifier.fillMaxSize().padding(6.dp),
        anchor = 90f,
        angularDirection = CurvedDirection.Angular.Reversed,
    ) {
        curvedText(
            text = word,
            color = color,
            fontSize = 10.sp,
            fontWeight = FontWeight.SemiBold,
            letterSpacing = 1.5.sp,
            letterSpacingCounterClockwise = 1.5.sp,
        )
    }
}

/**
 * The draft in white, the phrase still being spoken in grey italic under it.
 * When the grey turns white, it landed. Pinned to the bottom so the newest
 * words are always in view; older lines fade out at the top.
 */
@Composable
private fun Words(ui: VoiceUi, modifier: Modifier) {
    var room by remember { mutableIntStateOf(0) }
    var needed by remember { mutableIntStateOf(0) }
    Box(
        modifier
            .onSizeChanged { room = it.height }
            .clipToBounds()
            .then(if (needed > room) FadeTop else Modifier),
        contentAlignment = Alignment.BottomCenter,
    ) {
        Column(
            Modifier
                .fillMaxWidth()
                .wrapContentHeight(Alignment.Bottom, unbounded = true)
                .onSizeChanged { needed = it.height },
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            if (ui.draft.isBlank() && ui.partial.isBlank()) {
                Text(
                    text = when (ui.mic) {
                        Mic.LISTENING -> stringResource(R.string.hint_listening)
                        Mic.IDLE -> stringResource(R.string.hint_idle)
                        Mic.OFF -> stringResource(R.string.hint_off)
                    },
                    color = Forge.Muted,
                    fontSize = 12.sp,
                    lineHeight = 15.sp,
                    textAlign = TextAlign.Center,
                )
            }
            if (ui.draft.isNotBlank()) {
                Text(
                    text = ui.draft.trim(),
                    color = Forge.Ink,
                    fontSize = 13.sp,
                    lineHeight = 16.sp,
                    textAlign = TextAlign.Center,
                )
            }
            if (ui.partial.isNotBlank()) {
                Text(
                    text = ui.partial.trim(),
                    color = Forge.Muted,
                    fontSize = 12.sp,
                    lineHeight = 15.sp,
                    fontStyle = FontStyle.Italic,
                    textAlign = TextAlign.Center,
                )
            }
        }
    }
}

/** Only when the words overflow: the oldest line dissolves instead of being cut in half. */
private val FadeTop = Modifier
    .graphicsLayer(compositingStrategy = CompositingStrategy.Offscreen)
    .drawWithContent {
        drawContent()
        val gone = 8.dp.toPx() / size.height
        val fade = 28.dp.toPx() / size.height
        drawRect(
            Brush.verticalGradient(
                0f to Color.Transparent,
                gone to Color.Transparent,
                fade to Color.Black,
            ),
            blendMode = BlendMode.DstIn,
        )
    }

/**
 * Listening: solid lime disc, with a ring that swells with your voice.
 * Paused: hollow disc, plain mic. Off: hollow disc, struck-through mic.
 */
@Composable
private fun MicButton(mic: Mic, level: Float, onClick: () -> Unit) {
    val listening = mic == Mic.LISTENING
    val clickLabel = stringResource(if (listening) R.string.mic_stop else R.string.mic_start)
    val description = stringResource(
        when (mic) {
            Mic.LISTENING -> R.string.mic_desc_listening
            Mic.IDLE -> R.string.mic_desc_paused
            Mic.OFF -> R.string.mic_desc_off
        },
    )
    val heard by animateFloatAsState(
        targetValue = if (listening) level.coerceIn(0f, 1f) else 0f,
        animationSpec = spring(dampingRatio = 0.7f, stiffness = Spring.StiffnessMediumLow),
        label = "level",
    )
    // A slow breath while the mic is open and the room is quiet, so an open mic never looks idle.
    val still = LocalReduceMotion.current
    val breath = if (listening && !still) {
        rememberInfiniteTransition(label = "breath").animateFloat(
            initialValue = 0f,
            targetValue = 1f,
            animationSpec = infiniteRepeatable(tween(1600), RepeatMode.Reverse),
            label = "breath",
        ).value
    } else 0f

    // The tap target is the whole 56 dp ring; the disc inside it is 40 dp.
    Box(
        Modifier
            .size(56.dp)
            .clip(CircleShape)
            .clickable(role = Role.Button, onClickLabel = clickLabel, onClick = onClick)
            .semantics { contentDescription = description }
            .drawBehind {
                if (!listening) return@drawBehind
                val disc = 20.dp.toPx()
                drawCircle(Forge.Lime.copy(alpha = 0.08f + 0.10f * heard), radius = disc + (2 + 6 * heard).dp.toPx())
                drawCircle(
                    Forge.Lime.copy(alpha = 0.35f + 0.25f * breath + 0.4f * heard),
                    radius = disc + (3 + 4 * heard).dp.toPx(),
                    style = Stroke(width = (1.25f + 1f * heard).dp.toPx()),
                )
            },
        contentAlignment = Alignment.Center,
    ) {
        Box(
            Modifier
                .size(40.dp)
                .clip(CircleShape)
                .background(if (listening) Forge.Lime else Forge.Well)
                .border(1.dp, if (listening) Forge.Lime else Forge.Faint, CircleShape),
            contentAlignment = Alignment.Center,
        ) {
            MicGlyph(
                color = when (mic) {
                    Mic.LISTENING -> Forge.OnLime
                    Mic.IDLE -> Forge.Ink
                    Mic.OFF -> Forge.Muted
                },
                struck = mic == Mic.OFF,
                cut = Forge.Well,
                modifier = Modifier.size(20.dp),
            )
        }
    }
}

/** A microphone drawn on a 24-unit grid; `struck` adds the slash, cut out of the glyph by `cut`. */
@Composable
internal fun MicGlyph(color: Color, struck: Boolean, cut: Color, modifier: Modifier) {
    Canvas(modifier) {
        val u = size.minDimension / 24f
        val line = 1.9f * u
        drawRoundRect(color, Offset(8.6f * u, 2.5f * u), Size(6.8f * u, 11.5f * u), CornerRadius(3.4f * u))
        drawArc(
            color, startAngle = 0f, sweepAngle = 180f, useCenter = false,
            topLeft = Offset(5.5f * u, 4.5f * u), size = Size(13f * u, 13f * u),
            style = Stroke(line, cap = StrokeCap.Round),
        )
        drawLine(color, Offset(12f * u, 17f * u), Offset(12f * u, 21f * u), line, StrokeCap.Round)
        drawLine(color, Offset(8.5f * u, 21f * u), Offset(15.5f * u, 21f * u), line, StrokeCap.Round)
        if (struck) {
            drawLine(cut, Offset(3.5f * u, 2.5f * u), Offset(20.5f * u, 21.5f * u), line * 2.4f, StrokeCap.Round)
            drawLine(color, Offset(3.5f * u, 2.5f * u), Offset(20.5f * u, 21.5f * u), line, StrokeCap.Round)
        }
    }
}

/** Tap to send, long-press to clear. Only here when there is a draft. */
@Composable
private fun SendButton(words: Int, onSend: () -> Unit, onClear: () -> Unit) {
    CompactButton(
        onClick = onSend,
        onLongClick = onClear,
        onLongClickLabel = stringResource(R.string.clear_draft),
        colors = ButtonDefaults.filledTonalButtonColors(
            containerColor = Forge.Well,
            contentColor = Forge.Lime,
            iconColor = Forge.Lime,
        ),
        border = androidx.compose.foundation.BorderStroke(1.dp, Forge.Lime.copy(alpha = 0.55f)),
        icon = {
            Icon(
                Icons.AutoMirrored.Filled.Send,
                contentDescription = null,
                modifier = Modifier.size(14.dp),
            )
        },
        label = {
            Text(stringResource(R.string.send_n, words), fontSize = 12.sp, fontWeight = FontWeight.SemiBold, maxLines = 1)
        },
    )
}
