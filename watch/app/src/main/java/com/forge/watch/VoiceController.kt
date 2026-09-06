package com.forge.watch

import android.content.Context
import android.content.Intent
import android.os.VibrationEffect
import android.os.Vibrator
import android.os.VibratorManager
import android.util.Log
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock

/**
 * Turns finished phrases into things that happen on the desktop.
 *
 * Lives in the process, not the activity, because the screen can be dismissed
 * mid-sentence — a wrist drop is a back press — and the words must still land.
 *
 * The rule is simple: a phrase is a command when VoiceCommands says so, and
 * prompt text otherwise. Prompt text accumulates in `draft` until "send it"
 * types it into the current pane and presses Enter.
 */
object VoiceController {
    private const val TAG = "ForgeWatch"

    /** Prompt text said so far, not yet sent. */
    val draft = MutableStateFlow("")
    /** One line of feedback about the last thing that happened. */
    val notice = MutableStateFlow("")
    /** True while a command is being carried out — no second one lands on top. */
    val busy = MutableStateFlow(false)

    private lateinit var app: Context
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    private val lock = Mutex()

    /** The first half of a split command, waiting for its name. See VoiceCommands.DANGLING. */
    private var dangling: String? = null
    private var danglingAt = 0L
    private const val DANGLING_MAX_MS = 6_000L

    /** Run socket work from a screen that may be finishing. */
    fun launchWork(action: suspend () -> Unit) {
        scope.launch { lock.withLock { runCatching { action() }.onFailure { notice.value = it.message ?: "That did not work" } } }
    }

    suspend fun newTabFromPicker(projectId: String, profileId: String) {
        val name = ForgeLink.projects.value.firstOrNull { it.id == projectId }?.name ?: return
        val profile = ForgeLink.profiles.value.firstOrNull { it.id == profileId }?.name ?: return
        newTab(profile, name)
    }

    /** "New tab" with no agent named: put the agent list on screen rather than guess one. */
    private fun askWhichAgent(projectId: String) {
        notice.value = "Which agent?"
        app.startActivity(
            Intent(app, PickerActivity::class.java)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                .putExtra(PickerActivity.EXTRA_PROJECT, projectId)
                .putExtra(PickerActivity.EXTRA_AGENTS, true))
    }

    suspend fun goToTabFromPicker(projectId: String, tabId: String) {
        if (!requireLive()) return
        ForgeLink.currentProjectId.value = projectId
        ForgeLink.selectProject(projectId)
        ForgeLink.selectTab(projectId, tabId)
        delay(150)
        notice.value = paneLabel()
        buzz(long = false)
    }

    suspend fun closeTabFromPicker(projectId: String, tabId: String) {
        if (!requireLive()) return
        ForgeLink.closeTab(projectId, tabId)
        buzz(long = false)
    }

    suspend fun closeOtherTabsFromPicker(projectId: String, keepTabId: String) {
        if (!requireLive()) return
        val ws = ForgeLink.workspaces.value[projectId] ?: return
        val toClose = ws.tabs.filter { it.id != keepTabId }
        for (t in toClose) {
            runCatching { ForgeLink.closeTab(projectId, t.id) }
        }
        buzz(long = false)
    }

    fun init(ctx: Context) {
        app = ctx.applicationContext
        scope.launch {
            DictationState.phrases.collect { phrase -> handle(phrase) }
        }
    }

    fun cancelDraft() {
        draft.value = ""
        notice.value = "Cleared"
    }

    /** The Send button: the same path as saying "send it". */
    fun sendDraft() {
        scope.launch { lock.withLock { performSend() } }
    }

