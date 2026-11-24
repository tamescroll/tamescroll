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
// The b-roll: the page is busy, then calm, on a loop (the website's
// phone does the same). Held calm for anyone who asks for less motion.
const demo = $('demo');
const removed = $('removed');
function calm(on) {
  demo.classList.toggle('calm', on);
  removed.classList.toggle('gone', on);
}
if (matchMedia('(prefers-reduced-motion: reduce)').matches) {
  calm(true);
} else {
  let on = false;
  setTimeout(function tick() {
    on = !on;
    calm(on);
    setTimeout(tick, on ? 4200 : 2600);
  }, 1400);
}

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
