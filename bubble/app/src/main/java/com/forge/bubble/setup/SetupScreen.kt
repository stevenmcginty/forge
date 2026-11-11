package com.forge.bubble.setup

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
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
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.forge.bubble.ui.ForgeColors

private val PIN_SHAPE = Regex("^\\d{4,12}$")

/**
 * The setup steps. Each shows a mark and a word: a filled disc with a tick and
 * "Done", or a hollow ring and "Needed" — never colour alone.
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
    Text("Set up Forge", color = ForgeColors.Text, fontSize = 24.sp, fontWeight = FontWeight.SemiBold)

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
    Button(enabled = ready, onClick = onFinish, modifier = Modifier.fillMaxWidth()) {
      Text(if (ready) "Open Forge" else "Finish steps 1 to 4 first")
    }
  }
}

@Composable
private fun Step(n: Int, title: String, done: Boolean, body: @Composable () -> Unit) {
  Column(
    Modifier
      .fillMaxWidth()
      .border(1.dp, ForgeColors.Outline, RoundedCornerShape(12.dp))
      .padding(14.dp),
    verticalArrangement = Arrangement.spacedBy(8.dp),
  ) {
    Row(verticalAlignment = Alignment.CenterVertically) {
      Mark(done)
      Spacer(Modifier.width(10.dp))
      Text("$n. $title", color = ForgeColors.Text, fontWeight = FontWeight.SemiBold, modifier = Modifier.weight(1f))
      Text(if (done) "Done" else "Needed", color = if (done) ForgeColors.Text else ForgeColors.Accent, fontSize = 14.sp)
    }
    body()
  }
}

/** Done: filled disc with a tick. Needed: hollow ring. */
@Composable
private fun Mark(done: Boolean) {
  Canvas(Modifier.size(22.dp)) {
    val r = size.minDimension / 2f
    if (done) {
      drawCircle(ForgeColors.Text, r)
      val tick = Path().apply {
        moveTo(r * 0.5f, r * 1.0f)
        lineTo(r * 0.85f, r * 1.35f)
        lineTo(r * 1.5f, r * 0.65f)
      }
      drawPath(tick, ForgeColors.Bg, style = Stroke(width = r * 0.25f))
    } else {
      drawCircle(ForgeColors.TextDim, r * 0.85f, Offset(r, r), style = Stroke(width = r * 0.18f))
    }
  }
}
