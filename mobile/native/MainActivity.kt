package com.forge.mobile

import android.annotation.SuppressLint
import android.graphics.Color
import android.graphics.drawable.GradientDrawable
import android.os.Bundle
import android.util.TypedValue
import android.view.Gravity
import android.view.KeyEvent
import android.view.View
import android.view.ViewGroup
import android.view.WindowManager
import android.webkit.CookieManager
import android.webkit.JavascriptInterface
import android.webkit.WebChromeClient
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.TextView
import com.getcapacitor.BridgeActivity
import com.getcapacitor.WebViewListener
import org.json.JSONObject

/**
 * Replaces the generated MainActivity (scripts/apk-init.mjs copies this in)
 * for four reasons.
 *
 * **Plugin registration.** Capacitor 7 discovers npm-installed plugins on its
 * own, but a plugin that lives inside the app — which is what ForgeUpdater is —
 * must be registered by hand, and it must happen *before* super.onCreate()
 * builds the bridge or the WebView side calls into a plugin that does not
 * exist.
 *
 * **The TV remote's Back button.** A Fire TV remote sends the D-pad as arrow
 * keys and Enter, which reach the page as ordinary key events, but Back is not
 * a key at all — Android turns it into `onBackPressed()`, and the default
 * answer to that is to finish the activity. On the TV dashboard Back means
 * "close the zoomed pane", so this hands the press to the page as an Escape
 * keydown first and only falls back to leaving the app when the page did not
 * take it. See mobile/src/components/TvDashboard.tsx, whose zoomed pane is the
 * only thing that listens for Escape.
 *
 * **A television that has to play video and stay awake.** The screen mirror
 * (mobile/src/components/TvDashboard.tsx) puts a WebRTC MediaStream into a
 * <video> that nobody can tap, so both of Android's defaults are wrong for it:
 * a WebView will not start media without a user gesture, and a panel with no
 * touch events on it goes to sleep. Both are answered in onCreate below.
 *
 * **The television's second half.** On the TV build the activity is not one
 * WebView but two side by side: Forge's wall, and YouTube's own leanback
 * interface at youtube.com/tv. See TvPanels below for why that is a native
 * split rather than an iframe, and for what the remote does with it.
 *
 * All four are gated on the application id, because the TV APK is the build
 * that gets the `.tv` suffix (scripts/apk-tv-build.mjs, `-PforgeTv`). Ungated,
 * the Back handling would make the phone's Back button depend on no phone
 * screen ever calling preventDefault on an Escape it happens to receive — a
 * coupling that would be invisible until the day it broke — the phone would
 * silently gain an autoplay policy and a screen that never dims, and a handset
 * would find half of itself given over to a television.
 */
class MainActivity : BridgeActivity() {
  /** The split, or null on the phone build. Everything TV-shaped hangs off it. */
  private var panels: TvPanels? = null

  override fun onCreate(savedInstanceState: Bundle?) {
    registerPlugin(ForgeUpdaterPlugin::class.java)
    super.onCreate(savedInstanceState)
    if (!packageName.endsWith(TV_SUFFIX)) return

    // Autoplay, for a screen with nothing to tap.
    //
    // A WebView blocks media from starting until a user gesture, and `muted`
    // does not buy an exemption the way it does in a browser. The mirror's
    // <video> is filled by WebRTC and has to play the moment the track lands,
    // so the policy is turned off here rather than worked around in JS. After
    // super.onCreate(), because that is what builds the bridge and its WebView.
    bridge?.webView?.settings?.mediaPlaybackRequiresUserGesture = false

    // And the panel must not fall asleep over a stream nobody is touching.
    //
    // Deliberately not the JS Wake Lock API: that is a secure-context call with
    // patchy WebView support, and this app has already been bitten by exactly
    // that class of bug (see the crypto.randomUUID comment in
    // mobile/src/lib/link.ts). A window flag is one line and cannot be
    // undefined at runtime. On the whole activity rather than only while the
    // mirror is open, because the wall is a dashboard that is meant to be
    // looked at too — a Fire Stick dimming over it is the same complaint.
    window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)

    // `bridge.webView` is non-null by here unless the device has no WebView at
    // all, in which case BridgeActivity has already shown its no_webview screen
    // and there is nothing to split.
    val forge = bridge?.webView ?: return
    val built = TvPanels(this, forge)
    panels = built
    setContentView(built.root)

