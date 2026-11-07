package com.forge.hands

import android.Manifest
import android.app.Activity
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.content.res.ColorStateList
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.graphics.drawable.RippleDrawable
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.PowerManager
import android.provider.Settings
import android.text.InputType
import android.util.TypedValue
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.view.inputmethod.EditorInfo
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.Switch
import android.widget.TextView

/**
 * The one screen. Every row says what is true right now in words, with one
 * button that fixes it. The screen owns nothing: it reads ForgeHands state on
 * a one-second tick while it is open, and pairing is ForgeHandsPairing's.
 *
 * A link never pairs on its own: any web page or message can carry one, and
 * pairing hands the phone to whatever host it names. A tapped
 * forgehands://pair link opens this screen on a card, "Pair with this PC?",
 * with the desk address on its own line and Pair / Not now; a pasted link gets
 * the same card. If the link was copied rather than tapped, the screen finds it
 * on the clipboard when it gains focus (Android 10+ only lets the focused app
 * read the clipboard) and offers the same card as "Pair with the copied link?".
 * Only the card's Pair button calls startPair. If the link names a different
 * host than the saved desk, the card says it replaces that PC, and a
 * successful pairing turns "Let Forge use this phone" off (ForgeHandsPairing).
 *
 * Framework views only — no WebView, no Capacitor, no UI library.
 */
class SetupActivity : Activity() {

  companion object {
    private const val REQ_CONTACTS = 1
    private const val REQ_NOTIFICATIONS = 2
    private const val UI_PREFS = "forge_hands_ui"
    private const val KEY_LAST_CODE = "lastOfferedCode"
    private const val STATE_LINK_HANDLED = "linkHandled"
    private const val STATE_OFFERED = "offeredLink"
    private const val STATE_OFFERED_CLIP = "offeredFromClipboard"

    private const val BG = 0xFF0F1115.toInt()
    private const val CARD = 0xFF181B21.toInt()
    private const val CARD_EDGE = 0xFF252932.toInt()
    private const val TEXT = 0xFFE8EAED.toInt()
    private const val MUTED = 0xFF9AA0A6.toInt()
    private const val ACCENT = 0xFFF2A541.toInt()
    private const val GOOD = 0xFF5FD38D.toInt()
    private const val BAD = 0xFFFF8A80.toInt()
    private const val WAIT = 0xFFF2C14E.toInt()
    private const val BUTTON = 0xFF2A2F38.toInt()
  }

  private val main = Handler(Looper.getMainLooper())
  private var resumed = false
  private var pairing = false
  private var renderingSwitch = false

  private lateinit var scroller: ScrollView
  private lateinit var resultView: TextView
  private lateinit var pairCard: LinearLayout
  private lateinit var pairText: TextView
  /** The link on the confirm card, waiting for Pair; null when no card shows. */
  private var offered: ForgeHandsPairing.Link? = null
  private var offeredRaw: String? = null
  private var offeredFromClipboard = false

  private lateinit var enabledSwitch: Switch
  private lateinit var enabledRow: Row
  private lateinit var deskRow: Row
  private lateinit var pairRow: Row
  private lateinit var pasteField: EditText
  private lateinit var a11yRow: Row
  private lateinit var listenerRow: Row
  private lateinit var contactsRow: Row
  private lateinit var postRow: Row
  private lateinit var batteryRow: Row

  private val tick = object : Runnable {
    override fun run() {
      render()
      if (resumed) main.postDelayed(this, 1000)
    }
  }

