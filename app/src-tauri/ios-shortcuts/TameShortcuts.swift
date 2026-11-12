import AppIntents
import UIKit

/// "Tame for YouTube" for iPhone: Android has it as a second launcher
/// icon, and iPhone lets no app add one, so it is an App Shortcut.
/// Spotlight lists it when the person searches "YouTube", Siri knows its
/// phrases, and the Shortcuts app can put it on the home screen. It opens
/// the app through its own tamescroll:// address, the same validated way
/// in the widgets and quick actions use (launcher_query_for_open in
/// lib.rs). The symbol is a plain Y, never YouTube's logo.
@available(iOS 16.0, *)
struct OpenTameYouTube: AppIntent {
  static var title: LocalizedStringResource = "Tame for YouTube"
  static var description = IntentDescription("Open YouTube inside Tame Scroll, without the feed.")
  static var openAppWhenRun: Bool = true

  @MainActor
  func perform() async throws -> some IntentResult {
    if let url = URL(string: "tamescroll://open/youtube") {
      await UIApplication.shared.open(url)
    }
    return .result()
  }
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
      shortTitle: "Tame for YouTube",
      systemImageName: "y.square.fill"
    )
  }
}
