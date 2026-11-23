// The popup. One screen for the site you are on: its name, one switch,
// what it is hiding here, Bring back and Blur. Settings holds the other
// sites and blur strength. Every change is written to storage; the
// content scripts and the background pick it up from there.

import { SITES, BLUR_PRESETS, siteForHost } from './sites.js';
import { parseSurfaces, toggles } from './rules.js';
import { rulesText } from './ota.js';
import { BUNDLED } from './bundled.js';
import { seed } from './settings.js';
import { wantedScripts } from './scripts.js';
import { parseKill } from './kill.js';

const VERSION = chrome.runtime.getManifest().version;
let settings = null;
let overrides = {};
let otaState = null;
let needsReload = false;
let site = null;
let tabId = null;
let hiddenHere = null;
let loaded = false; // the page has been asked at least once

const $ = (id) => document.getElementById(id);
const el = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
};
const surfacesOf = (s) => parseSurfaces(rulesText(s.rulesFile, BUNDLED, overrides));
const killList = () => parseKill(rulesText('kill.json', BUNDLED, overrides));
const scriptIds = (s) => wantedScripts(s, killList()).map((x) => x.id).sort().join(',');

async function save(mutate) {
  const before = scriptIds(settings);
  mutate();
  if (scriptIds(settings) !== before) needsReload = true;
  await chrome.storage.local.set({ settings });
  render();
}

function switchEl(checked, label, onFlip) {
  const b = el('button', 'switch');
  b.type = 'button';
  b.setAttribute('role', 'switch');
  b.setAttribute('aria-checked', String(!!checked));
  b.setAttribute('aria-label', label);
  b.addEventListener('click', () => onFlip(!checked));
  return b;
}

/** "Home feed, Shorts and Topic chips" */
function listWords(words) {
  if (words.length <= 1) return words.join('');
  return words.slice(0, -1).join(', ') + ' and ' + words[words.length - 1];
}

function backCount(s, prefs) {
  const ids = toggles(s, surfacesOf(s)).map((t) => t.id);
  return { back: (prefs.shown || []).filter((id) => ids.includes(id)).length, total: ids.length };
}

function summary(s) {
  const prefs = settings.sites[s.id];
  if (!prefs.on) return 'Paused';
  const { back } = backCount(s, prefs);
  return back === 0 ? 'Everything tamed' : back === 1 ? '1 brought back' : `${back} brought back`;
}

function home() {
  const rows = $('site-rows');
  const count = $('count');
  const tags = $('tags');
  if (!site) {
    $('site-chip').textContent = '';
    $('site-name').textContent = 'Nothing to tame here';
    $('site-switch').replaceChildren();
    $('site-status').textContent = `Open ${listWords(SITES.map((s) => s.label)).replace(' and ', ' or ')} to tame it.`;
    count.hidden = true;
    tags.replaceChildren();
    rows.hidden = true;
    return;
  }
  const prefs = settings.sites[site.id];
  $('site-chip').textContent = site.label[0];
  $('site-name').textContent = site.label;
  $('site-switch').replaceChildren(switchEl(prefs.on, `Tame ${site.label}`, (v) => save(() => { prefs.on = v; })));
  rows.hidden = !prefs.on;

  const status = prefs.on && hiddenHere ? hiddenHere : null;
  const hidden = status ? status.hidden : [];
  const showing = status ? status.showing : [];
  const slipped = status ? status.slipped : [];
  $('showing-wrap').hidden = showing.length === 0;
  $('showing').replaceChildren(...showing.map((h) => {
    const r = el('div', 'row');
    r.append(el('span', 'row-label', h.label), el('span', 'row-state', 'Showing'),
      switchEl(false, `Hide ${h.label}`, () => save(() => { prefs.shown = prefs.shown.filter((x) => x !== h.id); })));
    return r;
  }));
  $('slipped-note').hidden = slipped.length === 0;
  $('slipped-text').textContent = slipped.length
    ? `${listWords(slipped.map((h) => h.label))} got through on this page.`
    : '';
  // The page answered nothing: it opened before Tame Scroll did.
  $('stale-note').hidden = !(prefs.on && hiddenHere === null && tabId != null && loaded);
  count.hidden = hidden.length === 0;
  $('count-num').textContent = String(hidden.length);
  $('count-text').textContent = hidden.length === 1 ? 'thing hidden on this page' : 'things hidden on this page';
  tags.replaceChildren(...hidden.map((h) => el('span', '', h.label)));
  $('site-status').textContent = !prefs.on
    ? 'Paused. This site shows everything. Switch it on above.'
    : hidden.length ? '' : 'Tamed. Nothing to hide on this page right now.';

  const { back, total } = backCount(site, prefs);
  $('parts-value').textContent = back ? `${back} of ${total}` : 'None';
  $('blur-switch').replaceChildren(switchEl(prefs.blur, 'Blur pictures', (v) => save(() => { prefs.blur = v; })));
}

