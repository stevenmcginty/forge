package com.forge.watch

import android.Manifest
import android.app.RemoteInput
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Bundle
import android.view.View
import android.widget.Button
import android.widget.TextView
import androidx.activity.ComponentActivity
import androidx.activity.result.contract.ActivityResultContracts
import androidx.core.content.ContextCompat
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.lifecycleScope
import androidx.lifecycle.repeatOnLifecycle
import androidx.wear.input.RemoteInputIntentHelper
import kotlinx.coroutines.flow.collectLatest
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.launch

/**
 * The Forge voice screen. One mic button, a status line, the words so far.
 *
 * Launched from the watch face's mic shortcut and starts listening at once
 * when it can. Everything else is said: "open forge", "new tab", the prompt,
 * "send it". Sign-in and the desktop's PIN are the two things that have to be
 * typed, and both go through Wear's full-screen input.
 *
 * Keeps its old class name because the watch face's Launch target names it.
 */
class DictationActivity : ComponentActivity() {

    private lateinit var status: TextView
    private lateinit var transcript: TextView
    private lateinit var notice: TextView
    private lateinit var partial: TextView
    private lateinit var level: android.widget.ProgressBar
    private lateinit var mic: Button
    private lateinit var send: Button

    private var asking: String? = null
    private var typedEmail: String? = null
    private var autoStart = true

