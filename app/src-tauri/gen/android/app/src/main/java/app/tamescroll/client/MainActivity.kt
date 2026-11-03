package app.tamescroll.client

import android.content.Intent
import androidx.core.content.FileProvider
import java.io.File
import java.net.HttpURLConnection
import java.net.URL
import java.security.MessageDigest
import org.json.JSONObject
import android.content.pm.ActivityInfo
import android.graphics.Color
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Process
import android.view.Display
import android.view.Gravity
import android.text.TextUtils
import android.graphics.drawable.GradientDrawable
import android.util.TypedValue
import android.widget.FrameLayout
import android.widget.ImageButton
import android.widget.LinearLayout
import android.widget.TextView
import android.view.MotionEvent
import android.view.ScaleGestureDetector
import android.view.View
import android.view.ViewGroup
import android.view.WindowManager
import android.webkit.ConsoleMessage
import android.webkit.GeolocationPermissions
import android.webkit.JavascriptInterface
import android.webkit.JsPromptResult
import android.webkit.JsResult
import android.webkit.PermissionRequest
import android.webkit.ValueCallback
import android.webkit.WebViewClient
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebBackForwardList
import android.webkit.WebResourceError
import android.graphics.Bitmap
import java.io.ByteArrayInputStream
import android.util.Log
import android.webkit.WebChromeClient
import android.webkit.WebView
import androidx.activity.OnBackPressedCallback
import androidx.activity.SystemBarStyle
import androidx.activity.enableEdgeToEdge
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import androidx.webkit.WebMessageCompat
import androidx.webkit.WebMessagePortCompat
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature

class MainActivity : TauriActivity() {
  private lateinit var webView: WebView

  companion object {
    // Kept in lockstep with appupdate.rs DEFAULT_MANIFEST_URL. Fixed so
    // no page-supplied URL is ever fetched by the installer.
    private const val UPDATE_MANIFEST_URL =
      "https://raw.githubusercontent.com/tamescroll/tamescroll/main/updates/app-manifest.json"
    private const val TAG_PERF = "TsPerf"
    // One frame at ~30fps -- the target the ADPF session in PerfBridge.hint
    // asks the scheduler to keep ts-infer's inferences under.
    private const val PERF_HINT_TARGET_NS = 33_000_000L
    private const val TAG_TUNE = "TsTune"
    private const val TUNE_PREFS = "tamescroll.tuning"
    private const val TUNE_KEY = "json"
    // A dial JSON blob is a few dozen small numbers -- this is generous
    // headroom against a corrupted or hostile write, not a real budget.
    private const val TUNE_MAX_BYTES = 8 * 1024
    // Link ownership (1108). The probe is a real public video; the
    // ts_probe marker is what tells us the system chose us for it.
    private const val YOUTUBE_PKG = "com.google.android.youtube"
    private const val PROBE_URL = "https://youtu.be/jNQXAC9IVRw?ts_probe=1"
    private const val LINKS_PREFS = "tamescroll.links"
    private const val LINKS_PROBED = "probed"
    // Height of the top bar above every site (installTopBar).
    private const val TOP_BAR_DP = 52
    private const val TOP_STRIP_DP = 24
    private const val STATS_PREFS = "tamescroll.stats"
    private const val LOOK_PREFS = "tamescroll.look"
    private const val NIGHT_BG = 0xFF141414.toInt()
    private const val PAPER_BG = 0xFFF7F5F0.toInt()
  }

  // Platform requested by a home-screen shortcut before the webview
  // exists (cold start): consumed by ShortcutBridge. @Volatile because
  // @JavascriptInterface methods run on the WebView's JavaBridge
  // thread while onCreate/onNewIntent write from the UI thread — a
  // plain var has no happens-before edge and a cold-start consume()
  // could legally read a stale null on weaker ARM memory models.
  @Volatile
  private var pendingPlatform: String? = null
  // The exact page a LINK asked for (1107), carried beside the platform
  // id so the launcher opens the watch page rather than the home feed.
  // Null for a shortcut or a plain launch.
  @Volatile
  private var pendingUrl: String? = null

  // Only ids our shortcuts.xml can send; anything else is dropped so an
  // arbitrary external intent can't steer the launcher.
  private fun platformFromIntent(intent: Intent?): String? {
    val id = intent?.getStringExtra("ts_platform") ?: return null
    return if (id in setOf("youtube", "reddit", "x", "tiktok", "instagram", "facebook")) id else null
  }

  // A LINK IS A REQUEST FOR ONE PAGE ON ONE PLATFORM (1107). Two ways
  // in: the system handing us a VIEW intent because the user picked
  // tamescroll for youtube links, or a SEND (share sheet) whose text
  // carries a url. Either way the HOST decides the platform against the
  // same whitelist the manifest claims, and anything else is refused --
  // an external intent may pick a page on a platform we ship, never
  // steer the webview somewhere arbitrary.
  private val linkHosts = mapOf(
    "youtube.com" to "youtube", "www.youtube.com" to "youtube",
    "m.youtube.com" to "youtube", "youtu.be" to "youtube",
  )

  private fun urlFromIntent(intent: Intent?): Uri? {
    if (intent == null) return null
    if (intent.action == Intent.ACTION_VIEW) return intent.data
    if (intent.action != Intent.ACTION_SEND) return null
    val text = intent.getStringExtra(Intent.EXTRA_TEXT) ?: return null
    val m = Regex("https?://[^\\s]+").find(text) ?: return null
    return try { Uri.parse(m.value) } catch (_: Throwable) { null }
  }

  /** (platform id, url) for a link intent, or null when the intent is
   * not a link we own. */
  private fun linkFromIntent(intent: Intent?): Pair<String, String>? {
    val u = urlFromIntent(intent) ?: return null
    val scheme = u.scheme?.lowercase() ?: return null
    if (scheme != "https" && scheme != "http") return null
    val host = u.host?.lowercase() ?: return null
    // A link SHARED to us from any other site lands in the launcher's
    // address box, filled and selected; the user taps Go. A share is the
    // user's own act, and nothing loads until they confirm it. VIEW stays
    // limited to the hosts the manifest claims.
    val id = linkHosts[host]
      ?: return if (intent?.action == Intent.ACTION_SEND) "search" to u.toString() else null
    // The self-test link came back to us: the system hands us youtu.be.
    // Only a VIEW counts -- a SEND of the same url proves nothing.
    if (intent?.action == Intent.ACTION_VIEW && u.getQueryParameter("ts_probe") == "1") {
      getSharedPreferences(LINKS_PREFS, MODE_PRIVATE).edit().putBoolean(LINKS_PROBED, true).apply()
    }
    return id to u.toString()
  }

  // The shortcut lands on the LAUNCHER with ?open=<id>, not directly on
  // the platform URL: the launcher frontend owns mode/prefs sync and
  // calls open_platform itself (main.ts reads the param), so a shortcut
  // launch behaves exactly like a tile tap. A link adds &url=<page>.
  private fun launcherUrl(platform: String?, url: String? = null) =
    if (platform == null) "http://tauri.localhost/"
    else if (url == null) "http://tauri.localhost/?open=$platform"
    else "http://tauri.localhost/?open=$platform&url=" + Uri.encode(url)

  override fun onCreate(savedInstanceState: Bundle?) {
    // Edge-to-edge is enforced anyway at targetSdk 35+; dark() forces
    // light status-bar icons so they stay readable on our dark strip.
    enableEdgeToEdge(
      statusBarStyle = SystemBarStyle.dark(Color.TRANSPARENT),
      navigationBarStyle = SystemBarStyle.dark(Color.TRANSPARENT),
    )
    val coldLink = linkFromIntent(intent)
    pendingPlatform = coldLink?.first ?: platformFromIntent(intent)
    pendingUrl = coldLink?.second
    super.onCreate(savedInstanceState)
    // Owner report 2026-08-20 (Redmi test): page content drew under the
    // phone's status bar — the template's edge-to-edge ships no inset
    // handling. Pad the content view by the system bars and paint the
    // exposed strips launcher-dark so every page sits below the clock.
    paperLook = getSharedPreferences(LOOK_PREFS, MODE_PRIVATE).getBoolean("paper", false)
    window.decorView.setBackgroundColor(if (paperLook) PAPER_BG else NIGHT_BG)
    val content = findViewById<ViewGroup>(android.R.id.content)
    ViewCompat.setOnApplyWindowInsetsListener(content) { v, insets ->
      // ime() included: with edge-to-edge enforced (targetSdk 35+) the
      // window no longer resizes for the keyboard, and this listener
      // consumes the insets — without ime() the keyboard would overlap
      // focused inputs (review 2026-08-23 #14).
      val bars = insets.getInsets(
        WindowInsetsCompat.Type.systemBars()
          or WindowInsetsCompat.Type.displayCutout()
          or WindowInsetsCompat.Type.ime()
      )
      v.setPadding(bars.left, bars.top, bars.right, bars.bottom)
      WindowInsetsCompat.CONSUMED
    }
  }

  override fun onNewIntent(intent: Intent) {
    super.onNewIntent(intent)
    // Without this, getIntent() keeps returning the ORIGINAL launching
    // intent forever — an activity recreation (font-scale change,
    // process death restore) would then replay a stale shortcut extra
    // and the app would yank itself to that platform out of nowhere.
    setIntent(intent)
    // Warm shortcut tap OR a warm link (singleTask): the activity
    // already runs, so navigate the live webview straight to the
    // launcher+params.
    val link = linkFromIntent(intent)
    val id = link?.first ?: platformFromIntent(intent)
    if (id != null) {
      if (this::webView.isInitialized) {
        webView.loadUrl(launcherUrl(id, link?.second))
      } else {
        pendingPlatform = id
        pendingUrl = link?.second
      }
    }
  }

