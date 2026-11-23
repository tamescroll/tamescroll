// The popup, built like the app (app-polish v2 and its ideas round):
// Home is the site you are on as a "How calm should it be?" sheet, what
// this page is keeping out of sight, and your sites as tiles. Settings
// holds Blur, Look and About. Every change is written to storage; the
// content scripts and the background pick it up from there.

import { SITES, BLUR_PRESETS, siteForHost, siteById } from './sites.js';
import { parseSurfaces, toggles } from './rules.js';
import { rulesText } from './ota.js';
import { BUNDLED } from './bundled.js';
import { seed } from './settings.js';
import { wantedScripts } from './scripts.js';
import { presetsFor, applyPreset, currentPreset, siteSummary } from './presets.js';

const VERSION = chrome.runtime.getManifest().version;
let settings = null;
let overrides = {};
let otaState = null;
let needsReload = false;
let tabSite = null;
let tabId = null;
let selected = 'youtube';
let hiddenHere = null;

const $ = (id) => document.getElementById(id);
const el = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
};
const surfacesOf = (site) => parseSurfaces(rulesText(site.rulesFile, BUNDLED, overrides));
const scriptIds = (s) => wantedScripts(s).map((x) => x.id).sort().join(',');

function remember(key, value) {
  try { sessionStorage.setItem(key, value); } catch (e) {}
}
function recall(key) {
  try { return sessionStorage.getItem(key); } catch (e) { return null; }
}

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

function letter(site) {
  return el('span', 'letter', site.label[0]);
}

// ---------- home ----------

function sheet() {
  const site = siteById(selected);
  const prefs = settings.sites[site.id];
  const surfaces = surfacesOf(site);
  const current = currentPreset(site, surfaces, prefs);
  const root = $('sheet');
  root.replaceChildren();

  const head = el('div', 'sheet-head');
  const titles = el('div', 'grow');
  titles.append(el('div', 'sheet-title', site.label),
    el('div', 'sheet-sub', current === 'off' ? 'Paused' : 'How calm should it be?'));
  head.append(letter(site), titles);
  root.appendChild(head);

  if (current === 'off') {
    root.appendChild(el('p', 'paused-body', `${site.label} shows everything as it is. Nothing is hidden or blurred.`));
    const again = el('button', 'btn-solid wide', `Tame ${site.label} again`);
    again.type = 'button';
    again.addEventListener('click', () => save(() => { prefs.on = true; }));
    root.appendChild(again);
    return;
  }

  for (const p of presetsFor(site, surfaces)) {
    const b = el('button', 'choice' + (current === p.id ? ' active' : ''));
    b.type = 'button';
    b.setAttribute('aria-pressed', String(current === p.id));
    const text = el('span', 'grow');
    text.append(el('span', 'choice-title', p.label), el('span', 'choice-body', p.body));
    b.append(text, el('span', 'radio'));
    b.addEventListener('click', () => save(() => {
      settings.sites[site.id] = applyPreset(site, surfaces, prefs, p.id);
    }));
    root.appendChild(b);
  }

  const det = el('details', 'custom' + (current === 'custom' ? ' active' : ''));
  det.open = recall('custom:' + site.id) === '1';
  det.addEventListener('toggle', () => remember('custom:' + site.id, det.open ? '1' : '0'));
  const sum = el('summary');
  const st = el('span', 'grow');
  st.append(el('span', 'choice-title', 'Customise'),
    el('span', 'choice-body', current === 'custom' ? siteSummary(site, surfaces, prefs) : 'Pick each part yourself'));
  sum.append(st, el('span', 'chev', '›'));
  det.appendChild(sum);
  const body = el('div', 'custom-body');
  body.appendChild(el('div', 'eyebrow', 'Switch on what you want back'));
  for (const t of toggles(site, surfaces)) {
    const on = prefs.shown.includes(t.id);
    const row = el('div', 'row');
    row.append(el('span', 'row-label', t.label), switchEl(on, t.label, (v) => save(() => {
      prefs.shown = v ? [...new Set([...prefs.shown, t.id])] : prefs.shown.filter((x) => x !== t.id);
    })));
    body.appendChild(row);
  }
  det.appendChild(body);
  root.appendChild(det);

  const pause = el('button', 'pause', `Pause on ${site.label}`);
  pause.type = 'button';
  pause.addEventListener('click', () => save(() => { prefs.on = false; }));
  root.appendChild(pause);
}

function here() {
  const box = $('here');
  const site = siteById(selected);
  const items = hiddenHere && tabSite && tabSite.id === site.id && settings.sites[site.id].on ? hiddenHere : [];
  box.hidden = items.length === 0;
  const list = $('here-list');
  list.replaceChildren(...items.map((h) => {
    const r = el('div', 'list-row');
    const icon = el('span', 'row-icon');
    icon.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 12s3.5-6 9-6 9 6 9 6-3.5 6-9 6-9-6-9-6z"/><path d="M4 4l16 16"/></svg>';
    r.append(icon, el('span', 'grow row-title', h.label), el('span', 'count', h.count === 1 ? '1 item' : `${h.count} items`));
    return r;
  }));
}