function parts() {
  if (!site) return;
  const prefs = settings.sites[site.id];
  $('parts-title').textContent = `Bring back on ${site.label}`;
  $('parts').replaceChildren(...toggles(site, surfacesOf(site)).map((t) => {
    const r = el('div', 'row');
    r.append(el('span', 'row-label', t.label), switchEl(prefs.shown.includes(t.id), t.label, (v) => save(() => {
      prefs.shown = v ? [...new Set([...prefs.shown, t.id])] : prefs.shown.filter((x) => x !== t.id);
    })));
    return r;
  }));
}

function settingsView() {
  $('sites').replaceChildren(...SITES.map((s) => {
    const prefs = settings.sites[s.id];
    const r = el('div', 'row');
    r.append(el('span', 'row-label', s.label), el('span', 'row-sub', summary(s)),
      switchEl(prefs.on, `Tame ${s.label}`, (v) => save(() => { prefs.on = v; })));
    return r;
  }));
  $('strength').replaceChildren(...BLUR_PRESETS.map((p) => {
    const b = el('button', p.px === settings.blurPx ? 'active' : '', p.label);
    b.type = 'button';
    b.setAttribute('aria-pressed', String(p.px === settings.blurPx));
    b.addEventListener('click', () => save(() => { settings.blurPx = p.px; }));
    return b;
  }));
  $('version').textContent = `Version ${VERSION}`;
  $('rules-status').textContent = otaState && otaState.outcome === 'ok'
    ? `Filters checked ${new Date(otaState.checkedAt).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })}.`
    : 'Using the filters built into this version.';
}

function show(view) {
  for (const v of ['home', 'parts', 'settings']) $('view-' + v).hidden = v !== view;
}

function render() {
  $('reload-note').hidden = !(needsReload && site);
  home();
  parts();
  settingsView();
}

async function loadHiddenHere() {
  if (tabId == null || !site) return;
  try {
    const r = await chrome.tabs.sendMessage(tabId, { type: 'ts-hidden-here' });
    hiddenHere = r && Array.isArray(r.hidden) ? { hidden: r.hidden, showing: r.showing || [], slipped: r.slipped || [] } : null;
  } catch (e) {
    hiddenHere = null; // the page loaded before the extension did
  }
  loaded = true;
  home();
}

// Opening the popup checks for a newer build at once (unpacked installs).
async function checkBuild() {
  try {
    const [{ id }, onDisk] = await Promise.all([
      chrome.runtime.sendMessage({ type: 'build-id' }),
      fetch(chrome.runtime.getURL('build-id.txt'), { cache: 'no-store' }).then((r) => (r.ok ? r.text() : '')),
    ]);
    const me = await chrome.management.getSelf();
    if (me.installType === 'development' && onDisk.trim() && id && onDisk.trim() !== id) chrome.runtime.reload();
  } catch (e) {}
}

async function main() {
  const st = await chrome.storage.local.get(['settings', 'ota']);
  otaState = st.ota && st.ota.version === VERSION ? st.ota : null;
  overrides = otaState && otaState.files ? otaState.files : {};
  settings = seed(st.settings, (name) => rulesText(name, BUNDLED, overrides));

  try {
    // ?tab=<id> lets the smoke test open the popup as a page for one tab.
    const forced = Number(new URLSearchParams(location.search).get('tab'));
    const [tab] = forced ? [await chrome.tabs.get(forced)] : await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab && tab.url) {
      site = siteForHost(new URL(tab.url).hostname);
      tabId = tab.id;
    }
  } catch (e) {}

  $('open-settings').addEventListener('click', () => show('settings'));
  $('open-parts').addEventListener('click', () => show('parts'));
  for (const b of document.querySelectorAll('.back')) b.addEventListener('click', () => show('home'));
  for (const id of ['reload-stale', 'reload-slipped']) $(id).addEventListener('click', () => { if (tabId != null) chrome.tabs.reload(tabId); window.close(); });
  try {
    chrome.extension.isAllowedIncognitoAccess((ok) => { $('incognito-note').hidden = !!ok; });
  } catch (e) {}
  $('reload').addEventListener('click', () => {
    if (tabId != null) chrome.tabs.reload(tabId);
    needsReload = false;
    render();
  });
  $('credits').addEventListener('click', () => chrome.tabs.create({ url: chrome.runtime.getURL('THIRD-PARTY-NOTICES.txt') }));
  $('check-rules').addEventListener('click', async () => {
    $('rules-status').textContent = 'Checking…';
    try { await chrome.runtime.sendMessage({ type: 'refresh-rules' }); } catch (e) {}
    const s2 = await chrome.storage.local.get('ota');
    otaState = s2.ota && s2.ota.version === VERSION ? s2.ota : otaState;
    render();
  });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.settings) setTimeout(loadHiddenHere, 150);
  });

  render();
  show('home');
  loadHiddenHere();
  // After the popup has drawn: never let the update check (which wakes
  // the background) hold up the first paint.
  setTimeout(checkBuild, 1200);
}

main();
