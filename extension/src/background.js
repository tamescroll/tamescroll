// The background worker: seeds settings on install, keeps the page-code
// scripts registered to match the settings, and refreshes the rules over
// the air once a day.

import { SITES, rulesFiles } from './sites.js';
import { seed } from './settings.js';
import { refresh, rulesText } from './ota.js';
import { BUNDLED } from './bundled.js';
import { wantedScripts } from './scripts.js';
import { parseKill } from './kill.js';
import { onBreak } from './break.js';
import { BUILD_ID, isDevBuild, checkForNewBuild, watchBuilds } from './dev-reload.js';

const api = globalThis.browser || globalThis.chrome;
const VERSION = api.runtime.getManifest().version;

async function state() {
  return api.storage.local.get(['settings', 'ota']);
}

function overridesOf(st) {
  // An OTA copy fetched under an older package must not shadow the rules
  // this package was built with (the app's cache_stamp, same lesson).
  return st.ota && st.ota.version === VERSION && st.ota.files ? st.ota.files : {};
}

async function ensureSettings() {
  const st = await state();
  const files = overridesOf(st);
  const settings = seed(st.settings, (name) => rulesText(name, BUNDLED, files));
  // A break that ended while the browser was closed is over.
  if (settings.breakUntil && !onBreak(settings)) delete settings.breakUntil;
  await api.storage.local.set({ settings });
  scheduleBreakEnd(settings);
  return settings;
}

// When a break is on, an alarm ends it: clearing breakUntil fires the
// storage change that resyncs the scripts and restyles every open page.
function scheduleBreakEnd(settings) {
  if (onBreak(settings)) api.alarms.create('break-end', { when: settings.breakUntil });
  else api.alarms.clear('break-end');
}

async function endBreak() {
  const st = await state();
  if (!st.settings || !st.settings.breakUntil) return;
  const settings = { ...st.settings };
  delete settings.breakUntil;
  await api.storage.local.set({ settings });
}

let syncing = Promise.resolve();
function syncScripts(settings) {
  // Serialised: two quick toggles must not race each other's register.
  syncing = syncing.then(async () => {
    const ours = new Set(SITES.flatMap((s) => s.scripts.map((x) => x.id)));
    const registered = (await api.scripting.getRegisteredContentScripts()).map((r) => r.id);
    const stale = registered.filter((id) => ours.has(id));
    if (stale.length) await api.scripting.unregisterContentScripts({ ids: stale });
    const st = await state();
    const wanted = wantedScripts(settings, parseKill(rulesText('kill.json', BUNDLED, overridesOf(st))));
    if (wanted.length) await api.scripting.registerContentScripts(wanted);
  }).catch((e) => console.warn('tamescroll: script sync failed', e));
  return syncing;
}

// An unpacked (developer) install runs the rules it was built with:
// rules OTA reads main, so a branch being tested would otherwise be
// shadowed by main's older rules the moment it loads (2026-11-23, the
// Reddit fix that never reached the page). isDevBuild is always false in
// a store build (dev-reload-store.js).

async function refreshRules() {
  const st = await state();
  if (await isDevBuild()) {
    await api.storage.local.set({ ota: { version: VERSION, files: {}, checkedAt: Date.now(), outcome: 'dev build' } });
    return;
  }
  try {
    const files = await refresh({
      fetchText: async (url) => {
        const r = await fetch(url, { cache: 'no-cache' });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.text();
      },
      wanted: rulesFiles(),
      bundled: BUNDLED,
      overrides: overridesOf(st),
    });
    await api.storage.local.set({ ota: { version: VERSION, files, checkedAt: Date.now(), outcome: 'ok' } });
  } catch (e) {
    const prev = st.ota && st.ota.version === VERSION ? st.ota : { version: VERSION, files: {} };
    await api.storage.local.set({ ota: { ...prev, checkedAt: Date.now(), outcome: String(e && e.message || e) } });
  }
}

api.runtime.onInstalled.addListener(async (details) => {
  // A fresh install opens the welcome page once; an update never does.
  if (details && details.reason === 'install') {
    try { api.tabs.create({ url: api.runtime.getURL('welcome.html') }); } catch (e) {}
  }
  const settings = await ensureSettings();
  await syncScripts(settings);
  api.alarms.create('rules-refresh', { periodInMinutes: 24 * 60, delayInMinutes: 1 });
  refreshRules();
});

