package com.forge.watch

import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.wear.compose.foundation.LocalReduceMotion
import androidx.wear.compose.foundation.lazy.rememberTransformingLazyColumnState
import androidx.wear.compose.material3.AppScaffold
import com.github.takahirom.roborazzi.RoborazziOptions
import com.github.takahirom.roborazzi.captureRoboImage
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode
import java.io.File

/**
 * Pictures of every screen on a round 384 px face (Pixel Watch 2: 192 dp, xhdpi), from
 * fake state. Opt-in, so the grammar tests stay quick:
 *
 *   ./gradlew :app:testDebugUnitTest -Pforge.shots=<folder>
 */
@RunWith(RobolectricTestRunner::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(sdk = [35], qualifiers = "w192dp-h192dp-round-xhdpi")
class ScreensScreenshotTest {

    private val dir = File(System.getProperty("forge.shots") ?: "build/forge-shots")
    private val crop = RoborazziOptions(recordOptions = RoborazziOptions.RecordOptions(applyDeviceCrop = true))

    /** Reduced motion holds the mic's breathing still, so the picture is one frame. */
    private fun shot(name: String, content: @Composable () -> Unit) =
        captureRoboImage(File(dir, "$name.png"), crop) {
            CompositionLocalProvider(LocalReduceMotion provides true) { ForgeTheme { content() } }
        }

    @Composable private fun voice(ui: VoiceUi) = VoiceScreen(ui, onMic = {}, onSend = {}, onClear = {}, onStatus = {}, onSettings = {})

    private val live = VoiceUi(
        status = "forge · tab 2 login fix",
        live = true,
        mic = Mic.IDLE,
        level = 0f,
        draft = "",
        partial = "",
        notice = "",
    )

    @Test fun voiceIdle() = shot("voice-1-idle") { voice(live) }

    @Test fun voiceListening() = shot("voice-2-listening") {
        voice(live.copy(mic = Mic.LISTENING, level = 0.6f, partial = "and check the settings page", notice = "Ready. Talk."))
    }

    @Test fun voiceDraft() = shot("voice-3-draft") {
        voice(
            live.copy(
                mic = Mic.LISTENING,
                level = 0.15f,
                draft = "fix the login bug on the settings page and add a test",
            ),
        )
    }

    @Test fun voiceLongDraft() = shot("voice-4-long-draft") {
        voice(
            live.copy(
                mic = Mic.LISTENING,
                level = 0.35f,
                draft = "the login form on the settings page loses the email when the password is wrong " +
                    "so keep the email and only clear the password then add a test that types a wrong " +
                    "password and checks the email is still there",
                partial = "and run the whole suite",
            ),
        )
    }

    @Test fun voicePin() = shot("voice-5-pin") {
        voice(live.copy(status = "Tap to enter PIN", live = false, notice = "The desktop wants its PIN"))
    }

    @Test fun voiceOffline() = shot("voice-6-offline-mic-off") {
        voice(
            live.copy(
                status = "Desktop is off",
                live = false,
                mic = Mic.OFF,
                draft = "fix the login bug",
                notice = "Microphone is blocked",
            ),
        )
    }

    private val actions = PickerActions({}, {}, {}, {}, {}, {}, {}, {})

    @Test fun pickerProjects() = shot("picker-1-projects") {
        AppScaffold {
            PickerScreen(
                PickerUi.Projects(
                    listOf(
                        ProjectRow("1", "forge", 3, current = true),
                        ProjectRow("2", "car-harness", 1, current = false),
                        ProjectRow("3", "Dealer Ledger Pro", 0, current = false),
                        ProjectRow("4", "DictationMic", 2, current = false),
                    ),
                ),
                actions,
            )
        }
    }

    @Test fun pickerTabs() = shot("picker-2-tabs") {
        AppScaffold {
            PickerScreen(
                PickerUi.Tabs(
                    "forge",
                    listOf(
                        TabRow("a", "1 · Claude Code", active = false),
                        TabRow("b", "2 · login fix", active = true),
                        TabRow("c", "3 · Codex", active = false),
                    ),
                ),
                actions,
            )
        }
    }

    @Test fun pickerAgents() = shot("picker-3-agents") {
        AppScaffold {
            PickerScreen(
                PickerUi.Agents(
                    "forge",
                    listOf(
                        ForgeLink.Profile("cc", "Claude Code"),
                        ForgeLink.Profile("cx", "Codex"),
                        ForgeLink.Profile("ps", "PowerShell"),
                    ),
                ),
                actions,
            )
        }
    }

    @Test fun pickerOffline() = shot("picker-4-offline") {
        AppScaffold { PickerScreen(PickerUi.Offline, actions) }
    }

    @Test fun settings() = shot("settings-1") {
        AppScaffold {
            SettingsScreen(
                SettingsUi(email = "steve@example.com", warmup = false, autoWarmup = true),
                onTalk = {},
                onAccount = {},
                onWarmup = {},
                onAutoWarmup = {},
            )
        }
    }

    @Test fun settingsScrolled() = shot("settings-2-scrolled") {
        AppScaffold {
            SettingsScreen(
                SettingsUi(email = "steve@example.com", warmup = true, autoWarmup = true),
                onTalk = {},
                onAccount = {},
                onWarmup = {},
                onAutoWarmup = {},
                state = rememberTransformingLazyColumnState(initialAnchorItemIndex = 3),
            )
        }
    }
}
