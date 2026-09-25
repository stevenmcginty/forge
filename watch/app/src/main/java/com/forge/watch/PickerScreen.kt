package com.forge.watch

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Close
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.res.pluralStringResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.wear.compose.foundation.lazy.TransformingLazyColumn
import androidx.wear.compose.foundation.lazy.TransformingLazyColumnScope
import androidx.wear.compose.foundation.lazy.rememberTransformingLazyColumnState
import androidx.wear.compose.material3.Button
import androidx.wear.compose.material3.ButtonDefaults
import androidx.wear.compose.material3.CompactButton
import androidx.wear.compose.material3.EdgeButton
import androidx.wear.compose.material3.EdgeButtonSize
import androidx.wear.compose.material3.FilledTonalIconButton
import androidx.wear.compose.material3.Icon
import androidx.wear.compose.material3.IconButtonDefaults
import androidx.wear.compose.material3.ListHeader
import androidx.wear.compose.material3.ScreenScaffold
import androidx.wear.compose.material3.SurfaceTransformation
import androidx.wear.compose.material3.Text
import androidx.wear.compose.material3.lazy.rememberTransformationSpec
import androidx.wear.compose.material3.lazy.transformedHeight

/** What the picker is showing: one level of projects → tabs → agent for a new tab. */
sealed interface PickerUi {
    data object Offline : PickerUi
    data class Projects(val rows: List<ProjectRow>) : PickerUi
    data class Tabs(val project: String, val tabs: List<TabRow>) : PickerUi
    data class Agents(val project: String, val agents: List<ForgeLink.Profile>) : PickerUi
}

data class ProjectRow(val id: String, val name: String, val tabs: Int, val current: Boolean)
data class TabRow(val id: String, val label: String, val active: Boolean)

class PickerActions(
    val openProject: (String) -> Unit,
    val allProjects: () -> Unit,
    val newTab: () -> Unit,
    val pickAgent: (String) -> Unit,
    val goToTab: (String) -> Unit,
    val closeTab: (String) -> Unit,
    val closeOthers: () -> Unit,
    /** One level up; the header does this too. */
    val back: () -> Unit,
)

/** A compact Wear list: rows morph at the round edges, the crown scrolls it. */
@Composable
fun PickerScreen(ui: PickerUi, act: PickerActions) {
    val state = rememberTransformingLazyColumnState()
    val spec = rememberTransformationSpec()
    val list: TransformingLazyColumnScope.() -> Unit = {
        when (ui) {
            PickerUi.Offline -> {
                item { Header(stringResource(R.string.picker_not_connected), onClick = act.back) }
                item { Note(stringResource(R.string.picker_not_connected_note)) }
            }
            is PickerUi.Projects -> {
                item { Header(stringResource(R.string.picker_projects), onClick = act.back) }
                items(ui.rows.size) { i ->
                    val p = ui.rows[i]
                    val count = if (p.tabs == 0) stringResource(R.string.picker_no_tab_count)
                        else pluralStringResource(R.plurals.picker_tabs, p.tabs, p.tabs)
                    ListRow(
                        label = p.name,
                        detail = if (p.current) "$count · ${stringResource(R.string.picker_current)}" else count,
                        marked = p.current,
                        modifier = Modifier.transformedHeight(this, spec),
                        transformation = SurfaceTransformation(spec),
                        onClick = { act.openProject(p.id) },
                    )
                }
            }
            is PickerUi.Tabs -> {
                item { Header(ui.project, onClick = act.back) }
                item { Small(stringResource(R.string.picker_all_projects), back = true, onClick = act.allProjects) }
                if (ui.tabs.isEmpty()) item { Note(stringResource(R.string.picker_no_tabs)) }
                items(ui.tabs.size) { i ->
                    val t = ui.tabs[i]
                    // One pill per tab, its close button tucked into the pill's round end so it
                    // never meets the bezel. Morphs at the edges like the plain rows.
                    Box(
                        Modifier
                            .fillMaxWidth()
                            .transformedHeight(this, spec)
                            .graphicsLayer { with(spec) { applyContainerTransformation(scrollProgress) } },
                        contentAlignment = Alignment.CenterEnd,
                    ) {
                        ListRow(
                            label = t.label,
                            detail = if (t.active) stringResource(R.string.picker_active) else null,
                            marked = t.active,
                            contentPadding = PaddingValues(start = 14.dp, end = 46.dp, top = 6.dp, bottom = 6.dp),
                            onClick = { act.goToTab(t.id) },
                            onLongClick = { act.closeTab(t.id) },
                            onLongClickLabel = stringResource(R.string.close_tab),
                        )
                        // 32 dp to look at, 48 dp to hit.
                        FilledTonalIconButton(
                            onClick = { act.closeTab(t.id) },
                            modifier = Modifier.padding(end = 8.dp).size(IconButtonDefaults.ExtraSmallButtonSize),
                            colors = IconButtonDefaults.filledTonalIconButtonColors(
                                containerColor = Color.Black.copy(alpha = 0.35f),
                                contentColor = Forge.Ink,
                            ),
                        ) {
                            Icon(
                                Icons.Filled.Close,
                                contentDescription = stringResource(R.string.close_named, t.label),
                                modifier = Modifier.size(16.dp),
                            )
                        }
                    }
                }
                if (ui.tabs.size >= 3) {
                    item { Small(stringResource(R.string.close_other_tabs), onClick = act.closeOthers) }
                }
            }
            is PickerUi.Agents -> {
                item { Header(stringResource(R.string.picker_agent_for, ui.project), onClick = act.back) }
                item { Small(stringResource(R.string.picker_back), back = true, onClick = act.back) }
                items(ui.agents.size) { i ->
                    val a = ui.agents[i]
                    ListRow(
                        label = a.name,
                        modifier = Modifier.transformedHeight(this, spec),
                        transformation = SurfaceTransformation(spec),
                        onClick = { act.pickAgent(a.id) },
                    )
                }
            }
        }
    }

    if (ui is PickerUi.Tabs) {
        // New tab hugs the bottom curve, the Wear place for a screen's one main action.
        ScreenScaffold(
            scrollState = state,
            edgeButton = {
                EdgeButton(onClick = act.newTab, buttonSize = EdgeButtonSize.ExtraSmall) {
                    Icon(Icons.Filled.Add, contentDescription = null, modifier = Modifier.size(18.dp))
                    Text(stringResource(R.string.picker_new_tab), modifier = Modifier.padding(start = 4.dp))
                }
            },
        ) { padding ->
            TransformingLazyColumn(state = state, contentPadding = padding, content = list)
        }
    } else {
        ScreenScaffold(scrollState = state) { padding ->
            TransformingLazyColumn(state = state, contentPadding = padding, content = list)
        }
    }
}