    private suspend fun handle(heard: String) {
        val projects = ForgeLink.projects.value.map { it.name }
        val profiles = ForgeLink.profiles.value.map { it.name }
        // "go to project" on its own is half a command. Hold it for the name.
        var phrase = heard
        val held = dangling
        if (held != null) {
            if (System.currentTimeMillis() - danglingAt < DANGLING_MAX_MS) phrase = "$held $heard"
            else draft.value = (draft.value + " " + held).trim()
        }
        dangling = null
        if (VoiceCommands.isDangling(heard) && held == null) {
            dangling = VoiceCommands.clean(heard)
            danglingAt = System.currentTimeMillis()
            notice.value = "$dangling…"
            Log.i(TAG, "holding: \"$heard\"")
            return
        }
        val command = VoiceCommands.parse(phrase, draft.value.isBlank(), projects, profiles)
        Log.i(TAG, "heard: \"$phrase\" -> $command")
        lock.withLock {
            busy.value = true
            try {
                when (command) {
                    is VoiceCommands.Command.Text -> {
                        // A phrase ended by "send it" in the same breath carries it.
                        val body = VoiceCommands.stripTerminal(command.text)
                        val ended = body != VoiceCommands.clean(command.text)
                        if (body.isNotBlank()) {
                            draft.value = (draft.value + " " + body).trim()
                            val words = Regex("""\S+""").findAll(draft.value).count()
                            notice.value = "Ready ($words words) · Say \"send it\""
                        }
                        if (ended) performSend()
                    }
                    VoiceCommands.Command.Send -> performSend()
                    VoiceCommands.Command.Cancel -> cancelDraft()
                    VoiceCommands.Command.Stop -> {
                        ForgeDictationService.stop(app)
                        notice.value = "Stopped"
                    }
                    VoiceCommands.Command.Enter -> typeRaw("\r", "Enter")
                    VoiceCommands.Command.Escape -> typeRaw(" ", "Escape")
                    is VoiceCommands.Command.OpenProject -> openProject(command.name)
                    is VoiceCommands.Command.NewTab -> newTab(command.profile, command.project)
                    is VoiceCommands.Command.SelectTab -> selectTab(command)
                    is VoiceCommands.Command.CloseTab -> closeTab(command)
                }
            } catch (e: Exception) {
                Log.i(TAG, "command failed: ${e.message}")
                notice.value = e.message ?: "That did not work"
                buzz(long = true)
            } finally {
                busy.value = false
            }
        }
    }

    private fun requireLive(): Boolean {
        if (ForgeLink.state.value == ForgeLink.State.LIVE) return true
        notice.value = when (ForgeLink.state.value) {
            ForgeLink.State.SIGNED_OUT -> "Sign in first"
            ForgeLink.State.PIN -> "PIN needed"
            ForgeLink.State.ABSENT -> "Desktop is off"
            else -> "Not connected"
        }
        buzz(long = true)
        return false
    }

    private suspend fun performSend() {
        val text = draft.value.trim()
        if (text.isEmpty()) {
            notice.value = "Nothing to send"
            return
        }
        if (!requireLive()) return
        val pane = ForgeLink.currentPaneId()
        if (pane == null) {
            notice.value = "No tab open. Say \"new tab\"."
            buzz(long = true)
            return
        }
        if (pane !in ForgeLink.sessions.value) {
            notice.value = "That pane is not running"
            buzz(long = true)
            return
        }
        notice.value = "Sending…"
        if (ForgeLink.sendPrompt(pane, text)) {
            draft.value = ""
            notice.value = "Sent to ${paneLabel()}"
            buzz(long = false)
        } else {
            notice.value = "Could not send"
            buzz(long = true)
        }
    }

    private fun typeRaw(bytes: String, label: String) {
        if (!requireLive()) return
        val pane = ForgeLink.currentPaneId() ?: run { notice.value = "No tab open"; return }
        if (ForgeLink.write(pane, bytes)) {
            notice.value = label
            buzz(long = false)
        } else notice.value = "Could not send"
    }

    private suspend fun openProject(name: String) {
        if (!requireLive()) return
        val project = ForgeLink.projects.value.firstOrNull { it.name == name } ?: run {
            notice.value = "No project called $name"
            return
        }
        notice.value = "Opening ${project.name}…"
        ForgeLink.selectProject(project.id)
        val tabs = ForgeLink.workspaces.value[project.id]?.tabs?.size ?: 0
        notice.value = if (tabs == 0) "${project.name}. No tabs — say \"new tab\"." else "${project.name}, ${tabs} tab${if (tabs == 1) "" else "s"}"
        buzz(long = false)
    }

    private suspend fun newTab(profileName: String?, projectName: String?) {
        if (!requireLive()) return
        if (projectName != null) openProject(projectName)
        val project = ForgeLink.currentProject() ?: run {
            notice.value = "Say \"open <project>\" first"
            return
        }
        val profile = profileName?.let { n -> ForgeLink.profiles.value.firstOrNull { it.name == n } }
        if (profile == null) {
            askWhichAgent(project.id)
            return
        }
        notice.value = "Opening a ${profile.name} tab…"
        val pane = ForgeLink.createTab(project.id, profile?.id)
        if (pane == null) {
            notice.value = "The desktop did not open the tab"
            buzz(long = true)
            return
        }
        // The pane is live before the agent is ready. Words typed into a shell
        // that has not handed over yet are run by that shell, so wait for the
        // banner and the silence after it before saying so.
        notice.value = "Tab open. Waiting for ${profile?.name ?: "the agent"}…"
        val ready = ForgeLink.awaitReady(pane)
        notice.value = if (ready) "Ready. Talk." else "Tab open, but the agent has not spoken yet"
        buzz(long = false)
    }