  /* ------------------------------------------------------------ lifecycle */

  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    setContentView(buildScreen())
    val fromHistory = (intent.flags and Intent.FLAG_ACTIVITY_LAUNCHED_FROM_HISTORY) != 0
    if (savedInstanceState?.getBoolean(STATE_LINK_HANDLED) != true && !fromHistory) handleLink(intent)
    // A rotation keeps a waiting card as a card: it still pairs only on Pair.
    savedInstanceState?.getString(STATE_OFFERED)?.let { raw ->
      ForgeHandsPairing.parse(raw)?.let { offerPair(it, raw, savedInstanceState.getBoolean(STATE_OFFERED_CLIP)) }
    }
  }

  override fun onNewIntent(intent: Intent) {
    super.onNewIntent(intent)
    setIntent(intent)
    handleLink(intent)
  }

  override fun onSaveInstanceState(outState: Bundle) {
    super.onSaveInstanceState(outState)
    // The link in the launching intent is spent once handled: a rotation or a
    // restore after the process died must not offer it again.
    outState.putBoolean(STATE_LINK_HANDLED, true)
    // Only a rotation (not a restart) brings a waiting card back.
    if (isChangingConfigurations) offeredRaw?.let {
      outState.putString(STATE_OFFERED, it)
      outState.putBoolean(STATE_OFFERED_CLIP, offeredFromClipboard)
    }
  }

  override fun onResume() {
    super.onResume()
    resumed = true
    main.removeCallbacks(tick)
    main.post(tick)
  }

  override fun onPause() {
    resumed = false
    main.removeCallbacks(tick)
    super.onPause()
  }

  override fun onWindowFocusChanged(hasFocus: Boolean) {
    super.onWindowFocusChanged(hasFocus)
    if (hasFocus) offerClipboardLink()
  }

  override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<out String>, grantResults: IntArray) {
    super.onRequestPermissionsResult(requestCode, permissions, grantResults)
    val granted = grantResults.isNotEmpty() && grantResults[0] == PackageManager.PERMISSION_GRANTED
    val perm = permissions.firstOrNull()
    if (!granted && perm != null && !shouldShowRequestPermissionRationale(perm)) {
      // Android will not ask again after "Don't allow" twice: App info is the only way left.
      showResult("Android will not ask again. Open App info > Permissions and allow it there.", BAD)
    }
    ForgeHands.notifyStatus(this)
    render()
  }

  /* --------------------------------------------------------------- pairing */

  private fun handleLink(intent: Intent?) {
    val data = intent?.data ?: return
    if (!"forgehands".equals(data.scheme, ignoreCase = true)) return
    val link = ForgeHandsPairing.parse(data.toString())
    if (link == null) {
      showResult("That is not a complete Forge Hands pairing link. Ask Forge for a new one.", BAD)
      return
    }
    offerPair(link, data.toString(), fromClipboard = false)
  }

  private fun offerClipboardLink() {
    if (pairing) return
    // A tapped or pasted link is waiting on the card: the clipboard does not replace it.
    if (offered != null && !offeredFromClipboard) return
    val clip = try {
      (getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager).primaryClip
    } catch (_: Throwable) { null }
    val text = clip?.takeIf { it.itemCount > 0 }?.getItemAt(0)?.coerceToText(this)?.toString()
    val link = ForgeHandsPairing.parse(text)
    if (text == null || link == null || link.code == uiPrefs().getString(KEY_LAST_CODE, "")) {
      hideOffer()
      return
    }
    offerPair(link, text.trim(), fromClipboard = true)
  }

  /**
   * Show the confirm card for [link]: the desk address on its own line, and a
   * plain warning when it would replace the saved desk. Nothing is paired or
   * stored here; only the card's Pair button pairs.
   */
  private fun offerPair(link: ForgeHandsPairing.Link, raw: String, fromClipboard: Boolean) {
    if (pairing) return
    offered = link
    offeredRaw = raw
    offeredFromClipboard = fromClipboard
    val lines = mutableListOf(
      if (fromClipboard) "Pair with the copied link?" else "Pair with this PC?",
      ForgeHandsPairing.address(link)
    )
    val saved = ForgeHands.origin(this)
    if (ForgeHandsPairing.replacesDesk(saved, link)) {
      val host = ForgeHandsPairing.hostOf(saved)
      val name = ForgeHands.desktopName(this)
      lines += "This replaces your current PC: ${if (name.isEmpty()) host else "$name ($host)"}. " +
        "\"Let Forge use this phone\" will turn off; turn it on again when you are ready."
    }
    pairText.text = lines.joinToString("\n")
    pairCard.visibility = View.VISIBLE
    scroller.post { scroller.smoothScrollTo(0, 0) }
  }

  private fun hideOffer() {
    offered = null
    offeredRaw = null
    offeredFromClipboard = false
    pairCard.visibility = View.GONE
  }

  /** Pair with [link]. Called only from the confirm card's Pair button. */
  private fun startPair(link: ForgeHandsPairing.Link) {
    if (pairing) return
    // Decided before pairing, from the desk saved now; ForgeHandsPairing turns
    // the switch off by the same rule just before it stores the new desk.
    val replaces = ForgeHandsPairing.replacesDesk(ForgeHands.origin(this), link)
    pairing = true
    // Remember the code either way: it is single-use, so never offer it twice.
    uiPrefs().edit().putString(KEY_LAST_CODE, link.code).apply()
    hideOffer()
    showResult("Pairing with ${ForgeHandsPairing.address(link)}…", WAIT)
    render()
    ForgeHandsPairing.pair(this, link) { problem ->
      pairing = false
      if (problem == null) {
        val desk = ForgeHands.desktopName(this).ifEmpty { link.host }
        val next = when {
          replaces -> "This is a new PC, so \"Let Forge use this phone\" is off. Turn it on when you are ready."
          ForgeHands.isEnabled(this) -> "Forge Hands is connecting now."
          else -> "Turn on \"Let Forge use this phone\" when you are ready."
        }
        showResult("Paired with $desk. $next", GOOD)
        pasteField.setText("")
        ForgeHandsService.reconnect(this)
      } else {
        showResult(problem, BAD)
      }
      render()
    }
  }

  private fun uiPrefs() = getSharedPreferences(UI_PREFS, Context.MODE_PRIVATE)

  /* ---------------------------------------------------------------- render */

  private fun render() {
    if (!::enabledSwitch.isInitialized) return
    val s = ForgeHands.status(this)
    val paired = ForgeHands.deviceToken(this).isNotEmpty()
    val desk = ForgeHands.desktopName(this).ifEmpty { ForgeHandsPairing.hostOf(ForgeHands.origin(this)) }.ifEmpty { "the desk" }

    renderingSwitch = true
    enabledSwitch.isChecked = s.enabled
    renderingSwitch = false
    enabledRow.status(
      if (s.enabled) "On. Forge agents can operate this phone." else "Off. Forge cannot touch this phone.",
      if (s.enabled) GOOD else MUTED
    )

    val note = ForgeHands.linkNote
    when {
      !paired -> deskRow.status(note.ifEmpty { "Not paired. Pair below first." }, BAD)
      ForgeHands.linked -> deskRow.status("Connected to $desk.", GOOD)
      !s.enabled && !ForgeHandsService.alive -> deskRow.status("Not connected. The switch above is off.", MUTED)
      else -> deskRow.status(note.ifEmpty { "Not connected. Trying to reach $desk…" }, WAIT)
    }
    deskRow.button.visibility = if (paired) View.VISIBLE else View.GONE

    pairRow.status(
      when {
        pairing -> "Pairing…"
        paired -> "Paired with $desk (${ForgeHandsPairing.hostOf(ForgeHands.origin(this))})."
        else -> "Not paired. Tap the Forge Hands link Forge gives you, or paste it here."
      },
      if (pairing) WAIT else if (paired) GOOD else BAD
    )
    pairRow.button.isEnabled = !pairing
    pairRow.button.alpha = if (pairing) 0.5f else 1f

    a11yRow.grant(s.accessibility, "On. Forge Hands can see and tap the screen.", "Off. Turn on Forge Hands in Accessibility.")
    listenerRow.grant(s.notifications, "On. Forge Hands can read and answer notifications.", "Off. Turn on Forge Hands in Notification access.")
    contactsRow.grant(s.contacts, "Allowed. Forge can look up a number by name.", "Not allowed.")
    postRow.grant(hasPostNotifications(), "Allowed. The \"Forge can use this phone\" notice shows.", "Not allowed. Android hides the ongoing notice.")
    batteryRow.grant(isBatteryUnrestricted(), "Unrestricted. The link stays up with the screen off.", "Restricted. Android may cut the link when idle.")
  }

  private fun showResult(text: String, color: Int) {
    resultView.text = text
    resultView.setTextColor(color)
    resultView.visibility = View.VISIBLE
  }

  /* --------------------------------------------------------------- actions */

  private fun openSettings(intent: Intent) {
    try {
      startActivity(intent)
    } catch (_: Throwable) {
      showResult("Could not open that settings screen. Open Settings and search for it.", BAD)
    }
  }

  private fun openAppInfo() = openSettings(
    Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:$packageName"))
  )

  private fun requestContacts() {
    if (ForgeHands.hasContacts(this)) { openAppInfo(); return }
    requestPermissions(arrayOf(Manifest.permission.READ_CONTACTS), REQ_CONTACTS)
  }

  private fun requestPostNotifications() {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU || hasPostNotifications()) { openAppInfo(); return }
    requestPermissions(arrayOf(Manifest.permission.POST_NOTIFICATIONS), REQ_NOTIFICATIONS)
  }

  private fun requestBattery() {
    if (isBatteryUnrestricted()) {
      openSettings(Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS))
      return
    }
    @Suppress("BatteryLife")
    openSettings(Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS, Uri.parse("package:$packageName")))
  }

  private fun hasPostNotifications(): Boolean {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) return true
    return checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED
  }

  private fun isBatteryUnrestricted(): Boolean =
    getSystemService(PowerManager::class.java)?.isIgnoringBatteryOptimizations(packageName) ?: false

  /* ---------------------------------------------------------------- views */

  private fun buildScreen(): View {
    val column = LinearLayout(this).apply {
      orientation = LinearLayout.VERTICAL
      setPadding(dp(20), dp(28), dp(20), dp(32))
    }

    column.addView(text("Forge Hands", 26f, TEXT, bold = true))
    column.addView(text(
      "Lets Forge agents on your PC use this phone. Set it up once; after that it runs in the background.",
      14f, MUTED
    ).apply { setPadding(0, dp(6), 0, dp(12)) })

    resultView = text("", 14f, TEXT).apply {
      visibility = View.GONE
      background = rounded(CARD, CARD_EDGE)
      setPadding(dp(14), dp(12), dp(14), dp(12))
    }
    column.addView(resultView, spaced())

    // The confirm card: every link (tapped, pasted, copied) waits here for Pair.
    pairCard = card().apply { visibility = View.GONE }
    pairText = text("", 15f, TEXT)
    pairCard.addView(pairText)
    val pairButtons = LinearLayout(this).apply {
      orientation = LinearLayout.HORIZONTAL
      gravity = Gravity.END
      setPadding(0, dp(10), 0, 0)
    }
    pairButtons.addView(pill("Not now", primary = false) {
      // Not offered again from the clipboard; nothing else changes.
      offered?.let { uiPrefs().edit().putString(KEY_LAST_CODE, it.code).apply() }
      hideOffer()
    })
    pairButtons.addView(space(dp(8)))
    pairButtons.addView(pill("Pair") { offered?.let { startPair(it) } })
    pairCard.addView(pairButtons)
    column.addView(pairCard, spaced())

    column.addView(section("Control"))

    enabledSwitch = Switch(this).apply {
      setOnCheckedChangeListener { _, on ->
        if (renderingSwitch) return@setOnCheckedChangeListener
        ForgeHands.setEnabled(this@SetupActivity, on)
        render()
      }
    }
    enabledRow = Row("Let Forge use this phone", enabledSwitch)
    column.addView(enabledRow.view, spaced())

    deskRow = Row("Desk link", pill("Reconnect") {
      if (!ForgeHands.isEnabled(this) && !ForgeHandsService.alive) {
        showResult("Turn on \"Let Forge use this phone\" first.", MUTED)
      } else {
        ForgeHandsService.reconnect(this)
      }
    })
    column.addView(deskRow.view, spaced())

    pasteField = EditText(this).apply {
      hint = "Paste link (forgehands://pair?…)"
      setHintTextColor(MUTED)
      setTextColor(TEXT)
      textSize = 14f
      isSingleLine = true
      inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_URI
      imeOptions = EditorInfo.IME_ACTION_GO
      backgroundTintList = ColorStateList.valueOf(MUTED)
      setOnEditorActionListener { _, _, _ -> pairFromField(); true }
    }
    pairRow = Row("Pair", pill("Pair") { pairFromField() }, extra = pasteField)
    column.addView(pairRow.view, spaced())

    column.addView(section("Permissions (once)"))

    a11yRow = Row("Accessibility", pill("Open") { openSettings(Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS)) })
    listenerRow = Row("Notification access", pill("Open") {
      openSettings(Intent(Settings.ACTION_NOTIFICATION_LISTENER_SETTINGS))
    })
    contactsRow = Row("Contacts", pill("Allow") { requestContacts() })
    postRow = Row("Notifications", pill("Allow") { requestPostNotifications() })
    batteryRow = Row("Battery unrestricted", pill("Allow") { requestBattery() })
    for (row in listOf(a11yRow, listenerRow, contactsRow, postRow, batteryRow)) column.addView(row.view, spaced())

    val help = card()
    help.addView(text("Android says \"Restricted setting\"?", 15f, TEXT, bold = true))
    help.addView(text(
      "Android blocks Accessibility and Notification access for apps installed from a file. " +
        "Try to turn the setting on once, then open App info, tap ⋮ (top right), tap " +
        "\"Allow restricted settings\", confirm, and turn the setting on again.",
      13f, MUTED
    ).apply { setPadding(0, dp(6), 0, dp(10)) })
    help.addView(pill("App info") { openAppInfo() }, LinearLayout.LayoutParams(
      ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT
    ).apply { gravity = Gravity.END })
    column.addView(help, spaced())

    column.addView(text(
      "${ForgeHands.deviceName(this)} · v${ForgeHands.version(this)}",
      12f, MUTED
    ).apply { setPadding(0, dp(16), 0, 0); gravity = Gravity.CENTER_HORIZONTAL })

    scroller = ScrollView(this).apply {
      setBackgroundColor(BG)
      isFillViewport = true
      addView(column)
    }
    return scroller
  }

  private fun pairFromField() {
    val raw = pasteField.text?.toString().orEmpty()
    if (raw.isBlank()) {
      showResult("Paste the forgehands://pair link Forge gave you into the box first.", BAD)
      return
    }
    if (raw.trim().startsWith("forge://", ignoreCase = true)) {
      showResult("That is a Forge Mobile link. Ask Forge for a Forge Hands link instead (phone_pair).", BAD)
      return
    }
    val link = ForgeHandsPairing.parse(raw)
    if (link == null) {
      showResult("That is not a complete Forge Hands pairing link. It starts forgehands://pair?", BAD)
      return
    }
    offerPair(link, raw.trim(), fromClipboard = false)
  }

  /** One card: title, a dot + words for the state, and its control on the right. */
  private inner class Row(title: String, val button: View, extra: View? = null) {
    val view: LinearLayout = card()
    private val statusText: TextView = text("", 13f, MUTED)
    private val dot: View = View(this@SetupActivity)

    init {
      val top = LinearLayout(this@SetupActivity).apply {
        orientation = LinearLayout.HORIZONTAL
        gravity = Gravity.CENTER_VERTICAL
      }
      val words = LinearLayout(this@SetupActivity).apply { orientation = LinearLayout.VERTICAL }
      words.addView(text(title, 16f, TEXT, bold = true))
      val line = LinearLayout(this@SetupActivity).apply {
        orientation = LinearLayout.HORIZONTAL
        gravity = Gravity.CENTER_VERTICAL
        setPadding(0, dp(4), 0, 0)
      }
      dot.background = GradientDrawable().apply { shape = GradientDrawable.OVAL; setColor(MUTED) }
      line.addView(dot, LinearLayout.LayoutParams(dp(8), dp(8)).apply { marginEnd = dp(8) })
      line.addView(statusText, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f))
      words.addView(line)
      top.addView(words, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f))
      top.addView(space(dp(12)))
      top.addView(button)
      view.addView(top)
      if (extra != null) view.addView(extra, LinearLayout.LayoutParams(
        ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT
      ).apply { topMargin = dp(8) })
    }

    fun status(words: String, color: Int) {
      statusText.text = words
      (dot.background as GradientDrawable).setColor(color)
    }

    /** A permission row: green with a quiet button when granted, red with a bright one when not. */
    fun grant(ok: Boolean, yes: String, no: String) {
      status(if (ok) yes else no, if (ok) GOOD else BAD)
      (button as? TextView)?.let {
        it.text = if (ok) "Change" else (it.tag as? String ?: "Open")
        it.setTextColor(if (ok) MUTED else ACCENT)
      }
    }
  }

  private fun card(): LinearLayout = LinearLayout(this).apply {
    orientation = LinearLayout.VERTICAL
    background = rounded(CARD, CARD_EDGE)
    setPadding(dp(16), dp(14), dp(16), dp(14))
  }

  private fun section(title: String): TextView = text(title.uppercase(), 12f, MUTED, bold = true).apply {
    letterSpacing = 0.08f
    setPadding(dp(4), dp(18), 0, dp(8))
  }

  private fun text(value: String, sizeSp: Float, color: Int, bold: Boolean = false): TextView =
    TextView(this).apply {
      text = value
      textSize = sizeSp
      setTextColor(color)
      if (bold) typeface = Typeface.create("sans-serif-medium", Typeface.NORMAL)
      setLineSpacing(0f, 1.15f)
    }

  /** A pill button. Its first label is kept in `tag` so grant() can restore it. */
  private fun pill(label: String, primary: Boolean = true, onClick: () -> Unit): TextView =
    TextView(this).apply {
      text = label
      tag = label
      textSize = 14f
      setTextColor(if (primary) ACCENT else MUTED)
      typeface = Typeface.create("sans-serif-medium", Typeface.NORMAL)
      gravity = Gravity.CENTER
      minWidth = dp(76)
      setPadding(dp(16), dp(9), dp(16), dp(9))
      background = RippleDrawable(
        ColorStateList.valueOf(0x33F2A541),
        GradientDrawable().apply { cornerRadius = dp(20).toFloat(); setColor(BUTTON) },
        null
      )
      isClickable = true
      isFocusable = true
      setOnClickListener { onClick() }
    }

  private fun rounded(fill: Int, edge: Int) = GradientDrawable().apply {
    cornerRadius = dp(14).toFloat()
    setColor(fill)
    setStroke(dp(1), edge)
  }

  private fun space(width: Int) = View(this).apply { layoutParams = LinearLayout.LayoutParams(width, 1) }

  private fun spaced() = LinearLayout.LayoutParams(
    ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT
  ).apply { bottomMargin = dp(10) }

  private fun dp(v: Int): Int =
    TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, v.toFloat(), resources.displayMetrics).toInt()
}
