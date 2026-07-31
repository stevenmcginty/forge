package com.forge.mobile

import android.app.DownloadManager
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.provider.Settings
import androidx.core.content.FileProvider
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import java.io.File
import java.io.FileInputStream
import java.security.MessageDigest

/**
 * The native half of self-update. An APK not from a store can only be replaced
 * by handing Android a new APK file and asking; this plugin owns the three
 * steps of that — download, verify, hand over — and nothing else. Deciding
 * *whether* to update stays in TypeScript (src/lib/update.ts), where the
 * manifest and the version comparison live.
 *
 * Download goes through Android's DownloadManager rather than a socket we own:
 * it survives the app being backgrounded mid-download (likely — the user just
 * tapped "update", why would they stare at it), retries over network blips,
 * and shows the system progress notification for free. Progress and completion
 * are read by *polling* its query API — DownloadManager does broadcast
 * completion, but a poller is needed for progress anyway and one mechanism
 * that also sees completion beats two that can disagree (and skips the
 * receiver-export flags that shifted across API 26–35).
 *
 * The SHA-256 check is the line that must not be crossed: this APK unlocks a
 * shell as Steve, and the manifest (fetched over TLS from the release) is the
 * root of trust for what the binary should be. A file that does not hash to
 * the manifest's answer is deleted and reported loudly — never offered to the
 * installer. Beyond that, Android itself refuses any update not signed with
 * the same key as the installed app, which is why scripts/apk-build.mjs
 * guards the release keystore so carefully.
 */
@CapacitorPlugin(name = "ForgeUpdater")
class ForgeUpdaterPlugin : Plugin() {

  private val poller = Handler(Looper.getMainLooper())

  /**
   * On API 26+ installing from an app needs a per-app user grant. Reported as
   * a fact for the UI to act on rather than checked lazily inside install(),
   * so the "allow installs from Forge" step can be shown *before* a 30 MB
   * download instead of as a surprise after it.
   */
  @PluginMethod
  fun canInstall(call: PluginCall) {
    val allowed = Build.VERSION.SDK_INT < Build.VERSION_CODES.O ||
      context.packageManager.canRequestPackageInstalls()
    val out = JSObject()
    out.put("allowed", allowed)
    call.resolve(out)
  }

  /**
   * Opens this app's own "install unknown apps" settings screen. Android
   * offers no dialog for this permission — settings is the only road, and
   * sending the user there beats failing mutely.
   */
  @PluginMethod
  fun requestInstallPermission(call: PluginCall) {
    try {
      val intent = Intent(
        Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
        Uri.parse("package:" + context.packageName)
      )
      intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
      context.startActivity(intent)
      call.resolve()
    } catch (e: Exception) {
      call.reject("Could not open the install-permission settings.", "settings-unavailable")
    }
  }

  /**
   * Download `url` and verify it against `sha256` before reporting success.
   * Resolves with the verified file's path; emits "downloadProgress" events
   * (received/total bytes) while it runs. Any rejection here is a signal for
   * the JS side to fall back to the browser download.
   */
  @PluginMethod
  fun download(call: PluginCall) {
    val url = call.getString("url")
    val expectedSha = call.getString("sha256")?.lowercase()
    if (url.isNullOrEmpty() || expectedSha.isNullOrEmpty()) {
      call.reject("download() needs both url and sha256.", "bad-args")
      return
    }

    val base = context.getExternalFilesDir(null)
    if (base == null) {
      call.reject("No external files dir on this device.", "no-storage")
      return
    }
    // A stale half-file from a previous attempt must not be what gets hashed.
    val target = File(File(base, "updates"), "forge-update.apk")
    target.parentFile?.mkdirs()
    if (target.exists()) target.delete()

    val manager = context.getSystemService(Context.DOWNLOAD_SERVICE) as? DownloadManager
    if (manager == null) {
      call.reject("DownloadManager is unavailable.", "download-unavailable")
      return
    }

    val id: Long
    try {
      val request = DownloadManager.Request(Uri.parse(url))
        .setTitle("Forge update")
        .setDestinationInExternalFilesDir(context, null, "updates/forge-update.apk")
        .setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE)
      id = manager.enqueue(request)
    } catch (e: Exception) {
      // The Download Manager system app can be disabled by the user; enqueue
      // is where that surfaces.
      call.reject("Could not start the download.", "download-unavailable")
      return
    }

