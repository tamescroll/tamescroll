// Page context, YouTube only, registered while Shorts are hidden.
// A SHORT IS A VIDEO (ZV, 2026-09-05): /shorts/<id> opens as /watch?v=<id>
// and the bare /shorts feed goes home. The same three doors the app's
// init-entry.js uses, over the same helper module:
//   1. a clicked <a href="/shorts/...">;
//   2. YouTube's own router, caught at history.pushState/replaceState
//      BEFORE the URL changes, so the swipe feed never mounts;
//   3. a tick for everything else (server redirects, hard loads).
import { shortsExitFor } from '../../app/gaze/src/shorts-redirect.mjs';

(function () {
  if (window.__TS_EXT_SHORTS__) return;
  window.__TS_EXT_SHORTS__ = 1;

  function leaveNow() {
    var w = shortsExitFor(location.pathname + location.search, location.href);
    if (!w) return false;
    location.replace(w);
    return true;
  }
  if (leaveNow()) return;

  document.addEventListener('click', function (ev) {
    var a = ev.target && ev.target.closest ? ev.target.closest('a[href]') : null;
    if (!a) return;
    var w = shortsExitFor(a.getAttribute('href'), location.href);
    if (!w) return;
    ev.preventDefault();
    ev.stopPropagation();
    location.assign(w);
  }, true);

  ['pushState', 'replaceState'].forEach(function (name) {
    var orig = history[name];
    if (typeof orig !== 'function' || orig.__tsShorts) return;
    var hooked = function (state, title, url) {
      if (url != null) {
        var w = shortsExitFor(url, location.href);
        if (w) {
          if (name === 'pushState') location.assign(w);
          else location.replace(w);
          return;
        }
      }
      return orig.apply(this, arguments);
    };
    hooked.__tsShorts = true;
    try { history[name] = hooked; } catch (e) {}
  });

  window.addEventListener('popstate', leaveNow);
  setInterval(leaveNow, 500);
})();
