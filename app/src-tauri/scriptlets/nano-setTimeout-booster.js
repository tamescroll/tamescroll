function nanoSetTimeoutBooster(rawNeedle, rawDelay, rawBoost) {
  // Clean-room implementation of the `nano-setTimeout-booster` (`nano-stb`)
  // scriptlet semantics (MPL-2.0, this project). Speeds up the page's own
  // countdown timers, the "wait 10 seconds" walls download sites put in
  // front of a link: a setTimeout whose callback text contains `needle`
  // and whose delay matches `delay` runs after delay * boost instead.
  //   needle  plain text or /regex/ matched against the callback's
  //           source; empty or `*` matches every callback
  //   delay   the exact delay to match (ms); `*` matches any; default 1000
  //   boost   multiplier, clamped to [0.001, 50]; default 0.05
  "use strict";
  if (typeof window === "undefined" || typeof window.setTimeout !== "function") return;
  var needle = rawNeedle === undefined || rawNeedle === "*" ? "" : String(rawNeedle);
  var matchesNeedle;
  var lastSlash = needle.lastIndexOf("/");
  if (needle.charAt(0) === "/" && lastSlash > 0) {
    try {
      var re = new RegExp(needle.slice(1, lastSlash), needle.slice(lastSlash + 1));
      matchesNeedle = function (s) { return re.test(s); };
    } catch (e) {}
  }
  if (!matchesNeedle) {
    matchesNeedle = needle
      ? function (s) { return s.indexOf(needle) !== -1; }
      : function () { return true; };
  }
  var delaySpec = rawDelay === undefined || rawDelay === "" ? "1000" : String(rawDelay);
  var anyDelay = delaySpec === "*";
  var wantDelay = parseInt(delaySpec, 10);
  if (!anyDelay && isNaN(wantDelay)) wantDelay = 1000;
  var boost = parseFloat(rawBoost);
  if (isNaN(boost) || !isFinite(boost)) boost = 0.05;
  boost = Math.min(50, Math.max(0.001, boost));

  var realSetTimeout = window.setTimeout;
  window.setTimeout = function (callback, delay) {
    var args = Array.prototype.slice.call(arguments);
    try {
      var d = Number(delay) || 0;
      if ((anyDelay || d === wantDelay) && matchesNeedle(String(callback))) {
        args[1] = Math.round(d * boost);
      }
    } catch (e) {}
    return realSetTimeout.apply(this, args);
  };
}
