// Chrome Web Store images for the extension, from the real store build:
//   screenshot-1..4.png  1280x800
//   promo-small.png      440x280
//   promo-marquee.png    1400x560
//
//   cd extension && node build.mjs --store && cd .. &&
//   node store/chrome-web-store/shots.mjs
//
// The popups are the store package's own popup.html, opened against
// OFFLINE fixture pages (no live site is loaded, so no platform's logo,
// thumbnails or people appear; the blur-on rule for live test browsers
// does not come into play). The pages behind the popups are drawn
// schematically, in grey blocks.
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';

const require = createRequire(join(dirname(fileURLToPath(import.meta.url)), '../../extension/package.json'));
const { chromium } = require('playwright');
const here = dirname(fileURLToPath(import.meta.url));
const ext = join(here, '../../extension/dist/chrome-store');
const icon = readFileSync(join(here, '../../extension/icons/icon-128.png')).toString('base64');

const YT_HOME = `<!doctype html><html><body>
<ytd-browse page-subtype="home"><ytd-rich-grid-renderer>feed</ytd-rich-grid-renderer><ytd-feed-filter-chip-bar-renderer>chips</ytd-feed-filter-chip-bar-renderer></ytd-browse>
<ytd-guide-entry-renderer><a title="Shorts" href="/shorts">Shorts</a></ytd-guide-entry-renderer>
<ytd-guide-section-renderer><a href="/feed/storefront">Explore</a></ytd-guide-section-renderer>
<ytd-video-preview>preview</ytd-video-preview>
</body></html>`;
const YT_WATCH = `<!doctype html><html><body><div id="watch">watch</div>
<ytd-watch-next-secondary-results-renderer>recs</ytd-watch-next-secondary-results-renderer></body></html>`;

const ctx = await chromium.launchPersistentContext(mkdtempSync(join(tmpdir(), 'ts-shots-')), {
  headless: true,
  channel: 'chromium',
  args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`],
});
const shots = {};
try {
  await ctx.route(/^https:\/\/(www|m)\.youtube\.com\//, (route) => {
    const u = new URL(route.request().url());
    route.fulfill({ status: 200, contentType: 'text/html', body: u.pathname.startsWith('/watch') ? YT_WATCH : YT_HOME });
  });
  await ctx.route(/^https:\/\/raw\.githubusercontent\.com\//, (route) => route.abort());
  let [sw] = ctx.serviceWorkers();
  if (!sw) sw = await ctx.waitForEvent('serviceworker');
  const extId = new URL(sw.url()).host;
  await sw.evaluate(async () => {
    for (let i = 0; i < 50; i++) {
      if ((await chrome.storage.local.get('settings')).settings) return;
      await new Promise((r) => setTimeout(r, 100));
    }
  });

  const page = await ctx.newPage();
  await page.goto('https://www.youtube.com/');
  await page.waitForFunction(() => document.getElementById('tamescroll-style')?.textContent.length > 0);
  const tab = await sw.evaluate(async () => (await chrome.tabs.query({ url: 'https://www.youtube.com/*' }))[0].id);

  const snap = async (name, prepare) => {
    const p = await ctx.newPage({ deviceScaleFactor: 2 });
    await p.setViewportSize({ width: 340, height: 200 });
    await p.goto(`chrome-extension://${extId}/popup.html?tab=${tab}`);
    await p.waitForTimeout(400);
    if (prepare) await prepare(p);
    await p.waitForTimeout(400);
    shots[name] = (await p.screenshot({ fullPage: true })).toString('base64');
    await p.close();
  };

  await snap('home', (p) => p.waitForFunction(() => !document.getElementById('count').hidden));
  await snap('parts', async (p) => {
    await p.click('#open-parts');
    await p.getByRole('switch', { name: 'Search inserts' }).click();
  });
  // Put it back: the later shots start from the defaults again.
  await sw.evaluate(async () => {
    const { settings } = await chrome.storage.local.get('settings');
    settings.sites.youtube.shown = settings.sites.youtube.shown.filter((x) => x !== 'search_inserts');
    await chrome.storage.local.set({ settings });
  });
  await snap('settings', (p) => p.click('#open-settings'));
  await page.goto('https://www.youtube.com/watch?v=abcdefghijk');
  await page.waitForFunction(() => document.getElementById('tamescroll-style')?.textContent.length > 0);
  await snap('showing', (p) => p.waitForFunction(() => !document.getElementById('showing-wrap').hidden));
} finally {
  await ctx.close();
}

