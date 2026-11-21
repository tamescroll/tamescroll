function jsonPruneXhrResponse(rawPaths, rawRequired, name1, value1, name2, value2) {
  // Clean-room implementation of the `json-prune-xhr-response` scriptlet
  // semantics (MPL-2.0, this project): the XMLHttpRequest twin of
  // json-prune-fetch-response. For requests whose URL matches the
  // optional `propsToMatch` named argument, the JSON response is parsed,
  // the given property paths are deleted (same token rules as
  // json-prune: dotted keys, `*` / `[]` / `[-]` for every key) and the
  // result is what `response` / `responseText` hand out. Patched on the
  // prototype accessors, so every reader sees the pruned body whatever
  // order the page's handlers run in. Unparseable bodies pass untouched.
  "use strict";
  if (typeof XMLHttpRequest === "undefined") return;
  var paths = String(rawPaths || "").split(/ +/).filter(function (p) {
    return p && p !== "important" && p !== "legacyImportant";
  });
  if (paths.length === 0) return;
  var required = String(rawRequired || "").split(/ +/).filter(Boolean);

  var urlSpec = "";
  var named = [name1, value1, name2, value2];
  for (var n = 0; n + 1 < named.length; n += 2) {
    if (named[n] === "propsToMatch") urlSpec = String(named[n + 1] || "");
  }
  if (urlSpec.indexOf("url:") === 0) urlSpec = urlSpec.slice(4);
  var matchesUrl;
  var lastSlash = urlSpec.lastIndexOf("/");
  if (urlSpec.charAt(0) === "/" && lastSlash > 0) {
    try {
      var re = new RegExp(urlSpec.slice(1, lastSlash), urlSpec.slice(lastSlash + 1));
      matchesUrl = function (u) { return re.test(u); };
    } catch (e) {}
  }
  if (!matchesUrl) {
    matchesUrl = urlSpec
      ? function (u) { return u.indexOf(urlSpec) !== -1; }
      : function () { return true; };
  }

  function collect(root, tokens, index, out) {
    if (root === null || typeof root !== "object") return;
    var token = tokens[index];
    var last = index === tokens.length - 1;
    if (token === "*" || token === "[]" || token === "[-]") {
      var keys = Array.isArray(root)
        ? root.map(function (_, k) { return k; })
        : Object.keys(root);
      for (var i = 0; i < keys.length; i++) {
        if (last) out.push([root, keys[i]]);
        else collect(root[keys[i]], tokens, index + 1, out);
      }
      return;
    }
    if (!(token in Object(root))) return;
    if (last) { out.push([root, token]); return; }
    collect(root[token], tokens, index + 1, out);
  }

  function prune(obj) {
    if (obj === null || typeof obj !== "object") return false;
    if (required.length) {
      var found = false;
      for (var i = 0; i < required.length && !found; i++) {
        var probe = [];
        collect(obj, required[i].split("."), 0, probe);
        found = probe.length > 0;
      }
      if (!found) return false;
    }
    var changed = false;
    for (var j = 0; j < paths.length; j++) {
      var owners = [];
      collect(obj, paths[j].split("."), 0, owners);
      for (var k = 0; k < owners.length; k++) {
        try { delete owners[k][0][owners[k][1]]; changed = true; } catch (e) {}
      }
    }
    return changed;
  }

  var proto = XMLHttpRequest.prototype;
  var realOpen = proto.open;
  proto.open = function (method, url) {
    try { this.__tamescroll_jpx_url = String(url); this.__tamescroll_jpx = undefined; } catch (e) {}
    return realOpen.apply(this, arguments);
  };

  // One prune per completed response, cached on the request: a page that
  // reads responseText ten times must not pay for ten parses, and must
  // see the same object each time it reads `response` as json.
  function pruned(xhr, raw) {
    if (!xhr.__tamescroll_jpx_url || !matchesUrl(xhr.__tamescroll_jpx_url)) return raw;
    if (xhr.readyState !== 4) return raw;
    var cache = xhr.__tamescroll_jpx;
    if (cache && cache.raw === raw) return cache.out;
    var out = raw;
    try {
      if (typeof raw === "string") {
        var obj = JSON.parse(raw);
        if (prune(obj)) out = JSON.stringify(obj);
      } else if (raw && typeof raw === "object") {
        prune(raw);
      }
    } catch (e) {
      out = raw;
    }
    try { xhr.__tamescroll_jpx = { raw: raw, out: out }; } catch (e) {}
    return out;
  }

  ["responseText", "response"].forEach(function (name) {
    var desc = Object.getOwnPropertyDescriptor(proto, name);
    if (!desc || typeof desc.get !== "function") return;
    Object.defineProperty(proto, name, {
      configurable: true,
      enumerable: desc.enumerable,
      get: function () {
        var value = desc.get.call(this);
        // `response` is only JSON-shaped for "", "text" and "json".
        if (name === "response" && this.responseType && this.responseType !== "text" && this.responseType !== "json") {
          return value;
        }
        return pruned(this, value);
      },
      set: desc.set
    });
  });
}
