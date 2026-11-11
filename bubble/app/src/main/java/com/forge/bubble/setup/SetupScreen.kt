package com.forge.bubble.setup

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.runtime.collectAsState
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.StrokeJoin
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.forge.bubble.ui.ForgeColors
import com.forge.bubble.ui.ForgeMark

private val PIN_SHAPE = Regex("^\\d{4,12}$")

/**
 * The setup steps. Each shows a mark and a word: a lime disc with a tick and
 * "Done", or a hollow ring with its number and "Needed" — never colour alone.
 */
@Composable
fun SetupScreen(
  account: Account,
  checks: SetupChecks,
  onSignIn: (email: String, password: String, done: (Result<Unit>) -> Unit) -> Unit,
  onPin: (pin: String, remember: Boolean) -> Unit,
  onOverlay: () -> Unit,
  onAppInfo: () -> Unit,
  onMic: () -> Unit,
  onNotifications: () -> Unit,
  onBattery: () -> Unit,
  onBubble: (Boolean) -> Unit,
  onFinish: () -> Unit,
) {
  val status by account.status.collectAsState()
  Column(
    Modifier
      .fillMaxSize()
      .background(ForgeColors.Bg)
      .safeDrawingPadding()
      .imePadding()
      .verticalScroll(rememberScrollState())
      .padding(16.dp),
    verticalArrangement = Arrangement.spacedBy(12.dp),
  ) {
    Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.padding(top = 8.dp, bottom = 4.dp)) {
      // The Forge Web icon in small: the dark F on its lime tile.
      Box(
        Modifier.size(44.dp).background(ForgeColors.Accent, RoundedCornerShape(12.dp)),
        contentAlignment = Alignment.Center,
      ) { ForgeMark(size = 26.dp, color = ForgeColors.OnAccent) }
      Spacer(Modifier.width(14.dp))
      Column {
        Text("Forge bubble", color = ForgeColors.TextFaint, fontSize = 13.sp)
        Text("Set up Forge", color = ForgeColors.Text, fontSize = 26.sp, fontWeight = FontWeight.SemiBold, lineHeight = 30.sp)
      }
    }

    Step(1, "Sign in", status.signedIn) {
      if (status.signedIn) {
        Text(if (status.email.isNotEmpty()) "Signed in as ${status.email}" else "Signed in", color = ForgeColors.TextDim)
      } else {
        var email by remember { mutableStateOf("") }
        var password by remember { mutableStateOf("") }
        var busy by remember { mutableStateOf(false) }
        var error by remember { mutableStateOf<String?>(null) }
        OutlinedTextField(
          email, { email = it }, Modifier.fillMaxWidth(), singleLine = true,
          label = { Text("Email") },
          keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Email),
        )
        OutlinedTextField(
          password, { password = it }, Modifier.fillMaxWidth(), singleLine = true,
          label = { Text("Password") },
          visualTransformation = PasswordVisualTransformation(),
          keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password),
        )
        (error ?: status.note)?.let { Text(it, color = ForgeColors.Accent) }
        Button(
          enabled = !busy && email.isNotBlank() && password.isNotEmpty(),
          onClick = {
            busy = true
            error = null
            onSignIn(email, password) { r ->
              busy = false
              error = r.exceptionOrNull()?.message
            }
          },
        ) { Text(if (busy) "Signing in..." else "Sign in") }
      }
    }

    Step(2, "PIN", status.pinSet) {
      var pin by remember { mutableStateOf("") }
      var remember by remember { mutableStateOf(true) }
      if (status.pinSet) Text("PIN entered. You can enter it again to change it.", color = ForgeColors.TextDim)
      // A wrong PIN or a lockout, in the engine's words (step 1 shows notes before sign-in).
      if (status.signedIn) status.note?.let { Text(it, color = ForgeColors.Accent) }
      OutlinedTextField(
        pin, { v -> pin = v.filter { it.isDigit() }.take(12) }, Modifier.fillMaxWidth(), singleLine = true,
        label = { Text("PIN (4 to 12 digits)") },
        visualTransformation = PasswordVisualTransformation(),
        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.NumberPassword),
      )
      Row(verticalAlignment = Alignment.CenterVertically) {
        Text("Remember PIN on this phone", color = ForgeColors.Text, modifier = Modifier.weight(1f))
        Switch(checked = remember, onCheckedChange = { remember = it })
      }
      Button(enabled = PIN_SHAPE.matches(pin), onClick = { onPin(pin, remember); pin = "" }) { Text("Save PIN") }
    }

    Step(3, "Display over other apps", checks.overlay) {
      Text("Lets the bubble float over other apps.", color = ForgeColors.TextDim)
      if (!checks.overlay) {
        Button(onClick = onOverlay) { Text("Open setting") }
        Text(
          "If the switch is greyed out (\"Restricted setting\"):\n" +
            "1. Open App info for Forge.\n" +
            "2. Tap the ⋮ menu at the top right, then \"Allow restricted settings\".\n" +
            "3. Come back here and turn on \"Display over other apps\".",
          color = ForgeColors.TextDim, fontSize = 14.sp,
        )
        OutlinedButton(onClick = onAppInfo) { Text("Open App info") }
      }
    }

    Step(4, "Microphone", checks.mic) {
      Text("So you can talk to Forge from the bubble.", color = ForgeColors.TextDim)
      if (!checks.mic) Button(onClick = onMic) { Text("Allow microphone") }
    }

    Step(5, "Notifications", checks.notifications) {
      Text("Shows the bubble's status notification.", color = ForgeColors.TextDim)
      if (!checks.notifications) Button(onClick = onNotifications) { Text("Allow notifications") }
    }

    Step(6, "Battery: Unrestricted", checks.battery) {
      Text("Keeps the bubble running when the phone is idle.", color = ForgeColors.TextDim)
      if (!checks.battery) Button(onClick = onBattery) { Text("Set Unrestricted") }
    }

    Step(7, "Bubble on", checks.bubbleOn) {
      Row(verticalAlignment = Alignment.CenterVertically) {
        Text(if (checks.bubbleOn) "On" else "Off", color = ForgeColors.Text, modifier = Modifier.weight(1f))
        Switch(checked = checks.bubbleOn, onCheckedChange = onBubble)
      }
    }

    val ready = status.signedIn && status.pinSet && checks.overlay && checks.mic
    Button(enabled = ready, onClick = onFinish, modifier = Modifier.fillMaxWidth().height(52.dp)) {
      Text(if (ready) "Open Forge" else "Finish steps 1 to 4 first")
    }
  }
}