  // Cold-start shortcut delivery. Loading a URL from onWebViewCreate
  // loses the race — wry loads its configured start URL right after and
  // clobbers the ?open= param (probe12 evidence: cold shortcut sat on
  // the launcher). Instead the launcher page PULLS the pending id via
  // this bridge during start(). consume() is one-shot; the worst a
  // remote page could learn by calling it is an already-consumed "".
  inner class ShortcutBridge {
    @JavascriptInterface
    fun consume(): String {
      val p = pendingPlatform
      val u = pendingUrl
      pendingPlatform = null
      pendingUrl = null
      // The bridge exists for one moment: the launcher's first read on
      // a cold start. Every page in this webview — including remote
      // platform pages and their ad iframes — can see the interface
      // while registered, and `!!window.TsShortcuts` is a free
      // tamescroll fingerprint for the platforms. Warm shortcuts use
      // the ?open= URL param instead, so after the first consume the
      // interface is dead weight: remove it (on the UI thread; this
      // method runs on the JavaBridge thread).
      runOnUiThread {
        if (this@MainActivity::webView.isInitialized) {
          webView.removeJavascriptInterface("TsShortcuts")
        }
      }
      // Bare id for a shortcut (unchanged wire format); id + newline +
      // url for a link. main.ts splits on the newline.
      return if (p == null) "" else if (u == null) p else p + "\n" + u
    }
  }

  // THE LOOK (his 2026-10-28): Night or Paper on the launcher. The strips
  // behind the clock and the nav bar belong to the window, not the page,
  // so the launcher tells us which look it wears and we paint them to
  // match. Sites keep the dark strips and the dark top bar either way.
  // Visible to every page like any interface; it only takes one of two
  // words and only acts while the launcher is showing.
  @Volatile
  private var paperLook = false

  inner class LookBridge {
    @JavascriptInterface
    fun set(look: String?) {
      val paper = look == "paper"
      runOnUiThread {
        val here = if (this@MainActivity::webView.isInitialized) webView.url ?: "" else ""
        if (!here.startsWith("http://tauri.localhost/")) return@runOnUiThread
        paperLook = paper
        getSharedPreferences(LOOK_PREFS, MODE_PRIVATE).edit().putBoolean("paper", paper).apply()
        applyStrips(here)
      }
    }
  }

  private fun applyStrips(url: String) {
    val light = paperLook && url.startsWith("http://tauri.localhost/")
    val bg = if (light) PAPER_BG else NIGHT_BG
    window.decorView.setBackgroundColor(bg)
    if (this::webView.isInitialized) webView.setBackgroundColor(bg)
    val controller = WindowInsetsControllerCompat(window, window.decorView)
    controller.isAppearanceLightStatusBars = light
    controller.isAppearanceLightNavigationBars = light
  }

  // THE ONE SCREEN THE APP HAS TO WALK THE USER TO (1107). Without
  // "Open by default -> Open supported links" the manifest filter only
  // ever offers tamescroll in a chooser, and on many launchers not even
  // that. There is no API to set it for them; there is one to open the
  // exact page. Gated to the launcher: the interface is visible to every
  // page in the webview, and while popping the user's own settings
  // screen is not dangerous, a platform page has no business doing it.
  //
  // 1108, MEASURED ON HIS PHONE: YouTube's links are system_configured,
  // so a bare youtu.be tap opens the YouTube app in every state of OUR
  // package. The one recipe that hands the tap to tamescroll is
  // YouTube's master "Open supported links" OFF plus ours ON. So the
  // bridge can open the Open-by-default page for EITHER package (never
  // a third), read both states back where the OS allows it, fire a
  // self-test link, pin our YouTube shortcut, and open YouTube's
  // app-info page for the user who wants it gone. `pm disable-user`
  // is refused by MIUI, so nothing here tries to disable anything.
  inner class LinksBridge {
    private fun fromLauncher(): Boolean {
      val here = if (this@MainActivity::webView.isInitialized) webView.url ?: "" else ""
      return here.startsWith("http://tauri.localhost/")
    }

    private fun allowedPkg(pkg: String?): String? =
      if (pkg == null || pkg == packageName) packageName
      else if (pkg == YOUTUBE_PKG) YOUTUBE_PKG else null

    private fun launch(intent: Intent, what: String) {
      try { startActivity(intent) } catch (e: Throwable) {
        Log.w("TsLinks", "$what failed: " + e.message)
      }
    }

    /** Open-by-default page for our package (pkg null) or YouTube. */
    @JavascriptInterface
    fun openDefaultApps(pkg: String?) {
      val target = allowedPkg(pkg) ?: return
      runOnUiThread {
        if (!fromLauncher()) return@runOnUiThread
        val intent = if (Build.VERSION.SDK_INT >= 31) {
          Intent(android.provider.Settings.ACTION_APP_OPEN_BY_DEFAULT_SETTINGS,
            Uri.parse("package:$target"))
        } else {
          Intent(android.provider.Settings.ACTION_APPLICATION_DETAILS_SETTINGS,
            Uri.parse("package:$target"))
        }
        launch(intent, "open-by-default($target)")
      }
    }

    /** Kept for the 1107 launcher bundle; same as openDefaultApps(null). */
    @JavascriptInterface
    fun openDefaultApps() = openDefaultApps(null)

    /** YouTube's app-info page, where Uninstall / Disable live. */
    @JavascriptInterface
    fun openAppInfo(pkg: String?) {
      val target = allowedPkg(pkg) ?: return
      if (target == packageName) return
      runOnUiThread {
        if (!fromLauncher()) return@runOnUiThread
        launch(Intent(android.provider.Settings.ACTION_APPLICATION_DETAILS_SETTINGS,
          Uri.parse("package:$target")), "app-info($target)")
      }
    }

    /** Fire a real youtu.be link through the system resolver. If the
     * user's settings hand it to tamescroll it comes back through
     * onNewIntent carrying ts_probe=1, and linkFromIntent records the
     * win. If YouTube wins, the user sees YouTube and nothing is
     * recorded -- which is the honest answer. */
    @JavascriptInterface
    fun probe() {
      runOnUiThread {
        if (!fromLauncher()) return@runOnUiThread
        val intent = Intent(Intent.ACTION_VIEW, Uri.parse(PROBE_URL))
        intent.addCategory(Intent.CATEGORY_BROWSABLE)
        launch(intent, "probe")
      }
    }

    /** Pin one of our static shortcuts (shortcuts.xml ids only) and SAY
     * WHAT HAPPENED. The first version returned nothing, and on his own
     * phone (olauncher, 2026-09-10) the launcher refuses pin requests, so
     * the "Add" button did nothing at all with no word to the user.
     * Returns: pinned | requested | unsupported | unavailable | refused. */
    @JavascriptInterface
    fun pinShortcut(id: String?): String {
      if (id == null || id !in setOf("youtube", "reddit", "x", "tiktok", "instagram", "facebook")) return "refused"
      // JavascriptInterface runs off the UI thread and WebView.getUrl()
      // throws there (measured 1117 first cut: "Java exception was raised").
      val onLauncher = java.util.concurrent.FutureTask<Boolean> { fromLauncher() }
      runOnUiThread(onLauncher)
      val ok = try { onLauncher.get(2, java.util.concurrent.TimeUnit.SECONDS) } catch (_: Throwable) { false }
      if (!ok) return "refused"
      if (Build.VERSION.SDK_INT < 26) return "unavailable"
      return try {
        val sm = getSystemService(android.content.pm.ShortcutManager::class.java) ?: return "unavailable"
        if (sm.pinnedShortcuts.any { it.id == id }) return "pinned"
        if (!sm.isRequestPinShortcutSupported) return "unsupported"
        val existing = sm.manifestShortcuts.firstOrNull { it.id == id } ?: return "unavailable"
        if (sm.requestPinShortcut(existing, null)) "requested" else "unsupported"
      } catch (e: Throwable) {
        Log.w("TsLinks", "pin($id) failed: " + e.message)
        "refused"
      }
    }

    /** Is the platform's shortcut on the home screen, and can this
     * launcher take one at all. Null where the OS will not say. */
    @JavascriptInterface
    fun pinState(id: String?): String {
      val o = JSONObject()
      try {
        if (Build.VERSION.SDK_INT >= 26 && id != null) {
          val sm = getSystemService(android.content.pm.ShortcutManager::class.java)
          if (sm != null) {
            o.put("supported", sm.isRequestPinShortcutSupported)
            o.put("pinned", sm.pinnedShortcuts.any { it.id == id })
          }
        }
      } catch (_: Throwable) {}
      return o.toString()
    }

    /** What the OS says about both packages, plus whether a probe ever
     * landed here. Fields the OS refuses to tell us are null, never
     * guessed. Readable from any page but says nothing a page could
     * not learn by firing a link itself. */
    @JavascriptInterface
    fun state(): String {
      val o = JSONObject()
      o.put("probed", getSharedPreferences(LINKS_PREFS, MODE_PRIVATE).getBoolean(LINKS_PROBED, false))
      o.put("youtubeInstalled", try {
        packageManager.getPackageInfo(YOUTUBE_PKG, 0); true
      } catch (_: Throwable) { false })
      if (Build.VERSION.SDK_INT >= 31) {
        val dvm = getSystemService(android.content.pm.verify.domain.DomainVerificationManager::class.java)
        for ((key, pkg) in listOf("ours" to packageName, "youtube" to YOUTUBE_PKG)) {
          try {
            val st = dvm.getDomainVerificationUserState(pkg) ?: continue
            val j = JSONObject()
            j.put("allowed", st.isLinkHandlingAllowed)
            val hosts = JSONObject()
            for ((host, v) in st.hostToStateMap) {
              // 0 none, 1 selected (user), 2 verified
              hosts.put(host, v)
            }
            j.put("hosts", hosts)
            o.put(key, j)
          } catch (e: Throwable) {
            Log.w("TsLinks", "state($pkg): " + e.message)
          }
        }
      }
      return o.toString()
    }
  }

