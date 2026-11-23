// Runs in every page of a served site at document_start, in the
// extension's own world. Builds the stylesheet from the stored settings
// and rules and keeps it current as either changes. Page-context code
// (ad scriptlets, the Shorts redirect) is registered separately by the
// background; this file never runs anything in the page's world.

import { siteForHost } from './sites.js';
import { pageCss, parseSurfaces } from './rules.js';
import { rulesText } from './ota.js';
import { BUNDLED, ENGINE } from './bundled.js';
import { pageKind } from '../../app/gaze/src/diag-report.mjs';

const site = siteForHost(location.hostname);
const STYLE_ID = 'tamescroll-style';

function styleEl() {
  let el = document.getElementById(STYLE_ID);
  if (!el) {
    el = document.createElement('style');
    el.id = STYLE_ID;
  }
  // Re-attach if a page rewrite dropped it.
  if (!el.isConnected) (document.head || document.documentElement).appendChild(el);
  return el;
}

let lastCss = null;
let lastState = null;
function render(state) {
  lastState = state;
  const settings = state.settings || {};
  const ota = state.ota;
  // An OTA copy from an older package never shadows this package's rules.
  const overrides = ota && ota.version === chrome.runtime.getManifest().version && ota.files ? ota.files : {};
  const css = pageCss({
    site,
    host: location.hostname,
    engine: ENGINE,
    rulesText: rulesText(site.rulesFile, BUNDLED, overrides),
    blurText: rulesText(site.blurFile, BUNDLED, overrides),
    prefs: (settings.sites || {})[site.id],
    blurStrength: settings.blurPx || 16,
  });
  lastCss = css;
  styleEl().textContent = css;
}

if (site) {
  chrome.storage.local.get(['settings', 'ota']).then(render);
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || (!changes.settings && !changes.ota)) return;
    chrome.storage.local.get(['settings', 'ota']).then(render);
  });


  // The popup asks what this page is keeping out of sight: the surfaces
  // that are hidden here and match at least one element right now.
  chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
    if (!msg || msg.type !== 'ts-hidden-here') return false;
    const st = lastState || {};
    const ota = st.ota;
    const overrides = ota && ota.version === chrome.runtime.getManifest().version && ota.files ? ota.files : {};
    const prefs = ((st.settings || {}).sites || {})[site.id];
    const shown = (prefs && prefs.shown) || [];
    const out = [];
    if (prefs && prefs.on !== false) {
      for (const s of parseSurfaces(rulesText(site.rulesFile, BUNDLED, overrides))) {
        if (s.alwaysOn || shown.includes(s.id)) continue;
        let n = 0;
        for (const [, sel] of s.rules) {
          try { n += document.querySelectorAll(sel).length; } catch (e) {}
        }
        if (n) out.push({ id: s.id, label: s.label, count: n });
      }
    }
    reply({ site: site.id, hidden: out });
    return false;
  });

  // YouTube's single-page app can replace <head>; put the sheet back.
  new MutationObserver(() => {
    if (lastCss !== null && !document.getElementById(STYLE_ID)) styleEl().textContent = lastCss;
  }).observe(document.documentElement, { childList: true, subtree: false });

  // data-ts-page: the page kind some rules scope on (the app sets it from
  // init-entry.js; same helper, same values).
  let lastKind = null;
  const syncKind = () => {
    const k = pageKind(site.id, location.pathname);
    if (k === lastKind) return;
    lastKind = k;
    document.documentElement.setAttribute('data-ts-page', k);
  };
  syncKind();
  window.addEventListener('popstate', syncKind);
  setInterval(syncKind, 500);
}