@Composable
private fun Step(n: Int, title: String, done: Boolean, body: @Composable () -> Unit) {
  Column(
    Modifier
      .fillMaxWidth()
      .background(ForgeColors.Surface, RoundedCornerShape(20.dp))
      .border(1.dp, ForgeColors.Outline, RoundedCornerShape(20.dp))
      .padding(16.dp),
    verticalArrangement = Arrangement.spacedBy(10.dp),
  ) {
    Row(verticalAlignment = Alignment.CenterVertically) {
      Mark(n, done)
      Spacer(Modifier.width(12.dp))
      Text(title, color = ForgeColors.Text, fontSize = 16.sp, fontWeight = FontWeight.SemiBold, modifier = Modifier.weight(1f))
      Text(
        if (done) "Done" else "Needed",
        color = if (done) ForgeColors.TextDim else ForgeColors.Attn, fontSize = 14.sp, fontWeight = FontWeight.Medium,
      )
    }
    body()
  }
}

/** Done: a lime disc with a tick. Needed: a hollow ring holding the step's number. */
@Composable
private fun Mark(n: Int, done: Boolean) {
  Box(Modifier.size(26.dp), contentAlignment = Alignment.Center) {
    Canvas(Modifier.size(26.dp)) {
      val r = size.minDimension / 2f
      if (done) {
        drawCircle(ForgeColors.Accent, r)
        val tick = Path().apply {
          moveTo(r * 0.55f, r * 1.02f)
          lineTo(r * 0.88f, r * 1.34f)
          lineTo(r * 1.46f, r * 0.7f)
        }
        drawPath(tick, ForgeColors.OnAccent, style = Stroke(width = r * 0.2f, cap = StrokeCap.Round, join = StrokeJoin.Round))
      } else {
        drawCircle(ForgeColors.TextFaint, r * 0.9f, Offset(r, r), style = Stroke(width = r * 0.12f))
      }
    }
    if (!done) Text("$n", color = ForgeColors.TextDim, fontSize = 13.sp, fontWeight = FontWeight.SemiBold)
  }
}