  // ---- in-app updater (owner ask 2026-08-23: stop re-sending the APK
  // over WhatsApp). install() downloads the latest build and hands it to
  // the system package installer, which ALWAYS asks the user to confirm.
  //
  // Security: the manifest URL is hardcoded (same GitHub raw host as the
  // rules OTA), the APK URL + sha256 come only from that manifest, and
  // the downloaded file is rejected unless its hash matches. No value
  // from page JavaScript is trusted, so the interface being visible to
  // remote platform pages cannot be turned into an arbitrary-APK install.
  @Volatile
  private var updating = false

  // ---- diagnostics (owner ask 2026-08-28: "can't you implement a
  // diagnostics feature in the app ... so you can always check the
  // logs", then "or give me the control of reporting").
  //
  // NOTHING HERE UPLOADS ANYTHING. A platform page hands over a report
  // that its own redaction gate already passed (diag-report.mjs), and
  // this appends it to one local file the Settings pane can show and
  // share. The owner is the transport.
  //
  // The page is untrusted even though we injected the code that calls
  // this: a hostile page can call submit() with anything. So the input
  // is size-capped, must parse as JSON, must carry our own version
  // marker, and is re-checked for the two things that must never reach
  // a log -- a scheme and a protocol-relative url -- before it is
  // written. The file is capped and rotates.
  inner class DiagBridge {
    @JavascriptInterface
    fun submit(json: String) {
      try {
        if (json.length > 128 * 1024) return
        val o = JSONObject(json)
        if (o.optInt("v", 0) != 1) return
        if (json.contains("://") || json.contains("//")) return
        synchronized(diagLock) {
          val f = File(filesDir, "diagnostics.jsonl")
          if (f.length() > 512 * 1024) {
            // Keep the most recent half rather than deleting the lot:
            // the report that explains a complaint is usually the last
            // one, and a file that vanishes takes the evidence with it.
            val keep = f.readLines().takeLast(40)
            f.writeText(keep.joinToString("\n", postfix = "\n"))
          }
          // One report per line, so the file is appendable, tailable and
          // survives a truncated write at the end.
          f.appendText(json.replace("\n", " ") + "\n")
        }
      } catch (e: Exception) {
        // A diagnostic that crashes the app is the worst possible
        // outcome of a diagnostic.
      }
    }

    /** Everything collected so far, for the Settings pane. */
    @JavascriptInterface
    fun read(): String {
      return try {
        synchronized(diagLock) {
          val f = File(filesDir, "diagnostics.jsonl")
          if (f.exists()) f.readText() else ""
        }
      } catch (e: Exception) {
        ""
      }
    }

    /** Hand the file to the system share sheet. The owner chooses who
     * sees it; the app never chooses for him. */
    @JavascriptInterface
    fun share() {
      runOnUiThread {
        try {
          val f = File(filesDir, "diagnostics.jsonl")
          if (!f.exists() || f.length() == 0L) return@runOnUiThread
          val out = File(cacheDir, "tamescroll-diagnostics.txt")
          f.copyTo(out, overwrite = true)
          val uri = FileProvider.getUriForFile(
            this@MainActivity, "$packageName.fileprovider", out
          )
          val send = Intent(Intent.ACTION_SEND).apply {
            type = "text/plain"
            putExtra(Intent.EXTRA_STREAM, uri)
            addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
          }
          startActivity(Intent.createChooser(send, "Share diagnostics"))
        } catch (e: Exception) {
          // No share target, or a provider refusal: the Copy button in
          // Settings still works.
        }
      }
    }

    @JavascriptInterface
    fun clear() {
      try {
        synchronized(diagLock) { File(filesDir, "diagnostics.jsonl").delete() }
      } catch (e: Exception) {
      }
    }
  }

  private val diagLock = Any()

  inner class UpdateBridge {
    @JavascriptInterface
    fun install() {
      if (updating) return
      updating = true
      Thread {
        try {
          val manifest = JSONObject(httpGet(UPDATE_MANIFEST_URL))
          val versionCode = manifest.optLong("versionCode", 0)
          val apkUrl = manifest.optString("apkUrl", "")
          val sha256 = manifest.optString("sha256", "").lowercase()
          if (versionCode <= BuildConfig.VERSION_CODE || apkUrl.isEmpty() || sha256.isEmpty()) {
            report("No installable update.")
            return@Thread
          }
          report("Downloading update…")
          val apk = File(externalCacheDir, "tamescroll-update.apk")
          val got = download(apkUrl, apk)
          if (got != sha256) {
            apk.delete()
            report("Update failed a security check. Not installed.")
            return@Thread
          }
          report("Starting install…")
          runOnUiThread { launchInstall(apk) }
        } catch (e: Exception) {
          report("Couldn't reach the update server.")
        } finally {
          updating = false
        }
      }.start()
    }

    // Push a one-line status back to the launcher without a nag surface.
    private fun report(msg: String) {
      runOnUiThread {
        if (this@MainActivity::webView.isInitialized) {
          val safe = msg.replace("\\", "\\\\").replace("'", "\\'")
          webView.evaluateJavascript(
            "window.__tsUpdateStatus && window.__tsUpdateStatus('" + safe + "')",
            null,
          )
        }
      }
    }
  }

  private fun httpGet(spec: String): String {
    val conn = URL(spec).openConnection() as HttpURLConnection
    conn.connectTimeout = 15000
    conn.readTimeout = 30000
    conn.instanceFollowRedirects = true
    try {
      return conn.inputStream.bufferedReader().use { it.readText() }
    } finally {
      conn.disconnect()
    }
  }

  // Streams url -> file, returning the lowercase sha256 hex of the bytes
  // written so the caller can verify against the manifest before ever
  // handing the file to the installer.
  private fun download(spec: String, dest: File): String {
    val conn = URL(spec).openConnection() as HttpURLConnection
    conn.connectTimeout = 15000
    conn.readTimeout = 60000
    conn.instanceFollowRedirects = true
    val digest = MessageDigest.getInstance("SHA-256")
    try {
      conn.inputStream.use { input ->
        dest.outputStream().use { output ->
          val buf = ByteArray(64 * 1024)
          while (true) {
            val n = input.read(buf)
            if (n < 0) break
            digest.update(buf, 0, n)
            output.write(buf, 0, n)
          }
        }
      }
    } finally {
      conn.disconnect()
    }
    return digest.digest().joinToString("") { "%02x".format(it) }
  }

  private fun launchInstall(apk: File) {
    val uri = FileProvider.getUriForFile(this, "$packageName.fileprovider", apk)
    val intent = Intent(Intent.ACTION_VIEW).apply {
      setDataAndType(uri, "application/vnd.android.package-archive")
      addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
      addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
    }
    startActivity(intent)
  }

  // ---- fullscreen video (owner report 2026-08-22: "full screen doesn't
  // actually full screen"). wry's generated RustWebChromeClient rejects
  // the Fullscreen API outright — its onShowCustomView immediately calls
  // callback.onCustomViewHidden(), so m.youtube falls back to an in-page
  // pseudo-fullscreen with the system bars still up. Real browsers
  // (Brave/Chrome) accept the custom view, float it over everything, and
  // go immersive; this replicates that.

  private var fullscreenView: View? = null
  private var fullscreenCallback: WebChromeClient.CustomViewCallback? = null

  // Pinch-to-zoom in fullscreen (owner ask 2026-08-22: the YouTube app
  // zooms the video closer when you spread two fingers). The gesture is
  // observed at dispatch level and never consumed, so the player's own
  // taps/controls keep working; the fullscreen view just scales. Reset
  // on every enter/exit.
  private var fullscreenScale = 1f
  private val scaleDetector by lazy {
    ScaleGestureDetector(
      this,
      object : ScaleGestureDetector.SimpleOnScaleGestureListener() {
        override fun onScale(detector: ScaleGestureDetector): Boolean {
          val view = fullscreenView ?: return false
          fullscreenScale = (fullscreenScale * detector.scaleFactor).coerceIn(1f, 3f)
          view.scaleX = fullscreenScale
          view.scaleY = fullscreenScale
          return true
        }
      },
    )
  }

  override fun dispatchTouchEvent(ev: MotionEvent): Boolean {
    if (fullscreenView != null) scaleDetector.onTouchEvent(ev) else foldBarOnDrag(ev)
    return super.dispatchTouchEvent(ev)
  }

