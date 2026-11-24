// WHAT'S HIDDEN ON THIS PAGE, for the app's shield chip and sheet (#76),
// the same reading the extension's popup gives (extension/src/content.js
// pageStatus): a surface counts as hidden here when something on the page
// matches it and none of it is visible, and as showing when you brought it
// back and it is on screen.
//
// `surfaces` is data built by lib.rs: [{ l: label, s: shown, q: [selectors] }].
// Selectors may come from a rules OTA, so they are only ever handed to
// querySelectorAll; a bad one is skipped. `report` receives
// { h: [labels hidden], s: [labels showing] } at most every 1.5s, and
// only when it changed.

function visible(el) {
  const r = el.getBoundingClientRect();
  return r.width > 0 && r.height > 0 && getComputedStyle(el).display !== 'none';
}

/** The labels hidden and showing on this page right now. */
export function pageStatus(surfaces, doc = document) {
  const out = { h: [], s: [] };
  for (const surface of surfaces) {
    let n = 0, seen = 0;
    for (const sel of surface.q) {
      try {
        for (const el of doc.querySelectorAll(sel)) {
          n++;
          if (visible(el)) seen++;
        }
      } catch (e) {
        // An invalid selector hides nothing; it must not stop the count.
      }
    }
    if (!n) continue;
    if (surface.s) {
      if (seen) out.s.push(surface.l);
    } else if (!seen) {
      out.h.push(surface.l);
    }
  }
  return out;
}

/** Reports the page's status as it changes. Safe to call twice. */
export function startStatus(surfaces, report) {
  if (window.__tsHiddenStatus) return;
  window.__tsHiddenStatus = 1;
  let timer = null;
  let last = '';
  const send = () => {
    timer = null;
    const status = pageStatus(surfaces);
    const key = JSON.stringify(status);
    if (key === last) return;
    last = key;
    try {
      report(status);
    } catch (e) {
      // No bridge (desktop): nothing to tell.
    }
  };
  const schedule = () => {
    if (!timer) timer = setTimeout(send, 1500);
  };
  schedule();
  new MutationObserver(schedule).observe(document.documentElement, { childList: true, subtree: true });
}
