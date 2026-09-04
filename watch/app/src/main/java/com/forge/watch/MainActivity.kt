package com.forge.watch

import android.Manifest
import android.content.Intent
import android.os.Build
import android.os.Bundle
import android.widget.Button
import android.widget.CheckBox
import androidx.activity.ComponentActivity
import androidx.activity.result.contract.ActivityResultContracts
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.lifecycleScope
import androidx.lifecycle.repeatOnLifecycle
import kotlinx.coroutines.flow.collectLatest
import kotlinx.coroutines.launch

/** Settings, more or less: the voice screen, the account, and the LTE warm-up. */
class MainActivity : ComponentActivity() {

    private val requestPermissions =
        registerForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) { }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)

        val wanted = mutableListOf(Manifest.permission.RECORD_AUDIO)
        if (Build.VERSION.SDK_INT >= 31) wanted += Manifest.permission.BLUETOOTH_CONNECT
        if (Build.VERSION.SDK_INT >= 33) wanted += Manifest.permission.POST_NOTIFICATIONS
        requestPermissions.launch(wanted.toTypedArray())

        findViewById<Button>(R.id.dictate).setOnClickListener {
            startActivity(Intent(this, DictationActivity::class.java))
        }

        val account = findViewById<Button>(R.id.account)
        lifecycleScope.launch {
            repeatOnLifecycle(Lifecycle.State.STARTED) {
                ForgeAuth.email.collectLatest { mail ->
                    account.text = if (mail == null) getString(R.string.sign_in) else getString(R.string.sign_out_as, mail)
                }
            }
        }
        account.setOnClickListener {
            if (ForgeAuth.email.value == null) {
                // The voice screen owns the sign-in flow; it asks on open.
                startActivity(Intent(this, DictationActivity::class.java))
            } else {
                ForgeAuth.signOut(this)
                ForgeLink.kick()
            }
        }

        val warmup = findViewById<Button>(R.id.warmup)
        fun renderWarmup() {
            warmup.setText(
                if (CellularWarmupService.running) R.string.warmup_stop else R.string.warmup_start
            )
        }
        renderWarmup()
        warmup.setOnClickListener {
            if (CellularWarmupService.running) CellularWarmupService.stop(this)
            else CellularWarmupService.start(this)
            // The service flips its flag synchronously in onStartCommand, but that
            // runs after this click returns, so re-render on the next loop pass.
            warmup.post { renderWarmup() }
        }

        val prefs = getSharedPreferences("forge-watch", MODE_PRIVATE)
        val auto = findViewById<CheckBox>(R.id.autoWarmup)
        auto.isChecked = prefs.getBoolean(PREF_AUTO_WARMUP, true)
        auto.setOnCheckedChangeListener { _, checked ->
            prefs.edit().putBoolean(PREF_AUTO_WARMUP, checked).apply()
        }
    }

    companion object {
        const val PREF_AUTO_WARMUP = "auto_warmup"
    }
}