    // The seam the web layer publishes on (mobile/src/lib/tv-bridge.ts). The
    // interface goes on *this* WebView only — it loads nothing but our own
    // bundle from https://localhost, which is the trust Capacitor's own bridge
    // already runs on. The YouTube WebView never gets one.
    forge.addJavascriptInterface(built.jsBridge, JS_BRIDGE_NAME)
    bridge?.addWebViewListener(object : WebViewListener() {
      override fun onPageLoaded(webView: WebView) {
        webView.evaluateJavascript(SUBSCRIBE_TO_TV_EVENTS, null)
      }
    })
  }

  /**
   * Menu cycles the layout, a held Left or Right crosses between the panels,
   * and everything else goes to whichever panel is lit.
   *
   * All of it is here rather than in `onKeyDown` because the alternative is
   * arguing with the focus system about a WebView that wants every key it can
   * see. Dispatching to the YouTube WebView by hand is a fact; hoping Android's
   * focus search lands on it is not.
   *
   * ## The transport buttons are the panel controls
   *
   * Rewind and Fast-Forward do not belong to either page — nothing in the wall
   * or in youtube.com/tv reads them for navigation — so they are the one pair
   * of keys that can mean the same thing in every mode without taking anything
   * away. **Rewind steps toward Forge, Fast-Forward steps toward YouTube**,
   * along the one line the four modes sit on:
   *
   *     Forge alone — split, Forge lit — split, YouTube lit — YouTube alone
   *
   * so two presses of Rewind gets to the wall from anywhere, and two of
   * Fast-Forward gets to a full-screen video. Menu walks the same line and
   * wraps, for a remote whose owner has found one button rather than three.
   *
   * A held Left or Right does the same step. That is a convenience and not the
   * mechanism: the obvious grammar — tap Left at the left edge of the
   * right-hand panel and hop out — needs to know the panel is at its edge, and
   * youtube.com/tv never says. It consumes every arrow to walk its own shelves,
   * so there is no *tap* left over to mean "leave". A hold collides with
   * nothing, because it is an extra repeat of a key the panel has already acted
   * on.
   *
   * Play/Pause always goes to YouTube, from either side, because that is the
   * only panel that has anything to pause. Held, it mutes it instead.
   */
  override fun dispatchKeyEvent(event: KeyEvent): Boolean {
    val split = panels ?: return super.dispatchKeyEvent(event)
    val down = event.action == KeyEvent.ACTION_DOWN
    val tap = down && event.repeatCount == 0
    // Exactly on the HOLD_REPEATS'th repeat, so one hold fires once however
    // long it is held for.
    val held = down && event.repeatCount == HOLD_REPEATS

    // The wall is driving the desktop's mouse, so the D-pad is a mouse and not
    // a navigation ring. Every key goes to the page untouched except the two
    // transport buttons below, which are the way out of a mode whose own keys
    // are all spoken for. See `controlling` and the 'control' event in
    // mobile/src/lib/tv-bridge.ts.
    if (split.controlling && !split.youtubeIsLit) {
      when (event.keyCode) {
        KeyEvent.KEYCODE_MEDIA_REWIND -> {
          if (tap) split.step(towardYouTube = false)
          return true
        }
        KeyEvent.KEYCODE_MEDIA_FAST_FORWARD -> {
          if (tap) split.step(towardYouTube = true)
          return true
        }
        // Menu is the one button the pointer wants and cannot otherwise have:
        // six keys reach the page and all six are already spoken for, so the
        // scroll toggle has to come from somewhere the page never sees. Handed
        // over as ContextMenu, which is what a WebView calls this key.
        KeyEvent.KEYCODE_MENU -> {
          if (event.action == KeyEvent.ACTION_UP) split.pressInPage("ContextMenu")
          return true
        }
      }
      if (isRemoteKey(event.keyCode)) return split.route(event)
      return super.dispatchKeyEvent(event)
    }

    when (event.keyCode) {
      KeyEvent.KEYCODE_MENU -> {
        // On the up stroke, so holding the button does not run the whole cycle.
        if (event.action == KeyEvent.ACTION_UP) split.cycle()
        return true
      }

      KeyEvent.KEYCODE_MEDIA_REWIND -> {
        if (tap) split.step(towardYouTube = false)
        return true
      }

      KeyEvent.KEYCODE_MEDIA_FAST_FORWARD -> {
        if (tap) split.step(towardYouTube = true)
        return true
      }

      KeyEvent.KEYCODE_MEDIA_PLAY_PAUSE, KeyEvent.KEYCODE_MEDIA_PLAY, KeyEvent.KEYCODE_MEDIA_PAUSE -> {
        if (held) split.toggleMute() else split.youtube.dispatchKeyEvent(event)
        return true
      }

      KeyEvent.KEYCODE_DPAD_LEFT, KeyEvent.KEYCODE_DPAD_RIGHT ->
        if (held) {
          split.step(towardYouTube = event.keyCode == KeyEvent.KEYCODE_DPAD_RIGHT)
          return true
        }
    }

    if (isRemoteKey(event.keyCode)) return split.route(event)
    return super.dispatchKeyEvent(event)
  }

  override fun onBackPressed() {
    val split = panels
    if (split != null && split.youtubeIsLit) {
      // Back belongs to YouTube while YouTube is lit. It is the only way out of
      // a video and back up through its menus, so it is offered to the page
      // first, then to the WebView's history, and only reaches this app when
      // neither had anywhere to go. Swapping panels on Back — which is what
      // this did before — made the interface a place you could enter and not
      // leave. Crossing panels is Rewind and Fast-Forward's job now.
      split.back { split.show(TvMode.FORGE_SPLIT) }
      return
    }

    val webView = if (packageName.endsWith(TV_SUFFIX)) bridge?.webView else null
    if (webView == null) {
      defaultBack()
      return
    }
    // `dispatchEvent` answers false when a listener called preventDefault, i.e.
    // the page consumed the press. Anything else — true, null, an evaluation
    // that failed — is treated as "not consumed", so a broken bridge leaves the
    // remote's Back working the way Android intended rather than dead.
    webView.evaluateJavascript(BACK_AS_ESCAPE) { result ->
      if (result?.trim() != "false") defaultBack()
    }
  }

  /**
   * Cookies are what "signed in to YouTube" is made of, and Android only
   * guarantees they reach disk when it is asked. Flushed on the way out of the
   * foreground rather than in onDestroy, because a Fire Stick is unplugged at
   * the wall far more often than it is closed politely.
   */
  override fun onPause() {
    super.onPause()
    if (panels != null) CookieManager.getInstance().flush()
  }

  /**
   * The behaviour we are replacing, kept callable from the evaluateJavascript
   * callback — Kotlin will not take a `super` call from inside a lambda.
   */
  @Suppress("DEPRECATION")
  private fun defaultBack() {
    super.onBackPressed()
  }

  private companion object {
    /** Matches the applicationId scripts/apk-tv-build.mjs builds under. */
    const val TV_SUFFIX = ".tv"

    /** Cancelable, or preventDefault would have nothing to cancel and the
     *  dispatch would always report the press as unconsumed. */
    const val BACK_AS_ESCAPE =
      "(function(){return window.dispatchEvent(new KeyboardEvent('keydown'," +
        "{key:'Escape',code:'Escape',bubbles:true,cancelable:true}))})()"

    /** The name the injected listener below calls. Nothing else uses it. */
    const val JS_BRIDGE_NAME = "ForgeTvNative"

    /**
     * Which auto-repeat of Left or Right counts as "held".
     *
     * Android sends the first repeat about 400ms after the key goes down, which
     * is past anything anyone taps by accident and short of the pause that
     * makes a remote feel broken. Matched exactly rather than with `>=`, so one
     * hold crosses once however long it is held for.
     */
    const val HOLD_REPEATS = 1

    /**
     * The whole of the native layer's half of mobile/src/lib/tv-bridge.ts: one
     * `forge:tv` listener that forwards `event.detail` as JSON.
     *
     * Injected on every page load and guarded by a flag, because a reload would
     * otherwise stack listeners — and because injecting twice has to be as safe
     * as injecting once, which is what lets this run unconditionally.
     */
    const val SUBSCRIBE_TO_TV_EVENTS =
      "(function(){" +
        "if(window.__forgeTvBridged)return;" +
        "if(typeof $JS_BRIDGE_NAME==='undefined')return;" +
        "window.__forgeTvBridged=true;" +
        "window.addEventListener('forge:tv',function(e){" +
        "try{$JS_BRIDGE_NAME.notify(JSON.stringify(e.detail))}catch(err){}" +
        "});" +
        "})()"

    /**
     * The remote's navigation ring, which is the only thing routed by which
     * panel is lit. The transport buttons are handled above and never reach
     * here, because they mean the same thing wherever the light is.
     */
    fun isRemoteKey(code: Int): Boolean =
      code == KeyEvent.KEYCODE_DPAD_UP ||
        code == KeyEvent.KEYCODE_DPAD_DOWN ||
        code == KeyEvent.KEYCODE_DPAD_LEFT ||
        code == KeyEvent.KEYCODE_DPAD_RIGHT ||
        code == KeyEvent.KEYCODE_DPAD_CENTER ||
        code == KeyEvent.KEYCODE_ENTER
  }
}

