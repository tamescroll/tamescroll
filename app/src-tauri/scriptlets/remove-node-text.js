function removeNodeText(rawNodeName, rawText) {
  // Clean-room implementation of the `remove-node-text` (`rmnt`) scriptlet
  // semantics (MPL-2.0, this project). Removes elements named `nodeName`
  // (almost always `script`) whose text contains `text` (plain or
  // /regex/) as they enter the document, before an inline script runs:
  // this is how the lists take out an anti-adblock or ad loader that has
  // no URL to block. Optional trailing named arguments are accepted and
  // ignored. Runs at document start; a MutationObserver sees inline
  // scripts as the parser inserts them, before they execute.
  "use strict";
  if (typeof document === "undefined" || typeof MutationObserver === "undefined") return;
  var nodeName = String(rawNodeName || "").toUpperCase();
  var text = String(rawText || "");
  if (!nodeName || !text) return;
  var matches;
  var lastSlash = text.lastIndexOf("/");
  if (text.charAt(0) === "/" && lastSlash > 0) {
    try {
      var re = new RegExp(text.slice(1, lastSlash), text.slice(lastSlash + 1));
      matches = function (s) { return re.test(s); };
    } catch (e) {}
  }
  if (!matches) matches = function (s) { return s.indexOf(text) !== -1; };

  function check(node) {
    if (!node || node.nodeName !== nodeName) return;
    // Never a script we fetched by URL: that one is the network rules' job,
    // and its text here would be empty anyway.
    var body = node.textContent || "";
    if (body && matches(body)) {
      try { node.remove(); } catch (e) {}
    }
  }

  var existing = document.getElementsByTagName(nodeName);
  for (var i = existing.length - 1; i >= 0; i--) check(existing[i]);

  var observer = new MutationObserver(function (records) {
    for (var r = 0; r < records.length; r++) {
      var added = records[r].addedNodes;
      for (var a = 0; a < added.length; a++) {
        var node = added[a];
        check(node);
        if (node.nodeType === 1 && node.getElementsByTagName) {
          var inner = node.getElementsByTagName(nodeName);
          for (var k = 0; k < inner.length; k++) check(inner[k]);
        }
      }
    }
  });
  observer.observe(document.documentElement || document, { childList: true, subtree: true });
  // The page's own scripts are what this guards against; once the
  // document is done parsing, stop watching every insertion.
  document.addEventListener("DOMContentLoaded", function () {
    setTimeout(function () { observer.disconnect(); }, 2000);
  }, { once: true });
}
