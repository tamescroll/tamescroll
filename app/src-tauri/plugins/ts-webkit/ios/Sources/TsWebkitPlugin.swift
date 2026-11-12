import Foundation
import ObjectiveC
import SwiftRs
import Tauri
import UIKit
import WebKit

struct PageScriptArgs: Decodable {
  let source: String
}

struct BlockerArgs: Decodable {
  let id: String
  let path: String
}

struct BlockingArgs: Decodable {
  let on: Bool
}

struct EvalArgs: Decodable {
  let source: String
  let path: String
}

class TsWebkitPlugin: Plugin {
  weak var webview: WKWebView?
  /// The one user script that is ours, so a replacement can drop exactly
  /// it and keep Tauri's own scripts in their original order.
  var pageScript: WKUserScript?
  /// The compiled network block list, once WebKit has it.
  var blocker: WKContentRuleList?
  /// Off while the current platform's Ads switch is Shown.
  var blockingOn = true

  override func load(webview: WKWebView) {
    self.webview = webview
    // iPhone has no Back button. The edge swipe is how people expect to
    // go back, including from a platform to the launcher.
    webview.allowsBackForwardNavigationGestures = true
    installTouchLockBridge(webview)
    // The blur's face models answer here (TsInfer.swift); the page finds
    // them through lib.rs's native-port stash.
    webview.configuration.userContentController.addScriptMessageHandler(
      TsInfer.shared, contentWorld: .page, name: "tsInfer")
    installQuickActions()
    keepBelowStatusBar(webview)
  }

  /// m.youtube asks for the whole screen (viewport-fit=cover), so its top
  /// bar drew under the clock and the camera cut-out (CI screenshot,
  /// 2026-10-27). Safari never lets a page reach that area either: the
  /// web view starts below the status bar, and the band above it takes
  /// the page's own colour, as Safari's does (a white band over our dark
  /// launcher looked broken, 2026-10-27 mockup).
  func keepBelowStatusBar(_ webview: WKWebView) {
    DispatchQueue.main.async {
      guard let superview = webview.superview else { return }
      superview.backgroundColor = .systemBackground
      webview.translatesAutoresizingMaskIntoConstraints = false
      let bar = self.makeTopBar()
      superview.addSubview(bar)
      let barHeight = bar.heightAnchor.constraint(equalToConstant: Self.barFull)
      self.barHeight = barHeight
      let underClock = webview.topAnchor.constraint(equalTo: superview.safeAreaLayoutGuide.topAnchor)
      self.webUnderClock = underClock
      self.webUnderBar = webview.topAnchor.constraint(equalTo: bar.bottomAnchor)
      NSLayoutConstraint.activate([
        bar.topAnchor.constraint(equalTo: superview.safeAreaLayoutGuide.topAnchor),
        bar.leadingAnchor.constraint(equalTo: superview.leadingAnchor),
        bar.trailingAnchor.constraint(equalTo: superview.trailingAnchor),
        barHeight,
        underClock,
        webview.bottomAnchor.constraint(equalTo: superview.bottomAnchor),
        webview.leadingAnchor.constraint(equalTo: superview.leadingAnchor),
        webview.trailingAnchor.constraint(equalTo: superview.trailingAnchor),
      ])
      self.bandObservers = [
        webview.observe(\.themeColor, options: [.initial, .new]) { [weak self] wv, _ in
          self?.paintBand(wv)
        },
        webview.observe(\.underPageBackgroundColor, options: [.initial, .new]) { [weak self] wv, _ in
          self?.paintBand(wv)
        },
        webview.observe(\.url, options: [.initial, .new]) { [weak self] wv, _ in
          self?.updateTopBar(wv)
        },
        webview.scrollView.observe(\.contentOffset, options: [.new]) { [weak self] sv, _ in
          self?.followScroll(sv)
        },
      ]
      // paintBand pins the web view to the phone's light or dark setting,
      // so a switch made while the app was open (Control Center, or the
      // automatic sunset change) left sites in the old mode until the
      // page's colour happened to change. Coming back to the app, which
      // closing Control Center also does, repaints with the current one.
      self.activeObserver = NotificationCenter.default.addObserver(
        forName: UIApplication.didBecomeActiveNotification, object: nil, queue: .main
      ) { [weak self, weak webview] _ in
        if let webview = webview { self?.paintBand(webview) }
      }
    }
  }

  var bandObservers: [NSKeyValueObservation] = []
  var activeObserver: NSObjectProtocol?

