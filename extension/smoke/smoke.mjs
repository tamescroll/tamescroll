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
const ext = join(here, '..', 'dist', 'chrome');

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
<shreddit-app pagetype="home" user-logged-in="true"><shreddit-feed reload-url="/svc/shreddit/feeds/interest-home-feed?feed=for-you">
<article id="a1"><shreddit-post is-subscribed="" recommendation-source="">mine</shreddit-post></article><hr id="h1">
<article id="a2"><shreddit-post recommendation-source="good_visits_on_subreddit">suggested</shreddit-post></article><hr id="h2">
<shreddit-post id="p3">not joined</shreddit-post>
</shreddit-feed></shreddit-app></body></html>`;

const FB_PAGE = `<!doctype html><html><head><style>html{overflow:hidden}</style></head><body><div id="root">
<div id="page"><div role="main">public page</div></div>
<div id="layer"><div><div role="dialog"><h2>See more on Facebook</h2><input name="email"><input name="pass" type="password"></div></div></div>
</div></body></html>`;

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
  await ctx.route(/^https:\/\/www\.facebook\.com\//, (route) => route.fulfill({ status: 200, contentType: 'text/html', body: FB_PAGE }));
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
  assert.deepEqual(regs.map((r) => r.id).sort(), ['facebook-login-nags', 'instagram-login-nags', 'reddit-discovery', 'reddit-login-nags', 'x-login-nags', 'youtube-autoplay', 'youtube-shorts']);

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
  console.log('reddit home: only joined communities stay');
  const fb = await ctx.newPage();
  await fb.goto('https://www.facebook.com/NASA');
  await fb.waitForFunction(() => getComputedStyle(document.getElementById('layer')).display === 'none');
  assert.notEqual(await fb.$eval('#page', (el) => getComputedStyle(el).display), 'none', 'the public page stays');
  assert.equal(await fb.evaluate(() => getComputedStyle(document.documentElement).overflow), 'auto', 'scroll given back');
  await fb.goto('https://www.facebook.com/login/');
  await fb.waitForTimeout(500);
  assert.notEqual(await fb.$eval('#layer', (el) => getComputedStyle(el).display), 'none', 'a real login page is left alone');
  console.log('facebook: sign-in pop-up hidden, scroll back, login page untouched');
  console.log('SMOKE OK');
} finally {
  await ctx.close();
}
