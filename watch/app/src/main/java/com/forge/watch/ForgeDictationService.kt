package com.forge.watch

import android.annotation.SuppressLint
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.content.pm.ServiceInfo
import android.os.Bundle
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.os.PowerManager
import android.speech.RecognitionListener
import android.speech.RecognizerIntent
import android.speech.SpeechRecognizer
import android.util.Log
import androidx.core.app.NotificationCompat
import androidx.core.app.ServiceCompat
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import java.util.Locale

/** What the screen mirrors, whether or not the activity is alive. */
object DictationState {
    val running = MutableStateFlow(false)
    /** The phrase being spoken right now. */
    val partial = MutableStateFlow("")
    /** Mic level 0..1 for the ring. */
    val level = MutableStateFlow(0f)
    /** Each finished phrase, once. VoiceController reads these. */
    val phrases = MutableSharedFlow<String>(extraBufferCapacity = 16)
    /** A sentence when the recogniser cannot work at all. */
    val problem = MutableStateFlow<String?>(null)
}

/**
 * The microphone, kept open as a foreground service so listening survives the
 * screen going dark and the wrist going down.
 *
 * The engine is DictationMic's (`DictationService` in that repo's `:core`),
 * carried over without its notes and cloud sync: Android's own SpeechRecognizer
 * ends an utterance on a natural pause, so it is restarted after every result
 * and every silence error, and a pause becomes a phrase boundary instead of an
 * ending. Each finished phrase goes out on `DictationState.phrases`; what it
 * means — a command, or words for the pane — is VoiceController's business.
 *
 * Measured on a Pixel Watch 2: the system recogniser is there, the microphone
 * opens with a real level, and back-to-back restarts work with no BUSY. There
 * is no offline model on the watch, so it recognises over the network.
 */
class ForgeDictationService : Service() {
    companion object {
        const val ACTION_START = "com.forge.watch.LISTEN"
        const val ACTION_STOP = "com.forge.watch.STOP"
        private const val CHANNEL = "forge-voice"
        private const val NOTIF_ID = 2
        private const val LOG = "ForgeWatch"
        /** Nothing said for this long: stop on our own. Long, because thinking is silence. */
        private const val SILENCE_STOP_MS = 120_000L
        /** How long the finaliser gets after a terminal word is heard in a partial. */
        private const val STOP_GRACE_MS = 900L

        fun start(ctx: Context) {
            ctx.startForegroundService(Intent(ctx, ForgeDictationService::class.java).setAction(ACTION_START))
        }

        fun stop(ctx: Context) {
            ctx.startService(Intent(ctx, ForgeDictationService::class.java).setAction(ACTION_STOP))
        }
    }

