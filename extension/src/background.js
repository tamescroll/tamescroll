// The background worker: seeds settings on install, keeps the page-code
// scripts registered to match the settings, and refreshes the rules over
// the air once a day.

import { SITES, rulesFiles } from './sites.js';
import { seed } from './settings.js';
import { refresh, rulesText } from './ota.js';
import { BUNDLED } from './bundled.js';
import { wantedScripts } from './scripts.js';

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
    const wanted = wantedScripts(settings);
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
  }
});

api.runtime.onMessage.addListener((msg, _sender, reply) => {
  if (msg && msg.type === 'refresh-rules') {
    refreshRules().then(() => reply({ ok: true }));
    return true;
  }
  return false;
});
