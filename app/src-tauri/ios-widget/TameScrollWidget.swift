// Home-screen widgets for Tame Scroll. Nothing is added for anyone: a
// person adds one themselves (press and hold the home screen, +, Tame
// Scroll). A tap opens the app through its own tamescroll:// address,
// the same way the long-press quick actions do.
//
// The tiles are OUR letter glyphs on our ink, never a platform's logo
// or colours (his ruling: the home icon must be our glyph).
import SwiftUI
import WidgetKit

struct Site {
  let id: String
  let name: String
  let glyph: String
  var link: URL { URL(string: "tamescroll://open/\(id)")! }
}

let sites = [
  Site(id: "youtube", name: "YouTube", glyph: "Y"),
  Site(id: "reddit", name: "Reddit", glyph: "R"),
  Site(id: "x", name: "X", glyph: "X"),
]

let ink = Color(red: 38 / 255, green: 35 / 255, blue: 29 / 255)
let cream = Color(red: 231 / 255, green: 229 / 255, blue: 225 / 255)

struct Still: TimelineEntry { let date: Date }

/// The tiles never change, so one entry that never refreshes.
struct StillProvider: TimelineProvider {
  func placeholder(in context: Context) -> Still { Still(date: Date()) }
  func getSnapshot(in context: Context, completion: @escaping (Still) -> Void) {
    completion(Still(date: Date()))
  }
  func getTimeline(in context: Context, completion: @escaping (Timeline<Still>) -> Void) {
    completion(Timeline(entries: [Still(date: Date())], policy: .never))
  }
}

extension View {
  /// iOS 17 asks every widget for its background this way; older
  /// systems draw the view's own.
  @ViewBuilder func inkBackground() -> some View {
    if #available(iOSApplicationExtension 17.0, *) {
      self.containerBackground(ink, for: .widget)
    } else {
      self.background(ink)
    }
  }
}

struct SiteTile: View {
  let site: Site
  var body: some View {
    VStack(spacing: 6) {
      Text(site.glyph)
        .font(.system(size: 54, weight: .medium))
        .foregroundColor(cream)
      Text(site.name)
        .font(.system(size: 13, weight: .regular))
        .foregroundColor(cream.opacity(0.6))
    }
    .frame(maxWidth: .infinity, maxHeight: .infinity)
    .inkBackground()
    .widgetURL(site.link)
  }
}

func siteWidget(_ site: Site) -> some WidgetConfiguration {
  StaticConfiguration(kind: "site.\(site.id)", provider: StillProvider()) { _ in
    SiteTile(site: site)
  }
  .configurationDisplayName(site.name)
  .description("Opens \(site.name) in Tame Scroll.")
  .supportedFamilies([.systemSmall])
}

struct AllSites: View {
  var body: some View {
    HStack(spacing: 10) {
      ForEach(sites, id: \.id) { site in
        Link(destination: site.link) {
          VStack(spacing: 4) {
            Text(site.glyph)
              .font(.system(size: 36, weight: .medium))
              .foregroundColor(cream)
            Text(site.name)
              .font(.system(size: 12))
              .foregroundColor(cream.opacity(0.6))
          }
          .frame(maxWidth: .infinity, maxHeight: .infinity)
          .background(RoundedRectangle(cornerRadius: 14).fill(cream.opacity(0.07)))
        }
      }
    }
    .padding(2)
    .inkBackground()
  }
}

struct AllSitesWidget: Widget {
  var body: some WidgetConfiguration {
    StaticConfiguration(kind: "sites", provider: StillProvider()) { _ in AllSites() }
      .configurationDisplayName("Your sites")
      .description("YouTube, Reddit and X, opened in Tame Scroll.")
      .supportedFamilies([.systemMedium])
  }
}

struct YouTubeWidget: Widget {
  var body: some WidgetConfiguration { siteWidget(sites[0]) }
}
struct RedditWidget: Widget {
  var body: some WidgetConfiguration { siteWidget(sites[1]) }
}
struct XWidget: Widget {
  var body: some WidgetConfiguration { siteWidget(sites[2]) }
}

@main
struct TameScrollWidgets: WidgetBundle {
  var body: some Widget {
    YouTubeWidget()
    RedditWidget()
    XWidget()
    AllSitesWidget()
  }
}
