package com.forge.watch

import android.Manifest
import android.content.Intent
import android.os.Build
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.wear.compose.material3.AppScaffold

/** Settings, more or less: the voice screen, the account, and the LTE warm-up. */
class MainActivity : ComponentActivity() {

    private val requestPermissions =
        registerForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) { }

    /** Mirrors CellularWarmupService.running, which is a plain flag, not a flow. */
    private var warmup by mutableStateOf(CellularWarmupService.running)

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        val wanted = mutableListOf(Manifest.permission.RECORD_AUDIO)
        if (Build.VERSION.SDK_INT >= 31) wanted += Manifest.permission.BLUETOOTH_CONNECT
        if (Build.VERSION.SDK_INT >= 33) wanted += Manifest.permission.POST_NOTIFICATIONS
        requestPermissions.launch(wanted.toTypedArray())

        val prefs = getSharedPreferences("forge-watch", MODE_PRIVATE)
        var auto by mutableStateOf(prefs.getBoolean(PREF_AUTO_WARMUP, true))

        setContent {
            val email by ForgeAuth.email.collectAsStateWithLifecycle()
            ForgeTheme {
                AppScaffold {
                    SettingsScreen(
                        ui = SettingsUi(email = email, warmup = warmup, autoWarmup = auto),
                        onTalk = { startActivity(Intent(this@MainActivity, DictationActivity::class.java)) },
                        onAccount = {
                            if (ForgeAuth.email.value == null) {
                                // The voice screen owns the sign-in flow; it asks on open.
                                startActivity(Intent(this@MainActivity, DictationActivity::class.java))
                            } else {
                                ForgeAuth.signOut(this@MainActivity)
                                ForgeLink.kick()
                            }
                        },
                        onWarmup = {
                            if (CellularWarmupService.running) CellularWarmupService.stop(this@MainActivity)
                            else CellularWarmupService.start(this@MainActivity)
                            // The service flips its flag synchronously in onStartCommand, but that
                            // runs after this click returns, so re-read it on the next loop pass.
                            window.decorView.post { warmup = CellularWarmupService.running }
                        },
                        onAutoWarmup = { checked ->
                            auto = checked
                            prefs.edit().putBoolean(PREF_AUTO_WARMUP, checked).apply()
                        },
                    )
                }
            }
        }
    }

    override fun onResume() {
        super.onResume()
        warmup = CellularWarmupService.running
    }

    companion object {
        const val PREF_AUTO_WARMUP = "auto_warmup"
    }
}
