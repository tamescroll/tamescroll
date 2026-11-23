// Signed-out "log in to see more" pop-ups on Facebook, Instagram, X and
// Reddit: the overlay that covers a public page after a scroll or two.
// This hides the OVERLAY and gives the page its scroll back. It never
// touches a real login page or a login wall that replaces the content:
// what was public stays exactly as public as the site made it.
//
// Found by what the pop-up asks for (a password or username field, or a
// link to the site's login or sign-up flow) inside a dialog, then the
// whole top layer around it is hidden, so the grey backdrop goes too.
// Registered only while the "Sign-in pop-ups" switch is off.

const ON_LOGIN_PAGE = /^\/(login|signup|accounts\/(login|emailsignup)|i\/flow\/(login|signup)|recover|r\/[^/]+\/login)/i;

const ASKS_TO_SIGN_IN = [
  'input[type="password"]',
  'input[name="pass"]',
  'input[name="username"]',
  'a[href*="/login"]',
  'a[href*="/signup"]',
  'a[href*="/accounts/emailsignup"]',
  'a[href*="/i/flow/login"]',
  'a[href*="/i/flow/signup"]',
  'a[href*="/reg/"]',
].join(',');

const STYLE_ID = 'tamescroll-nag-scroll';

function layerOf(dialog) {
  // Climb to the child of the first ancestor that also holds the page
  // itself, so the backdrop and wrapper go with the dialog.
  let el = dialog;
  while (el.parentElement && el.parentElement !== document.body
    && !el.parentElement.querySelector('[role="main"], main, [role="banner"], shreddit-app')) {
    el = el.parentElement;
  }
  return el;
}

function releaseScroll() {
  if (document.getElementById(STYLE_ID)) return;
  const s = document.createElement('style');
  s.id = STYLE_ID;
  s.textContent = 'html, body { overflow: auto !important; position: static !important; }';
  (document.head || document.documentElement).appendChild(s);
}

function sweep() {
  if (ON_LOGIN_PAGE.test(location.pathname)) return;
  for (const d of document.querySelectorAll('[role="dialog"], dialog, [data-testid="sheetDialog"]')) {
    if (d.dataset.tsNag === '1' || !d.querySelector(ASKS_TO_SIGN_IN)) continue;
    // A dialog that IS the page (nothing else rendered) is a wall, not a
    // pop-up: leave it.
    if (!document.querySelector('[role="main"], main, shreddit-app')) continue;
    d.dataset.tsNag = '1';
    layerOf(d).style.setProperty('display', 'none', 'important');
    releaseScroll();
  }
}

sweep();
new MutationObserver(sweep).observe(document.documentElement, { childList: true, subtree: true });
