// The popup: per-site switches, Bring back toggles, blur, look. Every
// change is written to storage; the content scripts and the background
// pick it up from there.

import { SITES, BLUR_PRESETS } from './sites.js';
import { parseSurfaces, toggles } from './rules.js';
import { rulesText } from './ota.js';
import { BUNDLED } from './bundled.js';
import { seed } from './settings.js';

const VERSION = chrome.runtime.getManifest().version;
let settings = null;
let overrides = {};
let needsReload = false;

function segmented(options, current, onPick, label) {
  const wrap = document.createElement('div');
  wrap.className = 'toggle';
  wrap.setAttribute('role', 'group');
  if (label) wrap.setAttribute('aria-label', label);
  for (const opt of options) {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = opt.label;
    const active = opt.value === current;
    b.className = active ? 'active' : '';
    b.setAttribute('aria-pressed', String(active));
    b.addEventListener('click', () => onPick(opt.value));
    wrap.appendChild(b);
  }
  return wrap;
}

function row(labelText, control) {
  const r = document.createElement('div');
  r.className = 'setting-row';
  const l = document.createElement('span');
  l.className = 'setting-label';
  l.textContent = labelText;
  r.append(l, control);
  return r;
}

const ON_OFF = [{ label: 'Off', value: false }, { label: 'On', value: true }];
const HIDDEN_SHOWN = [{ label: 'Hidden', value: false }, { label: 'Shown', value: true }];

async function save(touchesScripts) {
  await chrome.storage.local.set({ settings });
  if (touchesScripts) needsReload = true;
  render();
}

function siteCard(site) {
  const prefs = settings.sites[site.id];
  const card = document.createElement('section');
  card.className = 'card' + (prefs.on ? '' : ' off');

  const head = document.createElement('div');
  head.className = 'site-head';
  const name = document.createElement('span');
  name.className = 'site-name';
  name.textContent = site.label;
  head.append(name, segmented(ON_OFF, prefs.on, (v) => { prefs.on = v; save(true); }, site.label));
  card.appendChild(head);

  const rest = document.createElement('div');
  rest.className = 'rest';
  rest.appendChild(row('Blur images', segmented(ON_OFF, !!prefs.blur, (v) => { prefs.blur = v; save(false); }, 'Blur images')));

  const details = document.createElement('details');
  details.open = sessionStorage.getItem('open:' + site.id) === '1';
  details.addEventListener('toggle', () => {
    try { sessionStorage.setItem('open:' + site.id, details.open ? '1' : '0'); } catch (e) {}
  });
  const summary = document.createElement('summary');
  summary.textContent = 'Bring back';
  details.appendChild(summary);
  const surfaces = parseSurfaces(rulesText(site.rulesFile, BUNDLED, overrides));
  const scripted = new Set(site.scripts.length ? ['ads', 'shorts', 'autoplay_next'] : []);
  for (const t of toggles(site, surfaces)) {
    const shown = prefs.shown.includes(t.id);
    details.appendChild(row(t.label, segmented(HIDDEN_SHOWN, shown, (v) => {
      prefs.shown = v ? [...new Set([...prefs.shown, t.id])] : prefs.shown.filter((x) => x !== t.id);
      save(scripted.has(t.id));
    }, t.label)));
  }
  rest.appendChild(details);
  card.appendChild(rest);
  return card;
}

function render() {
  document.documentElement.dataset.look = settings.look;
  const sites = document.getElementById('sites');
  sites.replaceChildren(...SITES.map(siteCard));

  document.getElementById('look').replaceWith(Object.assign(
    segmented([{ label: 'Night', value: 'night' }, { label: 'Paper', value: 'paper' }], settings.look,
      (v) => { settings.look = v; save(false); }, 'Look'),
    { id: 'look' }));
  document.getElementById('strength').replaceWith(Object.assign(
    segmented(BLUR_PRESETS.map((p) => ({ label: p.label, value: p.px })), settings.blurPx,
      (v) => { settings.blurPx = v; save(false); }, 'Blur strength'),
    { id: 'strength' }));

  document.getElementById('reload-note').hidden = !needsReload;
}

async function main() {
  const st = await chrome.storage.local.get(['settings', 'ota']);
  overrides = st.ota && st.ota.version === VERSION && st.ota.files ? st.ota.files : {};
  settings = seed(st.settings, (name) => rulesText(name, BUNDLED, overrides));
  try {
    const status = document.getElementById('rules-status');
    const ota = st.ota && st.ota.version === VERSION ? st.ota : null;
    const rules = ota && ota.outcome === 'ok'
      ? `rules checked ${new Date(ota.checkedAt).toLocaleString()}`
      : 'using the rules built into this version';
    status.textContent = `Version ${VERSION}, ${rules}.`;
  } catch (e) {}

  document.getElementById('reload').addEventListener('click', async () => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab && tab.id != null) chrome.tabs.reload(tab.id);
    needsReload = false;
    render();
  });
  render();
}

main();

