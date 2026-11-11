package com.forge.bubble.bubble

import android.view.View
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleOwner
import androidx.lifecycle.LifecycleRegistry
import androidx.lifecycle.ViewModelStore
import androidx.lifecycle.ViewModelStoreOwner
import androidx.lifecycle.setViewTreeLifecycleOwner
import androidx.lifecycle.setViewTreeViewModelStoreOwner
import androidx.savedstate.SavedStateRegistry
import androidx.savedstate.SavedStateRegistryController
import androidx.savedstate.SavedStateRegistryOwner
import androidx.savedstate.setViewTreeSavedStateRegistryOwner

/**
 * The lifecycle a ComposeView needs when a Service, not an Activity, hosts it
 * in a WindowManager overlay. Without these three owners on the view tree
 * Compose throws on attach. The service drives it: [start] to RESUMED when the
 * service is created, [destroy] when it goes.
 */
class OverlayOwner : LifecycleOwner, SavedStateRegistryOwner, ViewModelStoreOwner {
  private val registry = LifecycleRegistry(this)
  private val saved = SavedStateRegistryController.create(this)
  private val store = ViewModelStore()

  override val lifecycle: Lifecycle get() = registry
  override val savedStateRegistry: SavedStateRegistry get() = saved.savedStateRegistry
  override val viewModelStore: ViewModelStore get() = store

  fun start() {
    saved.performAttach()
    saved.performRestore(null)
    registry.currentState = Lifecycle.State.RESUMED
  }

  fun destroy() {
    registry.currentState = Lifecycle.State.DESTROYED
    store.clear()
  }

  /** Call on the root view of each overlay window before adding it. */
  fun attach(root: View) {
    root.setViewTreeLifecycleOwner(this)
    root.setViewTreeSavedStateRegistryOwner(this)
    root.setViewTreeViewModelStoreOwner(this)
  }
}
