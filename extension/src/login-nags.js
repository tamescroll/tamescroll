// Signed-out "log in to see more" pop-ups on Facebook, Instagram, X and
// Reddit: the overlay that covers a public page after a scroll or two.
// This hides the OVERLAY and gives the page its scroll back. It only ever
// hides: nothing that was not already on the page is revealed, and what
// was public stays exactly as public as the site made it.
//
// Narrowed on purpose (the 2026-11-23 legal review, his word "yes
// important"). It acts only when ALL of these hold:
//   - you are signed out (each site's own signed-in marker is absent);
//   - you did not open the dialog yourself (nothing you clicked or
//     pressed in the last moment, and no Log in / Sign up control you
//     used: those bring back anything hidden here);
//   - it is not an age or mature-content gate (18+, NSFW, date of birth),
//     and the page is not a Reddit NSFW post;
//   - it is a pop-up over a page, not a real login page or a login wall
//     that replaces the content.
// Registered only while the "Sign-in pop-ups" switch is off.

const ON_LOGIN_PAGE = /^\/(login|signup|accounts\/(login|emailsignup)|i\/flow\/(login|signup)|recover|r\/[^/]+\/login)/i;

// Present only for a signed-in account, per site.
const SIGNED_IN = [
  'shreddit-app[user-logged-in="true"]',
  '[data-testid="SideNav_AccountSwitcher_Button"]',
  '[data-testid="AppTabBar_Profile_Link"]',
  'a[href="/direct/inbox/"]',
  '[aria-label="Your profile"]',
  '[aria-label="Account controls and settings"]',
].join(',');

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
  'a[href*="/i/jf/onboarding/"]',
  // Instagram's "See photos, videos and more" sign-up dialog has buttons,
  // not links, for Sign up and Log in; its only links are these two.
  'a[href*="privacycenter.instagram.com"]',
].join(',');

// Age and mature-content gates are never touched, whatever else they ask.
const AGE_GATE_WORDS = /18\+|\bover 18\b|\b18 or older\b|\b18 years\b|\badult\b|\bmature\b|\bnsfw\b|age[- ]restricted|\byour age\b|\bconfirm (your )?age\b|\bbirthday\b|date of birth|sensitive content/i;
// Reddit's NSFW post pages and their gates: leave the whole page alone.
const AGE_GATE_PAGE = 'shreddit-post[nsfw], shreddit-post[over18], xpromo-nsfw-blocking-container, xpromo-nsfw-blocking-modal, [nsfw-blocking]';

// A control that asks to log in or sign up, when you use it yourself.
const SIGN_IN_CONTROL = /^(log ?in|sign ?in|sign ?up|create (new )?account|continue with .+)$/i;

// Small fixed app-download buttons with no stable attribute (X's "Scan
// to get the app"). Matched by their exact words.
const APP_BUTTON_WORDS = /^(Scan to get the app)$/i;

const STYLE_ID = 'tamescroll-nag-scroll';
const USER_OPENED_MS = 1500;

let lastInput = -Infinity;
const hidden = [];

function signedIn() {
  return !!document.querySelector(SIGNED_IN);
}

function visible(el) {
  const r = el.getBoundingClientRect();
  return r.width > 0 && r.height > 0;
}

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

function hide(el) {
  hidden.push(el);
  el.style.setProperty('display', 'none', 'important');
}

// You used a Log in or Sign up control: give back everything hidden here
// and stop, so the box you asked for opens as the site meant it to.
function restore() {
  for (const el of hidden.splice(0)) el.style.removeProperty('display');
  const s = document.getElementById(STYLE_ID);
  if (s) s.remove();
}

// A full-screen dimmer the site renders beside the dialog rather than
// around it (Instagram): a fixed element covering the viewport that holds
// no page content. Only looked for once a sign-in pop-up was found.
function hideDimmers() {
  const vw = innerWidth, vh = innerHeight;
  for (const el of document.body.querySelectorAll('div')) {
    const cs = getComputedStyle(el);
    if (cs.position !== 'fixed') continue;
    const r = el.getBoundingClientRect();
    if (r.width < vw * 0.9 || r.height < vh * 0.9) continue;
    if (el.querySelector('[role="main"], main, shreddit-app, nav, [role="dialog"], dialog')) continue;
    if (!/rgba\(.*,\s*0?\.\d+\)/.test(cs.backgroundColor)) continue;
    hide(el);
  }
}

function releaseScroll() {
  if (document.getElementById(STYLE_ID)) return;
  const s = document.createElement('style');
  s.id = STYLE_ID;
  s.textContent = 'html, body { overflow: auto !important; position: static !important; }';
  (document.head || document.documentElement).appendChild(s);
}

function sweep() {
  if (ON_LOGIN_PAGE.test(location.pathname) || signedIn()) return;
  if (document.querySelector(AGE_GATE_PAGE)) return;
  // A dialog that IS the page (nothing else rendered) is a wall, not a
  // pop-up: leave it.
  if (!document.querySelector('[role="main"], main, shreddit-app')) return;
  const userOpened = performance.now() - lastInput < USER_OPENED_MS;
  for (const d of document.querySelectorAll('[role="dialog"], dialog, [data-testid="sheetDialog"]')) {
    if (d.dataset.tsNag || !visible(d) || !d.querySelector(ASKS_TO_SIGN_IN)) continue;
    // Opened by you, or an age gate: marked so it is never looked at again.
    if (userOpened || AGE_GATE_WORDS.test(d.textContent || '')) { d.dataset.tsNag = 'keep'; continue; }
    d.dataset.tsNag = '1';
    hide(layerOf(d));
    hideDimmers();
    releaseScroll();
  }
  for (const b of document.querySelectorAll('button, a, div[role="button"]')) {
    if (b.dataset.tsNag || !APP_BUTTON_WORDS.test((b.textContent || '').trim())) continue;
    let el = b;
    while (el.parentElement && el.parentElement !== document.body && getComputedStyle(el).position !== 'fixed') el = el.parentElement;
    if (getComputedStyle(el).position !== 'fixed') continue;
    b.dataset.tsNag = '1';
    hide(el);
  }
}

function onInput(e) {
  if (!e.isTrusted) return;
  if (e.type === 'keydown' && e.key !== 'Enter' && e.key !== ' ') return;
  lastInput = performance.now();
  const c = e.target instanceof Element && e.target.closest('a, button, [role="button"], [role="link"]');
  if (!c) return;
  const words = (c.getAttribute('aria-label') || c.textContent || '').trim();
  const href = c.getAttribute('href') || '';
  if (SIGN_IN_CONTROL.test(words) || /\/(login|signup|i\/flow\/(login|signup)|accounts\/(login|emailsignup))/i.test(href)) restore();
}

addEventListener('click', onInput, true);
addEventListener('keydown', onInput, true);
sweep();
new MutationObserver(sweep).observe(document.documentElement, { childList: true, subtree: true });