    val tick = object : Runnable {
      override fun run() {
        val cursor = manager.query(DownloadManager.Query().setFilterById(id))
        if (cursor == null || !cursor.moveToFirst()) {
          // The row vanishing means the user cancelled it from the
          // notification shade — an answer, not an error to retry.
          cursor?.close()
          call.reject("Download cancelled.", "cancelled")
          return
        }
        val status = cursor.getInt(cursor.getColumnIndexOrThrow(DownloadManager.COLUMN_STATUS))
        val received = cursor.getLong(cursor.getColumnIndexOrThrow(DownloadManager.COLUMN_BYTES_DOWNLOADED_SO_FAR))
        val total = cursor.getLong(cursor.getColumnIndexOrThrow(DownloadManager.COLUMN_TOTAL_SIZE_BYTES))
        cursor.close()

        when (status) {
          DownloadManager.STATUS_SUCCESSFUL -> verify(call, target, expectedSha)
          DownloadManager.STATUS_FAILED -> {
            manager.remove(id)
            call.reject("The download failed.", "download-failed")
          }
          else -> {
            val progress = JSObject()
            progress.put("received", received)
            progress.put("total", total)
            notifyListeners("downloadProgress", progress)
            poller.postDelayed(this, 400L)
          }
        }
      }
    }
    poller.post(tick)
  }

  /** Hash off the main thread — the file is tens of megabytes. */
  private fun verify(call: PluginCall, file: File, expectedSha: String) {
    Thread {
      val actual = try {
        sha256Of(file)
      } catch (e: Exception) {
        ""
      }
      if (actual != expectedSha) {
        // A wrong hash means the bytes on disk are not the bytes the release
        // published — truncation, a captive portal, or worse. The file must
        // not survive to be install()ed later, and the failure must be loud.
        file.delete()
        call.reject(
          "Downloaded file failed its integrity check and was deleted. Expected sha256 $expectedSha, got ${if (actual.isEmpty()) "unreadable" else actual}.",
          "checksum-mismatch"
        )
        return@Thread
      }
      val out = JSObject()
      out.put("path", file.absolutePath)
      call.resolve(out)
    }.start()
  }

  /**
   * Hand a *verified* file to Android's installer. The path must be one
   * download() resolved with; the FileProvider (declared in the manifest,
   * paths in res/xml) is what lets the system installer read a file inside
   * this app's private dir — plain file:// URIs have been refused since N.
   */
  @PluginMethod
  fun install(call: PluginCall) {
    val path = call.getString("path")
    if (path.isNullOrEmpty()) {
      call.reject("install() needs the path download() returned.", "bad-args")
      return
    }
    val file = File(path)
    if (!file.exists()) {
      call.reject("The downloaded file is gone — download it again.", "file-missing")
      return
    }
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O &&
      !context.packageManager.canRequestPackageInstalls()
    ) {
      // Not a dead end: the JS side answers this code by calling
      // requestInstallPermission() and re-trying install().
      call.reject("Installing from Forge is not yet allowed on this phone.", "needs-permission")
      return
    }
    try {
      val uri = FileProvider.getUriForFile(context, context.packageName + ".fileprovider", file)
      val intent = Intent(Intent.ACTION_VIEW)
        .setDataAndType(uri, "application/vnd.android.package-archive")
        .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_ACTIVITY_NEW_TASK)
      context.startActivity(intent)
      call.resolve()
    } catch (e: Exception) {
      call.reject("Could not start the installer: ${e.message}", "install-failed")
    }
  }

  /**
   * The last-resort path: open the APK's URL in the system browser so Chrome
   * downloads it and the user taps the notification to install. Every failure
   * above funnels here from JS, so the update button always does *something*.
   */
  @PluginMethod
  fun openExternal(call: PluginCall) {
    val url = call.getString("url")
    if (url.isNullOrEmpty()) {
      call.reject("openExternal() needs a url.", "bad-args")
      return
    }
    try {
      val intent = Intent(Intent.ACTION_VIEW, Uri.parse(url))
      intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
      context.startActivity(intent)
      call.resolve()
    } catch (e: Exception) {
      call.reject("No browser could open that URL.", "no-browser")
    }
  }

  private fun sha256Of(file: File): String {
    val digest = MessageDigest.getInstance("SHA-256")
    FileInputStream(file).use { stream ->
      val buffer = ByteArray(64 * 1024)
      while (true) {
        val read = stream.read(buffer)
        if (read <= 0) break
        digest.update(buffer, 0, read)
      }
    }
    return digest.digest().joinToString("") { "%02x".format(it) }
  }
}
