package com.forge.watch

import android.Manifest
import android.app.RemoteInput
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.core.content.ContextCompat
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.lifecycleScope
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.repeatOnLifecycle
import androidx.wear.input.RemoteInputIntentHelper
import kotlinx.coroutines.flow.collectLatest
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

    /** The one-line notice: VoiceController's, the recogniser's problem, or sign-in's, latest wins. */
    private val notice = mutableStateOf("")

    private var asking: String? = null
    private var typedEmail: String? = null
    private var autoStart = true

    private val requestMic =
        registerForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
            if (granted) startListening() else notice.value = getString(R.string.mic_needed)
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
                    notice.value = getString(R.string.signing_in)
                    val failure = ForgeAuth.signIn(this@DictationActivity, mail, answer)
                    notice.value = failure ?: ""
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
        setContent { ForgeTheme { Screen() } }

        lifecycleScope.launch {
            repeatOnLifecycle(Lifecycle.State.STARTED) {
                launch { VoiceController.notice.collectLatest { notice.value = it } }
                launch { DictationState.problem.collectLatest { if (!it.isNullOrBlank()) notice.value = it } }
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

    @Composable
    private fun Screen() {
        val state by ForgeLink.state.collectAsStateWithLifecycle()
        val detail by ForgeLink.detail.collectAsStateWithLifecycle()
        val desktop by ForgeLink.desktopName.collectAsStateWithLifecycle()
        val projectId by ForgeLink.currentProjectId.collectAsStateWithLifecycle()
        val workspaces by ForgeLink.workspaces.collectAsStateWithLifecycle()
        val projects by ForgeLink.projects.collectAsStateWithLifecycle()
        val draft by VoiceController.draft.collectAsStateWithLifecycle()
        val running by DictationState.running.collectAsStateWithLifecycle()
        val partial by DictationState.partial.collectAsStateWithLifecycle()
        val level by DictationState.level.collectAsStateWithLifecycle()
        val problem by DictationState.problem.collectAsStateWithLifecycle()

        val ui = VoiceUi(
            status = statusLine(state, detail, desktop, projectId, workspaces, projects),
            live = state == ForgeLink.State.LIVE && projects.any { it.id == projectId },
            mic = when {
                running -> Mic.LISTENING
                !problem.isNullOrBlank() -> Mic.OFF
                else -> Mic.IDLE
            },
            level = level,
            draft = draft,
            partial = partial,
            notice = notice.value,
        )
        VoiceScreen(
            ui = ui,
            onMic = { if (DictationState.running.value) ForgeDictationService.stop(this) else startListening() },
            onSend = { VoiceController.sendDraft() },
            onClear = { VoiceController.cancelDraft() },
            onStatus = { onStatusTap() },
            onSettings = { startActivity(Intent(this, MainActivity::class.java)) },
        )
    }

    /** Desktop · project · tab when live; otherwise what the link is doing, in words. */
    private fun statusLine(
        state: ForgeLink.State,
        detail: String,
        desktop: String,
        projectId: String?,
        workspaces: Map<String, ForgeLink.Workspace>,
        projects: List<ForgeLink.Project>,
    ): String = when (state) {
        ForgeLink.State.OFF -> getString(R.string.state_off)
        ForgeLink.State.SIGNED_OUT -> getString(R.string.state_signed_out)
        ForgeLink.State.FINDING -> detail.ifBlank { getString(R.string.state_finding) }
        ForgeLink.State.ABSENT -> detail.ifBlank { getString(R.string.state_absent) }
        ForgeLink.State.CONNECTING -> getString(R.string.state_connecting, desktop.ifBlank { "desktop" })
        ForgeLink.State.PIN -> detail.ifBlank { getString(R.string.state_pin) }
        ForgeLink.State.REFUSED -> detail.ifBlank { getString(R.string.state_refused) }
        ForgeLink.State.LIVE -> {
            val project = projects.firstOrNull { it.id == projectId }?.name
            if (project == null) {
                getString(R.string.pick_project)
            } else {
                val ws = workspaces[projectId]
                val tab = ForgeLink.currentTab()
                val tabIndex = if (tab != null && ws != null) ws.tabs.indexOfFirst { it.id == tab.id }.takeIf { it >= 0 }?.plus(1) ?: 1 else 1
                val tabLabel = when {
                    tab == null -> "no tab"
                    tab.title.isNotBlank() -> "tab $tabIndex ${tab.title}"
                    else -> "tab $tabIndex"
                }
                "$project · $tabLabel"
            }
        }
    }

    companion object {
        private const val ASK_EMAIL = "email"
        private const val ASK_PASSWORD = "password"
        private const val ASK_PIN = "pin"
    }
}
