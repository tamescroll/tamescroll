// Runs in every page of a served site at document_start, in the
// extension's own world. Builds the stylesheet from the stored settings
// and rules and keeps it current as either changes. Page-context code
// (ad scriptlets, the Shorts redirect) is registered separately by the
// background; this file never runs anything in the page's world.

import { siteForHost } from './sites.js';
import { pageCss, parseSurfaces } from './rules.js';
import { rulesText } from './ota.js';
import { parseKill, effectivePrefs } from './kill.js';
import { BUNDLED, ENGINE } from './bundled.js';
import { smartChoice } from './gaze-settings.js';

// With Smart blur on, the gaze runtime covers every picture itself until
// it has placed the faces in it (blur-first); the plain blur stylesheet
// on top would keep the cleared ones blurred too.
function withoutPlainBlur(prefs) {
  return prefs && smartChoice(prefs) !== 'off' ? { ...prefs, blur: false } : prefs;
}
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
    prefs: withoutPlainBlur(effectivePrefs(site, (settings.sites || {})[site.id], parseKill(rulesText('kill.json', BUNDLED, overrides)))),
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


  // What this page is doing, for the popup and the toolbar badge:
  //   hidden  - surfaces hidden here that match something on the page;
  //   showing - surfaces you brought back that are on the page now;
  //   slipped - surfaces set to hide whose elements are still visible
  //             (the stylesheet did not reach them).
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0 && getComputedStyle(el).display !== 'none';
  };
  function pageStatus() {
    const st = lastState || {};
    const ota = st.ota;
    const overrides = ota && ota.version === chrome.runtime.getManifest().version && ota.files ? ota.files : {};
    const prefs = ((st.settings || {}).sites || {})[site.id];
    if (!prefs || prefs.on === false) return { site: site.id, off: true, hidden: [], showing: [], slipped: [] };
    const shown = prefs.shown || [];
    const out = { site: site.id, off: false, hidden: [], showing: [], slipped: [], styled: !!(lastCss && lastCss.length) };
    for (const s of parseSurfaces(rulesText(site.rulesFile, BUNDLED, overrides))) {
      const isShown = !s.alwaysOn && shown.includes(s.id);
      let n = 0, seen = 0;
      for (const [, sel] of s.rules) {
        try {
          for (const el of document.querySelectorAll(sel)) { n++; if (visible(el)) seen++; }
        } catch (e) {}
      }
      if (!n) continue;
      const item = { id: s.id, label: s.label, count: n };
      if (isShown) { if (seen) out.showing.push(item); }
      else if (seen) out.slipped.push(item);
      else out.hidden.push(item);
    }
    return out;
  }

  chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
    if (!msg || msg.type !== 'ts-hidden-here') return false;
    reply(pageStatus());
    return false;
  });

  // Keep the toolbar badge current: at most every 1.5s while the page changes.
  let badgeTimer = null, lastBadge = '';
  const reportStatus = () => {
    badgeTimer = null;
    const p = pageStatus();
    const msg = { type: 'ts-status', off: p.off, hidden: p.hidden.length, showing: p.showing.length, slipped: p.slipped.length };
    const key = JSON.stringify(msg);
    if (key === lastBadge) return;
    lastBadge = key;
    try { chrome.runtime.sendMessage(msg).catch(() => {}); } catch (e) {}
  };
  const scheduleStatus = () => { if (!badgeTimer) badgeTimer = setTimeout(reportStatus, 1500); };
  new MutationObserver(scheduleStatus).observe(document.documentElement, { childList: true, subtree: true });
  chrome.storage.onChanged.addListener(() => { lastBadge = ''; scheduleStatus(); });
  scheduleStatus();

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
