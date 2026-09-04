package com.forge.watch

import android.app.Application

class ForgeWatchApp : Application() {
    override fun onCreate() {
        super.onCreate()
        ForgeAuth.load(this)
        ForgeLink.init(this)
        VoiceController.init(this)
    }
}
