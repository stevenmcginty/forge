package com.forge.watch

import android.bluetooth.BluetoothDevice
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

/**
 * Reacts to the paired phone appearing/disappearing on Bluetooth. On
 * disconnect, starts the cellular warm-up so LTE is already attached by the
 * time the OS would have begun its own (slow) failover. On reconnect, releases
 * it to save battery.
 *
 * TODO: filter to the actual companion phone's BluetoothDevice address instead
 * of reacting to any ACL event (e.g. earbuds disconnecting).
 */
class BluetoothReceiver : BroadcastReceiver() {

    override fun onReceive(context: Context, intent: Intent) {
        val prefs = context.getSharedPreferences("forge-watch", Context.MODE_PRIVATE)
        if (!prefs.getBoolean(MainActivity.PREF_AUTO_WARMUP, true)) return

        when (intent.action) {
            BluetoothDevice.ACTION_ACL_DISCONNECTED -> CellularWarmupService.start(context)
            BluetoothDevice.ACTION_ACL_CONNECTED -> CellularWarmupService.stop(context)
        }
    }
}
