package com.forge.bubble.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.Button
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.forge.bubble.talk.CardUi
import com.forge.bubble.talk.PanelUi
import com.forge.bubble.talk.TalkState

/** The bubble face that stands for a talk state, so the panel and the bubble match. */
fun TalkState.face(): BubbleState = when (this) {
  TalkState.Idle -> BubbleState.Idle
  TalkState.Listening -> BubbleState.Listening
  TalkState.Thinking -> BubbleState.Thinking
  TalkState.Speaking -> BubbleState.Speaking
  TalkState.Offline -> BubbleState.Offline
}

/**
 * The pop-out panel (placeholder look): state face + word, what was heard,
 * the reply, any cards, the counts, and a row to type or toggle the mic.
 */
@Composable
fun TalkPanel(
  ui: PanelUi,
  onMicTap: () -> Unit,
  onTyped: (String) -> Unit,
  onCardAction: (cardId: String, action: String) -> Unit,
  onClose: () -> Unit,
  modifier: Modifier = Modifier,
) {
  Column(
    modifier
      .fillMaxWidth()
      .background(ForgeColors.Surface, RoundedCornerShape(topStart = 20.dp, topEnd = 20.dp))
      .navigationBarsPadding()
      .padding(16.dp),
    verticalArrangement = Arrangement.spacedBy(10.dp),
  ) {
    Row(verticalAlignment = Alignment.CenterVertically) {
      BubbleFace(ui.state.face(), ui.level, 0, 0, size = 40.dp)
      Spacer(Modifier.width(10.dp))
      Text(ui.state.face().word(), color = ForgeColors.Text, fontSize = 18.sp, fontWeight = FontWeight.SemiBold)
      Spacer(Modifier.weight(1f))
      TextButton(onClick = onClose) { Text("Close", color = ForgeColors.TextDim) }
    }
    ui.notice?.let { Text(it, color = ForgeColors.Accent) }
    if (ui.heard.isNotEmpty()) {
      Text("You", color = ForgeColors.TextDim, fontSize = 12.sp)
      Text(ui.heard, color = ForgeColors.Text)
    }
    if (ui.reply.isNotEmpty()) {
      Text("Forge", color = ForgeColors.TextDim, fontSize = 12.sp)
      Text(ui.reply, color = ForgeColors.Text)
    }
    ui.cards.forEach { Card(it, onCardAction) }
    Text("Working: ${ui.working}   Needs you: ${ui.needsYou}", color = ForgeColors.TextDim, fontSize = 13.sp)
    var typed by remember { mutableStateOf("") }
    Row(verticalAlignment = Alignment.CenterVertically) {
      OutlinedTextField(
        value = typed,
        onValueChange = { typed = it },
        modifier = Modifier.weight(1f),
        singleLine = true,
        placeholder = { Text("Type to Forge") },
        keyboardOptions = KeyboardOptions(imeAction = ImeAction.Send),
        keyboardActions = KeyboardActions(onSend = { onTyped(typed); typed = "" }),
      )
      Spacer(Modifier.width(8.dp))
      if (typed.isNotBlank()) {
        Button(onClick = { onTyped(typed); typed = "" }) { Text("Send") }
      } else {
        val on = ui.state == TalkState.Listening
        OutlinedButton(onClick = onMicTap) { Text(if (on) "Mic on" else "Mic off") }
      }
    }
  }
}

@Composable
private fun Card(card: CardUi, onAction: (String, String) -> Unit) {
  Column(
    Modifier
      .fillMaxWidth()
      .border(1.dp, ForgeColors.Outline, RoundedCornerShape(12.dp))
      .padding(12.dp),
    verticalArrangement = Arrangement.spacedBy(6.dp),
  ) {
    Row(verticalAlignment = Alignment.CenterVertically) {
      if (card.kind == "needs-you") {
        Text(
          "!", color = ForgeColors.Bg, fontWeight = FontWeight.Black,
          modifier = Modifier.background(ForgeColors.Text, RoundedCornerShape(4.dp)).padding(horizontal = 7.dp),
        )
        Spacer(Modifier.width(8.dp))
      }
      Text(card.title, color = ForgeColors.Text, fontWeight = FontWeight.SemiBold)
    }
    Text(card.line, color = ForgeColors.TextDim)
    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
      card.actions.forEach { a -> OutlinedButton(onClick = { onAction(card.id, a) }) { Text(a) } }
    }
  }
}