// ---- Composition -----------------------------------------------------

const FONTS = '<link href="https://fonts.googleapis.com/css2?family=Spectral:wght@500&family=Inter:wght@400;500;600&display=block" rel="stylesheet">';
const BASE = `
:root { --bg:#121212; --card:#1a1a19; --chip:#262625; --line:rgba(255,255,255,.07); --ink:#ecebe8; --muted:#a19d96; --faint:#6f6b65; --green:#86a893; --gold:#c9a45e; }
* { box-sizing:border-box; margin:0; padding:0; }
body { background:var(--bg); color:var(--ink); font-family:Inter, sans-serif; -webkit-font-smoothing:antialiased; overflow:hidden; }
h1 { font-family:Spectral, Georgia, serif; font-weight:500; letter-spacing:-.015em; line-height:1.08; }
p { color:var(--muted); }
.brand { display:flex; align-items:center; gap:12px; font-weight:600; font-size:18px; letter-spacing:-.01em; }
.brand img { width:36px; height:36px; border-radius:9px; }
.popup { border-radius:14px; box-shadow:0 30px 80px rgba(0,0,0,.55), 0 0 0 1px rgba(255,255,255,.08); display:block; }
/* A schematic browser window: grey blocks, no real site. */
.win { position:absolute; background:#181817; border-radius:14px; box-shadow:0 0 0 1px rgba(255,255,255,.06); overflow:hidden; }
.win .top { height:38px; background:#1f1f1e; display:flex; align-items:center; gap:7px; padding:0 14px; }
.win .top i { width:10px; height:10px; border-radius:50%; background:#3a3936; }
.win .top .url { margin-left:14px; height:20px; flex:1; max-width:340px; border-radius:6px; background:#2a2a28; }
.blk { position:absolute; background:#242423; border-radius:8px; }
`;

function frame({ title, body, popup, popupWidth = 440, page }) {
  return `<!doctype html><html><head>${FONTS}<style>${BASE}
  body { width:1280px; height:800px; position:relative; }
  .copy { position:absolute; left:84px; top:0; bottom:0; width:470px; display:flex; flex-direction:column; justify-content:center; gap:22px; }
  h1 { font-size:54px; }
  p { font-size:20px; line-height:1.5; }
  .shot { position:absolute; right:150px; top:50%; transform:translateY(-50%); }
  </style></head><body>
  ${page || ''}
  <div class="copy"><div class="brand"><img src="data:image/png;base64,${icon}">Tame Scroll</div><h1>${title}</h1><p>${body}</p></div>
  <div class="shot"><img class="popup" style="width:${popupWidth}px" src="data:image/png;base64,${popup}"></div>
  </body></html>`;
}