  private fun enterFullscreen(view: View, callback: WebChromeClient.CustomViewCallback) {
    if (fullscreenView != null) {
      callback.onCustomViewHidden()
      return
    }
    fullscreenView = view
    fullscreenCallback = callback
    fullscreenScale = 1f
    view.setBackgroundColor(Color.BLACK)
    // Onto the decor view, NOT the padded content view — fullscreen must
    // cover the inset strips the normal UI deliberately avoids.
    (window.decorView as ViewGroup).addView(
      view,
      ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT),
    )
    val controller = WindowInsetsControllerCompat(window, window.decorView)
    controller.systemBarsBehavior =
      WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
    controller.hide(WindowInsetsCompat.Type.systemBars())
    window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
    // WebView never implements screen.orientation.lock, so the page can't
    // rotate itself the way it does in Chrome — rotate for it, the way
    // video fullscreen is expected to behave. USER_LANDSCAPE still honors
    // both landscape directions. (Trade-off: portrait videos also go
    // landscape; the user's sensor rotation is respected on exit.)
    requestedOrientation = ActivityInfo.SCREEN_ORIENTATION_USER_LANDSCAPE
  }

  private fun exitFullscreen() {
    val view = fullscreenView ?: return
    fullscreenView = null
    view.scaleX = 1f
    view.scaleY = 1f
    fullscreenScale = 1f
    (window.decorView as ViewGroup).removeView(view)
    val callback = fullscreenCallback
    fullscreenCallback = null
    WindowInsetsControllerCompat(window, window.decorView)
      .show(WindowInsetsCompat.Type.systemBars())
    window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
    requestedOrientation = ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED
    callback?.onCustomViewHidden()
  }

  /// wry's RustWebChromeClient is final and attached from Rust AFTER
  /// onWebViewCreate returns (main_pipe.rs: setWebView -> ... ->
  /// setWebChromeClient in one main-thread block), so this runs via
  /// webView.post: by then wry's client is in place and can be wrapped.
  /// The wrapper delegates every behavior wry implements (dialogs,
  /// permissions, file chooser, console, title -> Rust) and replaces only
  /// the fullscreen pair. Needs the webChromeClient getter (API 26+);
  /// below that the old no-fullscreen behavior remains.
  private fun installFullscreenClient() {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
    val wry = webView.webChromeClient ?: return
    webView.webChromeClient = object : WebChromeClient() {
      override fun onShowCustomView(view: View, callback: CustomViewCallback) =
        enterFullscreen(view, callback)

      override fun onHideCustomView() = exitFullscreen()

      override fun onPermissionRequest(request: PermissionRequest) =
        wry.onPermissionRequest(request)

      override fun onJsAlert(view: WebView, url: String, message: String, result: JsResult) =
        wry.onJsAlert(view, url, message, result)

      override fun onJsConfirm(view: WebView, url: String, message: String, result: JsResult) =
        wry.onJsConfirm(view, url, message, result)

      override fun onJsPrompt(
        view: WebView,
        url: String,
        message: String,
        defaultValue: String?,
        result: JsPromptResult,
      ) = wry.onJsPrompt(view, url, message, defaultValue, result)

      override fun onGeolocationPermissionsShowPrompt(
        origin: String,
        callback: GeolocationPermissions.Callback,
      ) = wry.onGeolocationPermissionsShowPrompt(origin, callback)

      override fun onShowFileChooser(
        view: WebView,
        filePathCallback: ValueCallback<Array<Uri>>,
        fileChooserParams: FileChooserParams,
      ) = wry.onShowFileChooser(view, filePathCallback, fileChooserParams)

      override fun onConsoleMessage(consoleMessage: ConsoleMessage) =
        wry.onConsoleMessage(consoleMessage)

      override fun onReceivedTitle(view: WebView, title: String) =
        wry.onReceivedTitle(view, title)
    }
  }

  // --- Network ad blocking -------------------------------------------
  //
  // Owner 2026-08-25: "ads started appearing again... why were they able
  // to get through?" They always could. The adblock engine shipped in
  // Phase 2.5 with EasyList/EasyPrivacy/uBO compiled in, and the app
  // only ever asked it which ELEMENTS to hide. Hiding cannot stop a
  // request, and a YouTube pre-roll is not an element — it is video
  // served through the player. This is the missing half.
  //
  // shouldInterceptRequest runs on a background thread for every
  // subresource, so the decision has to be synchronous: it calls
  // straight into the Rust engine over JNI rather than through a Tauri
  // command (JS-facing, async, main thread).
  private external fun nativeShouldBlock(
    url: String,
    sourceUrl: String,
    resourceType: String,
  ): Boolean

  /// Resources we answer ourselves on the page's own origin — today the
  /// inference worker. Returns null for every normal request.
  ///
  /// This is what lets the models run off the page's main thread:
  /// YouTube requires Trusted Types for scripts, which refuses a blob:
  /// worker but allows a SAME-ORIGIN script url, and nothing serves such
  /// a url but us.
  private external fun nativeSyntheticResource(url: String): ByteArray?

  /// Every synthetic url gets its OWN cache entry. A single slot was a
  /// real bug: the first `/__tamescroll/` request (the bundle) filled it
  /// and every later one — the model json and weights the worker fetches
  /// — was answered with those same bytes, so no model ever parsed and
  /// blur-first left every thumbnail covered.
  ///
  /// Bytes cross JNI once per url per process and are then served from a
  /// file: a cached ByteArray would sit in the heap of a device that has
  /// none to spare. The directory is emptied once per process so a new
  /// build can never be served the previous build's bytes.
  private val syntheticFiles = java.util.concurrent.ConcurrentHashMap<String, java.io.File>()
  private var syntheticDir: java.io.File? = null

  private fun syntheticCacheDir(): java.io.File {
    syntheticDir?.let { return it }
    val dir = java.io.File(cacheDir, "tamescroll-synthetic")
    if (dir.exists()) dir.deleteRecursively()
    // The single-slot cache this replaced left a file behind, and it is
    // the whole bundle — dead weight on a phone that has no room for it.
    java.io.File(cacheDir, "tamescroll-synthetic.js").delete()
    dir.mkdirs()
    syntheticDir = dir
    return dir
  }

  private fun syntheticResponse(url: String): WebResourceResponse? {
    try {
      val path = url.substringAfter("/__tamescroll/").substringBefore('?')
      if (path.isEmpty()) return null
      val key = path.replace(Regex("[^A-Za-z0-9._-]"), "_")
      val cached = syntheticFiles[key]
      if (cached != null && cached.exists()) {
        return syntheticStream(path, java.io.FileInputStream(cached))
      }
      val bytes = nativeSyntheticResource(url) ?: return null
      val out = java.io.File(syntheticCacheDir(), key)
      out.writeBytes(bytes)
      syntheticFiles[key] = out
      return syntheticStream(path, java.io.FileInputStream(out))
    } catch (e: Throwable) {
      // Falling through means the page simply does not get a worker and
      // the in-page pipeline runs, which is the previous behaviour.
      Log.w("tamescroll", "synthetic resource failed: " + e.message)
      return null
    }
  }

  private fun syntheticMime(path: String): String =
    when {
      path.endsWith(".json") -> "application/json"
      path.endsWith(".bin") -> "application/octet-stream"
      else -> "text/javascript"
    }

  private fun syntheticStream(path: String, stream: java.io.InputStream): WebResourceResponse =
    WebResourceResponse(
      syntheticMime(path),
      "utf-8",
      200,
      "OK",
      mapOf("Cache-Control" to "no-store"),
      stream,
    )

  /// A blocked request answers with an empty 204 rather than an error.
  /// A hard failure makes pages retry, log errors and sometimes show
  /// their own "content blocked" placeholder — an empty success is the
  /// quiet outcome, and quiet is the product (NO NAGS).
  private fun blockedResponse(): WebResourceResponse =
    WebResourceResponse("text/plain", "utf-8", 204, "No Content", emptyMap(), ByteArrayInputStream(ByteArray(0)))

  /// Filter lists genuinely use resource-type options (script-only,
  /// image-only, third-party-only rules), so the type is part of the
  /// decision, not decoration. Android does not hand us the fetch
  /// destination directly, so it is inferred from the Accept header and
  /// the URL — imperfect, but far better than passing "other" for
  /// everything, which would silently disable every typed rule.
  private fun resourceTypeOf(request: WebResourceRequest): String {
    if (request.isForMainFrame) return "document"
    val accept = request.requestHeaders?.get("Accept").orEmpty()
    val path = request.url.path.orEmpty().lowercase()
    return when {
      accept.contains("text/css") || path.endsWith(".css") -> "stylesheet"
      accept.contains("image/") || Regex("\\.(png|jpe?g|gif|webp|svg|ico)$").containsMatchIn(path) -> "image"
      path.endsWith(".js") || path.endsWith(".mjs") -> "script"
      accept.contains("text/html") -> "sub_frame"
      Regex("\\.(mp4|webm|m4s|ts)$").containsMatchIn(path) -> "media"
      accept.contains("application/json") -> "xhr"
      else -> "other"
    }
  }

  // THE TOP BAR (his 2026-10-27, #33: "make it look more like a
  // browser"). Above every site, never on the launcher: home, the page's
  // address (tap it to search or type a new one, on the launcher's own
  // box) and a shield that opens this site's settings. Native, OUTSIDE
  // the WebView: the page only sees a shorter viewport, the way it would
  // under Chrome's toolbar, so nothing the gaze page measures moves
  // inside it. Video fullscreen sits on the decor view and covers it.
  private var topBar: View? = null
  private var topStrip: TextView? = null
  private var topBarAddress: TextView? = null
  private var topBarHost: View? = null
  private var topBarUrl = ""

  private fun installTopBar() {
    val content = findViewById<FrameLayout>(android.R.id.content) ?: return
    // The child of content that holds the WebView (the WebView itself
    // when wry sets it as the content view): the bar pushes it down.
    var host: View = webView
    while (host.parent != null && host.parent !== content) {
      host = host.parent as? View ?: return
    }
    if (host.parent !== content) return
    val dp = resources.displayMetrics.density
    val px = { v: Int -> (v * dp).toInt() }
    val ripple = TypedValue().also {
      theme.resolveAttribute(android.R.attr.selectableItemBackgroundBorderless, it, true)
    }.resourceId
    fun icon(res: Int, label: String, onTap: () -> Unit) = ImageButton(this).apply {
      setImageResource(res)
      contentDescription = label
      setBackgroundResource(ripple)
      layoutParams = LinearLayout.LayoutParams(px(44), px(44))
      setOnClickListener { onTap() }
    }
    val bar = LinearLayout(this).apply {
      orientation = LinearLayout.HORIZONTAL
      gravity = Gravity.CENTER_VERTICAL
      setBackgroundColor(0xFF141414.toInt())
      setPadding(px(4), 0, px(4), 0)
      visibility = View.GONE
    }
    val address = TextView(this).apply {
      setTextColor(0xFFE7E5E1.toInt())
      setTextSize(TypedValue.COMPLEX_UNIT_SP, 14f)
      maxLines = 1
      ellipsize = TextUtils.TruncateAt.END
      gravity = Gravity.CENTER_VERTICAL
      setPadding(px(14), 0, px(14), 0)
      background = GradientDrawable().apply {
        cornerRadius = px(18).toFloat()
        setColor(0xFF242320.toInt())
      }
      contentDescription = "Search or type a site"
      layoutParams = LinearLayout.LayoutParams(0, px(36), 1f).apply {
        marginStart = px(4)
        marginEnd = px(4)
      }
      setOnClickListener { webView.loadUrl("http://tauri.localhost/?search=" + Uri.encode(topBarUrl)) }
    }
    bar.addView(icon(R.drawable.ic_bar_home, "Home") { webView.loadUrl(launcherUrl(null)) })
    bar.addView(address)
    bar.addView(icon(R.drawable.ic_bar_shield, "What was tamed on this page") { showShieldSheet() })
    // The folded bar: a slim strip with the site's name, under the full
    // bar so the bar covers it when out. Tapping it brings the bar back.
    val strip = TextView(this).apply {
      setTextColor(0xFFA8A49D.toInt())
      setTextSize(TypedValue.COMPLEX_UNIT_SP, 12f)
      maxLines = 1
      ellipsize = TextUtils.TruncateAt.END
      gravity = Gravity.CENTER
      setBackgroundColor(0xFF141414.toInt())
      contentDescription = "Show the address bar"
      visibility = View.GONE
      setOnClickListener { foldBar(true) }
    }
    content.addView(strip, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, px(TOP_STRIP_DP), Gravity.TOP))
    content.addView(bar, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, px(TOP_BAR_DP), Gravity.TOP))
    topBar = bar
    topStrip = strip
    topBarAddress = address
    topBarHost = host
    updateTopBar(webView.url)
  }

  // THE SHIELD SHEET (2026-10-27 redesign, #39): the receipt for this
  // page. One number we actually know, the requests the block rules
  // stopped since this page's main-frame load, and the way into this
  // site's switches. Over the page, so looking costs nothing.
  private val blockedOnPage = java.util.concurrent.atomic.AtomicInteger(0)

  // Today's total for the launcher's "today" line. Kept on this phone
  // only, saved at each page load, and reset when the date changes.
  // -1 until read back from prefs on the first page load.
  private val stoppedToday = java.util.concurrent.atomic.AtomicInteger(-1)
  @Volatile private var statsDay = ""

  private fun statsToday(): String =
    java.text.SimpleDateFormat("yyyy-MM-dd", java.util.Locale.US).format(java.util.Date())

  @Synchronized private fun rollStatsDay() {
    val day = statsToday()
    if (stoppedToday.get() < 0) {
      val prefs = getSharedPreferences(STATS_PREFS, MODE_PRIVATE)
      val saved = prefs.getString("day", "") ?: ""
      stoppedToday.set(if (saved == day) prefs.getInt("stopped", 0) else 0)
      statsDay = day
    } else if (statsDay != day) {
      statsDay = day
      stoppedToday.set(0)
    }
  }

  private fun saveStats() {
    getSharedPreferences(STATS_PREFS, MODE_PRIVATE).edit()
      .putString("day", statsDay)
      .putInt("stopped", stoppedToday.get().coerceAtLeast(0))
      .apply()
  }

  /** A count, never a url or a host: every page can see this bridge. */
  inner class StatsBridge {
    @JavascriptInterface
    fun stoppedToday(): Int {
      rollStatsDay()
      return stoppedToday.get().coerceAtLeast(0)
    }
  }

  private fun showShieldSheet() {
    val dp = resources.displayMetrics.density
    val px = { v: Int -> (v * dp).toInt() }
    val host = (Uri.parse(topBarUrl).host ?: "").removePrefix("www.").removePrefix("m.")
    val stopped = blockedOnPage.get()
    val sheet = com.google.android.material.bottomsheet.BottomSheetDialog(this)
    fun text(value: String, sp: Float, color: Int, bold: Boolean = false) = TextView(this).apply {
      text = value
      setTextColor(color)
      setTextSize(TypedValue.COMPLEX_UNIT_SP, sp)
      if (bold) setTypeface(typeface, android.graphics.Typeface.BOLD)
    }
    val box = LinearLayout(this).apply {
      orientation = LinearLayout.VERTICAL
      setPadding(px(24), px(12), px(24), px(28))
      background = GradientDrawable().apply {
        val r = px(20).toFloat()
        cornerRadii = floatArrayOf(r, r, r, r, 0f, 0f, 0f, 0f)
        setColor(0xFF1C1C1C.toInt())
      }
    }
    box.addView(View(this).apply {
      background = GradientDrawable().apply { cornerRadius = px(2).toFloat(); setColor(0xFF363636.toInt()) }
      layoutParams = LinearLayout.LayoutParams(px(36), px(4)).apply {
        gravity = Gravity.CENTER_HORIZONTAL
        bottomMargin = px(16)
      }
    })
    box.addView(text(host, 17f, 0xFFE7E5E1.toInt(), bold = true))
    box.addView(text("$stopped", 34f, 0xFFE7E5E1.toInt()).apply {
      setPadding(0, px(12), 0, 0)
    })
    box.addView(text(
      when (stopped) {
        0 -> "ads and trackers stopped on this page. A quiet one."
        1 -> "ad or tracker stopped on this page."
        else -> "ads and trackers stopped on this page."
      },
      14f, 0xFFA8A49D.toInt(),
    ))
    box.addView(text(
      "Pictures follow your blur choice. On the sites we tame, feeds are hidden too.",
      13f, 0xFF7A766E.toInt(),
    ).apply { setPadding(0, px(12), 0, 0) })
    box.addView(text("Change what's hidden here", 14f, 0xFF141414.toInt(), bold = true).apply {
      gravity = Gravity.CENTER
      background = GradientDrawable().apply { cornerRadius = px(10).toFloat(); setColor(0xFFE7E5E1.toInt()) }
      layoutParams = LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, px(48)).apply {
        topMargin = px(20)
      }
      setOnClickListener {
        sheet.dismiss()
        webView.loadUrl("http://tauri.localhost/?settings=" + Uri.encode(topBarUrl))
      }
    })
    sheet.setContentView(box)
    sheet.setOnShowListener {
      // Our rounded box is the sheet; the library's own surface stays clear.
      sheet.findViewById<View>(com.google.android.material.R.id.design_bottom_sheet)
        ?.setBackgroundColor(Color.TRANSPARENT)
    }
    sheet.show()
  }

  // THE BAR FOLDS AWAY (his 2026-10-28: "like Safari"). Dragging the
  // page up folds it to a slim strip with the site's name, and a YouTube
  // watch page opens folded so the video sits near the top. Only a tap on
  // the strip (or a new page) brings it back: it used to return on any
  // drag down, and he found it popping in and out while reading
  // annoying (2026-10-28, on the 1124 test build). Driven by the
  // finger, not by WebView scroll events: m.youtube scrolls inside the
  // page, where onScrollChanged never fires. The touch is only watched,
  // never consumed. Folding shrinks the WebView's top margin with the
  // bar, the way Chrome's toolbar gives its height back to the page.
  private var barFraction = 1f
  private var barAnimator: android.animation.ValueAnimator? = null
  private var barPageKey = ""
  private var dragLastX = 0f
  private var dragLastY = 0f
  private var dragTravel = 0f

  private fun applyBarFraction(f: Float) {
    val bar = topBar ?: return
    val host = topBarHost ?: return
    barFraction = f
    val density = resources.displayMetrics.density
    val h = TOP_BAR_DP * density
    val strip = TOP_STRIP_DP * density
    bar.translationY = -(1f - f) * h
    topStrip?.let {
      it.alpha = 1f - f
      it.visibility = if (bar.visibility == View.VISIBLE && f < 1f) View.VISIBLE else View.GONE
    }
    val lp = host.layoutParams as? ViewGroup.MarginLayoutParams ?: return
    val margin = (strip + f * (h - strip)).toInt()
    if (lp.topMargin == margin) return
    lp.topMargin = margin
    host.layoutParams = lp
  }

  private fun foldBar(show: Boolean) {
    if (topBar?.visibility != View.VISIBLE) return
    val target = if (show) 1f else 0f
    if (barFraction == target && barAnimator == null) return
    barAnimator?.cancel()
    barAnimator = android.animation.ValueAnimator.ofFloat(barFraction, target).apply {
      duration = 180
      addUpdateListener { applyBarFraction(it.animatedValue as Float) }
      addListener(object : android.animation.AnimatorListenerAdapter() {
        override fun onAnimationEnd(animation: android.animation.Animator) {
          if (barAnimator === animation) barAnimator = null
        }
      })
      start()
    }
  }

  private fun foldBarOnDrag(ev: MotionEvent) {
    if (topBar?.visibility != View.VISIBLE) return
    when (ev.actionMasked) {
      MotionEvent.ACTION_DOWN -> {
        dragLastX = ev.rawX
        dragLastY = ev.rawY
        dragTravel = 0f
      }
      MotionEvent.ACTION_MOVE -> {
        val dx = ev.rawX - dragLastX
        val dy = ev.rawY - dragLastY
        dragLastX = ev.rawX
        dragLastY = ev.rawY
        // Sideways swipes (carousels, the seek bar) never move the bar.
        if (Math.abs(dy) <= Math.abs(dx)) return
        if ((dy > 0) != (dragTravel > 0)) dragTravel = 0f
        dragTravel += dy
        val threshold = 24 * resources.displayMetrics.density
        if (dragTravel < -threshold) foldBar(false)
      }
    }
  }

  private fun isWatchPage(u: Uri): Boolean {
    val host = u.host ?: return false
    return (host == "youtube.com" || host.endsWith(".youtube.com")) &&
      (u.path ?: "").startsWith("/watch")
  }

  /** Shows the bar on a web page and hides it on the launcher. UI thread. */
  private fun updateTopBar(url: String?) {
    val bar = topBar ?: return
    val u = url ?: ""
    val onSite = (u.startsWith("https://") || u.startsWith("http://")) && !u.contains("tauri.localhost")
    if (!onSite) {
      if (bar.visibility == View.GONE) return
      barAnimator?.cancel()
      barAnimator = null
      bar.visibility = View.GONE
      applyBarFraction(0f)
      // Off a site the page gets the whole screen back, strip included.
      (topBarHost?.layoutParams as? ViewGroup.MarginLayoutParams)?.let {
        it.topMargin = 0
        topBarHost?.layoutParams = it
      }
      bar.translationY = 0f
      barPageKey = ""
      return
    }
    topBarUrl = u
    val uri = Uri.parse(u)
    topBarAddress?.text = (uri.host ?: u).removePrefix("www.").removePrefix("m.")
    topStrip?.text = topBarAddress?.text
    if (bar.visibility != View.VISIBLE) {
      bar.visibility = View.VISIBLE
      applyBarFraction(1f)
    }
    // Each new page decides once (an SPA reports the same url several
    // times): a watch page opens folded, anything else with the bar out.
    // After that the finger decides.
    val key = u.substringBefore('#')
    if (key == barPageKey) return
    barPageKey = key
    foldBar(!isWatchPage(uri))
  }

  /// Same shape as installFullscreenClient: wry's RustWebViewClient is
  /// final and attached from Rust after onWebViewCreate returns, so this
  /// runs via webView.post and WRAPS it. Every method wry overrides is
  /// forwarded verbatim — the wrapper adds a block check in front of
  /// shouldInterceptRequest and changes nothing else. Getting this wrong
  /// breaks the custom protocol the whole app is served over, so the
  /// delegation is deliberately total.
  /// The top-level page url, written on the main thread and read from
  /// the interceptor's worker thread. See the note in
  /// installBlockingClient for why this exists rather than `view.url`.
  @Volatile private var pageUrlForBlocking: String = ""

  private fun installBlockingClient() {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
    val wry = webView.webViewClient
    webView.webViewClient = object : WebViewClient() {
      override fun shouldInterceptRequest(
        view: WebView,
        request: WebResourceRequest,
      ): WebResourceResponse? {
        // THE PER-DOCUMENT TOKEN DOOR RE-ARMS HERE, on the main-frame
        // request, NOT in onPageStarted. The document cannot run its
        // start scripts before its bytes were asked for, so this always
        // precedes the stash's TsPerf.claim(); onPageStarted does not --
        // measured on the Redmi (1100): one reload's stash claimed before
        // the reset and got "", so the tuning store had no token for that
        // document (override not read, Reset refused). And a reset that
        // lands AFTER the stash claimed would re-open the door to a page
        // script, which is the N8 exposure back again.
        if (request.isForMainFrame) {
          perfTokenServed = false
          blockedOnPage.set(0)
          rollStatsDay()
          saveStats()
        }
        try {
          val url = request.url.toString()
          // Never evaluate our own surfaces: a false positive there
          // bricks the app, and they cannot serve an ad.
          if (!url.startsWith("http")) return wry.shouldInterceptRequest(view, request)
          // Ours before theirs: this url exists only because we answer
          // it, and it must never be run past the block rules.
          if (url.contains("/__tamescroll/")) {
            syntheticResponse(url)?.let { return it }
          }
          // NEVER `view.url` HERE. shouldInterceptRequest runs on a
          // WebView worker thread, and every WebView method must be
          // called on the thread that made it -- so reading view.url
          // threw on EVERY request, the catch below fail-opened, and
          // request blocking never ran on Android at all. It looked
          // healthy from the outside because the synthetic-resource
          // branch above returns before this line, so the inference
          // worker loaded normally while nothing was ever blocked.
          // MEASURED on the emulator 2026-08-30: 1,107 "block check
          // failed" warnings in one logcat, all of them this exception,
          // and the request counter stayed at 0 across three page loads.
          // The page url is recorded on the main thread instead.
          if (nativeShouldBlock(url, pageUrlForBlocking, resourceTypeOf(request))) {
            blockedOnPage.incrementAndGet()
            if (stoppedToday.get() >= 0) stoppedToday.incrementAndGet()
            return blockedResponse()
          }
        } catch (e: Throwable) {
          // Fail OPEN. An engine that cannot answer must not take the
          // page down with it: a missed ad is a nuisance, a dead page is
          // a broken app.
          Log.w("tamescroll", "block check failed, allowing: " + e.message)
        }
        return wry.shouldInterceptRequest(view, request)
      }

      override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest) =
        wry.shouldOverrideUrlLoading(view, request)

      override fun onPageStarted(view: WebView, url: String, favicon: Bitmap?) {
        pageUrlForBlocking = url
        updateTopBar(url)
        applyStrips(url)
        // The port is PULLED by the document-start stash (TsNativePort.
        // requestPort), never pushed from here: a WebMessage posted at
        // onPageStarted can be delivered before the document's start
        // scripts have installed their listener (measured 1 of 7
        // navigations on the Redmi, 2026-09-02), and a message nobody
        // hears is a page with no native engine and no counter saying so.
        nativePortServed = false
        // perfTokenServed re-arms on the main-frame REQUEST (see
        // shouldInterceptRequest), never here.
        wry.onPageStarted(view, url, favicon)
      }

      // An SPA navigation fires no onPageStarted, and m.youtube is one:
      // tapping a video never leaves the document. Without this the
      // source url handed to the engine would be whatever page was last
      // hard-loaded, and exception rules are scoped by source. (The
      // native-inference port is NOT re-bound here: an SPA nav keeps the
      // document, and the document keeps its port.)
      override fun doUpdateVisitedHistory(view: WebView, url: String, isReload: Boolean) {
        pageUrlForBlocking = url
        updateTopBar(url)
        wry.doUpdateVisitedHistory(view, url, isReload)
      }

      override fun onPageFinished(view: WebView, url: String) {
        wry.onPageFinished(view, url)
      }

      override fun onReceivedError(
        view: WebView,
        request: WebResourceRequest,
        error: WebResourceError,
      ) {
        // OFFLINE SCREEN (owner ask 2026-09-01: "when there is no
        // internet and we try to open the YouTube app, it shows the link
        // isn't valid or something like that").
        //
        // WebView's own error page is a Chromium string about an invalid
        // URL, which reads like OUR app is broken rather than like the
        // network is down. Replace it with ours -- but only in the
        // narrow case where that is actually what happened.
        if (shouldShowOffline(request, error)) {
          view.loadDataWithBaseURL(
            null,
            offlineHtml(request.url.toString()),
            "text/html",
            "utf-8",
            // The failing url as the history entry, so Back behaves the
            // way it would have if the page HAD loaded, and a reload
            // retries the real page rather than re-rendering this one.
            request.url.toString(),
          )
          return
        }
        wry.onReceivedError(view, request, error)
      }
    }
  }

  /// Deliberately narrow. Three things have to be true, and each one is
  /// a way this could otherwise hide a real bug behind a friendly page:
  ///
  ///  - MAIN FRAME ONLY. A failed image or an XHR must not blank the
  ///    app; on a feed those fail constantly and by design (we block
  ///    them ourselves).
  ///  - A NETWORK error, not any error. An SSL failure or a bad scheme
  ///    is not "you are offline" and must keep its own page.
  ///  - NOT OUR OWN URLS. If tauri.localhost or a /__tamescroll/ url
  ///    fails, the app is broken and saying "check your connection"
  ///    would send the owner looking at his router.
  private fun shouldShowOffline(request: WebResourceRequest, error: WebResourceError): Boolean {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.M) return false
    if (!request.isForMainFrame) return false
    val url = request.url.toString()
    if (!url.startsWith("http")) return false
    if (url.contains("tauri.localhost") || url.contains("/__tamescroll/")) return false
    return when (error.errorCode) {
      WebViewClient.ERROR_HOST_LOOKUP,
      WebViewClient.ERROR_CONNECT,
      WebViewClient.ERROR_TIMEOUT,
      WebViewClient.ERROR_IO,
      WebViewClient.ERROR_UNKNOWN,
      -> true
      else -> false
    }
  }

  /// Self-contained: no network, no fonts, no images. It is the page
  /// shown when nothing can be fetched, so anything it references would
  /// fail too. Colours and type are the launcher's own tokens
  /// (app/src/styles.css) so it reads as part of the app rather than as
  /// a browser error, and the font stacks fall back to the system.
  ///
  /// It states a fact and offers two ways out. It does not apologise,
  /// does not blame, and asks for nothing -- NO NAGS is a hard rule here
  /// and an error screen is exactly where one usually creeps in.
  private fun offlineHtml(failed: String): String {
    val safe = failed
      .replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
      .replace("\"", "&quot;")
    return """<!doctype html>
<html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>No connection</title>
<style>
  :root {
    --bg:#141414; --ink:#e7e5e1; --muted:#a3a09a; --faint:#757169;
    --line:#343434; --hairline:rgba(255,255,255,.07);
    --elev:rgba(255,255,255,.035); --gold:#c9a45e;
    --font-ui:"Inter",system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;
    --font-display:"Spectral",Georgia,serif;
  }
  * { box-sizing:border-box; margin:0; padding:0; -webkit-tap-highlight-color:transparent; }
  html,body { height:100%; }
  body {
    background:var(--bg); color:var(--ink); font-family:var(--font-ui);
    display:flex; align-items:center; justify-content:center;
    padding:32px calc(24px + env(safe-area-inset-left)) 32px calc(24px + env(safe-area-inset-right));
    -webkit-user-select:none; user-select:none;
  }
  main { max-width:340px; width:100%; text-align:center;
         animation:ts-enter .18s cubic-bezier(.2,0,0,1) both; }
  @keyframes ts-enter { from { opacity:0; transform:translateY(6px); } to { opacity:1; transform:none; } }
  @media (prefers-reduced-motion: reduce) { main { animation:none; } }
  .mark { font-family:var(--font-display); font-size:26px; letter-spacing:.01em; color:var(--gold); }
  h1 { font-size:19px; font-weight:600; margin-top:22px; }
  p { color:var(--muted); font-size:14.5px; line-height:1.5; margin-top:10px; }
  .host { color:var(--faint); font-size:12.5px; margin-top:18px; word-break:break-all; }
  .row { display:flex; gap:10px; margin-top:26px; }
  a { flex:1; display:block; text-decoration:none; padding:12px 14px; border-radius:10px;
      font-size:14.5px; border:1px solid var(--hairline); background:var(--elev);
      color:var(--muted); transition:border-color .15s ease, transform .15s ease; }
  a.primary { border-color:var(--gold); color:var(--ink); }
  a:active { transform:scale(.97); }
</style></head>
<body><main>
  <div class="mark">tamescroll</div>
  <h1>No connection</h1>
  <p>This page needs the internet, and your phone cannot reach it right now.</p>
  <div class="row">
    <a class="primary" href="$safe">Try again</a>
    <a href="http://tauri.localhost/">Home</a>
  </div>
  <p class="host">$safe</p>
</main></body></html>"""
  }

  // ---- Native on-device inference (2026-09-02 plan): the page keeps
  // all policy (anchors/NMS, parsePersons, gender/age reads, tracking,
  // cadence); Kotlin is a dumb tensor runner reached over a
  // WebMessagePort. See NativeInfer.kt for the protocol and why
  // WebMessagePortCompat.postMessage needs no main-thread hop (it is
  // annotated @AnyThread at the class level -- confirmed by
  // disassembling androidx.webkit 1.14.0's WebMessagePortCompat.class,
  // not merely assumed from the docs).
  //
  // The native tensor runner (NativeInfer.kt). ONE engine for the
  // process -- the GPU delegate spends ~8s compiling the three models on
  // the Redmi, so they are loaded on the first YouTube page and kept.
  // Each DOCUMENT gets its own WebMessagePort, bound from onPageStarted:
  // that is the only hook a new document has before its scripts run, and
  // an SPA navigation (doUpdateVisitedHistory) keeps the document and
  // therefore the port. The page's end is posted as the string message
  // `ts-native-port` with the port attached; the document-start script
  // stashes it, because the gaze bundle is evaluated later and a message
  // nobody is listening for is simply gone. No @JavascriptInterface is
  // involved anywhere in this path.
  @Volatile private var nativeInfer: NativeInfer? = null
  // One port per document: the stash asks once at document start, and a
  // page script that finds the bridge and asks again gets nothing (a
  // second bind would close the engine's side of the port the bundle is
  // already using). Reset on every onPageStarted.
  @Volatile private var nativePortServed = false

  inner class NativePortBridge {
    @JavascriptInterface
    fun requestPort() {
      runOnUiThread {
        val view = webView ?: return@runOnUiThread
        if (nativePortServed) return@runOnUiThread
        nativePortServed = true
        bindNativeInfer(view, view.url ?: "")
      }
    }
  }

  override fun onDestroy() {
    // SDK-guarded before touching the class at all: an instanceof/cast
    // against android.os.PerformanceHintManager.Session must never be
    // the thing this method does unconditionally on every API level.
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S && hintSession != null) {
      try {
        (hintSession as? android.os.PerformanceHintManager.Session)?.close()
      } catch (e: Throwable) {
        // already closed / invalidated -- fine
      }
    }
    hintSession = null
    nativeInfer?.close()
    nativeInfer = null
    super.onDestroy()
  }

  private fun isYoutubeHost(host: String?): Boolean =
    host != null && (host == "youtube.com" || host.endsWith(".youtube.com"))

  private fun bindNativeInfer(view: WebView, url: String) {
    try {
      val host = try { Uri.parse(url).host } catch (e: Exception) { null }
      // One line per hard navigation: which host started, and whether
      // the engine was offered. A watch page that shows no `bound` line
      // after this one is a feature-check refusal, not a missing start.
      Log.i("TsNative", "page start host=" + host + " youtube=" + isYoutubeHost(host))
      if (!isYoutubeHost(host)) return
      if (!WebViewFeature.isFeatureSupported(WebViewFeature.CREATE_WEB_MESSAGE_CHANNEL) ||
        !WebViewFeature.isFeatureSupported(WebViewFeature.POST_WEB_MESSAGE) ||
        !WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_CALLBACK_ON_MESSAGE) ||
        !WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_ARRAY_BUFFER)
      ) {
        Log.w("TsNative", "WebView lacks a WebMessage feature; native inference off")
        return
      }
      val engine = nativeInfer ?: NativeInfer(this).also { nativeInfer = it }
      val ports = WebViewCompat.createWebMessageChannel(view)
      engine.bind(ports[0])
      WebViewCompat.postWebMessage(
        view,
        WebMessageCompat("ts-native-port", arrayOf(ports[1])),
        Uri.parse("*"),
      )
    } catch (e: Throwable) {
      Log.w("TsNative", "native infer setup failed: " + e.message)
    }
  }

  // ---- performance dials (performance batch 1098, plan Task 2). Every
  // one of these is a THROTTLE OR HINT to the OS, never a correctness
  // path, and every dial that reaches here from tuning.mjs ships at
  // today's behaviour (off/0) so nothing changes on a phone until the
  // owner pushes a number. Every OS call is guarded by SDK level and
  // wrapped in try/catch -- a perf bridge that crashes the app is a far
  // worse outcome than one that silently does nothing.

  private fun currentDisplayCompat(): Display? {
    return try {
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
        display
      } else {
        @Suppress("DEPRECATION")
        windowManager.defaultDisplay
      }
    } catch (e: Throwable) {
      null
    }
  }

  private fun clearRefreshCap() {
    val attrs = window.attributes
    attrs.preferredDisplayModeId = 0
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
      attrs.preferredRefreshRate = 0f
    }
    window.attributes = attrs
  }

  /** Picks the mode with the SAME physical resolution as the display's
   * CURRENT mode and the highest refresh rate at or below `hz`. Leaves
   * the display alone (does nothing) if no such mode exists -- this
   * never widens the resolution to chase a refresh rate, and it never
   * lowers refresh below what the caller asked simply because a closer
   * mode wasn't found. */
  private fun applyRefreshCap(hz: Int) {
    val disp = currentDisplayCompat() ?: return
    val cur = disp.mode ?: return
    var best: Display.Mode? = null
    for (m in disp.supportedModes) {
      if (m.physicalWidth == cur.physicalWidth &&
        m.physicalHeight == cur.physicalHeight &&
        m.refreshRate <= hz.toFloat() + 0.01f // float compare slop
      ) {
        val b = best
        if (b == null || m.refreshRate > b.refreshRate) best = m
      }
    }
    val chosen = best ?: return
    val attrs = window.attributes
    attrs.preferredDisplayModeId = chosen.modeId
    window.attributes = attrs
  }

  // android.os.PerformanceHintManager.Session, API 31+. Typed as Any?
  // rather than the real type so the field's own descriptor never forces
  // that class to resolve on a pre-31 device -- every real reference to
  // it lives inside an SDK_INT-guarded try/catch in PerfBridge.hint.
  @Volatile private var hintSession: Any? = null

  // PerfBridge answers only to a token the page cannot get (phase-n
  // N8). One token per process, handed to the FIRST caller of claim()
  // per document -- the document-start stash lib.rs injects
  // (perf_token_stash_script), which runs before any page script and
  // parks it behind a one-shot non-configurable getter. Reset on every
  // onPageStarted beside nativePortServed. A page script that finds
  // the bridge gets "" from claim() and a silent no-op from every
  // method: inferPriority(2) would otherwise let the page background
  // the inference thread (a wider verdict gap = more exposure),
  // refreshCap change the display mode, sustained cap the clocks.
  private val perfToken: String = java.util.UUID.randomUUID().toString()
  @Volatile private var perfTokenServed = false

  inner class PerfBridge {
    private fun ok(token: String?): Boolean = token != null && token == perfToken

    /** The token, once per document; "" for every later caller. */
    @JavascriptInterface
    fun claim(): String {
      if (perfTokenServed) return ""
      perfTokenServed = true
      return perfToken
    }

    @JavascriptInterface
    fun sustained(token: String?, on: Boolean) {
      if (!ok(token)) return
      try {
        runOnUiThread {
          try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
              window.setSustainedPerformanceMode(on)
            }
          } catch (e: Throwable) {
            Log.w(TAG_PERF, "sustained failed: " + e.message)
          }
        }
      } catch (e: Throwable) {
        Log.w(TAG_PERF, "sustained dispatch failed: " + e.message)
      }
    }

    @JavascriptInterface
    fun refreshCap(token: String?, hz: Int) {
      if (!ok(token)) return
      try {
        runOnUiThread {
          try {
            if (hz <= 0) clearRefreshCap() else applyRefreshCap(hz)
          } catch (e: Throwable) {
            Log.w(TAG_PERF, "refreshCap apply failed: " + e.message)
          }
        }
      } catch (e: Throwable) {
        Log.w(TAG_PERF, "refreshCap dispatch failed: " + e.message)
      }
    }

    /** The refresh rate actually in effect right now (display.refreshRate),
     * so the page can learn what refreshCap() landed on without a second
     * round trip through the UI thread. Synchronous, like every
     * @JavascriptInterface method with a return value. */
    @JavascriptInterface
    fun currentRefreshHz(token: String?): Float {
      if (!ok(token)) return Float.NaN
      return try {
        currentDisplayCompat()?.refreshRate ?: Float.NaN
      } catch (e: Throwable) {
        Float.NaN
      }
    }

    @JavascriptInterface
    fun thermalHeadroom(token: String?): Float {
      if (!ok(token)) return Float.NaN
      return try {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.R) return Float.NaN
        val pm = getSystemService(POWER_SERVICE) as? android.os.PowerManager ?: return Float.NaN
        pm.getThermalHeadroom(10)
      } catch (e: Throwable) {
        Float.NaN
      }
    }

    /** ADPF: a PerformanceHintManager session over the ts-infer thread,
     * fed by NativeInfer.onInferenceDuration -- every model inference
     * (never a CONFIG rebuild) reports its actual duration so the
     * scheduler can favor that thread toward the 33ms target instead of
     * guessing from CPU load alone. off() closes the session; a session
     * the OS has already invalidated fails its report/close silently. */
    @JavascriptInterface
    fun hint(token: String?, on: Boolean) {
      if (!ok(token)) return
      try {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S) return
        if (on) {
          if (hintSession != null) return
          val engine = nativeInfer ?: return
          val tid = engine.inferTid
          if (tid <= 0) return
          val mgr = getSystemService(android.os.PerformanceHintManager::class.java) ?: return
          val session = mgr.createHintSession(intArrayOf(tid), PERF_HINT_TARGET_NS)
          hintSession = session
          engine.onInferenceDuration = { durationNanos ->
            try {
              (hintSession as? android.os.PerformanceHintManager.Session)
                ?.reportActualWorkDuration(durationNanos)
            } catch (e: Throwable) {
              // The OS can invalidate a session at any time (thread
              // death, app backgrounded); a failed report is dropped,
              // never fatal to the inference it describes.
            }
          }
        } else {
          nativeInfer?.onInferenceDuration = null
          try {
            (hintSession as? android.os.PerformanceHintManager.Session)?.close()
          } catch (e: Throwable) {
            // already closed / invalidated -- fine
          }
          hintSession = null
        }
      } catch (e: Throwable) {
        Log.w(TAG_PERF, "hint failed: " + e.message)
      }
    }

    @JavascriptInterface
    fun inferPriority(token: String?, level: Int) {
      if (!ok(token)) return
      try {
        val engine = nativeInfer ?: return
        val tid = engine.inferTid
        if (tid <= 0) return
        val prio = when (level) {
          1 -> Process.THREAD_PRIORITY_LESS_FAVORABLE
          2 -> Process.THREAD_PRIORITY_BACKGROUND
          else -> Process.THREAD_PRIORITY_DEFAULT
        }
        Process.setThreadPriority(tid, prio)
      } catch (e: Throwable) {
        Log.w(TAG_PERF, "inferPriority failed: " + e.message)
      }
    }
  }

  // O1 (phase-o): the local override store used to be `localStorage`,
  // which belongs to the PAGE on m.youtube -- so a script on YouTube's
  // own origin (or one it loads) could read AND WRITE
  // `tamescroll.tuning` and weaken any protection dial the panel can
  // reach, silently, with no build and no OTA push. That is the same
  // shape as the pre-N8 TsPerf hole: an interface reachable by any
  // script is an interface OWNED by any script.
  //
  // Fix is the SAME token door PerfBridge already uses -- `perfToken`
  // is claimed once per document via `__TS_TAKE_PERF_TOKEN`, and every
  // method here refuses without it, exactly like `PerfBridge.ok`. The
  // store itself moves off the page entirely into SharedPreferences,
  // which no page script can reach at all (WebView never exposes app
  // SharedPreferences to content). A page that never claims the token
  // -- or claims it after gaze's own init script already took it --
  // gets "" from get() and a silent no-op from set(): the panel reports
  // "Overrides need the Android app" and edits stay in memory only,
  // which is the fail-safe already documented for desktop.
  inner class TsTune {
    private fun ok(token: String?): Boolean = token != null && token == perfToken

    /** The stored JSON blob, or "" if there is none / the token is
     * wrong / the store is unreadable. Never throws. */
    @JavascriptInterface
    fun get(token: String?): String {
      if (!ok(token)) return ""
      return try {
        val prefs = getSharedPreferences(TUNE_PREFS, MODE_PRIVATE)
        prefs.getString(TUNE_KEY, "") ?: ""
      } catch (e: Throwable) {
        Log.w(TAG_TUNE, "get failed: " + e.message)
        ""
      }
    }

    /** Persist one JSON blob (the whole override map -- the page owns
     * shaping it, this bridge only stores bytes). Empty string clears
     * it. Oversized or unwritable input is dropped silently -- a
     * failed persist must never look like a crash to the page. */
    @JavascriptInterface
    fun set(token: String?, json: String?) {
      if (!ok(token)) return
      try {
        val body = json ?: ""
        if (body.length > TUNE_MAX_BYTES) return
        val prefs = getSharedPreferences(TUNE_PREFS, MODE_PRIVATE)
        val editor = prefs.edit()
        if (body.isEmpty()) editor.remove(TUNE_KEY) else editor.putString(TUNE_KEY, body)
        editor.apply()
      } catch (e: Throwable) {
        Log.w(TAG_TUNE, "set failed: " + e.message)
      }
    }
  }

  override fun onWebViewCreate(webView: WebView) {
    this.webView = webView
    // A WebView paints WHITE until its first document draws, which on a
    // cold start is the frame between the dark window and the launcher.
    // Launcher --bg instead; every platform page paints its own body.
    paperLook = getSharedPreferences(LOOK_PREFS, MODE_PRIVATE).getBoolean("paper", false)
    webView.setBackgroundColor(if (paperLook) PAPER_BG else NIGHT_BG)
    webView.addJavascriptInterface(LookBridge(), "TsLook")
    webView.addJavascriptInterface(ShortcutBridge(), "TsShortcuts")
    webView.addJavascriptInterface(LinksBridge(), "TsLinks")
    // Updater bridge: only ever reachable from the launcher's About
    // pane. It takes NO url from JS — it re-fetches the fixed manifest
    // itself and hash-pins the download, so a hostile platform page
    // poking it can at most trigger a user-confirmed install of the
    // real app (see UpdateBridge).
    // Play flavor: no updater at all -- the store delivers builds, and
    // the bridge's absence is what hides the card (main.ts).
    if (BuildConfig.UPDATER) webView.addJavascriptInterface(UpdateBridge(), "TsUpdater")
    // Diagnostics: write-mostly, local-only. See DiagBridge for why a
    // hostile page cannot turn it into anything but a wasted disk write.
    webView.addJavascriptInterface(DiagBridge(), "TsDiag")
    webView.addJavascriptInterface(StatsBridge(), "TsStats")
    webView.addJavascriptInterface(NativePortBridge(), "TsNativePort")
    // Perf dials (PerfBridge): reachable from every platform page like
    // any @JavascriptInterface, so every method is gated on the
    // per-document token only the document-start stash can claim (see
    // PerfBridge). Inert dials would not have made the BRIDGE inert.
    webView.addJavascriptInterface(PerfBridge(), "TsPerf")
    // Local override store (O1, phase-o): same token as PerfBridge,
    // SharedPreferences instead of localStorage -- see TsTune above.
    webView.addJavascriptInterface(TsTune(), "TsTune")
    // AUTOFILL. Owner ask: "can't we have the sign in page automatically
    // show the existing accounts on the device". There is no device
    // account chooser available to a WebView -- Android 8+ account
    // visibility only exposes Google accounts to signature-matched apps,
    // so that half is a platform wall, not something we can build. What
    // IS available is the autofill framework: Google Password Manager
    // offers his saved google.com login as a suggestion chip over the
    // field, and the password goes field -> framework without our code
    // ever seeing it. On by default from API 26, but only if nothing in
    // the view tree opts out, and wry never states an intent -- so state
    // it here rather than inherit whatever the parent happens to be.
    // Research: docs/research/google-signin-2026-08-28.md (option 5).
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      webView.importantForAutofill = View.IMPORTANT_FOR_AUTOFILL_YES
    }
    webView.post { installFullscreenClient() }
    webView.post { installBlockingClient() }
    webView.post { installTopBar() }

    // tamescroll: on Android everything runs in this one WebView, so the
    // system Back key must always land on our launcher before it is
    // allowed to background the app — otherwise an exhausted back-stack
    // falls through to whatever task sits underneath in recents
    // (observed on the emulator 2026-08-18). Registered after wry's own
    // callback, so this one wins the dispatch.
    val callback = object : OnBackPressedCallback(true) {
      override fun handleOnBackPressed() {
        // Launcher first: it is the app's home screen, so Back there
        // always backgrounds the app — even though history may still
        // hold platform entries (loadUrl below pushes one), walking
        // back into a feed from home would turn Back into a toggle
        // (observed on the emulator 2026-08-18, press-2 anomaly).
        val onLauncher = webView.url?.contains("tauri.localhost") == true
        when {
          // Fullscreen video first: Back exits fullscreen, not the page —
          // the same contract every browser honors.
          fullscreenView != null -> exitFullscreen()
          // moveTaskToBack, never finish(): finishing destroys the
          // Activity while the Rust process lives on, and Tauri cannot
          // attach a fresh Activity to an already-initialized process —
          // the relaunch renders permanently blank (emulator evidence
          // 2026-08-18, new Task with zero webview activity).
          onLauncher -> moveTaskToBack(true)
          // Never history-restore INTO the launcher: goBack() onto the
          // custom-protocol page revives a back/forward-cache zombie
          // document that stays visible but detached — taps land in it
          // and its invokes never reach Rust (CDP evidence 2026-08-18,
          // spikes/logcat-probe6.log: two tauri.localhost targets, the
          // visible one attached:false). A fresh loadUrl creates one
          // live document instead.
          else -> {
            val list = webView.copyBackForwardList()
            val target = backTarget(list)
            val url = if (target >= 0) list.getItemAtIndex(target).url else null
            if (url == null || url.contains("tauri.localhost")) {
              webView.loadUrl("http://tauri.localhost/")
            } else {
              webView.goBackOrForward(target - list.currentIndex)
            }
          }
        }
      }
    }
    onBackPressedDispatcher.addCallback(this, callback)

    super.onWebViewCreate(webView)
  }

  /// The history index Back should land on, or -1 for none. It steps
  /// past entries that would only restore as a blank page: the offline
  /// screen keeps the failed url as its history url, so after a
  /// successful Try again the entry behind the real page has the SAME
  /// url, and going back to it showed an empty dark page with no bar
  /// (1124 on the old Redmi, 2026-10-28).
  private fun backTarget(list: WebBackForwardList): Int {
    val current = list.currentItem?.url
    var i = list.currentIndex - 1
    while (i >= 0) {
      val url = list.getItemAtIndex(i).url
      if (url != null && url != current && !url.startsWith("about:") && !url.startsWith("data:")) break
      i--
    }
    return i
  }
}
