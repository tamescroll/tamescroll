// KID CONTROLS (ZV ask 2026-11-06, issue #50).
//
// A toddler using the app swiped from one YouTube video to the next. Two
// page-side controls answer that, each behind its own YouTube setting
// (a third, autoplay, followed on 2026-11-10 -- see its block below):
//
//   swipeOff  -- "Swiping between videos" is Hidden: in fullscreen, a
//                swipe that starts on the player is swallowed before
//                YouTube sees it. MEASURED 2026-11-06 (emulator, 1138): a
//                swipe UP there opens a strip of 12 other videos, and that
//                is how she went video to video. Taps still reach the
//                player, so play, pause, seek and leaving fullscreen keep
//                working. Out of fullscreen YouTube's swipes do nothing
//                (same probe), so the page and our own drag-to-mini
//                gesture are left alone there.
//   lock      -- "Touch lock button" is Shown: a padlock sits beside the
//                home pill. One tap locks: a clear layer covers the page
//                and swallows every touch while the video keeps playing.
//                Unlocking is a deliberate act a small child will not
//                stumble into: HOLD the padlock for three seconds.
//
// Neither touches YouTube's code or the video itself (player red line):
// both only decide which of the user's own touches reach the page.
//
// Built by lib.rs (kid_controls_script), which replaces the TS_KID token
// with a JSON object of booleans it produced itself. Nothing here is OTA.
(function () {
  var KID = /*TS_KID*/ null;
  if (!KID || (!KID.swipeOff && !KID.lock && !KID.autoplayOff)) {
    try { if (window.TsLock) window.TsLock.set(false); } catch (e) {}
    return;
  }
  if (window.__TS_KID__) return;
  window.__TS_KID__ = 1;

  // Where a swipe changes the video. The watch-page player in portrait
  // and in fullscreen, and the Shorts reel. Matched with closest(), so a
  // name that does not exist simply matches nothing.
  var PLAYER =
    "#player-container-id, .player-container, ytm-player, #movie_player, " +
    ".html5-video-player, ytm-shorts-player, ytm-reel-player-renderer, " +
    "ytm-reel-video-renderer, ytm-shorts-lockup-view-model, .reel-player";
  var SWIPE_PX = 12;

  function fullscreen() {
    return !!(document.fullscreenElement || document.webkitFullscreenElement);
  }

  function inPlayer(t) {
    try {
      return !!(t && t.closest && t.closest(PLAYER));
    } catch (e) {
      return false;
    }
  }

  // ---- swiping between videos ---------------------------------------
  if (KID.swipeOff) {
    var start = null;
    // On window, in the capture phase: the first listener anything can
    // have, and registered before YouTube's own scripts run.
    window.addEventListener(
      "touchstart",
      function (e) {
        var t = e.touches && e.touches[0];
        start = t && fullscreen() && inPlayer(e.target) ? { x: t.clientX, y: t.clientY, moved: false } : null;
      },
      { capture: true, passive: true }
    );
    // Once a touch on the player moves, it is a swipe and not a tap: from
    // there on neither YouTube's gesture code nor the browser sees it.
    // preventDefault needs passive:false, and both calls are what stop a
    // vertical swipe opening the suggestions panel or the next video.
    window.addEventListener(
      "touchmove",
      function (e) {
        if (!start) return;
        var t = e.touches && e.touches[0];
        if (!t) return;
        if (!start.moved && Math.abs(t.clientX - start.x) < SWIPE_PX && Math.abs(t.clientY - start.y) < SWIPE_PX) {
          return;
        }
        start.moved = true;
        if (e.cancelable) e.preventDefault();
        e.stopImmediatePropagation();
      },
      { capture: true, passive: false }
    );
    window.addEventListener(
      "touchend",
      function (e) {
        // The end of a swallowed swipe is swallowed too, or a gesture
        // recogniser that saw the start could still fire on release.
        if (start && start.moved) {
          if (e.cancelable) e.preventDefault();
          e.stopImmediatePropagation();
        }
        start = null;
      },
      { capture: true, passive: false }
    );
  }

  // ---- autoplay next video ------------------------------------------
  // ZV 2026-11-10: at the end of a video the app still went on to the
  // next one, autoplay switch off or not, and YouTube's "next video"
  // overlay came up over the finished frame. Both start from the same
  // moment: the watch video reaching its ENDED state. So it never gets
  // there. A moment before the end the video is paused, which leaves the
  // last frame on screen with YouTube's ordinary paused controls: no
  // countdown, no end screen, nothing to carry on to. Pressing play again
  // from there starts the video over, as a finished video's replay would.
  //
  // This reads the video element's own clock and calls pause(), nothing
  // else (player red line): no YouTube code is patched, and no selector
  // has to keep up with how YouTube draws its end screen.
  //
  // Only the watch page's player: Shorts loop by design, and the feed's
  // inline previews share the same player element off /watch. A live
  // stream has no end, an ad is left to finish, and a video set to loop
  // keeps looping.
  if (KID.autoplayOff) {
    var heldAt = null; // the video we stopped, until it plays again

    function watchVideo(v) {
      if (!v || v.tagName !== "VIDEO") return false;
      var p = location.pathname || "";
      if (p.indexOf("/watch") !== 0 && p.indexOf("/live/") !== 0) return false;
      if (v.loop) return false;
      var d = v.duration;
      if (!isFinite(d) || d < 3) return false;
      try {
        if (v.closest && v.closest(".ad-showing, .ad-interrupting")) return false;
      } catch (e) {}
      return true;
    }

    // timeupdate arrives about four times a second of wall time, so the
    // margin covers at least two of them at any playback speed.
    function margin(v) {
      return 0.6 * Math.max(1, v.playbackRate || 1);
    }

    function nearEnd(v) {
      return v.duration - v.currentTime <= margin(v);
    }

    // `timeupdate`, `play` and `ended` do not bubble: listen in the
    // capture phase on the document, which every media event passes.
    document.addEventListener(
      "timeupdate",
      function (e) {
        var v = e.target;
        if (v.paused || !watchVideo(v) || !nearEnd(v)) return;
        heldAt = v;
        try { v.pause(); } catch (err) {}
      },
      true
    );
    document.addEventListener(
      "play",
      function (e) {
        var v = e.target;
        if (!watchVideo(v)) return;
        // Play pressed on a video we held (or one sitting at its end):
        // start it over rather than run the last moment into autoplay.
        if (heldAt === v || nearEnd(v)) {
          try { v.currentTime = 0; } catch (err) {}
        }
        heldAt = null;
      },
      true
    );
    // A backstop for the one case the pause above cannot catch: a seek
    // straight onto the end. YouTube's player listens for `ended` on the
    // video itself, after this capture listener, so stopping the event
    // here keeps its end screen and autoplay countdown from starting.
    document.addEventListener(
      "ended",
      function (e) {
        if (!watchVideo(e.target)) return;
        e.stopImmediatePropagation();
        heldAt = e.target;
      },
      true
    );
  }

  // ---- touch lock -----------------------------------------------------
  // Named "Touch lock" everywhere a user reads it (ZV, 2026-11-07, after
  // the legal review): calling it a child or kid feature reads as an app
  // made for children, which brings in Google Play's Families rules. The
  // surface id stays `child_lock` so settings already saved keep working.
  if (!KID.lock) {
    try { if (window.TsLock) window.TsLock.set(false); } catch (e) {}
    return;
  }

  var BTN_ID = "tamescroll-lock";
  var VEIL_ID = "tamescroll-lock-veil";
  var HOLD_MS = 3000;
  var KEY = "tsChildLock";
  var locked = false;
  var btn = null;
  var veil = null;
  var hint = null;
  var holdTimer = null;
  // The release of the press that unlocked must not count as a tap, or
  // the click it fires would lock again straight away.
  var unlockedAt = 0;
  var hintTimer = null;

  // Our own padlock, open and closed. Never YouTube's iconography.
  // BUILT AS NODES, NEVER A STRING: m.youtube enforces Trusted Types, so
  // `innerHTML = "<svg..."` throws ("requires 'TrustedHTML' assignment"),
  // and on the emulator that throw killed paint() -- an empty circle that
  // never locked (verify run 2026-11-06).
  var SVG_NS = "http://www.w3.org/2000/svg";
  function icon(shut) {
    var svg = document.createElementNS(SVG_NS, "svg");
    var attrs = {
      viewBox: "0 0 24 24", width: "18", height: "18", fill: "none",
      stroke: "currentColor", "stroke-width": "2", "stroke-linecap": "round",
      "stroke-linejoin": "round", "aria-hidden": "true"
    };
    for (var k in attrs) svg.setAttribute(k, attrs[k]);
    var body = document.createElementNS(SVG_NS, "rect");
    body.setAttribute("x", "5");
    body.setAttribute("y", "11");
    body.setAttribute("width", "14");
    body.setAttribute("height", "10");
    body.setAttribute("rx", "2");
    var shackle = document.createElementNS(SVG_NS, "path");
    shackle.setAttribute("d", shut ? "M8 11V7a4 4 0 0 1 8 0v4" : "M8 11V7a4 4 0 0 1 7.5-2");
    svg.appendChild(body);
    svg.appendChild(shackle);
    return svg;
  }

  function remember(v) {
    try {
      if (v) sessionStorage.setItem(KEY, "1");
      else sessionStorage.removeItem(KEY);
    } catch (e) {}
  }
  function remembered() {
    try {
      return sessionStorage.getItem(KEY) === "1";
    } catch (e) {
      return false;
    }
  }
  function tellNative(v) {
    try {
      if (window.TsLock) window.TsLock.set(!!v);
    } catch (e) {}
  }

  // In fullscreen only the fullscreen element is drawn, so the lock and
  // its layer have to live inside it, and come back out afterwards.
  function host() {
    return document.fullscreenElement || document.webkitFullscreenElement || document.body;
  }
  function place(el) {
    var h = host();
    if (el && h && el.parentNode !== h) h.appendChild(el);
  }

  function swallow(e) {
    if (!locked) return;
    if (btn && (e.target === btn || btn.contains(e.target))) return;
    if (e.cancelable) e.preventDefault();
    e.stopImmediatePropagation();
  }
  [
    "touchstart", "touchmove", "touchend", "pointerdown", "pointermove",
    "pointerup", "mousedown", "mouseup", "click", "dblclick",
    "contextmenu", "wheel", "keydown"
  ].forEach(function (type) {
    window.addEventListener(type, swallow, { capture: true, passive: false });
  });

  function buildVeil() {
    veil = document.createElement("div");
    veil.id = VEIL_ID;
    veil.style.cssText =
      "position:fixed;inset:0;z-index:2147483646;background:transparent;" +
      "pointer-events:auto;touch-action:none;display:none;";
    // The layer takes the hit test, so a tap lands on nothing. The window
    // capture listeners below make sure no listener of YouTube's -- even a
    // capturing one on window -- ever sees the touch while locked.
    hint = document.createElement("div");
    hint.textContent = "Hold the lock for 3 seconds to unlock";
    hint.style.cssText =
      "position:fixed;left:50%;bottom:62px;transform:translateX(-50%);" +
      "z-index:2147483647;padding:8px 14px;border-radius:16px;" +
      "background:rgba(15,17,21,.82);color:#e8e6e3;font:500 13px system-ui;" +
      "pointer-events:none;opacity:0;transition:opacity .2s;";
    veil.appendChild(hint);
  }

  function showHint() {
    if (!hint) return;
    hint.style.opacity = "1";
    clearTimeout(hintTimer);
    hintTimer = setTimeout(function () { hint.style.opacity = "0"; }, 1800);
  }

  // ONLY WHERE THERE IS A VIDEO TO GUARD (ZV, 2026-11-07: a padlock on a
  // page with no video started "makes no sense"). It shows on a watch page
  // once its video has started playing, in portrait and in fullscreen, and
  // nowhere else: not on home, search or a channel, and not on a watch page
  // whose video has not begun. While locked it always shows, because it is
  // the only way to unlock.
  var started = false;
  var startedFor = "";
  function videoStarted() {
    var here = location.pathname + location.search;
    if (startedFor !== here) {
      started = false;
      startedFor = here;
    }
    if (!/^\/watch/.test(location.pathname)) return false;
    if (started) return true;
    var v = document.querySelector("#movie_player video, video.html5-main-video");
    if (v && (!v.paused || v.currentTime > 0)) started = true;
    return started;
  }
  function shouldShow() {
    return locked || videoStarted();
  }

  function paint() {
    if (!btn) return;
    btn.style.display = shouldShow() ? "flex" : "none";
    while (btn.firstChild) btn.removeChild(btn.firstChild);
    btn.appendChild(icon(locked));
    btn.setAttribute("aria-label", locked ? "Touch lock on. Hold to unlock" : "Turn on touch lock");
    btn.setAttribute("aria-pressed", locked ? "true" : "false");
    btn.style.opacity = locked ? "1" : ".55";
    btn.style.background = locked ? "rgba(15,17,21,.85)" : "rgba(15,17,21,.62)";
    btn.style.boxShadow = "none";
    if (veil) veil.style.display = locked ? "block" : "none";
  }

  function setLocked(v) {
    locked = !!v;
    remember(locked);
    tellNative(locked);
    place(veil);
    place(btn);
    paint();
  }

  function cancelHold() {
    clearTimeout(holdTimer);
    holdTimer = null;
    if (btn) btn.style.boxShadow = "none";
  }

  function buildButton() {
    btn = document.createElement("button");
    btn.id = BTN_ID;
    btn.type = "button";
    // Beside the home pill (left:10px, 34px wide), same look.
    btn.style.cssText =
      "position:fixed;left:52px;bottom:14px;z-index:2147483647;" +
      "width:34px;height:34px;border-radius:50%;border:none;padding:0;" +
      "display:flex;align-items:center;justify-content:center;" +
      "background:rgba(15,17,21,.62);color:#e8e6e3;opacity:.55;" +
      "pointer-events:auto;touch-action:none;-webkit-user-select:none;" +
      "user-select:none;backdrop-filter:blur(6px);transition:box-shadow 3s linear;";
    btn.addEventListener("contextmenu", function (e) { e.preventDefault(); });
    btn.addEventListener(
      "pointerdown",
      function (e) {
        e.stopPropagation();
        if (!locked) return;
        // The hold ring grows over the three seconds, so a parent can see
        // the unlock coming and a child sees nothing happen on a tap.
        btn.style.boxShadow = "0 0 0 6px rgba(232,230,227,.7)";
        holdTimer = setTimeout(function () {
          holdTimer = null;
          unlockedAt = Date.now();
          setLocked(false);
        }, HOLD_MS);
      },
      true
    );
    ["pointerup", "pointercancel", "pointerleave"].forEach(function (type) {
      btn.addEventListener(type, function (e) {
        e.stopPropagation();
        if (locked && holdTimer) showHint();
        cancelHold();
      }, true);
    });
    btn.addEventListener(
      "click",
      function (e) {
        e.preventDefault();
        e.stopPropagation();
        if (Date.now() - unlockedAt < 1500) return;
        if (!locked) setLocked(true);
      },
      true
    );
  }

  function ensure() {
    var body = document.body;
    if (!body) return;
    if (!veil) buildVeil();
    if (!btn) buildButton();
    if (!document.getElementById(VEIL_ID)) place(veil);
    if (!document.getElementById(BTN_ID)) place(btn);
    paint();
  }

  function onFullscreen() {
    place(veil);
    place(btn);
  }

  function boot() {
    ensure();
    // A reload, or a page load inside the same tab, keeps the lock on.
    setLocked(remembered());
  }

  if (document.body) boot();
  else document.addEventListener("DOMContentLoaded", boot);
  document.addEventListener("fullscreenchange", onFullscreen);
  document.addEventListener("webkitfullscreenchange", onFullscreen);
  // A video starting is the moment the padlock appears, so listen for it
  // rather than wait for the next tick. `play` does not bubble: capture.
  document.addEventListener("play", function () { setTimeout(ensure, 0); }, true);
  document.addEventListener("playing", function () { setTimeout(ensure, 0); }, true);
  ["pushState", "replaceState"].forEach(function (name) {
    var original = history[name];
    history[name] = function () {
      var result = original.apply(this, arguments);
      setTimeout(ensure, 0);
      return result;
    };
  });
  window.addEventListener("popstate", function () { setTimeout(ensure, 0); });
  setInterval(ensure, 1000);
})();
