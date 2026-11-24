import AppIntents
import UIKit

/// "Tame for YouTube", "Tame for Reddit" and the rest, for iPhone: Android
/// has them as home-screen shortcuts, and iPhone lets no app add one, so
/// each site is an App Shortcut. Spotlight lists it when the person
/// searches the site's name, Siri knows its phrases, and the Shortcuts app
/// can put it on the home screen. It opens the app through its own
/// tamescroll:// address, the same validated way in the widgets and quick
/// actions use (launcher_query_for_open in lib.rs). The symbol is a plain
/// letter, never the site's logo, and the home-screen name is "Y-Tamed",
/// "R-Tamed" and so on, never the bare site name (ZV, 2026-11-17); the
/// title and phrases still say the site so search finds it. TikTok took
/// T first, so Twitch is "Tw-Tamed" (Android's labels match).
///
/// One intent per site rather than one with a parameter: an App Shortcut
/// with a parameter needs the person to pick the site, and these must
/// open in one tap. Apple allows ten App Shortcuts; this uses nine.

@available(iOS 16.0, *)
private func openTamed(_ id: String) async {
  if let url = URL(string: "tamescroll://open/\(id)") {
    await UIApplication.shared.open(url)
  }
}

@available(iOS 16.0, *)
struct OpenTameYouTube: AppIntent {
  static var title: LocalizedStringResource = "Tame for YouTube"
  static var description = IntentDescription("Open YouTube inside Tame Scroll, without the feed.")
  static var openAppWhenRun: Bool = true
  @MainActor func perform() async throws -> some IntentResult { await openTamed("youtube"); return .result() }
}

@available(iOS 16.0, *)
struct OpenTameReddit: AppIntent {
  static var title: LocalizedStringResource = "Tame for Reddit"
  static var description = IntentDescription("Open Reddit inside Tame Scroll, without the feed.")
  static var openAppWhenRun: Bool = true
  @MainActor func perform() async throws -> some IntentResult { await openTamed("reddit"); return .result() }
}

@available(iOS 16.0, *)
struct OpenTameX: AppIntent {
  static var title: LocalizedStringResource = "Tame for X"
  static var description = IntentDescription("Open X inside Tame Scroll, without the feed.")
  static var openAppWhenRun: Bool = true
  @MainActor func perform() async throws -> some IntentResult { await openTamed("x"); return .result() }
}

@available(iOS 16.0, *)
struct OpenTameTikTok: AppIntent {
  static var title: LocalizedStringResource = "Tame for TikTok"
  static var description = IntentDescription("Open TikTok inside Tame Scroll, without the feed.")
  static var openAppWhenRun: Bool = true
  @MainActor func perform() async throws -> some IntentResult { await openTamed("tiktok"); return .result() }
}

@available(iOS 16.0, *)
struct OpenTameInstagram: AppIntent {
  static var title: LocalizedStringResource = "Tame for Instagram"
  static var description = IntentDescription("Open Instagram inside Tame Scroll, without the feed.")
  static var openAppWhenRun: Bool = true
  @MainActor func perform() async throws -> some IntentResult { await openTamed("instagram"); return .result() }
}

@available(iOS 16.0, *)
struct OpenTameFacebook: AppIntent {
  static var title: LocalizedStringResource = "Tame for Facebook"
  static var description = IntentDescription("Open Facebook inside Tame Scroll, without the feed.")
  static var openAppWhenRun: Bool = true
  @MainActor func perform() async throws -> some IntentResult { await openTamed("facebook"); return .result() }
}

@available(iOS 16.0, *)
struct OpenTameTwitch: AppIntent {
  static var title: LocalizedStringResource = "Tame for Twitch"
  static var description = IntentDescription("Open Twitch inside Tame Scroll, without the feed.")
  static var openAppWhenRun: Bool = true
  @MainActor func perform() async throws -> some IntentResult { await openTamed("twitch"); return .result() }
}

@available(iOS 16.0, *)
struct OpenTameLinkedIn: AppIntent {
  static var title: LocalizedStringResource = "Tame for LinkedIn"
  static var description = IntentDescription("Open LinkedIn inside Tame Scroll, without the feed.")
  static var openAppWhenRun: Bool = true
  @MainActor func perform() async throws -> some IntentResult { await openTamed("linkedin"); return .result() }
}

@available(iOS 16.0, *)
struct OpenTamePinterest: AppIntent {
  static var title: LocalizedStringResource = "Tame for Pinterest"
  static var description = IntentDescription("Open Pinterest inside Tame Scroll, without the feed.")
  static var openAppWhenRun: Bool = true
  @MainActor func perform() async throws -> some IntentResult { await openTamed("pinterest"); return .result() }
}

@available(iOS 16.0, *)
struct TameShortcuts: AppShortcutsProvider {
  static var appShortcuts: [AppShortcut] {
    AppShortcut(
      intent: OpenTameYouTube(),
      phrases: [
        "Open YouTube in \(.applicationName)",
        "Tame YouTube with \(.applicationName)",
        "\(.applicationName) YouTube",
      ],
      shortTitle: "Y-Tamed",
      systemImageName: "y.square.fill"
    )
    AppShortcut(
      intent: OpenTameReddit(),
      phrases: ["Open Reddit in \(.applicationName)", "\(.applicationName) Reddit"],
      shortTitle: "R-Tamed",
      systemImageName: "r.square.fill"
    )
    AppShortcut(
      intent: OpenTameX(),
      phrases: ["Open X in \(.applicationName)", "\(.applicationName) X"],
      shortTitle: "X-Tamed",
      systemImageName: "x.square.fill"
    )
    AppShortcut(
      intent: OpenTameTikTok(),
      phrases: ["Open TikTok in \(.applicationName)", "\(.applicationName) TikTok"],
      shortTitle: "T-Tamed",
      systemImageName: "t.square.fill"
    )
    AppShortcut(
      intent: OpenTameInstagram(),
      phrases: ["Open Instagram in \(.applicationName)", "\(.applicationName) Instagram"],
      shortTitle: "I-Tamed",
      systemImageName: "i.square.fill"
    )
    AppShortcut(
      intent: OpenTameFacebook(),
      phrases: ["Open Facebook in \(.applicationName)", "\(.applicationName) Facebook"],
      shortTitle: "F-Tamed",
      systemImageName: "f.square.fill"
    )
    AppShortcut(
      intent: OpenTameTwitch(),
      phrases: ["Open Twitch in \(.applicationName)", "\(.applicationName) Twitch"],
      shortTitle: "Tw-Tamed",
      systemImageName: "t.square"
    )
    AppShortcut(
      intent: OpenTameLinkedIn(),
      phrases: ["Open LinkedIn in \(.applicationName)", "\(.applicationName) LinkedIn"],
      shortTitle: "L-Tamed",
      systemImageName: "l.square.fill"
    )
    AppShortcut(
      intent: OpenTamePinterest(),
      phrases: ["Open Pinterest in \(.applicationName)", "\(.applicationName) Pinterest"],
      shortTitle: "P-Tamed",
      systemImageName: "p.square.fill"
    )
  }
}
