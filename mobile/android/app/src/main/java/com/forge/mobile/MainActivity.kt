package com.forge.mobile

import android.os.Bundle
import com.getcapacitor.BridgeActivity

/**
 * Replaces the generated MainActivity (scripts/apk-init.mjs copies this in)
 * for one reason: Capacitor 7 discovers npm-installed plugins on its own, but
 * a plugin that lives inside the app — which is what ForgeUpdater is — must be
 * registered by hand, and it must happen *before* super.onCreate() builds the
 * bridge or the WebView side calls into a plugin that does not exist.
 */
class MainActivity : BridgeActivity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    registerPlugin(ForgeUpdaterPlugin::class.java)
    super.onCreate(savedInstanceState)
  }
}
