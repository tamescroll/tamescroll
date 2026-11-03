function trustedSetRequestField(urlSpec, fieldPath, rawValue) {
  // Clean-room request-editor (MPL-2.0, this project). Sets one dotted
  // field on the JSON body of OUTBOUND requests whose URL matches
  // `urlSpec`, for both fetch(init.body) and XMLHttpRequest.send(body).
  //
  // Used for YouTube's `/youtubei/v1/player` request, where one
  // playbackContext field avoids a multi-second start stall. Runs only
  // where the user has turned the site's Ads switch on.
  //
  // Provenance (clean-room): field name from a public protobuf write-up
  // (https://iter.ca/post/yt-adblock/), NOT from uBO/AdGuard scriptlet
  // code. Our own design: a single dotted path + literal value, no
  // query-path mini-language.
  "use strict";
  if (typeof fieldPath !== "string" || fieldPath.length === 0) return;
  var tokens = fieldPath.split(".");

  var value;
  switch (rawValue) {
    case "true": value = true; break;
    case "false": value = false; break;
    case "null": value = null; break;
    default:
      if (/^-?\d+(\.\d+)?$/.test(rawValue)) value = Number(rawValue);
      else value = String(rawValue == null ? "" : rawValue);
  }

  var spec = String(urlSpec || "");
  if (spec.indexOf("url:") === 0) spec = spec.slice(4);
  var matchesUrl;
  var lastSlash = spec.lastIndexOf("/");
  if (spec.charAt(0) === "/" && lastSlash > 0) {
    try {
      var re = new RegExp(spec.slice(1, lastSlash), spec.slice(lastSlash + 1));
      matchesUrl = function (u) { return re.test(u); };
    } catch (e) {}
  }
  if (!matchesUrl) {
    matchesUrl = spec
      ? function (u) { return u.indexOf(spec) !== -1; }
      : function () { return true; };
  }

  function edit(text) {
    if (typeof text !== "string" || text.length === 0) return text;
    var obj;
    try { obj = JSON.parse(text); } catch (e) { return text; }
    if (obj === null || typeof obj !== "object") return text;
    var node = obj;
    for (var i = 0; i < tokens.length - 1; i++) {
      var k = tokens[i];
      if (node[k] === null || typeof node[k] !== "object") node[k] = {};
      node = node[k];
    }
    node[tokens[tokens.length - 1]] = value;
    try { return JSON.stringify(obj); } catch (e) { return text; }
  }

  if (typeof window.fetch === "function") {
    var realFetch = window.fetch;
    window.fetch = function (input, init) {
      try {
        var url = typeof input === "string" ? input : (input && input.url) || "";
        if (matchesUrl(String(url)) && init && typeof init.body === "string") {
          init = Object.assign({}, init, { body: edit(init.body) });
        }
      } catch (e) {}
      return realFetch.call(this, input, init);
    };
  }

  var X = typeof XMLHttpRequest === "function" ? XMLHttpRequest : null;
  if (X && X.prototype) {
    var realOpen = X.prototype.open;
    var realSend = X.prototype.send;
    X.prototype.open = function (method, url) {
      try { this.__tsReqUrl = String(url == null ? "" : url); } catch (e) {}
      return realOpen.apply(this, arguments);
    };
    X.prototype.send = function (body) {
      try {
        if (this.__tsReqUrl && matchesUrl(this.__tsReqUrl) && typeof body === "string") {
          arguments[0] = edit(body);
        }
      } catch (e) {}
      return realSend.apply(this, arguments);
    };
  }
}
