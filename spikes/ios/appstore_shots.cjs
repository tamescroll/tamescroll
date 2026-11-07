// App Store screenshots of the launcher (web UI) at iPhone 6.9" size.
// Usage: node spikes/ios/appstore_shots.cjs app/dist <out dir> <platforms+surfaces json>
// The json is platforms() and surfaces(id) from lib.rs, dumped by a throwaway test.
const { chromium } = require('playwright');
const http = require('http');
const fs = require('fs');
const path = require('path');

const DIST = process.argv[2];
const OUT = process.argv[3];
const data = JSON.parse(fs.readFileSync(process.argv[4], 'utf8'));
const W = 440, H = 956, BAND = 62;

const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2', '.woff': 'font/woff', '.svg': 'image/svg+xml', '.png': 'image/png' };
const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  if (u.pathname === '/frame.html') {
    res.writeHead(200, { 'content-type': 'text/html' });
    const src = '/' + (u.searchParams.get('q') || '');
    res.end(`<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body style="margin:0;background:#141414;overflow:hidden">
<div style="height:${BAND}px;display:flex;align-items:center;justify-content:space-between;padding:0 34px 0 52px;color:#fff;font:600 17px -apple-system,Inter,sans-serif;box-sizing:border-box">
<span>9:41</span>
<span style="display:flex;gap:7px;align-items:center">
<svg width="19" height="12" viewBox="0 0 19 12"><g fill="#fff"><rect x="0" y="8" width="3" height="4" rx="1"/><rect x="5" y="5.5" width="3" height="6.5" rx="1"/><rect x="10" y="3" width="3" height="9" rx="1"/><rect x="15" y="0" width="3" height="12" rx="1"/></g></svg>
<svg width="17" height="12" viewBox="0 0 17 12"><path fill="#fff" d="M8.5 2.3c2.4 0 4.6.9 6.2 2.5l1.2-1.2C13.9 1.6 11.3.5 8.5.5S3.1 1.6 1.1 3.6l1.2 1.2C3.9 3.2 6.1 2.3 8.5 2.3zm0 3.6c1.4 0 2.7.5 3.7 1.5l1.2-1.2C12.1 4.9 10.4 4.2 8.5 4.2s-3.6.7-4.9 2l1.2 1.2c1-1 2.3-1.5 3.7-1.5zm0 3.5c-.5 0-1 .2-1.4.6L8.5 11.4l1.4-1.4c-.4-.4-.9-.6-1.4-.6z"/></svg>
<svg width="27" height="13" viewBox="0 0 27 13"><rect x=".5" y=".5" width="23" height="12" rx="3.5" fill="none" stroke="#fff" opacity=".4"/><rect x="2" y="2" width="20" height="9" rx="2" fill="#fff"/><rect x="24.5" y="4.5" width="1.5" height="4" rx=".7" fill="#fff" opacity=".4"/></svg>
</span></div>
<iframe id="app" src="${src}" style="border:0;width:${W}px;height:${H - BAND}px;display:block"></iframe></body></html>`);
    return;
  }
  let p = path.join(DIST, u.pathname === '/' ? 'index.html' : u.pathname);
  if (!fs.existsSync(p)) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'content-type': types[path.extname(p)] || 'application/octet-stream' });
  fs.createReadStream(p).pipe(res);
});

const mock = `
(() => {
  const data = ${JSON.stringify(data)};
  window.__TAURI_INTERNALS__ = {
    transformCallback: () => 0,
    invoke: async (cmd, args) => {
      if (cmd === 'platforms') return data.platforms;
      if (cmd === 'surfaces') return data.surfaces[args.id] || [];
      if (cmd === 'app_update_check') return { available: false };
      if (cmd === 'refresh_rules') return 'rules up to date';
      if (cmd === 'rules_summary') return {};
      return null;
    },
    metadata: { currentWindow: { label: 'main' }, currentWebview: { label: 'main', windowLabel: 'main' } },
  };
})();`;

(async () => {
  await new Promise((r) => server.listen(5179, r));
  const browser = await chromium.launch();
  const ctx = await browser.newContext({
    viewport: { width: W, height: H }, deviceScaleFactor: 3, isMobile: true, hasTouch: true,
    colorScheme: 'dark',
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148',
  });
  await ctx.addInitScript(mock);
  const page = await ctx.newPage();
  page.on('console', (m) => { if (m.type() === 'error') console.log('console:', m.text()); });
  page.on('pageerror', (e) => console.log('pageerror:', e.message));
  const app = () => page.frame({ url: /5179\/(\?|$|index)/ }) || page.frames()[1];
  const shot = async (name, wait = 1200) => { await page.waitForTimeout(wait); await page.screenshot({ path: path.join(OUT, name) }); console.log('wrote', name); };

  await page.goto('http://localhost:5179/frame.html');
  await shot('1-welcome.png', 2000);
  await app().click('#ob-start');
  await shot('2-demo.png', Number(process.env.DEMO_WAIT || 6000));

  // Onboarding done, three tiles chosen.
  await app().evaluate(() => {
    localStorage.setItem('tamescroll.chosen', JSON.stringify(['youtube', 'reddit', 'x', 'instagram', 'facebook']));
  });
  await page.goto('http://localhost:5179/frame.html');
  await shot('3-home.png', 2500);
  await page.goto('http://localhost:5179/frame.html?q=' + encodeURIComponent('?settings=https://www.youtube.com/'));
  await shot('5-settings.png', 2500);
  await browser.close();
  server.close();
})().catch((e) => { console.error(e); process.exit(1); });
