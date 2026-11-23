// The background worker: seeds settings on install, keeps the page-code
// scripts registered to match the settings, and refreshes the rules over
// the air once a day.

import { SITES, rulesFiles } from './sites.js';
import { seed } from './settings.js';
import { refresh, rulesText } from './ota.js';
import { BUNDLED } from './bundled.js';
import { wantedScripts } from './scripts.js';
import { parseKill } from './kill.js';

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
  await api.storage.local.set({ settings });
  return settings;
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
// Reddit fix that never reached the page).
async function isDevBuild() {
  try {
    const me = await api.management.getSelf();
    return me.installType === 'development';
  } catch (e) {
    return false;
  }
}

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

api.runtime.onInstalled.addListener(async () => {
  const settings = await ensureSettings();
  await syncScripts(settings);
  api.alarms.create('rules-refresh', { periodInMinutes: 24 * 60, delayInMinutes: 1 });
  refreshRules();
});

api.runtime.onStartup.addListener(async () => {
  const settings = await ensureSettings();
  await syncScripts(settings);
});

api.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'rules-refresh') refreshRules();
});

api.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.settings && changes.settings.newValue) {
    syncScripts(changes.settings.newValue);
  } else if (area === 'local' && changes.ota) {
    // A new kill.json can switch page code off: resync with the settings.
    state().then((st) => st.settings && syncScripts(st.settings));
  }
});

// The toolbar badge, per tab, from what the page reports: a green count
// of what is hidden here; gold when something you brought back is on the
// page; red "!" when something set to hide is still visible; grey "off"
// when the site is paused.
const BADGE = { green: '#86a893', gold: '#c9a45e', red: '#c96a5e', grey: '#6f6b65' };
function setBadge(tabId, s) {
  let text, color;
  if (s.off) { text = 'off'; color = BADGE.grey; }
  else if (s.slipped) { text = '!'; color = BADGE.red; }
  else { text = s.hidden ? String(s.hidden) : ''; color = s.showing ? BADGE.gold : BADGE.green; if (!text && s.showing) text = '•'; }
  api.action.setBadgeText({ tabId, text }).catch(() => {});
  api.action.setBadgeBackgroundColor({ tabId, color }).catch(() => {});
  if (api.action.setBadgeTextColor) api.action.setBadgeTextColor({ tabId, color: '#121212' }).catch(() => {});
}

api.runtime.onMessage.addListener((msg, sender, reply) => {
  if (msg && msg.type === 'ts-status' && sender.tab && sender.tab.id != null) {
    setBadge(sender.tab.id, msg);
    return false;
  }
  if (msg && msg.type === 'refresh-rules') {
    refreshRules().then(() => reply({ ok: true }));
    return true;
  }
  return false;
});