    private val requestMic =
        registerForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
            if (granted) startListening() else notice.text = getString(R.string.mic_needed)
        }

    private val input = registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { result ->
        val key = asking
        val answer = result.data
            ?.let { data -> key?.let { RemoteInput.getResultsFromIntent(data)?.getCharSequence(it) } }
            ?.toString()?.trim()
        when {
            key == null || answer.isNullOrEmpty() -> { asking = null; typedEmail = null }
            key == ASK_EMAIL -> { typedEmail = answer; ask(ASK_PASSWORD) }
            key == ASK_PASSWORD -> {
                val mail = typedEmail
                asking = null
                typedEmail = null
                if (mail != null) lifecycleScope.launch {
                    notice.text = getString(R.string.signing_in)
                    val failure = ForgeAuth.signIn(this@DictationActivity, mail, answer)
                    notice.text = failure ?: ""
                    if (failure == null) ForgeLink.kick()
                }
            }
            key == ASK_PIN -> {
                asking = null
                ForgeLink.providePin(answer)
            }
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        window.addFlags(android.view.WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        setContentView(R.layout.activity_dictation)
        status = findViewById(R.id.status)
        transcript = findViewById(R.id.transcript)
        notice = findViewById(R.id.notice)
        partial = findViewById(R.id.partial)
        level = findViewById(R.id.level)
        mic = findViewById(R.id.mic)
        send = findViewById(R.id.send)

        mic.setOnClickListener {
            if (DictationState.running.value) ForgeDictationService.stop(this) else startListening()
        }
        send.setOnClickListener { VoiceController.sendDraft() }
        send.setOnLongClickListener { VoiceController.cancelDraft(); true }
        status.setOnClickListener { onStatusTap() }
        status.setOnLongClickListener { startActivity(Intent(this, MainActivity::class.java)); true }

        lifecycleScope.launch {
            repeatOnLifecycle(Lifecycle.State.STARTED) {
                launch { renderStatus() }
                launch { renderWords() }
                launch { VoiceController.notice.collectLatest { notice.text = it } }
                launch { DictationState.level.collectLatest { level.progress = (it * 100).toInt() } }
                launch { DictationState.problem.collectLatest { if (!it.isNullOrBlank()) notice.text = it } }
                launch {
                    ForgeLink.pinNeeded.collectLatest { needed -> if (needed && asking == null) ask(ASK_PIN) }
                }
            }
        }
    }

    override fun onStart() {
        super.onStart()
        window.addFlags(android.view.WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        ForgeLink.setWanted("screen", true)
        if (!ForgeAuth.signedIn(this)) {
            if (asking == null) ask(ASK_EMAIL)
        } else if (!DictationState.running.value) {
            startListening()
        }
        autoStart = false
    }

    override fun onStop() {
        window.clearFlags(android.view.WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        ForgeDictationService.stop(this)
        ForgeLink.setWanted("screen", false)
        super.onStop()
    }

    override fun onDestroy() {
        ForgeDictationService.stop(this)
        super.onDestroy()
    }

    private fun startListening() {
        val granted = ContextCompat.checkSelfPermission(this, Manifest.permission.RECORD_AUDIO) ==
            PackageManager.PERMISSION_GRANTED
        if (granted) ForgeDictationService.start(this) else requestMic.launch(Manifest.permission.RECORD_AUDIO)
    }

    private fun onStatusTap() {
        when (ForgeLink.state.value) {
            ForgeLink.State.SIGNED_OUT -> ask(ASK_EMAIL)
            ForgeLink.State.PIN -> ask(ASK_PIN)
            ForgeLink.State.REFUSED, ForgeLink.State.ABSENT, ForgeLink.State.OFF -> ForgeLink.kick()
            ForgeLink.State.LIVE -> startActivity(
                Intent(this, PickerActivity::class.java).putExtra(PickerActivity.EXTRA_PROJECT, ForgeLink.currentProjectId.value))
            else -> {}
        }
    }

    /** Wear's full-screen text entry: scribble, keyboard or voice, handed back as an extra. */
    private fun ask(key: String) {
        asking = key
        val label = when (key) {
            ASK_EMAIL -> getString(R.string.ask_email)
            ASK_PASSWORD -> getString(R.string.ask_password)
            else -> getString(R.string.ask_pin)
        }
        val remote = RemoteInput.Builder(key).setLabel(label).build()
        val intent = RemoteInputIntentHelper.putRemoteInputsExtra(
            RemoteInputIntentHelper.createActionRemoteInputIntent(), listOf(remote))
        RemoteInputIntentHelper.putTitleExtra(intent, label)
        input.launch(intent)
    }

    private suspend fun renderStatus() {
        combine(
            ForgeLink.state, ForgeLink.detail, ForgeLink.desktopName,
            ForgeLink.currentProjectId, ForgeLink.workspaces,
        ) { state, detail, desktop, _, _ ->
            when (state) {
                ForgeLink.State.OFF -> getString(R.string.state_off)
                ForgeLink.State.SIGNED_OUT -> getString(R.string.state_signed_out)
                ForgeLink.State.FINDING -> detail.ifBlank { getString(R.string.state_finding) }
                ForgeLink.State.ABSENT -> detail.ifBlank { getString(R.string.state_absent) }
                ForgeLink.State.CONNECTING -> getString(R.string.state_connecting, desktop.ifBlank { "desktop" })
                ForgeLink.State.PIN -> detail.ifBlank { getString(R.string.state_pin) }
                ForgeLink.State.REFUSED -> detail.ifBlank { getString(R.string.state_refused) }
                ForgeLink.State.LIVE -> {
                    val project = ForgeLink.currentProject()?.name ?: return@combine getString(R.string.pick_project)
                    val tab = ForgeLink.currentTab()
                    val ws = ForgeLink.workspaces.value[ForgeLink.currentProjectId.value]
                    val tabIndex = if (tab != null && ws != null) ws.tabs.indexOfFirst { it.id == tab.id }.takeIf { it >= 0 }?.plus(1) ?: 1 else 1
                    val tabLabel = when {
                        tab == null -> "no tab"
                        tab.title.isNotBlank() -> "tab $tabIndex ${tab.title}"
                        else -> "tab $tabIndex"
                    }
                    "$project · $tabLabel ▾"
                }
            }
        }.collectLatest { status.text = it }
    }

    private suspend fun renderWords() {
        combine(VoiceController.draft, DictationState.partial, DictationState.running) { draft, spoken, running ->
            Triple(draft, spoken, running)
        }.collectLatest { (draft, spoken, running) ->
            // Two lines, two colours: white is caught and in the draft, grey
            // italic is still being spoken. When the grey turns white, it landed.
            transcript.text = when {
                draft.isNotBlank() -> draft
                running -> getString(R.string.listening)
                else -> getString(R.string.tap_to_talk)
            }
            partial.text = spoken
            partial.visibility = if (spoken.isBlank()) View.GONE else View.VISIBLE
            val words = Regex("""\S+""").findAll(draft).count()
            send.text = if (words > 0) getString(R.string.send_n, words) else getString(R.string.send)
            send.visibility = if (draft.isNotBlank()) View.VISIBLE else View.GONE
            mic.setText(if (running) R.string.stop else R.string.talk)
        }
    }

    companion object {
        private const val ASK_EMAIL = "email"
        private const val ASK_PASSWORD = "password"
        private const val ASK_PIN = "pin"
    }
}