/** Which panel is lit, and how much of the screen each one gets. */
enum class TvMode {
  /** Both panels, the wall lit. Where the app opens. */
  FORGE_SPLIT,

  /** Both panels, YouTube lit — the state the remote drives a video from. */
  YOUTUBE_SPLIT,

  /** YouTube alone. The only state a toast is worth interrupting. */
  YOUTUBE_FULL,

  /** The wall alone, which is what the TV build was before there was a video. */
  FORGE_FULL
}

/**
 * Forge on one side of the television, YouTube on the other.
 *
 * ## Why two native WebViews and not one page with an iframe
 *
 * youtube.com refuses to be framed, and an embedded player cannot be signed in
 * — so the account, the subscriptions and the watch history all disappear the
 * moment YouTube is something Forge renders rather than something that sits
 * beside it. A second WebView is also the only way to give one side a user
 * agent the other does not have, which is the entire trick below.
 *
 * ## The user agent
 *
 * `https://www.youtube.com/tv` serves the leanback (TV) interface only to
 * clients it recognises as televisions or consoles, and it is famously fussy
 * about which. The string below is the one VacuumTube arrived at after a lot of
 * trial and error (github.com/shy1132/VacuumTube, src/index.js): `Mozilla/5.0`
 * so YouTube treats the client as a full browser, `(PS4; Leanback Shell)` from
 * the PlayStation 4 YouTube app because it draws the most current interface,
 * and a Cobalt version — Cobalt being the browser YouTube's own TV app runs
 * inside — new enough for that interface and old enough not to trip playback.
 * The `ForgeTV` tail is so YouTube's own logging can tell what this is; it is
 * not load-bearing.
 *
 * Signing in never loads a Google account page: the leanback interface offers
 * an activation code, typed into youtube.com/activate on a phone. That is the
 * whole reason this is worth doing at all — a television with a D-pad cannot
 * type a password.
 *
 * ## The remote
 *
 * The four modes sit on a line, and two buttons walk it:
 *
 *     Forge alone — split, Forge lit — split, YouTube lit — YouTube alone
 *
 * **Rewind** steps left, **Fast-Forward** steps right, **Menu** steps right and
 * wraps. Holding the D-pad's Left or Right does the same step. Play/Pause goes
 * to YouTube from either side; held, it mutes it. See
 * MainActivity.dispatchKeyEvent for why the transport buttons carry this and
 * the D-pad only helps.
 *
 * **Back belongs to whichever panel is lit** and never moves the light. On the
 * YouTube side it is offered to the page, then to that WebView's history, and
 * only when neither has anywhere to go does it come back to this class — which
 * is what makes the leanback interface something you can walk into and out of.
 *
 * The navigation ring goes to whichever panel is lit: Forge's WebView gets it
 * as an ordinary key event (TvDashboard listens for arrows and Enter), and
 * YouTube's gets it dispatched natively, which is exactly what the leanback
 * interface expects — it was built for a D-pad.
 *
 * Which panel is lit is shown as a border, not a glow and not a dimming of the
 * other: from a sofa, a two-state colour change on a thick edge is the cue that
 * survives being seen out of the corner of an eye. Every change also flashes a
 * line naming the mode and the button that leaves it, because a television has
 * no place to put a manual.
 */
@SuppressLint("SetJavaScriptEnabled")
class TvPanels(private val activity: MainActivity, private val forge: WebView) {

  /** The YouTube side. Visible to the activity, which dispatches keys into it. */
  val youtube = WebView(activity)

  private val forgeFrame = FrameLayout(activity)
  private val youtubeFrame = FrameLayout(activity)
  private val toast = TextView(activity)
  private val modeLabel = TextView(activity)
  private val mutedCue = TextView(activity)
  private var mode = TvMode.FORGE_SPLIT
  /** Whether the YouTube WebView is currently stopped. See `quieten`. */
  private var youtubeQuiet = false

  /**
   * Is the wall driving the desktop's pointer right now?
   *
   * Told by the page, on both edges (see the 'control' event in
   * mobile/src/lib/tv-bridge.ts). It changes what the remote means: a held Left
   * or Right stops crossing between the panels — that press is the cursor
   * moving — and Menu stops cycling the layout so the pointer can use it to
   * toggle scrolling.
   *
   * Deliberately *not* cleared when YouTube takes the light — it is ignored
   * instead (see the guard in dispatchKeyEvent). Clearing it would leave the
   * two layers disagreeing the moment the wall was lit again: this side back to
   * cycling panels, the page still holding a cursor. The page owns this fact
   * and says when it changes; this side only ever repeats it.
   */
  var controlling = false
    private set
  /** Whether YouTube's sound is off. Survives navigation; see `applyMute`. */
  private var muted = false