function tiles() {
  $('tiles').replaceChildren(...SITES.map((site) => {
    const t = el('button', 'tile' + (settings.sites[site.id].on ? ' is-tamed' : '') + (site.id === selected ? ' selected' : ''));
    t.type = 'button';
    t.setAttribute('aria-pressed', String(site.id === selected));
    t.append(letter(site), el('span', 'name', site.label));
    t.addEventListener('click', () => { selected = site.id; remember('selected', site.id); render(); });
    return t;
  }));
}

// ---------- settings ----------

function seg(container, options, current, onPick, label) {
  container.setAttribute('role', 'group');
  container.setAttribute('aria-label', label);
  container.replaceChildren(...options.map((o) => {
    const b = el('button', o.value === current ? 'active' : '', o.label);
    b.type = 'button';
    b.setAttribute('aria-pressed', String(o.value === current));
    b.addEventListener('click', () => onPick(o.value));
    return b;
  }));
}

function settingsPanes() {
  seg($('strength'), BLUR_PRESETS.map((p) => ({ label: p.label, value: p.px })), settings.blurPx,
    (v) => save(() => { settings.blurPx = v; }), 'Blur strength');
  $('blur-sites').replaceChildren(...SITES.map((site) => {
    const prefs = settings.sites[site.id];
    const r = el('div', 'list-row');
    r.append(letter(site), el('span', 'grow row-title', site.label),
      switchEl(prefs.blur, `Blur on ${site.label}`, (v) => save(() => { prefs.blur = v; })));
    return r;
  }));

  const looks = [
    { value: 'night', label: 'Night', body: 'Warm black. Easy after dark.' },
    { value: 'paper', label: 'Paper', body: 'Warm white. For bright rooms.' },
  ];
  $('looks').replaceChildren(...looks.map((l) => {
    const b = el('button', 'look-card' + (settings.look === l.value ? ' active' : ''));
    b.type = 'button';
    b.setAttribute('aria-pressed', String(settings.look === l.value));
    const sw = el('span', 'look-swatch ' + l.value);
    sw.append(el('b', '', 'Aa'), el('i'));
    b.append(sw, el('span', 'look-name', l.label), el('span', 'look-body', l.body));
    b.addEventListener('click', () => save(() => { settings.look = l.value; }));
    return b;
  }));
  seg($('text-size'), [{ label: 'Normal', value: 'normal' }, { label: 'Larger', value: 'large' }],
    settings.text === 'large' ? 'large' : 'normal', (v) => save(() => { settings.text = v; }), 'Text size');

  $('version').textContent = `Version ${VERSION}`;
  const ok = otaState && otaState.outcome === 'ok';
  const pill = $('rules-pill');
  pill.textContent = ok ? 'Filters up to date' : 'Built-in filters';
  pill.className = 'pill' + (ok ? ' ok' : '');
  $('rules-status').textContent = otaState && otaState.checkedAt
    ? `Last checked ${new Date(otaState.checkedAt).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })}`
    : 'Checks once a day by itself';
}

function showSettings(open, pane) {
  $('view-home').hidden = open;
  $('view-settings').hidden = !open;
  remember('view', open ? 'settings' : 'home');
  if (pane) {
    remember('pane', pane);
    for (const b of document.querySelectorAll('.tabs [role=tab]')) {
      b.setAttribute('aria-selected', String(b.dataset.pane === pane));
    }
    for (const p of ['blur', 'look', 'about']) $('pane-' + p).hidden = p !== pane;
  }
}

function render() {
  document.documentElement.dataset.look = settings.look;
  document.documentElement.dataset.text = settings.text === 'large' ? 'large' : 'normal';
  $('reload-note').hidden = !(needsReload && tabSite);
  sheet();
  here();
  tiles();
  settingsPanes();
}

async function loadHiddenHere() {
  if (tabId == null || !tabSite) return;
  try {
    const r = await chrome.tabs.sendMessage(tabId, { type: 'ts-hidden-here' });
    hiddenHere = r && Array.isArray(r.hidden) ? r.hidden : null;
  } catch (e) {
    hiddenHere = null; // the page loaded before the extension did
  }
  here();
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
      tabSite = siteForHost(new URL(tab.url).hostname);
      tabId = tab.id;
    }
  } catch (e) {}
  selected = (tabSite && tabSite.id) || recall('selected') || 'youtube';
  if (!siteById(selected)) selected = 'youtube';

  $('open-settings').addEventListener('click', () => showSettings(true, recall('pane') || 'blur'));
  $('close-settings').addEventListener('click', () => showSettings(false));
  for (const b of document.querySelectorAll('.tabs [role=tab]')) {
    b.addEventListener('click', () => showSettings(true, b.dataset.pane));
  }
  $('reload').addEventListener('click', () => {
    if (tabId != null) chrome.tabs.reload(tabId);
    needsReload = false;
    render();
  });
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
  showSettings(recall('view') === 'settings', recall('pane') || 'blur');
  loadHiddenHere();
}

main();