/** The title; tapping it goes one level up. */
@Composable
internal fun Header(title: String, onClick: (() -> Unit)? = null) {
    val back = stringResource(R.string.picker_back)
    ListHeader(
        modifier = if (onClick != null) Modifier.clickable(onClickLabel = back, onClick = onClick) else Modifier,
    ) {
        Text(
            title,
            fontSize = 14.sp,
            fontWeight = FontWeight.SemiBold,
            maxLines = 2,
            overflow = TextOverflow.Ellipsis,
            textAlign = TextAlign.Center,
        )
    }
}

@Composable
internal fun Note(text: String) {
    Text(
        text,
        modifier = Modifier.fillMaxWidth(0.8f).padding(vertical = 6.dp),
        color = Forge.Muted,
        fontSize = 12.sp,
        lineHeight = 15.sp,
        textAlign = TextAlign.Center,
    )
}

/** A small secondary action: a 32 dp pill with a 48 dp tap target. */
@Composable
internal fun Small(label: String, back: Boolean = false, onClick: () -> Unit) {
    CompactButton(
        onClick = onClick,
        colors = ButtonDefaults.filledTonalButtonColors(),
        icon = if (back) {
            {
                Icon(
                    Icons.AutoMirrored.Filled.ArrowBack,
                    contentDescription = null,
                    modifier = Modifier.size(ButtonDefaults.ExtraSmallIconSize),
                )
            }
        } else null,
        label = { Text(label, fontSize = 12.sp, maxLines = 1) },
    )
}

/**
 * A list row: a 48 dp pill (the smallest safe tap), name in white, a small grey detail line under it.
 * `marked` is the current project or active tab: lime edge, and the detail says so in words.
 */
@Composable
internal fun ListRow(
    label: String,
    detail: String? = null,
    marked: Boolean = false,
    modifier: Modifier = Modifier,
    transformation: SurfaceTransformation? = null,
    contentPadding: PaddingValues = ButtonDefaults.ContentPadding,
    onClick: () -> Unit,
    onLongClick: (() -> Unit)? = null,
    onLongClickLabel: String? = null,
) {
    Button(
        onClick = onClick,
        onLongClick = onLongClick,
        onLongClickLabel = onLongClickLabel,
        modifier = modifier.fillMaxWidth().height(48.dp),
        colors = ButtonDefaults.filledTonalButtonColors(
            containerColor = if (marked) Forge.Lime.copy(alpha = 0.14f) else Forge.Well,
            contentColor = Forge.Ink,
            secondaryContentColor = if (marked) Forge.Lime else Forge.Muted,
        ),
        border = if (marked) BorderStroke(1.dp, Forge.Lime.copy(alpha = 0.6f)) else null,
        transformation = transformation,
        contentPadding = contentPadding,
        secondaryLabel = detail?.let {
            { Text(it, fontSize = 11.sp, lineHeight = 13.sp, maxLines = 1, overflow = TextOverflow.Ellipsis) }
        },
        label = {
            Text(
                label,
                fontSize = 13.sp,
                lineHeight = 16.sp,
                fontWeight = FontWeight.Medium,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
        },
    )
}
