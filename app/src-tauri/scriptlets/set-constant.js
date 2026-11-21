function setConstant(chain, rawValue) {
  // Clean-room implementation of the `set-constant` / `set` scriptlet
  // semantics (MPL-2.0, this project). Pins a window property chain to a
  // constant, surviving late and repeated assignment — YouTube assigns
  // ytInitialPlayerResponse after we run, so plain assignment would miss.
  // Unsupported value forms do nothing rather than risk breaking the page.
  "use strict";
  if (typeof chain !== "string" || chain.length === 0) return;
  var value;
  switch (rawValue) {
    case "undefined": value = undefined; break;
    case "null": value = null; break;
    case "true": value = true; break;
    case "false": value = false; break;
    case "": case "''": value = ""; break;
    case "[]": value = []; break;
    case "{}": value = {}; break;
    case "noopFunc": value = function () {}; break;
    case "trueFunc": value = function () { return true; }; break;
    case "falseFunc": value = function () { return false; }; break;
    default:
      if (/^-?\d+(\.\d+)?$/.test(rawValue)) { value = Number(rawValue); }
      else { return; }
  }
  var parts = chain.split(".");

  function pin(owner, index) {
    var prop = parts[index];
    if (index === parts.length - 1) {
      try {
        Object.defineProperty(owner, prop, {
          get: function () { return value; },
          set: function () {},
          configurable: true
        });
      } catch (e) {}
      return;
    }
    var existing;
    try { existing = owner[prop]; } catch (e) { return; }
    if (existing !== undefined && existing !== null && typeof existing === "object") {
      pin(existing, index + 1);
      return;
    }
    // SOMEONE ELSE MAY ALREADY BE TRAPPING THIS LINK. Blindly redefining
    // it is how a pre-roll reached the owner twice (measured 2026-08-25):
    // on a watch page another scriptlet (then our own pruner) traps
    // window.ytInitialPlayerResponse first, this walk then reads through
    // its getter, sees `undefined` ("not there yet"), and replaced the
    // whole accessor — so the pruner never saw the page's assignment and
    // `adSlots` kept all 5 entries.
    //
    // If the existing trap is a full configurable accessor, delegate to
    // it instead: let it store (and transform) the value, then continue
    // this walk on what IT ended up holding. Both scriptlets then get
    // what they came for regardless of the order the engine emits them.
    var d;
    try { d = Object.getOwnPropertyDescriptor(owner, prop); } catch (e) {}
    if (d && d.configurable && typeof d.get === "function" && typeof d.set === "function") {
      var prevGet = d.get;
      var prevSet = d.set;
      try {
        Object.defineProperty(owner, prop, {
          get: function () { return prevGet.call(owner); },
          set: function (v) {
            prevSet.call(owner, v);
            var held = prevGet.call(owner);
            if (held !== undefined && held !== null && typeof held === "object") {
              pin(held, index + 1);
            }
          },
          configurable: true
        });
      } catch (e) {}
      return;
    }

    // Link not there yet: trap its assignment, then continue the walk on
    // whatever value the page assigns (re-pinning on every reassignment).
    var stored = existing;
    try {
      Object.defineProperty(owner, prop, {
        get: function () { return stored; },
        set: function (v) {
          stored = v;
          if (v !== undefined && v !== null && typeof v === "object") {
            pin(v, index + 1);
          }
        },
        configurable: true
      });
    } catch (e) {}
  }

  pin(window, 0);
}
