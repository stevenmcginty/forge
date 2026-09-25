package com.forge.watch

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.addCallback
import androidx.activity.compose.setContent
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.wear.compose.material3.AppScaffold

/**
 * Tap navigation: projects and their tabs.
 *
 * Supports switching projects, switching tabs, creating new tabs with a chosen agent,
 * and closing individual tabs or closing all other tabs directly from the wrist.
 */
class PickerActivity : ComponentActivity() {

    private var projectId by mutableStateOf<String?>(null)
    /** Choosing which agent a new tab runs, for `projectId`. */
    private var pickingAgent by mutableStateOf(false)

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        projectId = intent.getStringExtra(EXTRA_PROJECT)
        pickingAgent = intent.getBooleanExtra(EXTRA_AGENTS, false) && projectId != null

        // The edge swipe is a back press. One level up: agents -> tabs -> projects -> voice screen.
        onBackPressedDispatcher.addCallback(this) { up() }

        setContent {
            val projects by ForgeLink.projects.collectAsStateWithLifecycle()
            val workspaces by ForgeLink.workspaces.collectAsStateWithLifecycle()
            val state by ForgeLink.state.collectAsStateWithLifecycle()
            val profiles by ForgeLink.profiles.collectAsStateWithLifecycle()
            val current by ForgeLink.currentProjectId.collectAsStateWithLifecycle()

            val project = projects.firstOrNull { it.id == projectId }
            val ws = project?.let { workspaces[it.id] }
            val tabs = ws?.tabs.orEmpty()
            val activeTabId = ws?.activeTabId ?: tabs.firstOrNull()?.id

            val ui = when {
                state != ForgeLink.State.LIVE -> PickerUi.Offline
                project == null -> PickerUi.Projects(
                    projects.map { p ->
                        ProjectRow(p.id, p.name, workspaces[p.id]?.tabs?.size ?: 0, current = p.id == current)
                    },
                )
                pickingAgent -> PickerUi.Agents(project.name, profiles)
                else -> PickerUi.Tabs(
                    project.name,
                    tabs.mapIndexed { i, tab ->
                        TabRow(
                            id = tab.id,
                            label = if (tab.title.isBlank()) "Tab ${i + 1}" else "${i + 1} · ${tab.title}",
                            active = tab.id == activeTabId,
                        )
                    },
                )
            }

            ForgeTheme {
                AppScaffold {
                    PickerScreen(
                        ui,
                        PickerActions(
                            openProject = { projectId = it },
                            allProjects = { projectId = null },
                            newTab = { pickingAgent = true },
                            pickAgent = { profileId ->
                                project?.id?.let { id -> finishWith { VoiceController.newTabFromPicker(id, profileId) } }
                            },
                            goToTab = { tabId ->
                                project?.id?.let { id -> finishWith { VoiceController.goToTabFromPicker(id, tabId) } }
                            },
                            closeTab = { tabId ->
                                project?.id?.let { id ->
                                    VoiceController.launchWork { VoiceController.closeTabFromPicker(id, tabId) }
                                }
                            },
                            closeOthers = {
                                val id = project?.id
                                val keepId = activeTabId ?: tabs.firstOrNull()?.id
                                if (id != null && keepId != null) {
                                    VoiceController.launchWork { VoiceController.closeOtherTabsFromPicker(id, keepId) }
                                }
                            },
                            back = { up() },
                        ),
                    )
                }
            }
        }
    }

    override fun onStart() {
        super.onStart()
        ForgeLink.setWanted("picker", true)
    }

    override fun onStop() {
        ForgeLink.setWanted("picker", false)
        super.onStop()
    }

    private fun up() {
        when {
            pickingAgent -> pickingAgent = false
            projectId != null -> projectId = null
            else -> finish()
        }
    }

    private fun finishWith(action: suspend () -> Unit) {
        VoiceController.launchWork(action)
        finish()
    }

    companion object {
        const val EXTRA_PROJECT = "project"
        const val EXTRA_AGENTS = "agents"
    }
}