  /// The band takes the page's theme colour, else its background, and the
  /// clock turns light or dark to stay readable on it. Only the window's
  /// style is overridden; the web view keeps the phone's own setting, so
  /// pages still see the user's light or dark mode.
  func paintBand(_ webview: WKWebView) {
    guard let superview = webview.superview, let window = webview.window else { return }
    // Over a site the band sits above our dark bar (or its folded strip),
    // so it takes the bar's colour.
    let color = topBar?.isHidden == false
      ? Self.barColor
      : webview.themeColor ?? webview.underPageBackgroundColor ?? .systemBackground
    superview.backgroundColor = color
    var white: CGFloat = 1
    var alpha: CGFloat = 1
    color.resolvedColor(with: window.traitCollection).getWhite(&white, alpha: &alpha)
    let system = window.windowScene?.screen.traitCollection.userInterfaceStyle ?? .unspecified
    webview.overrideUserInterfaceStyle = system
    window.overrideUserInterfaceStyle = white < 0.5 ? .dark : .light
  }

  // THE TOP BAR (Android's, #33: "make it look more like a browser"),
  // drawn natively on iPhone too. Above every site, never on the launcher:
  // home, the page's address (tap it to search or type a new one, on the
  // launcher's own box) and a shield that opens this site's settings.
  // Outside the web view, so the page only sees a shorter viewport.
  static let barColor = UIColor(red: 0x14 / 255.0, green: 0x14 / 255.0, blue: 0x14 / 255.0, alpha: 1)
  static let launcher = "tauri://localhost/"
  var topBar: UIView?
  var topBarAddress: UIButton?
  var topBarUrl = ""
  var webUnderClock: NSLayoutConstraint?
  var barHeight: NSLayoutConstraint?
  static let barFull: CGFloat = 52
  static let barStrip: CGFloat = 24
  /// Where the current drag started; nil while no finger is down.
  var dragStart: CGFloat?
  var barRow: UIView?
  var barStrip: UILabel?
  /// The page this bar was last set up for, so a video page collapses it
  /// once on arrival and not again on every scroll.
  var collapsedFor = ""
  var webUnderBar: NSLayoutConstraint?

