// A SHORT IS A VIDEO (owner 2026-09-05): "if the user were to click a
// shorts link or go to a short, it should play in a normal player
// instead of the shorts scrolling". /shorts/<id> is the same video id as
// /watch?v=<id>; the only thing the shorts URL adds is the vertical
// swipe-to-next feed. So every route to /shorts/ lands on /watch: the
// Rust side rewrites links that arrive from outside (canonical_link_url),
// and init-entry rewrites in-page navigation with this helper. Pure, so
// it is testable without a DOM.

/** The /watch URL for a /shorts/ path, or null when the path is not one. */
export function watchUrlForShorts(pathname, search) {
  var m = /^\/shorts\/([A-Za-z0-9_-]{6,})\/?$/.exec(String(pathname || ''));
  if (!m) return null;
  var q = String(search || '');
  var t = /[?&]t=([0-9]+)/.exec(q);
  return '/watch?v=' + m[1] + (t ? '&t=' + t[1] + 's' : '');
}

/** The /watch URL for an anchor href (absolute or relative), or null. */
export function watchUrlForShortsHref(href, origin) {
  var u;
  try {
    u = new URL(String(href || ''), origin || 'https://m.youtube.com');
  } catch (e) {
    return null;
  }
  if (!/(^|\.)youtube\.com$/.test(u.hostname)) return null;
  return watchUrlForShorts(u.pathname, u.search);
}

// THE SHORTS FEED ITSELF (2026-11-10). A bare /shorts or /shorts/ is the
// swipe feed with no video named: YouTube picks one and starts the feed.
// There is no video to turn into a watch page, so it goes home instead.
export function isShortsFeedPath(pathname) {
  return /^\/shorts\/?$/.test(String(pathname || ''));
}

/**
 * Where a navigation to `url` must go instead, or null to let it through.
 * `url` is anything a page hands history.pushState / replaceState or an
 * anchor: absolute, root-relative or relative to `base`. A short becomes
 * its watch page, the bare feed becomes home.
 */
export function shortsExitFor(url, base) {
  var u;
  try {
    u = new URL(String(url == null ? '' : url), base || 'https://m.youtube.com/');
  } catch (e) {
    return null;
  }
  if (!/(^|\.)youtube\.com$/.test(u.hostname)) return null;
  var w = watchUrlForShorts(u.pathname, u.search);
  if (w) return w;
  return isShortsFeedPath(u.pathname) ? '/' : null;
}
