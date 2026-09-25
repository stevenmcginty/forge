package com.forge.watch

import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.size
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.wear.compose.foundation.lazy.TransformingLazyColumn
import androidx.wear.compose.foundation.lazy.TransformingLazyColumnState
import androidx.wear.compose.foundation.lazy.rememberTransformingLazyColumnState
import androidx.wear.compose.material3.Button
import androidx.wear.compose.material3.ButtonDefaults
import androidx.wear.compose.material3.LocalContentColor
import androidx.wear.compose.material3.ScreenScaffold
import androidx.wear.compose.material3.SurfaceTransformation
import androidx.wear.compose.material3.SwitchButton
import androidx.wear.compose.material3.Text
import androidx.wear.compose.material3.lazy.rememberTransformationSpec
import androidx.wear.compose.material3.lazy.transformedHeight

data class SettingsUi(
    /** Signed-in Forge Web account, or null. */
    val email: String?,
    /** The LTE warm-up service is holding the modem on. */
    val warmup: Boolean,
    val autoWarmup: Boolean,
)

/** Settings, more or less: the voice screen, the account, and the LTE warm-up. */
@Composable
fun SettingsScreen(
    ui: SettingsUi,
    onTalk: () -> Unit,
    onAccount: () -> Unit,
    onWarmup: () -> Unit,
    onAutoWarmup: (Boolean) -> Unit,
    state: TransformingLazyColumnState = rememberTransformingLazyColumnState(),
) {
    val spec = rememberTransformationSpec()
    ScreenScaffold(scrollState = state) { padding ->
        TransformingLazyColumn(state = state, contentPadding = padding) {
            item { Header(stringResource(R.string.app_name)) }
            item {
                Button(
                    onClick = onTalk,
                    modifier = Modifier.transformedHeight(this, spec).fillMaxWidth().height(48.dp),
                    transformation = SurfaceTransformation(spec),
                    icon = {
                        MicGlyph(
                            color = LocalContentColor.current,
                            struck = false,
                            cut = Color.Transparent,
                            modifier = Modifier.size(ButtonDefaults.IconSize),
                        )
                    },
                    label = { Text(stringResource(R.string.dictate), fontSize = 13.sp, fontWeight = FontWeight.SemiBold) },
                )
            }
            item {
                ListRow(
                    label = stringResource(if (ui.email == null) R.string.sign_in else R.string.sign_out),
                    detail = ui.email ?: stringResource(R.string.not_signed_in),
                    modifier = Modifier.transformedHeight(this, spec),
                    transformation = SurfaceTransformation(spec),
                    onClick = onAccount,
                )
            }
            item {
                ListRow(
                    label = stringResource(if (ui.warmup) R.string.warmup_stop else R.string.warmup_start),
                    detail = stringResource(if (ui.warmup) R.string.warmup_on else R.string.warmup_off),
                    marked = ui.warmup,
                    modifier = Modifier.transformedHeight(this, spec),
                    transformation = SurfaceTransformation(spec),
                    onClick = onWarmup,
                )
            }
            item {
                SwitchButton(
                    checked = ui.autoWarmup,
                    onCheckedChange = onAutoWarmup,
                    modifier = Modifier.transformedHeight(this, spec).fillMaxWidth(),
                    transformation = SurfaceTransformation(spec),
                    secondaryLabel = {
                        Text(
                            stringResource(if (ui.autoWarmup) R.string.auto_warmup_on else R.string.off),
                            fontSize = 11.sp,
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis,
                        )
                    },
                    label = {
                        Text(
                            stringResource(R.string.auto_warmup),
                            fontSize = 13.sp,
                            lineHeight = 16.sp,
                            maxLines = 2,
                            overflow = TextOverflow.Ellipsis,
                        )
                    },
                )
            }
        }
    }
}
