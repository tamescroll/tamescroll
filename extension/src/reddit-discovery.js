// Reddit's discovery pages -- r/popular, r/all, News and Explore -- are
// sent to your home feed, which keeps only communities you joined. Runs
// at document_start in the extension's world while the Discovery feeds
// switch is off. The sidebar links to them are hidden by rules/reddit.txt.

const DISCOVERY = /^\/(r\/(popular|all)|news|explore)(\/|$)/i;

function check() {
  if (DISCOVERY.test(location.pathname)) location.replace('/');
}

check();
// Reddit moves between pages without a reload.
let last = location.pathname;
setInterval(() => {
  if (location.pathname !== last) { last = location.pathname; check(); }
}, 300);

// Signed in, Reddit draws Popular, News and Explore inside the shadow
// root of <left-nav-top-section>, which page CSS cannot reach (ZV's own
// console read, 2026-11-23: 3 links there, 0 in the page). Hidden from
// here instead, and the "Games on Reddit" drawer with them.
const DOOR = 'a[href*="/r/popular"], a[href*="/r/all"], a[href^="/news"], a[href*="reddit.com/news"], a[href^="/explore"], a[href*="reddit.com/explore"]';

function hide(el) {
  if (el && el.style.display !== 'none') el.style.setProperty('display', 'none', 'important');
}

function sweepNav() {
  for (const host of document.querySelectorAll('left-nav-top-section, [class*="left-nav"]')) {
    const root = host.shadowRoot;
    if (!root) continue;
    for (const a of root.querySelectorAll(DOOR)) hide(a.closest('li, faceplate-tracker, left-nav-item') || a);
    for (const t of root.querySelectorAll('faceplate-tracker[noun="popular_menu"], faceplate-tracker[noun="news_menu"], faceplate-tracker[noun="explore_menu"], faceplate-tracker[noun="all_menu"]')) hide(t.closest('li') || t);
  }
  for (const t of document.querySelectorAll('faceplate-tracker[noun="games_drawer"]')) {
    // Climb to the drawer's own section: the child of the first ancestor
    // that also holds the next section (custom feeds or communities).
    let el = t;
    while (el.parentElement && !el.parentElement.querySelector('[noun="multireddits_menu"], [noun="communities_menu"]')) el = el.parentElement;
    if (el.parentElement) hide(el);
  }
}

new MutationObserver(sweepNav).observe(document.documentElement, { childList: true, subtree: true });
setInterval(sweepNav, 1000);
