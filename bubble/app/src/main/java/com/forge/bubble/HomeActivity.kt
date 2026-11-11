package com.forge.bubble

import android.app.Activity
import android.content.Intent
import android.os.Bundle
import com.forge.bubble.bubble.BubbleService
import com.forge.bubble.setup.SetupActivity
import com.forge.bubble.store.Prefs
import com.google.androidbrowserhelper.trusted.LauncherActivity

/**
 * The launcher icon. Until setup is finished it opens the setup screen; after
 * that it opens Forge Web in the Trusted Web Activity. Either way it makes sure
 * the bubble service is running when "Bubble on" is set. No UI of its own.
 */
class HomeActivity : Activity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    if (Prefs.bubbleOn(this)) BubbleService.start(this)
    val next = if (Prefs.setupDone(this)) LauncherActivity::class.java else SetupActivity::class.java
    startActivity(Intent(this, next))
    finish()
  }
}
