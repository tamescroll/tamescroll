// A browser smoke test of the built extension, offline: every request to
// the served sites is answered by a fixture page, so this checks the
// extension's own wiring (stylesheet, page-world scripts, popup) and not
// the live sites' markup. The live selector pass is a separate step.
//
//   node build.mjs && node smoke/smoke.mjs
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import assert from 'node:assert/strict';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const here = dirname(fileURLToPath(import.meta.url));
// TS_EXT_DIR=dist/chrome-store runs the same checks on the store package.
const ext = process.env.TS_EXT_DIR ? join(here, '..', process.env.TS_EXT_DIR) : join(here, '..', 'dist', 'chrome');

const YT_HOME = `<!doctype html><html><head><title>yt</title></head><body>
<ytd-browse page-subtype="home"><ytd-rich-grid-renderer id="grid">feed</ytd-rich-grid-renderer></ytd-browse>
<ytd-reel-shelf-renderer id="shorts-shelf">shorts</ytd-reel-shelf-renderer>
<ytd-search><ytd-thumbnail id="thumb">thumb</ytd-thumbnail></ytd-search>
<a id="short" href="/shorts/abcdefghijk">a short</a>
</body></html>`;
const YT_WATCH = `<!doctype html><html><head></head><body><div id="watch">watch</div>
<ytd-watch-next-secondary-results-renderer id="recs">recs</ytd-watch-next-secondary-results-renderer></body></html>`;
const REDDIT = `<!doctype html><html><head></head><body>
<shreddit-app pagetype="popular"><shreddit-feed id="feed">popular</shreddit-feed></shreddit-app></body></html>`;

const REDDIT_HOME = `<!doctype html><html><head></head><body>
<left-nav-top-section id="nav"></left-nav-top-section><nav><div id="games"><faceplate-tracker noun="games_drawer">Games on Reddit</faceplate-tracker></div><div><faceplate-tracker noun="communities_menu">Communities</faceplate-tracker></div></nav>
<script>document.getElementById("nav").attachShadow({mode:"open"}).innerHTML='<ul><li id="h"><a href="/">Home</a></li><li id="pop"><a href="/r/popular/">Popular</a></li><li id="news"><a href="/news/">News</a></li></ul>';</script>
<shreddit-app pagetype="home" user-logged-in="true"><shreddit-feed reload-url="/svc/shreddit/feeds/interest-home-feed?feed=for-you">
<article id="a1"><shreddit-post is-subscribed="" recommendation-source="">mine</shreddit-post></article><hr id="h1">
<article id="a2"><shreddit-post recommendation-source="good_visits_on_subreddit">suggested</shreddit-post></article><hr id="h2">
<shreddit-post id="p3">not joined</shreddit-post>
</shreddit-feed></shreddit-app></body></html>`;

const FB_PAGE = `<!doctype html><html><head><style>html{overflow:hidden}</style></head><body><div id="root">
<div id="page"><div role="main">public page</div></div>
<div id="layer"><div><div role="dialog"><h2>See more on Facebook</h2><input name="email"><input name="pass" type="password"></div></div></div>
</div></body></html>`;

// The same pop-up where it must be left alone: an age gate, and a
// signed-in page. And a page whose buttons open sign-in boxes on purpose.
const FB_AGE = FB_PAGE.replace('See more on Facebook', 'You must be 18 or older to see this');
const FB_SIGNED_IN = FB_PAGE.replace('<div role="main">', '<a aria-label="Your profile" href="/me">me</a><div role="main">');
const FB_BUTTONS = FB_PAGE.replace('<div role="main">public page</div>', `<div role="main">public page
<button id="open-box" onclick="const d=document.createElement('div');d.id='mine';d.setAttribute('role','dialog');d.innerHTML='<input type=password>';document.body.append(d)">Comment</button>
<button id="log-in">Log in</button></div>`);
const IG_HOME = `<!doctype html><html><head></head><body><main><div><div id="feed">
<article id="mine"><header><a href="/friend/">friend</a></header>followed</article>
<article id="s1"><header><a href="/x1/">x1</a><div role="button">Follow</div></header>suggested</article>
<article id="s2"><header><a href="/x2/">x2</a><div role="button">Follow</div></header>suggested</article>
<article id="s3"><header><a href="/x3/">x3</a><div role="button">Follow</div></header>suggested</article>
</div><div id="loader"><svg aria-label="Loading..."></svg></div></div></main></body></html>`;