    private val main = Handler(Looper.getMainLooper())
    private var recognizer: SpeechRecognizer? = null
    private var wakeLock: PowerManager.WakeLock? = null
    @Volatile private var recording = false
    private var listening = false
    private var lastVoiceAt = 0L
    /** A terminal phrase was heard in a partial; finish on whatever comes back next. */
    private var pendingTerminal = false

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            ACTION_START -> if (!recording) startSession()
            ACTION_STOP -> stopSession()
        }
        return START_NOT_STICKY
    }

    @SuppressLint("MissingPermission", "WakelockTimeout")
    private fun startSession() {
        createChannel()
        if (checkSelfPermission(android.Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
            DictationState.problem.value = "Microphone needed"
            stopSelf()
            return
        }
        if (!SpeechRecognizer.isRecognitionAvailable(this)) {
            DictationState.problem.value = "No speech recogniser on this watch"
            stopSelf()
            return
        }
        val fg = runCatching {
            ServiceCompat.startForeground(
                this, NOTIF_ID, buildNotification(),
                ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE,
            )
        }
        if (fg.isFailure) {
            DictationState.problem.value = "Could not open the microphone"
            stopSelf()
            return
        }
        wakeLock = (getSystemService(POWER_SERVICE) as PowerManager)
            .newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "forgewatch:listen")
            .apply { acquire() }

        DictationState.problem.value = null
        DictationState.partial.value = ""
        DictationState.running.value = true
        recording = true
        pendingTerminal = false
        lastVoiceAt = System.currentTimeMillis()
        ForgeLink.setWanted("listen", true)

        main.post {
            recognizer = SpeechRecognizer.createSpeechRecognizer(this).also { it.setRecognitionListener(listener) }
            listen()
        }
    }

    private fun recognizerIntent(): Intent =
        Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH).apply {
            putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM)
            putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, true)
            putExtra(RecognizerIntent.EXTRA_LANGUAGE, Locale.getDefault().toLanguageTag())
            putExtra(RecognizerIntent.EXTRA_CALLING_PACKAGE, packageName)
        }

    private fun listen() {
        if (!recording || listening) return
        listening = true
        DictationState.partial.value = ""
        runCatching { recognizer?.startListening(recognizerIntent()) }
            .onFailure { listening = false; continueOrStop(recreate = true) }
    }

    private fun continueOrStop(recreate: Boolean) {
        if (!recording) return
        if (System.currentTimeMillis() - lastVoiceAt > SILENCE_STOP_MS) {
            stopSession(); return
        }
        if (recreate) {
            runCatching { recognizer?.destroy() }
            recognizer = null
            main.postDelayed({
                if (!recording) return@postDelayed
                recognizer = SpeechRecognizer.createSpeechRecognizer(this).also { it.setRecognitionListener(listener) }
                listen()
            }, 120)
        } else {
            main.postDelayed({ listen() }, 20)
        }
    }

    private val listener = object : RecognitionListener {
        override fun onReadyForSpeech(params: Bundle?) {}
        override fun onBeginningOfSpeech() { lastVoiceAt = System.currentTimeMillis() }

        override fun onRmsChanged(rmsdB: Float) {
            DictationState.level.value = ((rmsdB + 2f) / 12f).coerceIn(0f, 1f)
            if (rmsdB > 1.5f) lastVoiceAt = System.currentTimeMillis()
        }

        override fun onBufferReceived(buffer: ByteArray?) {}
        override fun onEndOfSpeech() { DictationState.level.value = 0f }

        override fun onPartialResults(partialResults: Bundle?) {
            firstResult(partialResults)?.let {
                DictationState.partial.value = it
                lastVoiceAt = System.currentTimeMillis()
                // "Send it" lands in a partial first. Acting on it only at the
                // final meant waiting out the end-of-speech silence — the clunk.
                if (!pendingTerminal && VoiceCommands.isTerminal(it)) {
                    pendingTerminal = true
                    runCatching { recognizer?.stopListening() }
                    main.postDelayed(stopGrace, STOP_GRACE_MS)
                }
            }
        }

        override fun onResults(results: Bundle?) {
            main.removeCallbacks(stopGrace)
            val text = firstResult(results)
            DictationState.partial.value = ""
            listening = false
            pendingTerminal = false
            if (!text.isNullOrBlank()) {
                lastVoiceAt = System.currentTimeMillis()
                DictationState.phrases.tryEmit(text)
            }
            continueOrStop(recreate = false)
        }

        override fun onError(error: Int) {
            Log.i(LOG, "recogniser error $error (${errorName(error)})")
            main.removeCallbacks(stopGrace)
            val wasTerminal = pendingTerminal
            val partial = DictationState.partial.value
            DictationState.partial.value = ""
            listening = false
            pendingTerminal = false
            // The finaliser answered a forced stop with a no-match: the partial
            // is what was said.
            if (wasTerminal && partial.isNotBlank()) DictationState.phrases.tryEmit(partial)
            if (error == SpeechRecognizer.ERROR_INSUFFICIENT_PERMISSIONS) {
                DictationState.problem.value = "Microphone is blocked"
                stopSession(); return
            }
            val recreate = error == SpeechRecognizer.ERROR_RECOGNIZER_BUSY || error == SpeechRecognizer.ERROR_CLIENT
            continueOrStop(recreate)
        }

        override fun onEvent(eventType: Int, params: Bundle?) {}
    }

    private val stopGrace = Runnable {
        if (!recording || !pendingTerminal) return@Runnable
        val partial = DictationState.partial.value
        DictationState.partial.value = ""
        listening = false
        pendingTerminal = false
        if (partial.isNotBlank()) DictationState.phrases.tryEmit(partial)
        continueOrStop(recreate = false)
    }

    private fun errorName(code: Int): String = when (code) {
        SpeechRecognizer.ERROR_NETWORK -> "network"
        SpeechRecognizer.ERROR_NETWORK_TIMEOUT -> "network timeout"
        SpeechRecognizer.ERROR_AUDIO -> "audio"
        SpeechRecognizer.ERROR_SERVER -> "server"
        SpeechRecognizer.ERROR_CLIENT -> "client"
        SpeechRecognizer.ERROR_SPEECH_TIMEOUT -> "no speech"
        SpeechRecognizer.ERROR_NO_MATCH -> "no match"
        SpeechRecognizer.ERROR_RECOGNIZER_BUSY -> "busy"
        SpeechRecognizer.ERROR_INSUFFICIENT_PERMISSIONS -> "no microphone permission"
        else -> "unknown"
    }

    private fun firstResult(b: Bundle?): String? =
        b?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)?.firstOrNull()

    private fun stopSession() {
        if (!recording) { stopSelf(); return }
        recording = false
        pendingTerminal = false
        main.removeCallbacks(stopGrace)
        main.post {
            listening = false
            runCatching { recognizer?.stopListening() }
            runCatching { recognizer?.destroy() }
            recognizer = null
        }
        DictationState.running.value = false
        DictationState.partial.value = ""
        DictationState.level.value = 0f
        ForgeLink.setWanted("listen", false)
        wakeLock?.let { if (it.isHeld) it.release() }
        wakeLock = null
        ServiceCompat.stopForeground(this, ServiceCompat.STOP_FOREGROUND_REMOVE)
        stopSelf()
    }

    override fun onDestroy() {
        recording = false
        main.post { runCatching { recognizer?.destroy() }; recognizer = null }
        wakeLock?.let { if (it.isHeld) it.release() }
        DictationState.running.value = false
        ForgeLink.setWanted("listen", false)
        super.onDestroy()
    }

    private fun createChannel() {
        getSystemService(NotificationManager::class.java).createNotificationChannel(
            NotificationChannel(CHANNEL, "Forge voice", NotificationManager.IMPORTANCE_LOW).apply {
                setSound(null, null)
                enableVibration(false)
            })
    }

    private fun buildNotification(): Notification {
        val open = PendingIntent.getActivity(
            this, 0, Intent(this, DictationActivity::class.java), PendingIntent.FLAG_IMMUTABLE)
        val stop = PendingIntent.getService(
            this, 1, Intent(this, ForgeDictationService::class.java).setAction(ACTION_STOP), PendingIntent.FLAG_IMMUTABLE)
        return NotificationCompat.Builder(this, CHANNEL)
            .setSmallIcon(android.R.drawable.ic_btn_speak_now)
            .setContentTitle("Forge is listening")
            .setOngoing(true)
            .setSilent(true)
            .setContentIntent(open)
            .addAction(0, "Stop", stop)
            .build()
    }
}