  /** The activity's whole content view. */
  val root = FrameLayout(activity)

  /** Is the lit panel YouTube's? Decides where the D-pad and Back go. */
  val youtubeIsLit: Boolean
    get() = mode == TvMode.YOUTUBE_SPLIT || mode == TvMode.YOUTUBE_FULL

  init {
    // Capacitor put the WebView in a CoordinatorLayout of its own; it has to
    // leave that before it can join this one, and its layout params go with it.
    (forge.parent as? ViewGroup)?.removeView(forge)
    forge.layoutParams = fill()
    forgeFrame.addView(forge)

    youtubeFrame.addView(youtube, sixteenByNine())
    // youtube.com/tv draws its interface into a 16:9 box and letterboxes the
    // rest itself, in its own near-black — which in a tall half-screen panel is
    // most of the panel, and reads as a shrunken page inside grey margins. So
    // the WebView *is* the 16:9 box: it is given the panel's width and exactly
    // the height that implies, centred, and the surround is the app's own black.
    // Nothing is scaled down, and full screen comes out exact, because a
    // television is already 16:9.
    youtubeFrame.addOnLayoutChangeListener { _, left, _, right, _, _, _, _, _ ->
      val width = right - left - youtubeFrame.paddingLeft - youtubeFrame.paddingRight
      val wanted = width * 9 / 16
      val params = youtube.layoutParams as FrameLayout.LayoutParams
      if (width > 0 && params.height != wanted) {
        params.height = wanted
        youtube.layoutParams = params
      }
    }
    configureYouTube()

    val split = LinearLayout(activity)
    split.orientation = LinearLayout.HORIZONTAL
    split.addView(forgeFrame, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.MATCH_PARENT, 1f))
    split.addView(youtubeFrame, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.MATCH_PARENT, 1f))

    root.setBackgroundColor(INK_BLACK)
    root.addView(split, fill())
    root.addView(toast, toastLayout())
    root.addView(modeLabel, labelLayout())
    youtubeFrame.addView(mutedCue, cueLayout())
    dressToast()
    dressLabel()
    dressCue()

    show(TvMode.FORGE_SPLIT)
  }

  /* ---------------------------------------------------------- the layout */

  /** The four modes in order, Forge at one end and YouTube at the other. */
  private val line = listOf(TvMode.FORGE_FULL, TvMode.FORGE_SPLIT, TvMode.YOUTUBE_SPLIT, TvMode.YOUTUBE_FULL)

  /** Menu: one step toward YouTube, wrapping round to the wall at the end. */
  fun cycle() {
    show(line[(line.indexOf(mode) + 1) % line.size])
  }

  /**
   * Rewind and Fast-Forward: one step along the line, stopping at its ends.
   *
   * Stopping rather than wrapping is what makes the pair honest — holding
   * Rewind lands on the wall and stays there, instead of shooting past it into
   * a full-screen video.
   */
  fun step(towardYouTube: Boolean) {
    val next = line.indexOf(mode) + if (towardYouTube) 1 else -1
    show(line[next.coerceIn(0, line.size - 1)])
  }

  /**
   * Send the D-pad to the lit panel, by hand.
   *
   * Not left to Android's focus system, which is the bug this replaced: a
   * WebView takes focus whenever its page asks for it, and youtube.com/tv asks
   * constantly, so the border said Forge while the arrows walked YouTube's
   * shelves. Dispatching to the panel the border points at makes the two the
   * same fact rather than two hopes.
   */
  fun route(event: KeyEvent): Boolean = (if (youtubeIsLit) youtube else forge).dispatchKeyEvent(event)

  /**
   * Press a key inside the wall's page that no remote can send it.
   *
   * One `keydown`, dispatched on `window` where the dashboard's own listeners
   * are. Quoted rather than interpolated at the call site would be safer still,
   * but the only caller passes a constant from this file — the day that stops
   * being true, this needs `JSONObject.quote` around it, exactly like
   * `searchForDesktops` does with what it collects off the network.
   */
  fun pressInPage(key: String) {
    forge.evaluateJavascript(
      "window.dispatchEvent(new KeyboardEvent('keydown'," +
        "{key:'$key',code:'$key',bubbles:true,cancelable:true}))",
      null
    )
  }

  /** The page picked the pointer up, or put it down. See `controlling`. */
  fun setControlling(on: Boolean) {
    controlling = on
  }

  /**
   * Back, while YouTube is lit: the page first, its history second, and only
   * then `atRoot` — which is the app deciding what Back means once YouTube has
   * said it has nowhere left to go.
   *
   * Asynchronous because that is what `evaluateJavascript` is; the callback
   * lands on the UI thread, so everything it touches is safe to touch.
   */
  fun back(atRoot: () -> Unit) {
    youtube.evaluateJavascript(BACK_INTO_YOUTUBE) { answer ->
      when {
        answer != null && answer.contains("page") -> Unit
        answer != null && answer.contains("history") -> Unit
        youtube.canGoBack() -> youtube.goBack()
        else -> atRoot()
      }
    }
  }

  fun show(next: TvMode) {
    mode = next
    val both = next == TvMode.FORGE_SPLIT || next == TvMode.YOUTUBE_SPLIT
    forgeFrame.visibility = if (both || next == TvMode.FORGE_FULL) View.VISIBLE else View.GONE
    youtubeFrame.visibility = if (both || next == TvMode.YOUTUBE_FULL) View.VISIBLE else View.GONE

    // A border only means anything while there is another panel to be told
    // apart from; alone on the screen a frame loses its edge, because the edge
    // of the picture is already the edge of the picture.
    //
    // A stroke and not a fill. The YouTube panel is a 16:9 box in a taller
    // column, so whatever colour the frame is painted shows in the space above
    // and below it — and painted volt, that is a bright green surface across a
    // third of the television. Volt is a hairline in this design and nothing
    // else, so the frame's ground is the same near-black as the wall's and only
    // its outline carries the light.
    forgeFrame.background = frameEdge(lit = both && !youtubeIsLit, drawn = both)
    youtubeFrame.background = frameEdge(lit = both && youtubeIsLit, drawn = both)
    val edge = if (both) BORDER_PX else 0
    forgeFrame.setPadding(edge, edge, edge, edge)
    youtubeFrame.setPadding(edge, edge, edge, edge)

    // Focus follows the light. Belt to the braces of routing every arrow by
    // hand (see `route`): the unlit panel is made unfocusable so that its page
    // cannot take the focus back the moment it feels like it, which is what
    // youtube.com/tv does on every navigation.
    val lit = if (youtubeIsLit) youtube else forge
    val dim = if (youtubeIsLit) forge else youtube
    dim.isFocusable = false
    dim.isFocusableInTouchMode = false
    dim.clearFocus()
    lit.isFocusable = true
    lit.isFocusableInTouchMode = true
    lit.requestFocus()

    // Nothing of YouTube is left running behind the wall when the wall is the
    // whole screen: a Fire Stick has one small processor, and a leanback page
    // that goes on animating a shelf nobody can see is spending it. A GONE
    // WebView is still attached, so it can still be told.
    quieten(next == TvMode.FORGE_FULL)

    // Leaving a toast up through a layout change would mean a message about a
    // pane arriving over the wall that is already showing it in more detail.
    if (mode != TvMode.YOUTUBE_FULL) toast.visibility = View.GONE

    flashLabel()
  }

  /**
   * Stop the YouTube WebView, or start it again.
   *
   * `onPause` is the per-WebView one — deliberately not `pauseTimers`, which is
   * process-wide and would freeze the wall's own clock along with it. The
   * explicit `pause()` on any <video> first, because stopping a WebView is not
   * documented to stop sound coming out of it, and a television still talking
   * about a video it is not showing is the worst version of this.
   */
  private fun quieten(quiet: Boolean) {
    if (quiet == youtubeQuiet) return
    youtubeQuiet = quiet
    if (quiet) {
      youtube.evaluateJavascript(PAUSE_ANY_VIDEO, null)
      youtube.onPause()
    } else {
      youtube.onResume()
    }
  }

  /* ------------------------------------------------------------- YouTube */

  private fun configureYouTube() {
    val settings = youtube.settings
    settings.javaScriptEnabled = true
    settings.domStorageEnabled = true
    // Leanback starts playing the moment a video is chosen, and on a television
    // the choosing *is* the gesture — there is no second tap to wait for. It is
    // also what lets a video flung from a phone start on its own.
    settings.mediaPlaybackRequiresUserGesture = false
    settings.userAgentString = YOUTUBE_UA
    // No `<meta viewport>` on a page written for a 1920x1080 television, so
    // without these the leanback interface would lay itself out inside the 480
    // CSS pixels half a Fire Stick's screen comes to, and draw a phone.
    settings.useWideViewPort = true
    settings.loadWithOverviewMode = true
    settings.setSupportZoom(false)
    settings.builtInZoomControls = false

    // Sign-in is a cookie, and it has to still be there after the Stick has
    // been pulled out of the wall. Third-party ones included: the account lives
    // on google.com and the page is youtube.com.
    val cookies = CookieManager.getInstance()
    cookies.setAcceptCookie(true)
    cookies.setAcceptThirdPartyCookies(youtube, true)

    // A client of our own, for two reasons: without any client at all a WebView
    // hands some navigations to whatever browser the device has (on a Fire TV,
    // a dialog nobody can answer with a remote), and a mute has to be re-applied
    // to each new document or it would last exactly until the next page.
    youtube.webViewClient = object : WebViewClient() {
      override fun onPageFinished(view: WebView, url: String) {
        if (muted) applyMute()
        val waiting = pendingVideo
        if (waiting != null && url.startsWith(YOUTUBE_TV)) {
          pendingVideo = null
          view.evaluateJavascript(watchHash(waiting), null)
        }
      }
    }
    youtube.webChromeClient = WebChromeClient()

    youtube.setBackgroundColor(INK_BLACK)
    youtube.isFocusable = true
    youtube.isFocusableInTouchMode = true
    youtube.loadUrl(YOUTUBE_TV)
  }

  /**
   * A video arrived from the phone.
   *
   * `#/watch?v=` is the leanback interface's own route, but it has to be
   * *steered* rather than loaded. `WebView.loadUrl` is a fresh navigation even
   * when only the fragment differs, so handing it the deep link reloaded
   * youtube.com/tv, and the interface booted, rewrote the hash to `#/` and
   * showed the home screen — measured on the Fire Stick, and silent: the URL
   * was accepted and the video never appeared. Setting `location.hash` inside
   * the page that is already there is a same-document navigation, which is the
   * one its router listens for.
   *
   * `video` has been through the 11-character shape twice by now (the desktop's
   * `videoIdOf`, then `VIDEO_ID` in `notify`), which is what makes it safe to
   * put inside a script here — there is no character left in it that could end
   * the string.
   */
  private fun play(video: String) {
    // Into view first. A WebView stopped by `quieten` runs no script at all, so
    // navigating before showing it would land on nothing.
    if (mode != TvMode.YOUTUBE_FULL) show(TvMode.YOUTUBE_SPLIT)

    if ((youtube.url ?: "").startsWith(YOUTUBE_TV)) {
      youtube.evaluateJavascript(watchHash(video), null)
      // And once more, a moment later. A fling that lands while the interface
      // is still booting is written into a hash the interface then resets to
      // `#/` on its way up — measured on the Fire Stick within the first few
      // seconds of a cold start, and it looks exactly like a phone whose button
      // does nothing. The second attempt is a no-op in every other case.
      youtube.postDelayed({ youtube.evaluateJavascript(watchHashIfLost(video), null) }, SETTLE_MS)
      return
    }
    // Not on youtube.com/tv at all yet — the very first fling of a cold start,
    // or an error page. Load the site and steer it once it has arrived.
    pendingVideo = video
    youtube.loadUrl(YOUTUBE_TV)
  }

  /** A video asked for before the page existed. Applied by `onPageFinished`. */
  private var pendingVideo: String? = null

  private fun watchHash(video: String): String = "(function(){location.hash='#/watch?v=$video'})()"

  private fun watchHashIfLost(video: String): String =
    "(function(){var w='#/watch?v=$video';if(location.hash!==w)location.hash=w})()"

  /* --------------------------------------------------------------- toast */

  private fun toastLayout(): FrameLayout.LayoutParams {
    val params = FrameLayout.LayoutParams(
      ViewGroup.LayoutParams.WRAP_CONTENT,
      ViewGroup.LayoutParams.WRAP_CONTENT,
      Gravity.BOTTOM or Gravity.CENTER_HORIZONTAL
    )
    params.bottomMargin = dp(48)
    return params
  }

  private fun dressToast() {
    val background = GradientDrawable()
    background.cornerRadius = dp(10).toFloat()
    background.setColor(TOAST_BACK)
    background.setStroke(dp(1), LIT)
    toast.background = background
    toast.setTextColor(LIT)
    toast.setTextSize(TypedValue.COMPLEX_UNIT_SP, 20f)
    toast.setPadding(dp(20), dp(12), dp(20), dp(12))
    toast.gravity = Gravity.CENTER
    toast.visibility = View.GONE
  }

  /**
   * Say one thing over the video, and take it away again.
   *
   * Only while YouTube is alone on the screen. In either split the wall is
   * right there saying the same thing in more detail, and a toast repeating it
   * would be noise on top of a picture.
   */
  private fun announce(line: String) {
    if (mode != TvMode.YOUTUBE_FULL) return
    toast.text = line
    toast.visibility = View.VISIBLE
    toast.removeCallbacks(hideToast)
    toast.postDelayed(hideToast, TOAST_MS)
  }

  private val hideToast = Runnable { toast.visibility = View.GONE }

  /* ----------------------------------------------------------- the mute */

  /**
   * Silence the YouTube panel, or give it its voice back.
   *
   * Done inside the page rather than to the device, because the device's volume
   * on a Fire Stick belongs to the television over HDMI-CEC and turning that
   * down would silence the room, not the panel. `applyMute` patches `play` as
   * well as the elements that exist, so a video started afterwards — including
   * one flung from a phone — is born muted.
   */
  fun toggleMute() {
    muted = !muted
    applyMute()
    mutedCue.visibility = if (muted) View.VISIBLE else View.GONE
    flashLabelWith(if (muted) "YouTube muted  ·  hold ▶❚❚ again for sound" else "YouTube unmuted")
  }

  private fun applyMute() {
    youtube.evaluateJavascript(if (muted) MUTE_YOUTUBE else UNMUTE_YOUTUBE, null)
  }

  /* ---------------------------------------------------------- mode label */

  private fun labelLayout(): FrameLayout.LayoutParams {
    val params = FrameLayout.LayoutParams(
      ViewGroup.LayoutParams.WRAP_CONTENT,
      ViewGroup.LayoutParams.WRAP_CONTENT,
      Gravity.TOP or Gravity.CENTER_HORIZONTAL
    )
    params.topMargin = dp(24)
    return params
  }

  private fun dressLabel() {
    val background = GradientDrawable()
    background.cornerRadius = dp(999).toFloat()
    background.setColor(TOAST_BACK)
    background.setStroke(dp(1), UNLIT)
    modeLabel.background = background
    modeLabel.setTextColor(LIT)
    modeLabel.setTextSize(TypedValue.COMPLEX_UNIT_SP, 14f)
    modeLabel.setPadding(dp(18), dp(8), dp(18), dp(8))
    modeLabel.gravity = Gravity.CENTER
    modeLabel.visibility = View.GONE
  }

  /**
   * Say what just happened, and what the remote does next.
   *
   * Every mode change, including the first — this is the only place the two
   * rules (Menu cycles, a held Left or Right crosses) are ever written down
   * where the person holding the remote will see them, and a grammar nobody is
   * told is a grammar nobody has. It is a flash rather than a permanent strip
   * because the fourth time you read it you are no longer reading it, you are
   * looking at a bar across your video.
   */
  private fun flashLabel() {
    flashLabelWith(
      when (mode) {
        TvMode.FORGE_SPLIT -> "Forge  ·  ⏩ YouTube  ·  ⏪ Forge alone"
        TvMode.YOUTUBE_SPLIT -> "YouTube  ·  ⏩ full screen  ·  ⏪ Forge  ·  Back walks YouTube"
        TvMode.YOUTUBE_FULL -> "YouTube, full screen  ·  ⏪ back to the split"
        TvMode.FORGE_FULL -> "Forge alone, YouTube stopped  ·  ⏩ brings it back"
      }
    )
  }

  private fun flashLabelWith(line: String) {
    modeLabel.text = line
    modeLabel.visibility = View.VISIBLE
    modeLabel.removeCallbacks(hideLabel)
    modeLabel.postDelayed(hideLabel, LABEL_MS)
  }

  private val hideLabel = Runnable { modeLabel.visibility = View.GONE }

  /* -------------------------------------------------------- the JS seam */

  /**
   * What `window.dispatchEvent(new CustomEvent('forge:tv', …))` reaches.
   *
   * Every field is re-checked here. The web layer validated the id and the
   * desktop validated it before that, but this is the last edge before a string
   * becomes part of a URL, and "two other layers checked" is not a property
   * this one can observe. An unrecognised `kind` is ignored rather than
   * refused, which is the additive rule tv-bridge.ts asks for: this activity
   * and that bundle do not update in lockstep.
   */
  /** One search at a time. A dashboard that re-renders must not stack probes. */
  private val searching = java.util.concurrent.atomic.AtomicBoolean(false)

  /**
   * "Which Forge is on this wifi?" — the television's half of discovery.
   *
   * Native because it has to be: a WebView speaks HTTP and WebSockets and has
   * no way to send a UDP datagram, and a broadcast is the only question that
   * can be asked before the answer is known. The alternative is the sentence
   * this whole feature exists to delete — *type your desktop's IP address* —
   * with a D-pad, one character at a time.
   *
   * Deliberately incurious about what it collects. Each reply is handed to the
   * web layer as the string it arrived as; shared/mobile.ts parses and
   * sanitises it there, in the same file the desktop wrote it with, rather than
   * being re-implemented here where it would drift. This layer knows the
   * question, the port and the timeout, and nothing else.
   *
   * Runs off the UI thread and answers on it. Failures are silent by design:
   * the screen already has a manual address field, and a toast about a socket
   * is not something anybody on a sofa can act on.
   */
  private fun searchForDesktops() {
    if (!searching.compareAndSet(false, true)) return
    Thread {
      val found = LinkedHashSet<String>()
      try {
        java.net.DatagramSocket().use { socket ->
          socket.broadcast = true
          socket.soTimeout = POLL_MS
          val probe = DISCOVERY_PROBE.padEnd(DISCOVERY_PROBE_BYTES, ' ').toByteArray()
          // Every broadcast address this device has, and the global one.
          // Routers differ on which they will carry, and the cost of asking
          // twice is one datagram.
          val targets = broadcastAddresses()
          val deadline = System.currentTimeMillis() + SEARCH_MS
          var nextProbe = 0L
          val buffer = ByteArray(DISCOVERY_REPLY_BYTES)
          while (System.currentTimeMillis() < deadline) {
            if (System.currentTimeMillis() >= nextProbe) {
              // Asked more than once on purpose: UDP drops, and a television
              // that searched once and found nothing looks broken.
              for (target in targets) {
                try {
                  socket.send(java.net.DatagramPacket(probe, probe.size, target, DISCOVERY_PORT))
                } catch (err: Exception) {
                  /* one address refused; the others are still worth asking */
                }
              }
              nextProbe = System.currentTimeMillis() + REPROBE_MS
            }
            val packet = java.net.DatagramPacket(buffer, buffer.size)
            try {
              socket.receive(packet)
              found.add(String(packet.data, packet.offset, packet.length))
            } catch (timeout: java.net.SocketTimeoutException) {
              /* nothing this poll; the loop decides whether to ask again */
            }
          }
        }
      } catch (err: Exception) {
        /* no socket, no answers — the manual address field is still there */
      }
      val payload = org.json.JSONObject().put("found", org.json.JSONArray(found.toList())).toString()
      activity.runOnUiThread {
        // Quoted rather than interpolated: these strings came off the network,
        // and the one place they must not end up is inside a script as code.
        forge.evaluateJavascript(
          "window.dispatchEvent(new CustomEvent('$TV_FOUND_EVENT'," +
            "{detail:JSON.parse(${org.json.JSONObject.quote(payload)}).found}))",
          null
        )
        searching.set(false)
      }
    }.start()
  }

  /** Every IPv4 broadcast address this device has, plus the global one. */
  private fun broadcastAddresses(): List<java.net.InetAddress> {
    val addresses = mutableListOf<java.net.InetAddress>()
    try {
      for (network in java.net.NetworkInterface.getNetworkInterfaces()) {
        if (!network.isUp || network.isLoopback) continue
        for (entry in network.interfaceAddresses) {
          val broadcast = entry.broadcast ?: continue
          addresses.add(broadcast)
        }
      }
    } catch (err: Exception) {
      /* fall through to the global address, which is usually enough */
    }
    try {
      addresses.add(java.net.InetAddress.getByName("255.255.255.255"))
    } catch (err: Exception) {
      /* nothing to add */
    }
    return addresses
  }

  val jsBridge = object {
    /**
     * Start a search. Returns immediately; the answers arrive as a
     * `forge:tv-found` event carrying the raw replies. See
     * mobile/src/lib/tv-bridge.ts for the web side of this seam.
     */
    @JavascriptInterface
    fun discover() {
      searchForDesktops()
    }

    @JavascriptInterface
    fun notify(json: String) {
      val event = try {
        JSONObject(json)
      } catch (err: Exception) {
        return
      }
      // Called on a WebView's JavaScript thread, so everything below has to be
      // handed to the one thread allowed to touch a view.
      activity.runOnUiThread {
        when (event.optString("kind")) {
          "tv-play" -> {
            val video = event.optString("video")
            if (VIDEO_ID.matches(video)) play(video)
          }

          "session-exit" -> {
            val session = event.optString("session").ifEmpty { "A pane" }
            val code = event.optInt("exitCode", 0)
            announce(if (code == 0) "$session finished" else "$session exited · code $code")
          }

          "control" -> setControlling(event.optBoolean("on", false))
        }
      }
    }
  }

  /* ------------------------------------------------------------ plumbing */

  private fun dp(value: Int): Int = Math.round(activity.resources.displayMetrics.density * value)

  private fun fill(): FrameLayout.LayoutParams =
    FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT)

  /** A panel's ground and its edge: always near-black, lit only on the outline. */
  private fun frameEdge(lit: Boolean, drawn: Boolean): GradientDrawable {
    val edge = GradientDrawable()
    edge.setColor(INK_BLACK)
    if (drawn) edge.setStroke(BORDER_PX, if (lit) LIT else UNLIT)
    return edge
  }

  /** Full width, and whatever height that makes 16:9. Height is set on layout. */
  private fun sixteenByNine(): FrameLayout.LayoutParams =
    FrameLayout.LayoutParams(
      ViewGroup.LayoutParams.MATCH_PARENT,
      ViewGroup.LayoutParams.MATCH_PARENT,
      Gravity.CENTER_VERTICAL
    )

  private fun cueLayout(): FrameLayout.LayoutParams {
    val params = FrameLayout.LayoutParams(
      ViewGroup.LayoutParams.WRAP_CONTENT,
      ViewGroup.LayoutParams.WRAP_CONTENT,
      Gravity.TOP or Gravity.END
    )
    params.topMargin = dp(12)
    params.rightMargin = dp(12)
    return params
  }

  private fun dressCue() {
    val background = GradientDrawable()
    background.cornerRadius = dp(6).toFloat()
    background.setColor(TOAST_BACK)
    background.setStroke(dp(1), UNLIT)
    mutedCue.background = background
    mutedCue.text = "MUTED"
    mutedCue.setTextColor(LIT)
    mutedCue.setTextSize(TypedValue.COMPLEX_UNIT_SP, 11f)
    mutedCue.setPadding(dp(8), dp(4), dp(8), dp(4))
    mutedCue.visibility = View.GONE
  }

  private companion object {
    const val YOUTUBE_TV = "https://www.youtube.com/tv"

    /* ------------------------------------------------ finding a desktop
     *
     * These five must agree with the discovery block in shared/mobile.ts,
     * which is the file the desktop answers from. They are duplicated here
     * because Kotlin cannot import TypeScript, and they are duplicated *with
     * this comment* because the failure mode of a silent drift is a television
     * that searches a network full of Forges and finds nothing.
     */

    /** MOBILE_DISCOVERY_PORT. */
    const val DISCOVERY_PORT = 8421

    /** DISCOVERY_PROBE. */
    const val DISCOVERY_PROBE = "forge-discover/1"

    /** DISCOVERY_MIN_PROBE_BYTES — the padding that earns an answer. */
    const val DISCOVERY_PROBE_BYTES = 512

    /** Comfortably larger than any reply; anything bigger is not one. */
    const val DISCOVERY_REPLY_BYTES = 2048

    /** How long a search listens before giving its answer to the screen. */
    const val SEARCH_MS = 1_500L

    /** How often the question is repeated inside that window. UDP drops. */
    const val REPROBE_MS = 400L

    /** How long one receive blocks — short, so the loop can re-ask on time. */
    const val POLL_MS = 200

    /** The event the web layer listens for. mobile/src/lib/tv-bridge.ts. */
    const val TV_FOUND_EVENT = "forge:tv-found"

    /** See the user-agent note in this class's own doc comment. */
    const val YOUTUBE_UA =
      "Mozilla/5.0 (PS4; Leanback Shell) Cobalt/25.lts.40.1035033; compatible; ForgeTV"

    /** The same 11 characters shared/mobile.ts and lib/link.ts hold an id to. */
    val VIDEO_ID = Regex("^[A-Za-z0-9_-]{11}$")

    /** mobile/src/styles.css — --volt, --line and --bg. The wall's own colours. */
    const val LIT = 0xFFC6FF4A.toInt()
    const val UNLIT = 0xFF23262D.toInt()
    const val INK_BLACK = 0xFF0B0C0E.toInt()
    val TOAST_BACK = Color.argb(238, 11, 12, 14)

    /** Thick enough to read from a sofa, thin enough to cost no picture. */
    const val BORDER_PX = 6

    /** Long enough to read a pane name at a glance, short enough not to nag. */
    const val TOAST_MS = 5_000L

    /** One line of hint, read at sofa distance, gone before it is furniture. */
    const val LABEL_MS = 3_500L

    /** Long enough for the leanback interface to finish booting over a fling. */
    const val SETTLE_MS = 2_500L

    /** Belt and braces to `WebView.onPause`, which says nothing about audio. */
    const val PAUSE_ANY_VIDEO =
      "(function(){var v=document.getElementsByTagName('video');" +
        "for(var i=0;i<v.length;i++){try{v[i].pause()}catch(e){}}})()"

    /**
     * Back, offered to YouTube.
     *
     * Three answers, in the order they are worth trying. `page` means a
     * listener called preventDefault — the interface took it. `history` is the
     * fallback for the hash routes it navigates with, which the WebView's own
     * `canGoBack` does not always count. `root` means it is at the top and the
     * press belongs to the app.
     */
    const val BACK_INTO_YOUTUBE =
      "(function(){" +
        "var opts={key:'Escape',code:'Escape',keyCode:27,which:27,bubbles:true,cancelable:true};" +
        "var took=!document.dispatchEvent(new KeyboardEvent('keydown',opts));" +
        "document.dispatchEvent(new KeyboardEvent('keyup',opts));" +
        "if(took)return 'page';" +
        "var h=location.hash||'';" +
        "if(h&&h!=='#'&&h!=='#/'){history.back();return 'history'}" +
        "return 'root'})()"

    /**
     * Mute, and keep it muted.
     *
     * `play` is patched as well as the elements that exist now, because the
     * leanback interface builds a fresh <video> for every video, and a phone
     * can fling one in at any moment. The interval is the belt to that brace:
     * an element muted before it is ever played makes no sound at all.
     */
    const val MUTE_YOUTUBE =
      "(function(){" +
        "if(window.__forgeMuteOn)return;window.__forgeMuteOn=true;" +
        "var hush=function(){var m=document.querySelectorAll('video,audio');" +
        "for(var i=0;i<m.length;i++){try{m[i].muted=true;m[i].volume=0}catch(e){}}};" +
        "if(!window.__forgeMutePatched){window.__forgeMutePatched=true;" +
        "var P=HTMLMediaElement.prototype,play=P.play;" +
        "P.play=function(){if(window.__forgeMuteOn){this.muted=true;this.volume=0}return play.apply(this,arguments)}}" +
        "window.__forgeMuteTimer=setInterval(function(){if(window.__forgeMuteOn)hush()},200);hush()})()"

    const val UNMUTE_YOUTUBE =
      "(function(){window.__forgeMuteOn=false;" +
        "if(window.__forgeMuteTimer){clearInterval(window.__forgeMuteTimer);window.__forgeMuteTimer=null}" +
        "var m=document.querySelectorAll('video,audio');" +
        "for(var i=0;i<m.length;i++){try{m[i].muted=false;m[i].volume=1}catch(e){}}})()"
  }
}
