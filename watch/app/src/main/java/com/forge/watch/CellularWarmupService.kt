package com.forge.watch

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import android.net.NetworkRequest
import android.os.IBinder
import android.util.Log

/**
 * Holds a TRANSPORT_CELLULAR network request so the modem attaches (and stays
 * attached) instead of waiting for the OS to notice the phone is gone. This is
 * what cuts the ~1 minute Bluetooth-to-LTE switchover: the Bluetooth
 * link-supervision timeout and the modem's cold attach both happen while the
 * request is held, not after.
 *
 * Battery cost is real while running — this is meant to be held only while a
 * Forge session is active or briefly after phone loss, not all day.
 */
class CellularWarmupService : Service() {

    private var callback: ConnectivityManager.NetworkCallback? = null

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == ACTION_STOP) {
            running = false
            stopSelf()
            return START_NOT_STICKY
        }

        running = true
        startForeground(
            NOTIFICATION_ID,
            buildNotification(),
            ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE,
        )

        if (callback == null) {
            val cm = getSystemService(ConnectivityManager::class.java)
            val request = NetworkRequest.Builder()
                .addTransportType(NetworkCapabilities.TRANSPORT_CELLULAR)
                .addCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
                .build()
            callback = object : ConnectivityManager.NetworkCallback() {
                override fun onAvailable(network: Network) {
                    Log.i(TAG, "cellular up: $network")
                }

                override fun onLost(network: Network) {
                    Log.i(TAG, "cellular lost: $network")
                }
            }.also { cm.requestNetwork(request, it) }
        }
        return START_STICKY
    }

    override fun onDestroy() {
        callback?.let { getSystemService(ConnectivityManager::class.java).unregisterNetworkCallback(it) }
        callback = null
        running = false
        super.onDestroy()
    }

    private fun buildNotification(): Notification {
        val manager = getSystemService(NotificationManager::class.java)
        manager.createNotificationChannel(
            NotificationChannel(CHANNEL_ID, "LTE warm-up", NotificationManager.IMPORTANCE_LOW),
        )
        return Notification.Builder(this, CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_launcher)
            .setContentTitle(getString(R.string.warmup_notification_title))
            .setContentText(getString(R.string.warmup_notification_text))
            .setOngoing(true)
            .build()
    }

    companion object {
        private const val TAG = "CellularWarmup"
        private const val CHANNEL_ID = "lte-warmup"
        private const val NOTIFICATION_ID = 1

        private const val ACTION_STOP = "com.forge.watch.WARMUP_STOP"

        /** Best-effort UI flag; the service runs in this same process. */
        @Volatile
        var running = false
            internal set

        fun start(context: Context) {
            context.startForegroundService(Intent(context, CellularWarmupService::class.java))
        }

        fun stop(context: Context) {
            context.startService(
                Intent(context, CellularWarmupService::class.java).setAction(ACTION_STOP),
            )
        }
    }
}
