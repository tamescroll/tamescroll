// Reddit's signed-in home has two tabs, "For You" (the algorithm) and
// "Following" (what you follow). This hides the For You tab and opens
// Following instead. Found by the tab's own words because Reddit's markup
// for it could not be read from here (the browser tool refuses reddit.com),
// and words are what a person sees anyway. Registered only while the For
// You feed switch is off; runs in the extension's world, never the page's.

const FOR_YOU = /^for you$/i;
const FOLLOWING = /^following$/i;

function tabs() {
  const out = { forYou: null, following: null };
  for (const e of document.querySelectorAll('a, button, [role="tab"]')) {
    const t = (e.textContent || '').trim();
    if (!out.forYou && FOR_YOU.test(t)) out.forYou = e;
    else if (!out.following && FOLLOWING.test(t)) out.following = e;
    if (out.forYou && out.following) break;
  }
  return out;
}

function isSelected(e) {
  return e.getAttribute('aria-selected') === 'true' || e.getAttribute('aria-current') === 'page'
    || e.getAttribute('aria-current') === 'true';
}

function onHome() {
  const app = document.querySelector('shreddit-app');
  const pt = app && app.getAttribute('pagetype');
  return pt === 'home' || location.pathname === '/' || /^\/(best|hot|new|top|rising)\/?$/.test(location.pathname);
}

let moved = false;
function tame() {
  if (!onHome()) return;
  const { forYou, following } = tabs();
  if (!forYou || !following) return;
  forYou.style.setProperty('display', 'none', 'important');
  if (moved || isSelected(following)) return;
  const href = following.getAttribute('href');
  if (href) {
    const target = new URL(href, location.href);
    if (target.pathname + target.search === location.pathname + location.search) return;
    moved = true;
    location.replace(target.href);
  } else if (isSelected(forYou) || !following.closest('[aria-selected="true"]')) {
    moved = true;
    following.click();
  }
}

tame();
new MutationObserver(tame).observe(document.documentElement, { childList: true, subtree: true });
// A soft navigation back to home starts over.
let lastPath = location.pathname + location.search;
setInterval(() => {
  const now = location.pathname + location.search;
  if (now !== lastPath) { lastPath = now; moved = false; tame(); }
}, 500);