const LI_FEED = `<!doctype html><html><head></head><body><main><div data-testid="mainFeed">
<div data-lazy-mount-id="a" id="li1"><div componentkey="expandedA">Friend<br>a post</div></div>
<div data-lazy-mount-id="b" id="li2"><div componentkey="expandedB">Stranger <button>Follow</button></div></div>
<div data-lazy-mount-id="c" id="li3"><div componentkey="expandedC">Promoted\nBuy this</div></div>
<div data-lazy-mount-id="d" id="li4"><div componentkey="expandedD">Other <button>+ Follow</button></div></div>
</div></main></body></html>`;

const FB_BODIES = { '/age': FB_AGE, '/me': FB_SIGNED_IN, '/buttons': FB_BUTTONS };

// The toolbar icon state for a tab, waiting up to 5s for `want`.
async function iconState(page, tabId, want) {
  let got = '';
  for (let i = 0; i < 25; i++) {
    got = await page.evaluate(async (t) => (await chrome.runtime.sendMessage({ type: 'icon-state', tabId: t })).state, tabId);
    if (got === want) break;
    await page.waitForTimeout(200);
  }
  return got;
}

const ctx = await chromium.launchPersistentContext(mkdtempSync(join(tmpdir(), 'ts-ext-')), {
  headless: true,
  channel: 'chromium',
  args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`],
});
try {
  await ctx.route(/^https:\/\/(www|m)\.youtube\.com\//, (route) => {
    const u = new URL(route.request().url());
    const body = u.pathname.startsWith('/watch') ? YT_WATCH : YT_HOME;
    route.fulfill({ status: 200, contentType: 'text/html', body });
  });
  await ctx.route(/^https:\/\/www\.reddit\.com\//, (route) => {
    const u = new URL(route.request().url());
    route.fulfill({ status: 200, contentType: 'text/html', body: u.pathname === '/' ? REDDIT_HOME : REDDIT });
  });
  await ctx.route(/^https:\/\/www\.linkedin\.com\//, (route) => route.fulfill({ status: 200, contentType: 'text/html', body: LI_FEED }));
  await ctx.route(/^https:\/\/www\.instagram\.com\//, (route) => route.fulfill({ status: 200, contentType: 'text/html', body: IG_HOME }));
  await ctx.route(/^https:\/\/www\.facebook\.com\//, (route) => route.fulfill({ status: 200, contentType: 'text/html', body: FB_BODIES[new URL(route.request().url()).pathname] || FB_PAGE }));
  await ctx.route(/^https:\/\/raw\.githubusercontent\.com\//, (route) => route.abort());

  let [sw] = ctx.serviceWorkers();
  if (!sw) sw = await ctx.waitForEvent('serviceworker');
  const extId = new URL(sw.url()).host;
  // Let onInstalled seed settings and register the page scripts.
  await sw.evaluate(async () => {
    for (let i = 0; i < 50; i++) {
      const st = await chrome.storage.local.get('settings');
      const regs = await chrome.scripting.getRegisteredContentScripts();
      if (st.settings && regs.length) return;
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error('settings never seeded');
  });
  const regs = await sw.evaluate(() => chrome.scripting.getRegisteredContentScripts());
  console.log('registered:', regs.map((r) => `${r.id}(${r.world})`).join(', '));

  // A fresh install opens the welcome page once, with the HaramBlur card.
  const welcome = ctx.pages().find((p) => p.url().endsWith('/welcome.html'))
    || await ctx.waitForEvent('page', { predicate: (p) => p.url().endsWith('/welcome.html'), timeout: 5000 });
  await welcome.waitForFunction(() => !document.getElementById('pair').hidden);
  assert.equal(await welcome.$eval('#get', (a) => a.href), 'https://chromewebstore.google.com/detail/pbcoegikffnadpahojjhgdladmmddeji', 'welcome links HaramBlur on the Chrome Web Store');
  assert.match(await welcome.$eval('#sites', (el) => el.textContent), /YouTube.*and /, 'welcome names the sites');
  await welcome.click('#not-now');
  assert.equal(await welcome.$eval('#pair', (el) => el.hidden), true, 'Not now hides the card');
  await welcome.reload();
  await welcome.waitForTimeout(300);
  assert.equal(await welcome.$eval('#pair', (el) => el.hidden), true, 'Not now is remembered');
  await welcome.close();
  console.log('welcome page: opened on install, HaramBlur card, Not now remembered');
  assert.deepEqual(regs.map((r) => r.id).sort(), ['facebook-login-nags', 'instagram-login-nags', 'instagram-suggested', 'linkedin-feed', 'reddit-discovery', 'reddit-login-nags', 'x-login-nags', 'youtube-autoplay', 'youtube-shorts']);

  const page = await ctx.newPage();
  const display = (sel) => page.$eval(sel, (el) => getComputedStyle(el).display);

  await page.goto('https://www.youtube.com/');
  await page.waitForFunction(() => document.getElementById('tamescroll-style')?.textContent.length > 0);
  assert.equal(await display('#grid'), 'none', 'home feed hidden');
  assert.equal(await display('#shorts-shelf'), 'none', 'shorts shelf hidden');
  assert.equal(await page.$eval('#thumb', (el) => getComputedStyle(el).filter), 'none', 'blur off by default');
  assert.equal(await page.evaluate(() => window.__TS_EXT_SHORTS__), 1, 'shorts script runs in the page world');
  assert.equal(await page.evaluate(() => window.__TS_EXT_ADS__), undefined, 'ads shown by default on YouTube');
  console.log('youtube home: feed and shorts hidden, page script present');

  await page.click('#short');
  await page.waitForURL(/\/watch\?v=abcdefghijk/);
  console.log('short opened as', new URL(page.url()).pathname + new URL(page.url()).search);
  assert.notEqual(await display('#recs'), 'none', 'watch recommendations start shown');

  await page.goto('https://www.youtube.com/shorts/zyxwvutsrqp');
  await page.waitForURL(/\/watch\?v=zyxwvutsrqp/);
  console.log('hard load of /shorts/ redirected');

  // Popup: bring the home feed back and turn blur on; the open page follows live.
  await page.goto('https://www.youtube.com/');
  await page.waitForFunction(() => document.getElementById('tamescroll-style')?.textContent.length > 0);
  const popup = await ctx.newPage();
  const ytTab = await sw.evaluate(async () => (await chrome.tabs.query({ url: 'https://www.youtube.com/*' }))[0].id);
  await popup.goto(`chrome-extension://${extId}/popup.html?tab=${ytTab}`);
  await popup.waitForFunction(() => document.getElementById('site-status').textContent === '' && !document.getElementById('count').hidden);
  await popup.setViewportSize({ width: 320, height: 300 });
  await popup.waitForTimeout(300); await popup.screenshot({ path: join(here, 'popup-home.png'), fullPage: true });
  await popup.click('#open-parts');
  await popup.getByRole('switch', { name: 'Home feed' }).click();
  await popup.waitForTimeout(300); await popup.screenshot({ path: join(here, 'popup-bring-back.png'), fullPage: true });
  await popup.click('#view-parts .back');
  await popup.getByRole('switch', { name: 'Blur pictures' }).click();
  await page.waitForFunction(() => getComputedStyle(document.getElementById('grid')).display !== 'none');
  await page.waitForFunction(() => getComputedStyle(document.getElementById('thumb')).filter.includes('blur'));
  console.log('popup: home feed brought back and blur on, applied live');

  // Ads hidden on YouTube registers the ad scriptlets.
  await popup.click('#open-parts');
  await popup.getByRole('switch', { name: 'Ads' }).click();
  await sw.evaluate(async () => {
    for (let i = 0; i < 50; i++) {
      const regs = await chrome.scripting.getRegisteredContentScripts();
      if (regs.some((r) => r.id === 'youtube-ads')) return;
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error('ads script never registered');
  });
  assert.equal(await popup.evaluate(() => document.getElementById('reload-note').hidden), false, 'popup says a reload is needed');
  await page.reload();
  assert.equal(await page.evaluate(() => window.__TS_EXT_ADS__), 1);
  // The scriptlets pin the player response: YouTube's own later
  // assignment of ad slots must come out pruned.
  const slots = await page.evaluate(() => {
    window.ytInitialPlayerResponse = { adSlots: [1, 2], adPlacements: [{}], playerAds: [{}], videoDetails: { videoId: 'v' } };
    const r = window.ytInitialPlayerResponse;
    return { adSlots: r && r.adSlots, adPlacements: r && r.adPlacements, video: r && r.videoDetails && r.videoDetails.videoId };
  });
  assert.equal(slots.adSlots, undefined);
  assert.equal(slots.adPlacements, undefined);
  assert.equal(slots.video, 'v');
  console.log('ads hidden: ad scriptlets run after reload');

  await popup.click('#view-parts .back');
  await popup.waitForTimeout(300); await popup.screenshot({ path: join(here, 'popup-home-reload.png'), fullPage: true });
  await popup.click('#open-settings');
  await popup.waitForTimeout(300); await popup.screenshot({ path: join(here, 'popup-settings.png'), fullPage: true });

  // On a video, what you brought back is listed on the first screen with
  // a one-tap Hide (recommendations ship shown).
  await page.goto('https://www.youtube.com/watch?v=abcdefghijk');
  await page.waitForFunction(() => document.getElementById('tamescroll-style')?.textContent.length > 0);
  const sp = await ctx.newPage();
  await sp.goto(`chrome-extension://${extId}/popup.html?tab=${ytTab}`);
  assert.equal(await sp.$eval('#companion', (a) => !a.hidden && a.href), 'https://chromewebstore.google.com/detail/pbcoegikffnadpahojjhgdladmmddeji', 'Settings suggests HaramBlur');
  await sp.waitForFunction(() => !document.getElementById('showing-wrap').hidden);
  assert.match(await sp.$eval('#showing', (el) => el.textContent), /Recommendations/, 'recommendations listed as showing');
  assert.equal(await iconState(sp, ytTab, 'gold'), 'gold', 'icon dot is gold while something is showing by choice');
  await sp.setViewportSize({ width: 340, height: 300 });
  await sp.waitForTimeout(300); await sp.screenshot({ path: join(here, 'popup-showing.png'), fullPage: true });
  await sp.getByRole('switch', { name: 'Hide Recommendations' }).click();
  await page.waitForFunction(() => getComputedStyle(document.getElementById('recs')).display === 'none');
  await sp.waitForFunction(() => document.getElementById('showing-wrap').hidden);
  assert.equal(await iconState(sp, ytTab, 'green'), 'green', 'icon dot back to green');
  await sp.close();
  console.log('popup: showing on this page listed, one tap hides it');

  // Take a break: every page shows everything, the icon dims, and ending
  // it (or the alarm) brings the stylesheet back.
  const bp = await ctx.newPage();
  await bp.goto(`chrome-extension://${extId}/popup.html?tab=${ytTab}`);
  await bp.click('#take-break');
  await page.waitForFunction(() => document.getElementById('tamescroll-style')?.textContent === '');
  assert.equal(await bp.evaluate(() => document.getElementById('break-note').hidden), false, 'popup shows the break');
  assert.match(await bp.$eval('#break-text', (e) => e.textContent), /On a break until/);
  assert.equal(await iconState(bp, ytTab, 'dim'), 'dim', 'icon dims during a break');
  await bp.setViewportSize({ width: 320, height: 300 });
  await bp.waitForTimeout(300); await bp.screenshot({ path: join(here, 'popup-break.png'), fullPage: true });
  await bp.click('#end-break');
  await page.waitForFunction(() => document.getElementById('tamescroll-style')?.textContent.length > 0);
  assert.equal(await bp.evaluate(() => document.getElementById('break-wrap').hidden), false, 'break button back');
  await bp.close();
  console.log('popup: a break shows everything, ending it tames the page again');

  const rp = await ctx.newPage();
  await rp.goto('https://www.reddit.com/r/popular/');
  await rp.waitForURL('https://www.reddit.com/');
  console.log('reddit: r/popular sent home');
  await rp.goto('https://www.reddit.com/');
  await rp.waitForFunction(() => document.getElementById('tamescroll-style')?.textContent.length > 0);
  const d = (id) => rp.$eval('#' + id, (el) => getComputedStyle(el).display);
  assert.notEqual(await d('a1'), 'none', 'a post from a joined community stays');
  assert.equal(await d('a2'), 'none', 'a suggested post is hidden');
  assert.equal(await d('h2'), 'none', 'and its divider');
  assert.equal(await d('p3'), 'none', 'a post from a community not joined is hidden');
  await rp.waitForFunction(() => getComputedStyle(document.getElementById('games')).display === 'none');
  const inNav = (id) => rp.evaluate((i) => getComputedStyle(document.getElementById('nav').shadowRoot.getElementById(i)).display, id);
  assert.equal(await inNav('pop'), 'none', 'Popular in the signed-in nav is hidden');
  assert.equal(await inNav('news'), 'none', 'News in the signed-in nav is hidden');
  assert.notEqual(await inNav('h'), 'none', 'Home stays');
  console.log('reddit home: only joined communities stay; Popular, News and Games gone from the menu');
  const fb = await ctx.newPage();
  await fb.goto('https://www.facebook.com/NASA');
  await fb.waitForFunction(() => getComputedStyle(document.getElementById('layer')).display === 'none');
  assert.notEqual(await fb.$eval('#page', (el) => getComputedStyle(el).display), 'none', 'the public page stays');
  assert.equal(await fb.evaluate(() => getComputedStyle(document.documentElement).overflow), 'auto', 'scroll given back');
  await fb.goto('https://www.facebook.com/login/');
  await fb.waitForTimeout(500);
  assert.notEqual(await fb.$eval('#layer', (el) => getComputedStyle(el).display), 'none', 'a real login page is left alone');
  console.log('facebook: sign-in pop-up hidden, scroll back, login page untouched');
  const layer = () => fb.$eval('#layer', (el) => getComputedStyle(el).display);
  await fb.goto('https://www.facebook.com/age');
  await fb.waitForTimeout(500);
  assert.notEqual(await layer(), 'none', 'an age gate is never hidden');
  await fb.goto('https://www.facebook.com/me');
  await fb.waitForTimeout(500);
  assert.notEqual(await layer(), 'none', 'nothing is hidden while signed in');
  await fb.goto('https://www.facebook.com/buttons');
  await fb.waitForFunction(() => getComputedStyle(document.getElementById('layer')).display === 'none');
  await fb.click('#open-box');
  await fb.waitForTimeout(500);
  assert.notEqual(await fb.$eval('#mine', (el) => getComputedStyle(el).display), 'none', 'a box you opened yourself stays');
  await fb.click('#log-in');
  await fb.waitForTimeout(300);
  assert.notEqual(await layer(), 'none', 'using Log in brings back what was hidden');
  console.log('facebook: age gate, signed in, and boxes you open are all left alone');
  const ig = await ctx.newPage();
  await ig.goto('https://www.instagram.com/');
  await ig.waitForSelector('#tamescroll-ig-caught-up');
  const igd = (id) => ig.$eval('#' + id, (el) => getComputedStyle(el).display);
  assert.notEqual(await igd('mine'), 'none', 'a post from someone you follow stays');
  for (const id of ['s1', 's2', 's3']) assert.equal(await igd(id), 'none', 'a suggested post is hidden');
  assert.equal(await igd('loader'), 'none', 'loading stops once only suggestions are left');
  console.log("instagram: suggested posts hidden, caught-up line shown");
  const li = await ctx.newPage();
  await li.goto('https://www.linkedin.com/feed/');
  await li.waitForSelector('#tamescroll-li-caught-up');
  const lid = (id) => li.$eval('#' + id, (el) => getComputedStyle(el).display);
  assert.notEqual(await lid('li1'), 'none', 'a post from someone you follow stays');
  for (const id of ['li2', 'li3', 'li4']) assert.equal(await lid(id), 'none', 'a post from someone you do not follow, or Promoted, is hidden');
  console.log('linkedin: unfollowed and promoted posts hidden');
  console.log('SMOKE OK');
} finally {
  await ctx.close();
}