// Developer builds reload themselves when a new build lands (dev-reload.js).
watchBuilds();

api.runtime.onStartup.addListener(async () => {
  const settings = await ensureSettings();
  await syncScripts(settings);
});

api.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'rules-refresh') refreshRules();
  if (alarm.name === 'dev-update') checkForNewBuild();
  if (alarm.name === 'break-end') endBreak();
});

api.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.settings && changes.settings.newValue) {
    syncScripts(changes.settings.newValue);
    scheduleBreakEnd(changes.settings.newValue);
  } else if (area === 'local' && changes.ota) {
    // A new kill.json can switch page code off: resync with the settings.
    state().then((st) => st.settings && syncScripts(st.settings));
  }
});

// The toolbar icon, per tab, from what the page reports (ZV picked the
// calm style, 2026-11-23): lit with a small green dot when all is tamed;
// a gold dot when something you brought back is on the page; a red "!"
// badge when something set to hide is still visible; dimmed when the site
// is paused. Sites Tame Scroll does not cover keep the dimmed default.
const DOT = { green: '#86a893', gold: '#c9a45e' };
const SIZES = [16, 32];
let iconBitmaps = null;
async function bitmaps() {
  if (!iconBitmaps) {
    iconBitmaps = {};
    for (const n of SIZES) {
      const blob = await (await fetch(api.runtime.getURL(`icons/icon-${n}.png`))).blob();
      iconBitmaps[n] = await createImageBitmap(blob);
    }
  }
  return iconBitmaps;
}
async function iconData({ dim = false, dot = null }) {
  const bms = await bitmaps();
  const out = {};
  for (const n of SIZES) {
    const c = new OffscreenCanvas(n, n);
    const g = c.getContext('2d');
    if (dim) { g.globalAlpha = 0.45; g.filter = 'grayscale(1)'; }
    g.drawImage(bms[n], 0, 0, n, n);
    g.globalAlpha = 1; g.filter = 'none';
    if (dot) {
      const r = n * 0.15, cx = n - r - n * 0.03, cy = n - r - n * 0.03;
      g.beginPath(); g.arc(cx, cy, r + n * 0.06, 0, Math.PI * 2); g.fillStyle = '#121212'; g.fill();
      g.beginPath(); g.arc(cx, cy, r, 0, Math.PI * 2); g.fillStyle = dot; g.fill();
    }
    out[n] = g.getImageData(0, 0, n, n);
  }
  return out;
}
const iconState = new Map(); // tabId -> 'dim' | 'green' | 'gold' (+ '!'), read by the smoke test
async function setIconFor(tabId, s) {
  iconState.set(tabId, s.off ? 'dim' : (s.showing ? 'gold' : 'green') + (s.slipped ? '!' : ''));
  try {
    if (s.off) await api.action.setIcon({ tabId, imageData: await iconData({ dim: true }) });
    else await api.action.setIcon({ tabId, imageData: await iconData({ dot: s.showing ? DOT.gold : DOT.green }) });
    await api.action.setBadgeText({ tabId, text: !s.off && s.slipped ? '!' : '' });
    if (!s.off && s.slipped) await api.action.setBadgeBackgroundColor({ tabId, color: '#c96a5e' });
  } catch (e) {} // the tab closed
}
// Default for every tab: dimmed, until a covered page says otherwise.
iconData({ dim: true }).then((imageData) => api.action.setIcon({ imageData })).catch(() => {});

api.runtime.onMessage.addListener((msg, sender, reply) => {
  if (msg && msg.type === 'ts-status' && sender.tab && sender.tab.id != null) {
    setIconFor(sender.tab.id, msg);
    return false;
  }
  if (msg && msg.type === 'icon-state') { reply({ state: iconState.get(msg.tabId) || 'dim' }); return false; }
  if (msg && msg.type === 'build-id') { reply({ id: BUILD_ID }); return false; }
  if (msg && msg.type === 'refresh-rules') {
    refreshRules().then(() => reply({ ok: true }));
    return true;
  }
  return false;
});
