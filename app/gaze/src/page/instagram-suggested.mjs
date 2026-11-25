// Instagram's home feed, signed in: posts from accounts you don't follow
// ("suggested posts"). They carry a Follow button in the post header; a
// post from someone you follow does not. Instagram's classes are
// generated and change, so the button's own words are the only stable
// mark. Registered only while "Suggested posts" is off.
//
// Hiding every suggested post would leave the feed short, and Instagram
// keeps loading more to fill it (Reddit did the same: 178 posts in 12s).
// So once the newest three posts are all suggested, followed posts have
// run out: the loader is hidden, which stops the loading, and a short
// "You're caught up" line takes its place.

const NOTE_ID = 'tamescroll-ig-caught-up';
const RUN = 3;

function onHome() {
  return location.pathname === '/';
}

function suggested(article) {
  const head = article.querySelector('header') || article;
  for (const b of head.querySelectorAll('div[role="button"], button')) {
    if ((b.textContent || '').trim() === 'Follow') return true;
  }
  return false;
}

function caughtUp(lastArticle) {
  if (document.getElementById(NOTE_ID)) return;
  // The loader sits in a sibling of the articles' wrapper.
  const loader = document.querySelector('main svg[aria-label="Loading..."]');
  let box = loader;
  while (box && box.parentElement && !box.parentElement.contains(lastArticle)) box = box.parentElement;
  if (!box || box.contains(lastArticle)) return;
  box.style.setProperty('display', 'none', 'important');
  const note = document.createElement('p');
  note.id = NOTE_ID;
  note.textContent = "You're caught up. Posts from accounts you don't follow are hidden by Tame Scroll.";
  note.style.cssText = 'text-align:center;padding:24px 16px;opacity:.7;font-size:14px;';
  box.parentElement.insertBefore(note, box);
}

function sweep() {
  if (!onHome()) return;
  const arts = [...document.querySelectorAll('main article')];
  for (const a of arts) {
    if (a.dataset.tsSugg === '1') continue;
    // Wait for the header to render before judging the post.
    if (!a.querySelector('header, a[href^="/"]')) continue;
    // Already hidden by a rule (an ad): not ours to judge.
    if (a.getBoundingClientRect().height === 0) { delete a.dataset.tsSugg; continue; }
    a.dataset.tsSugg = suggested(a) ? '1' : '0';
    if (a.dataset.tsSugg === '1') a.style.setProperty('display', 'none', 'important');
  }
  const judged = arts.filter((a) => a.dataset.tsSugg);
  const tail = judged.slice(-RUN);
  if (tail.length === RUN && tail.every((a) => a.dataset.tsSugg === '1')) caughtUp(tail[tail.length - 1]);
}

/** Starts the sweep. Safe to call twice: the second call does nothing. */
export function start() {
  if (window.__tsIgSugg) return;
  window.__tsIgSugg = 1;
  sweep();
  new MutationObserver(sweep).observe(document.documentElement, { childList: true, subtree: true });
}
