// What is YouTube's "Open App" pill on iPhone? (2026-10-27: ZV saw it on
// Appetize; Android's intent:// hide does not reach it.) Runs on the
// macOS CI runner with WebKit and an iPhone user agent, and prints every
// link or button that mentions the app, so the hide can name a real hook.
const { webkit, devices } = require('playwright');
(async () => {
  const b = await webkit.launch();
  const ctx = await b.newContext({ ...devices['iPhone 15 Pro'] });
  const pg = await ctx.newPage();
  const out = {};
  for (const url of ['https://m.youtube.com/', 'https://m.youtube.com/watch?v=dQw4w9WgXcQ']) {
    await pg.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await pg.waitForTimeout(8000);
    out[url] = await pg.evaluate(() =>
      [...document.querySelectorAll('a, button, [role=button]')]
        .filter((e) => /open app|get app|app store/i.test(e.textContent || '') ||
          /^(youtube|vnd\.youtube|intent):|apps\.apple|itunes|app=/i.test(e.getAttribute('href') || ''))
        .slice(0, 10)
        .map((e) => ({
          tag: e.tagName, href: e.getAttribute('href'), cls: String(e.className).slice(0, 120),
          text: (e.textContent || '').trim().slice(0, 40),
          path: (() => { const p = []; let n = e; for (let i = 0; n && i < 5; i++, n = n.parentElement) p.push(n.tagName.toLowerCase() + (n.id ? '#' + n.id : '')); return p.join(' < '); })(),
        })));
  }
  console.log(JSON.stringify(out, null, 1));
  await b.close();
})().catch((e) => { console.log('probe failed:', e.message); });