    private suspend fun selectTab(cmd: VoiceCommands.Command.SelectTab) {
        if (!requireLive()) return
        cmd.project?.let { openProject(it) }
        val project = ForgeLink.currentProject() ?: run { notice.value = "Say \"open <project>\" first"; return }
        val ws = ForgeLink.workspaces.value[project.id]
        val tabs = ws?.tabs.orEmpty()
        if (tabs.isEmpty()) { notice.value = "No tabs. Say \"new tab\"."; return }
        val current = tabs.indexOfFirst { it.id == ws?.activeTabId }.coerceAtLeast(0)
        val target = when {
            cmd.step != 0 -> tabs[((current + cmd.step) % tabs.size + tabs.size) % tabs.size]
            cmd.index != null -> tabs.getOrNull(cmd.index - 1) ?: run { notice.value = "Only ${tabs.size} tabs"; return }
            cmd.name != null -> {
                val hit = VoiceCommands.bestMatch(cmd.name, tabs.map { it.title }) ?: run { notice.value = "No tab called ${cmd.name}"; return }
                tabs.first { it.title == hit }
            }
            else -> return
        }
        ForgeLink.selectTab(project.id, target.id)
        // The workspace frame that confirms it is a beat behind the reply.
        delay(150)
        notice.value = "Tab ${tabs.indexOf(target) + 1}${if (target.title.isNotBlank()) ": ${target.title}" else ""}"
        buzz(long = false)
    }

    private suspend fun closeTab(cmd: VoiceCommands.Command.CloseTab) {
        if (!requireLive()) return
        cmd.project?.let { openProject(it) }
        val project = ForgeLink.currentProject() ?: run { notice.value = "Say \"open <project>\" first"; return }
        val ws = ForgeLink.workspaces.value[project.id]
        val tabs = ws?.tabs.orEmpty()
        if (tabs.isEmpty()) {
            notice.value = "No tabs open"
            return
        }
        if (cmd.others) {
            val activeId = ws?.activeTabId ?: tabs.first().id
            val toClose = tabs.filter { it.id != activeId }
            if (toClose.isEmpty()) {
                notice.value = "Only one tab open"
                return
            }
            for (t in toClose) {
                runCatching { ForgeLink.closeTab(project.id, t.id) }
            }
            delay(150)
            notice.value = "Closed ${toClose.size} other tab${if (toClose.size == 1) "" else "s"}"
            buzz(long = false)
            return
        }
        val current = tabs.indexOfFirst { it.id == ws?.activeTabId }.coerceAtLeast(0)
        val target = when {
            cmd.index != null -> tabs.getOrNull(cmd.index - 1) ?: run {
                notice.value = "Only ${tabs.size} tab${if (tabs.size == 1) "" else "s"}"
                return
            }
            cmd.name != null -> {
                val hit = VoiceCommands.bestMatch(cmd.name, tabs.map { it.title }) ?: run {
                    notice.value = "No tab called ${cmd.name}"
                    return
                }
                tabs.first { it.title == hit }
            }
            else -> tabs.getOrNull(current) ?: tabs.first()
        }
        val label = if (target.title.isNotBlank()) target.title else "tab ${tabs.indexOf(target) + 1}"
        ForgeLink.closeTab(project.id, target.id)
        delay(150)
        notice.value = "Closed $label"
        buzz(long = false)
    }

    private fun paneLabel(): String {
        val tab = ForgeLink.currentTab() ?: return "the pane"
        val ws = ForgeLink.workspaces.value[ForgeLink.currentProjectId.value] ?: return "the pane"
        val n = ws.tabs.indexOf(tab) + 1
        return if (tab.title.isNotBlank()) "tab $n (${tab.title})" else "tab $n"
    }

    /** A short buzz means done; a long one means look at the screen. */
    private fun buzz(long: Boolean) {
        runCatching {
            val v = (app.getSystemService(Context.VIBRATOR_MANAGER_SERVICE) as VibratorManager).defaultVibrator
            v.vibrate(VibrationEffect.createOneShot(if (long) 220L else 40L, VibrationEffect.DEFAULT_AMPLITUDE))
        }
    }
}
