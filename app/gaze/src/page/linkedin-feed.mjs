// LinkedIn's home feed: posts from people you don't follow ("Recommended
// for you", 3rd+ connections) and Promoted posts. LinkedIn's markup has
// no stable class or attribute for them, so they are found by what they
// show: a Follow button in the post, or a Promoted / Suggested /
// Recommended label at its top. Registered only while "Suggested posts"
// is off. Seen live 2026-11-23 (ZV's feed, signed in): 3 of 8 posts had
// a Follow button.
//
// Like Instagram, hiding them leaves the feed short and LinkedIn keeps
// loading more; once the newest three posts are all hidden, the feed is
// clipped at the last post you follow and a caught-up line shown.

const NOTE_ID = 'tamescroll-li-caught-up';
const RUN = 3;
const LABEL = /^(Promoted|Suggested|Recommended for you)\b/m;

function unwanted(post) {
  for (const b of post.querySelectorAll('button')) {
    const t = (b.innerText || '').trim();
    if (t === 'Follow' || t === '+ Follow') return true;
  }
  return LABEL.test((post.innerText || '').slice(0, 400));
}

function clip(feed, lastKept) {
  if (document.getElementById(NOTE_ID)) return;
  const note = document.createElement('p');
  note.id = NOTE_ID;
  note.textContent = "You're caught up. Posts from people you don't follow are hidden by Tame Scroll.";
  note.style.cssText = 'text-align:center;padding:24px 16px;opacity:.7;font-size:14px;';
  feed.parentElement.insertBefore(note, feed.nextSibling);
  // Clip the feed below the last post you follow, so its loader is out
  // of sight and stops fetching.
  const top = feed.getBoundingClientRect().top;
  const bottom = lastKept ? lastKept.getBoundingClientRect().bottom : top;
  feed.style.setProperty('max-height', Math.max(0, bottom - top) + 'px', 'important');
  feed.style.setProperty('overflow', 'hidden', 'important');
}

function sweep() {
  if (!location.pathname.startsWith('/feed')) return;
  const feed = document.querySelector('[data-testid="mainFeed"]');
  if (!feed) return;
  const items = [...feed.querySelectorAll('[data-lazy-mount-id]')].filter((m) => m.querySelector('div[componentkey^="expanded"]'));
  for (const m of items) {
    if (m.dataset.tsLi === '1') continue;
    m.dataset.tsLi = unwanted(m) ? '1' : '0';
    if (m.dataset.tsLi === '1') m.style.setProperty('display', 'none', 'important');
  }
  const tail = items.slice(-RUN);
  if (tail.length === RUN && tail.every((m) => m.dataset.tsLi === '1')) {
    const kept = items.filter((m) => m.dataset.tsLi === '0');
    clip(feed, kept[kept.length - 1]);
  }
}

/** Starts the sweep. Safe to call twice: the second call does nothing. */
export function start() {
  if (window.__tsLiFeed) return;
  window.__tsLiFeed = 1;
  sweep();
  new MutationObserver(sweep).observe(document.documentElement, { childList: true, subtree: true });
}