// The calm page behind a popup: a search bar and nothing else.
const CALM_PAGE = `<div class="win" style="left:620px; top:90px; width:700px; height:620px">
  <div class="top"><i></i><i></i><i></i><span class="url"></span></div>
  <div class="blk" style="left:40px; top:70px; width:150px; height:22px"></div>
  <div class="blk" style="left:230px; top:66px; width:330px; height:30px; border-radius:15px"></div>
  <div class="blk" style="left:40px; top:130px; width:120px; height:14px; opacity:.6"></div>
  <div class="blk" style="left:40px; top:160px; width:120px; height:14px; opacity:.6"></div>
  <div class="blk" style="left:40px; top:190px; width:120px; height:14px; opacity:.6"></div>
</div>`;
const WATCH_PAGE = `<div class="win" style="left:620px; top:90px; width:700px; height:620px">
  <div class="top"><i></i><i></i><i></i><span class="url"></span></div>
  <div class="blk" style="left:40px; top:66px; width:470px; height:264px"></div>
  <div class="blk" style="left:40px; top:350px; width:330px; height:20px"></div>
  <div class="blk" style="left:40px; top:384px; width:200px; height:14px; opacity:.6"></div>
  ${[0, 1, 2, 3, 4].map((i) => `<div class="blk" style="left:530px; top:${66 + i * 74}px; width:150px; height:62px; opacity:.75"></div>`).join('')}
</div>`;

const FRAMES = [
  ['screenshot-1', frame({
    title: 'Open the site, not the feed.',
    body: 'Tame Scroll hides algorithmic feeds, Shorts, Reels, autoplay and the other parts built to keep you scrolling. Search and your subscriptions stay.',
    popup: shots.home, page: CALM_PAGE,
  })],
  ['screenshot-2', frame({
    title: 'Bring back only what you want.',
    body: 'Feeds, Shorts and autoplay start hidden. One switch per part, per site, and the page changes as you flip it.',
    popup: shots.parts, popupWidth: 340, page: CALM_PAGE,
  })],
  ['screenshot-3', frame({
    title: 'Your choice stays in view.',
    body: 'What you brought back is listed first, with a one-tap Hide. The toolbar icon shows a small dot when a page is tamed.',
    popup: shots.showing, page: WATCH_PAGE,
  })],
  ['screenshot-4', frame({
    title: 'Five sites, one switch each.',
    body: 'YouTube, Reddit, X, Instagram and Facebook. Optional picture blur in three strengths. No account, and nothing about you leaves your browser.',
    popup: shots.settings, popupWidth: 390, page: CALM_PAGE,
  })],
];

const PROMO_SMALL = `<!doctype html><html><head>${FONTS}<style>${BASE}
  body { width:440px; height:280px; display:flex; flex-direction:column; justify-content:center; padding:0 36px; gap:16px; }
  h1 { font-size:34px; }
  </style></head><body><div class="brand"><img src="data:image/png;base64,${icon}">Tame Scroll</div><h1>A calmer social media.</h1></body></html>`;

const PROMO_MARQUEE = `<!doctype html><html><head>${FONTS}<style>${BASE}
  body { width:1400px; height:560px; position:relative; }
  .copy { position:absolute; left:96px; top:0; bottom:0; width:620px; display:flex; flex-direction:column; justify-content:center; gap:22px; }
  h1 { font-size:60px; }
  p { font-size:21px; line-height:1.5; }
  .shot { position:absolute; right:150px; top:60px; }
  </style></head><body>
  <div class="copy"><div class="brand"><img src="data:image/png;base64,${icon}">Tame Scroll</div><h1>A calmer social media.</h1><p>No algorithmic feeds, no Shorts or Reels, no autoplay. Bring back only what you want.</p></div>
  <div class="shot"><img class="popup" style="width:440px" src="data:image/png;base64,${shots.home}"></div>
  </body></html>`;

const browser = await chromium.launch();
try {
  const render = async (name, html, width, height) => {
    const p = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1 });
    await p.setContent(html, { waitUntil: 'networkidle' });
    await p.evaluate(() => document.fonts.ready);
    await p.screenshot({ path: join(here, `${name}.png`) });
    await p.close();
    console.log(`wrote store/chrome-web-store/${name}.png`);
  };
  for (const [name, html] of FRAMES) await render(name, html, 1280, 800);
  await render('promo-small', PROMO_SMALL, 440, 280);
  await render('promo-marquee', PROMO_MARQUEE, 1400, 560);
} finally {
  await browser.close();
}
