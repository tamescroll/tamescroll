// The welcome page, opened once after install (background.js). It says
// what is already on and suggests HaramBlur for blur inside videos
// (companion.js). "Not now" is remembered, so the card stays away.
import { SITES } from './sites.js';
import { companionUrl } from './companion.js';

const api = globalThis.browser || globalThis.chrome;
const $ = (id) => document.getElementById(id);

function listWords(xs) {
  return xs.length < 2 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`;
}

$('sites').textContent = listWords(SITES.map((s) => s.label));
// One chip per site: its initial and its name, never a site's logo.
$('site-chips').replaceChildren(...SITES.map((s) => {
  const chip = document.createElement('span');
  const mono = document.createElement('b');
  mono.textContent = s.label[0];
  chip.append(mono, s.label);
  return chip;
}));

const url = companionUrl(navigator.userAgent);
api.storage.local.get('companionDismissed').then((st) => {
  if (!url || st.companionDismissed) return;
  $('get').href = url;
  $('pair').hidden = false;
});
$('not-now').addEventListener('click', () => {
  $('pair').hidden = true;
  api.storage.local.set({ companionDismissed: true });
});
$('done').addEventListener('click', () => window.close());
