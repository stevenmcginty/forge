package com.forge.watch

import android.os.Bundle
import android.text.TextUtils
import android.view.Gravity
import android.widget.Button
import android.widget.LinearLayout
import android.widget.TextView
import androidx.activity.ComponentActivity
import androidx.activity.addCallback
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.lifecycleScope
import androidx.lifecycle.repeatOnLifecycle
import kotlinx.coroutines.flow.collectLatest
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.launch

/**
 * Tap navigation: projects and their tabs.
 *
 * Supports switching projects, switching tabs, creating new tabs with a chosen agent,
 * and closing individual tabs or closing all other tabs directly from the wrist.
 */
class PickerActivity : ComponentActivity() {

    private lateinit var title: TextView
    private lateinit var list: LinearLayout
    private var projectId: String? = null
    /** Choosing which agent a new tab runs, for `projectId`. */
    private var pickingAgent = false

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_picker)
        title = findViewById(R.id.title)
        list = findViewById(R.id.list)
        projectId = intent.getStringExtra(EXTRA_PROJECT)
        pickingAgent = intent.getBooleanExtra(EXTRA_AGENTS, false) && projectId != null

        // The edge swipe is a back press. One level up: agents -> tabs -> projects -> voice screen.
        onBackPressedDispatcher.addCallback(this) {
            when {
                pickingAgent -> { pickingAgent = false; rerender() }
                projectId != null -> { projectId = null; rerender() }
                else -> finish()
            }
        }
        title.setOnClickListener { onBackPressedDispatcher.onBackPressed() }

        lifecycleScope.launch {
            repeatOnLifecycle(Lifecycle.State.STARTED) {
                combine(ForgeLink.projects, ForgeLink.workspaces, ForgeLink.state) { p, w, s -> Triple(p, w, s) }
                    .collectLatest { (projects, workspaces, state) -> render(projects, workspaces, state) }
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

    private fun rerender() = render(ForgeLink.projects.value, ForgeLink.workspaces.value, ForgeLink.state.value)

    private fun render(
        projects: List<ForgeLink.Project>,
        workspaces: Map<String, ForgeLink.Workspace>,
        state: ForgeLink.State,
    ) {
        list.removeAllViews()
        if (state != ForgeLink.State.LIVE) {
            title.text = getString(R.string.picker_not_connected)
            return
        }
        val project = projects.firstOrNull { it.id == projectId }
        if (project == null) {
            title.text = getString(R.string.picker_projects)
            for (p in projects) {
                val count = workspaces[p.id]?.tabs?.size ?: 0
                val label = if (count > 0) "${p.name} ($count)" else p.name
                row(label) { projectId = p.id; render(projects, workspaces, state) }
            }
            return
        }
        if (pickingAgent) {
            title.text = getString(R.string.picker_agent_for, project.name)
            row(getString(R.string.picker_back), muted = true) { pickingAgent = false; render(projects, workspaces, state) }
            for (p in ForgeLink.profiles.value) {
                row(p.name) { finishWith { VoiceController.newTabFromPicker(project.id, p.id) } }
            }
            return
        }

        val ws = workspaces[project.id]
        val tabs = ws?.tabs.orEmpty()
        val activeTabId = ws?.activeTabId ?: tabs.firstOrNull()?.id

        title.text = "▲ ${project.name} (${tabs.size})"

        // Action header row: Projects on left, + New tab on right
        val headerRow = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            layoutParams = LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT
            ).apply { bottomMargin = dp(4) }
        }

        val backBtn = Button(this).apply {
            text = getString(R.string.picker_all_projects)
            isAllCaps = false
            textSize = 12f
            setTextColor(0xFF9AA0A6.toInt())
            layoutParams = LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f).apply {
                marginEnd = dp(2)
            }
            setOnClickListener {
                projectId = null
                render(projects, workspaces, state)
            }
        }

        val newTabBtn = Button(this).apply {
            text = getString(R.string.picker_new_tab)
            isAllCaps = false
            textSize = 12f
            setTextColor(0xFFC6FF3D.toInt())
            layoutParams = LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f).apply {
                marginStart = dp(2)
            }
            setOnClickListener {
                pickingAgent = true
                render(projects, workspaces, state)
            }
        }

        headerRow.addView(backBtn)
        headerRow.addView(newTabBtn)
        list.addView(headerRow)

        if (tabs.isEmpty()) {
            val emptyNotice = TextView(this).apply {
                text = "No tabs. Tap + New tab above."
                textSize = 12f
                setTextColor(0xFF9AA0A6.toInt())
                gravity = Gravity.CENTER
                setPadding(0, dp(16), 0, dp(16))
            }
            list.addView(emptyNotice)
            return
        }

        tabs.forEachIndexed { i, tab ->
            val label = if (tab.title.isBlank()) "Tab ${i + 1}" else "${i + 1} · ${tab.title}"
            val isActive = tab.id == activeTabId
            tabRow(
                label = label,
                isActive = isActive,
                onSelect = { finishWith { VoiceController.goToTabFromPicker(project.id, tab.id) } },
                onClose = {
                    VoiceController.launchWork {
                        VoiceController.closeTabFromPicker(project.id, tab.id)
                    }
                }
            )
        }

        if (tabs.size >= 3) {
            val closeOthersBtn = Button(this).apply {
                text = getString(R.string.close_other_tabs)
                isAllCaps = false
                textSize = 11f
                setTextColor(0xFFFF8A80.toInt())
                layoutParams = LinearLayout.LayoutParams(
                    LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT
                ).apply { topMargin = dp(6) }
                setOnClickListener {
                    val keepId = activeTabId ?: tabs.first().id
                    VoiceController.launchWork {
                        VoiceController.closeOtherTabsFromPicker(project.id, keepId)
                    }
                }
            }
            list.addView(closeOthersBtn)
        }
    }

    private fun tabRow(
        label: String,
        isActive: Boolean,
        onSelect: () -> Unit,
        onClose: () -> Unit
    ) {
        val row = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            layoutParams = LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT
            ).apply { topMargin = dp(4) }
        }

        val selectBtn = Button(this).apply {
            text = if (isActive) "● $label" else label
            isAllCaps = false
            textSize = 13f
            maxLines = 1
            ellipsize = TextUtils.TruncateAt.END
            if (isActive) {
                setTextColor(0xFFC6FF3D.toInt())
                setBackgroundResource(R.drawable.bg_tab_active)
            } else {
                setTextColor(0xFFFFFFFF.toInt())
                setBackgroundResource(R.drawable.bg_tab_inactive)
            }
            layoutParams = LinearLayout.LayoutParams(
                0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f
            )
            setOnClickListener { onSelect() }
            setOnLongClickListener {
                onClose()
                true
            }
        }

        val closeBtn = Button(this).apply {
            text = "✕"
            textSize = 14f
            setTextColor(0xFFFF5252.toInt())
            setBackgroundResource(R.drawable.bg_close_btn)
            minWidth = 0
            minimumWidth = 0
            setPadding(0, 0, 0, 0)
            layoutParams = LinearLayout.LayoutParams(
                dp(38), LinearLayout.LayoutParams.MATCH_PARENT
            ).apply { marginStart = dp(4) }
            setOnClickListener { onClose() }
        }

        row.addView(selectBtn)
        row.addView(closeBtn)
        list.addView(row)
    }

    private fun finishWith(action: suspend () -> Unit) {
        VoiceController.launchWork(action)
        finish()
    }

    private fun dp(dp: Int): Int = (dp * resources.displayMetrics.density).toInt()

    private fun row(label: String, accent: Boolean = false, muted: Boolean = false, onTap: () -> Unit) {
        val b = Button(this)
        b.text = label
        b.isAllCaps = false
        b.textSize = if (muted) 12f else 14f
        b.maxLines = 1
        b.ellipsize = TextUtils.TruncateAt.END
        if (accent) b.setTextColor(0xFFC6FF3D.toInt())
        if (muted) b.setTextColor(0xFF9AA0A6.toInt())
        b.layoutParams = LinearLayout.LayoutParams(
            LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT,
        ).apply { topMargin = dp(4) }
        b.setOnClickListener { onTap() }
        list.addView(b)
    }

    companion object {
        const val EXTRA_PROJECT = "project"
        const val EXTRA_AGENTS = "agents"
    }
}