  func makeTopBar() -> UIView {
    let bar = UIView()
    bar.translatesAutoresizingMaskIntoConstraints = false
    bar.backgroundColor = Self.barColor
    bar.overrideUserInterfaceStyle = .dark
    bar.isHidden = true
    bar.clipsToBounds = true
    let ink = UIColor(red: 0xE7 / 255.0, green: 0xE5 / 255.0, blue: 0xE1 / 255.0, alpha: 1)
    func icon(_ symbol: String, _ label: String, _ action: Selector) -> UIButton {
      let b = UIButton(type: .system)
      b.setImage(UIImage(systemName: symbol), for: .normal)
      b.tintColor = ink
      b.accessibilityLabel = label
      b.addTarget(self, action: action, for: .touchUpInside)
      b.translatesAutoresizingMaskIntoConstraints = false
      b.widthAnchor.constraint(equalToConstant: 44).isActive = true
      b.heightAnchor.constraint(equalToConstant: 44).isActive = true
      return b
    }
    let address = UIButton(type: .system)
    address.setTitleColor(ink, for: .normal)
    address.titleLabel?.font = .systemFont(ofSize: 15)
    address.titleLabel?.lineBreakMode = .byTruncatingTail
    address.contentHorizontalAlignment = .leading
    address.contentEdgeInsets = UIEdgeInsets(top: 0, left: 14, bottom: 0, right: 14)
    address.backgroundColor = UIColor(red: 0x24 / 255.0, green: 0x23 / 255.0, blue: 0x20 / 255.0, alpha: 1)
    address.layer.cornerRadius = 18
    address.accessibilityHint = "Search or type a site"
    address.addTarget(self, action: #selector(barSearch), for: .touchUpInside)
    address.heightAnchor.constraint(equalToConstant: 36).isActive = true
    let row = UIStackView(arrangedSubviews: [
      icon("house", "Home", #selector(barHome)),
      address,
      icon("shield", "What's hidden on this site", #selector(barShield)),
    ])
    row.axis = .horizontal
    row.alignment = .center
    row.spacing = 4
    row.translatesAutoresizingMaskIntoConstraints = false
    bar.addSubview(row)
    NSLayoutConstraint.activate([
      row.leadingAnchor.constraint(equalTo: bar.safeAreaLayoutGuide.leadingAnchor, constant: 4),
      row.trailingAnchor.constraint(equalTo: bar.safeAreaLayoutGuide.trailingAnchor, constant: -4),
      row.centerYAnchor.constraint(equalTo: bar.topAnchor, constant: Self.barFull / 2),
    ])
    // The folded bar: a strip with only the site's name. A tap on it
    // brings the whole bar back.
    let strip = UILabel()
    strip.font = .systemFont(ofSize: 12)
    strip.textColor = UIColor(red: 0xA8 / 255.0, green: 0xA4 / 255.0, blue: 0x9D / 255.0, alpha: 1)
    strip.textAlignment = .center
    strip.alpha = 0
    strip.isUserInteractionEnabled = true
    strip.accessibilityTraits = .button
    strip.accessibilityHint = "Shows the top bar"
    strip.addGestureRecognizer(UITapGestureRecognizer(target: self, action: #selector(barUnfold)))
    strip.translatesAutoresizingMaskIntoConstraints = false
    bar.addSubview(strip)
    NSLayoutConstraint.activate([
      strip.leadingAnchor.constraint(equalTo: bar.leadingAnchor),
      strip.trailingAnchor.constraint(equalTo: bar.trailingAnchor),
      strip.topAnchor.constraint(equalTo: bar.topAnchor),
      strip.heightAnchor.constraint(equalToConstant: Self.barStrip),
    ])
    topBar = bar
    barRow = row
    barStrip = strip
    topBarAddress = address
    return bar
  }

  /// Shows the bar on a web page and hides it on the launcher.
  func updateTopBar(_ webview: WKWebView) {
    guard let bar = topBar else { return }
    let u = webview.url
    let onSite = (u?.scheme == "https" || u?.scheme == "http") && u?.host != "localhost"
    if onSite, let u = u {
      topBarUrl = u.absoluteString
      topBarAddress?.setTitle(Self.bareHost(u.host ?? u.absoluteString), for: .normal)
      barStrip?.text = Self.bareHost(u.host ?? u.absoluteString)
      // Each new page opens with the whole bar, except a video page,
      // which opens folded to the strip so the video sits near the top.
      let video = (u.host ?? "").hasSuffix("youtube.com") && u.path.hasPrefix("/watch")
      // The address without its #fragment: m.youtube opens its menus and
      // search as #menu or #searching, and counting those as new pages
      // threw the folded bar back out (or folded it again on a video)
      // every time a menu opened. Android keys the same way.
      let page = u.absoluteString.components(separatedBy: "#")[0]
      if page != collapsedFor {
        collapsedFor = page
        setBarShown(!video, animated: !bar.isHidden)
      }
    }
    guard bar.isHidden == onSite else { return }
    bar.isHidden = !onSite
    webUnderClock?.isActive = !onSite
    webUnderBar?.isActive = onSite
    paintBand(webview)
  }

  /// Dragging the page up folds the bar into the strip. Dragging down
  /// does not bring it back (ZV found the bar popping in and out
  /// annoying, 2026-10-28): only a tap on the strip or a new page does.
  func followScroll(_ sv: UIScrollView) {
    guard let bar = topBar, !bar.isHidden else { return }
    guard sv.isTracking else {
      dragStart = nil
      return
    }
    let y = sv.contentOffset.y
    guard let start = dragStart else {
      dragStart = y
      return
    }
    if y - start > 24 { foldWhenStill(sv) }
  }

  /// Fold only once the page has stopped moving. Resizing the web view
  /// in the middle of a drag left YouTube's bottom bar floating partway
  /// up the screen with the feed showing beneath it (his iPhone,
  /// 2026-11-04): WebKit placed the page's fixed bars for the old size.
  var foldPending = false
  func foldWhenStill(_ sv: UIScrollView) {
    if foldPending { return }
    foldPending = true
    func check() {
      DispatchQueue.main.asyncAfter(deadline: .now() + 0.15) { [weak self, weak sv] in
        guard let self = self, let sv = sv else { return }
        if sv.isTracking || sv.isDecelerating || sv.isDragging { check(); return }
        self.foldPending = false
        self.setBarShown(false, animated: true)
      }
    }
    check()
  }

  @objc func barUnfold() { setBarShown(true, animated: true) }

  func setBarShown(_ shown: Bool, animated: Bool) {
    guard let h = barHeight else { return }
    let want = shown ? Self.barFull : Self.barStrip
    if h.constant == want { return }
    h.constant = want
    let swap = {
      self.barRow?.alpha = shown ? 1 : 0
      self.barStrip?.alpha = shown ? 0 : 1
    }
    guard animated, let parent = topBar?.superview else {
      swap()
      pageResized()
      return
    }
    UIView.animate(withDuration: 0.2, animations: {
      swap()
      parent.layoutIfNeeded()
    }, completion: { _ in self.pageResized() })
  }

  /// Tell the page its window changed size, so bars it pins to the
  /// bottom of the screen move to the new bottom.
  func pageResized() {
    webview?.evaluateJavaScript("window.dispatchEvent(new Event('resize'))", completionHandler: nil)
  }

  static func bareHost(_ host: String) -> String {
    var h = host
    for prefix in ["www.", "m."] where h.hasPrefix(prefix) { h.removeFirst(prefix.count) }
    return h
  }

  func openLauncher(_ query: String = "") {
    guard let url = URL(string: Self.launcher + query) else { return }
    webview?.load(URLRequest(url: url))
  }

  func pageParam() -> String {
    topBarUrl.addingPercentEncoding(withAllowedCharacters: .alphanumerics) ?? ""
  }

  @objc func barHome() { openLauncher() }

  @objc func barSearch() { openLauncher("?search=" + pageParam()) }

  /// The shield's sheet. iPhone's block list runs inside WebKit, which
  /// does not say what it stopped, so unlike Android there is no count:
  /// only the way into this site's switches.
  @objc func barShield() {
    guard let from = webview?.window?.rootViewController else { return }
    var top = from
    while let shown = top.presentedViewController { top = shown }
    let host = Self.bareHost(URL(string: topBarUrl)?.host ?? "")
    let sheet = UIAlertController(
      title: host,
      message: "On the sites we tame, feeds and distractions are hidden. You choose what stays.",
      preferredStyle: .actionSheet)
    sheet.addAction(UIAlertAction(title: "Change what's hidden here", style: .default) { [weak self] _ in
      guard let self = self else { return }
      self.openLauncher("?settings=" + self.pageParam())
    })
    sheet.addAction(UIAlertAction(title: "Close", style: .cancel))
    sheet.popoverPresentationController?.sourceView = topBar
    top.present(sheet, animated: true)
  }

  /// Home-screen quick actions (Info.ios.plist UIApplicationShortcutItems).
  /// tao's delegates have no handler for them, so one is added at
  /// runtime. It re-opens the app through its own tamescroll:// address,
  /// which keeps a single, validated way in (launcher_query_for_open in
  /// lib.rs); the home-screen widgets use that same address.
  ///
  /// tao runs without scenes unless Info.plist declares a scene manifest
  /// (ours does not), so the app delegate is the one UIKit asks. It asks
  /// after didFinishLaunching returns, and this plugin loads while that
  /// runs (the web view is made there), so a quick action that launches
  /// the app should land too. The scene
  /// delegate gets the handler as well in case a manifest appears.
  func installQuickActions() {
    func open(_ item: UIApplicationShortcutItem) -> Bool {
      let id = item.type.hasPrefix("open.") ? String(item.type.dropFirst(5)) : ""
      guard !id.isEmpty, let url = URL(string: "tamescroll://open/\(id)") else { return false }
      UIApplication.shared.open(url)
      return true
    }
    if let cls: AnyClass = NSClassFromString("TaoSceneDelegate") {
      let sel = NSSelectorFromString("windowScene:performActionForShortcutItem:completionHandler:")
      let handler: @convention(block) (AnyObject, UIWindowScene, UIApplicationShortcutItem, @escaping (Bool) -> Void) -> Void = {
        _, _, item, done in done(open(item))
      }
      class_addMethod(cls, sel, imp_implementationWithBlock(handler), "v@:@@@?")
    }
    if let delegate = UIApplication.shared.delegate {
      let sel = NSSelectorFromString("application:performActionForShortcutItem:completionHandler:")
      let handler: @convention(block) (AnyObject, UIApplication, UIApplicationShortcutItem, @escaping (Bool) -> Void) -> Void = {
        _, _, item, done in done(open(item))
      }
      if let cls = object_getClass(delegate) {
        class_addMethod(cls, sel, imp_implementationWithBlock(handler), "v@:@@@?")
      }
    }
  }

  @objc public func setPageScript(_ invoke: Invoke) throws {
    let args = try invoke.parseArgs(PageScriptArgs.self)
    DispatchQueue.main.async {
      guard let webview = self.webview else {
        invoke.reject("no webview yet")
        return
      }
      let controller = webview.configuration.userContentController
      // WebKit can remove only ALL user scripts, so keep the others and
      // put them back in the order they were added.
      let keep = controller.userScripts.filter { $0 !== self.pageScript }
      controller.removeAllUserScripts()
      keep.forEach { controller.addUserScript($0) }
      let script = WKUserScript(
        source: args.source, injectionTime: .atDocumentStart, forMainFrameOnly: true)
      controller.addUserScript(script)
      self.pageScript = script
      invoke.resolve()
    }
  }
}

extension TsWebkitPlugin {
  @objc public func prepareBlocker(_ invoke: Invoke) throws {
    let args = try invoke.parseArgs(BlockerArgs.self)
    guard let store = WKContentRuleListStore.default() else {
      invoke.reject("no content rule list store")
      return
    }
    // Lists from earlier builds or earlier rule updates are dead weight.
    store.getAvailableContentRuleListIdentifiers { ids in
      for old in (ids ?? []) where old != args.id {
        store.removeContentRuleList(forIdentifier: old) { _ in }
      }
    }
    store.lookUpContentRuleList(forIdentifier: args.id) { found, _ in
      if let found = found {
        self.install(found)
        invoke.resolve()
        return
      }
      guard let json = try? String(contentsOfFile: args.path, encoding: .utf8) else {
        invoke.reject("cannot read \(args.path)")
        return
      }
      store.compileContentRuleList(forIdentifier: args.id, encodedContentRuleList: json) {
        list, error in
        if let list = list {
          self.install(list)
          invoke.resolve()
        } else {
          invoke.reject(error?.localizedDescription ?? "compile failed")
        }
      }
    }
  }

  @objc public func setBlocking(_ invoke: Invoke) throws {
    let args = try invoke.parseArgs(BlockingArgs.self)
    DispatchQueue.main.async {
      self.blockingOn = args.on
      self.applyBlocker()
      invoke.resolve()
    }
  }

  @objc public func evalToFile(_ invoke: Invoke) throws {
    let args = try invoke.parseArgs(EvalArgs.self)
    DispatchQueue.main.async {
      guard let webview = self.webview else {
        invoke.reject("no webview yet")
        return
      }
      webview.evaluateJavaScript(args.source) { result, error in
        let text = error.map { "error: \($0)" } ?? String(describing: result ?? "nil")
        try? text.write(toFile: args.path, atomically: true, encoding: .utf8)
        invoke.resolve()
      }
    }
  }

  func install(_ list: WKContentRuleList) {
    DispatchQueue.main.async {
      self.blocker = list
      self.applyBlocker()
    }
  }

  func applyBlocker() {
    guard let webview = webview, let blocker = blocker else { return }
    let controller = webview.configuration.userContentController
    controller.remove(blocker)
    if blockingOn {
      controller.add(blocker)
    }
  }
}

/// The touch lock (kid-controls.js) tells the app when it locks and
/// unlocks through `window.TsLock.set(bool)`, the same call Android
/// answers. While locked, the back swipe is off, so a swipe from the edge
/// cannot leave the video. Every page starts unlocked; the lock script
/// says "locked" again on the next load if it still is.
extension TsWebkitPlugin {
  func installTouchLockBridge(_ webview: WKWebView) {
    let controller = webview.configuration.userContentController
    controller.add(TouchLockHandler(owner: self), name: "tsLock")
    let shim = """
      (function () {
        var h = window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.tsLock;
        if (!h) return;
        window.TsLock = { set: function (v) { try { h.postMessage(!!v); } catch (e) {} } };
        window.TsLock.set(false);
      })();
      """
    controller.addUserScript(
      WKUserScript(source: shim, injectionTime: .atDocumentStart, forMainFrameOnly: true))
  }

  func setTouchLocked(_ locked: Bool) {
    webview?.allowsBackForwardNavigationGestures = !locked
  }
}

/// Holds the plugin weakly: WebKit keeps its message handlers alive.
final class TouchLockHandler: NSObject, WKScriptMessageHandler {
  weak var owner: TsWebkitPlugin?
  init(owner: TsWebkitPlugin) { self.owner = owner }
  func userContentController(
    _ userContentController: WKUserContentController, didReceive message: WKScriptMessage
  ) {
    guard message.frameInfo.isMainFrame else { return }
    let locked = (message.body as? Bool) ?? ((message.body as? NSNumber)?.boolValue ?? false)
    DispatchQueue.main.async { self.owner?.setTouchLocked(locked) }
  }
}

@_cdecl("init_plugin_ts_webkit")
func initPlugin() -> Plugin {
  return TsWebkitPlugin()
}
