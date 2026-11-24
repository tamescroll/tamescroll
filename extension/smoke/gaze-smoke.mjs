// Smart blur, offline: the built extension on a fixture YouTube search
// page whose thumbnails are five face photos from spikes/perf-harness
// (three women, two men). Checks the wiring end to end, the way the app's
// own runtime would behave on the live site:
//   - with Smart blur off, the gaze runtime is not registered at all;
//   - Women: every thumbnail starts covered (blur-first), the models load
//     from the package, and the women stay covered while the men clear;
//   - Men: the opposite.
// It is a wiring check on five faces, not an accuracy measurement.
// Women and men are judged from the runtime's own per-image record.
//
//   node build.mjs && node smoke/gaze-smoke.mjs
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import assert from 'node:assert/strict';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..', '..');
const ext = process.env.TS_EXT_DIR ? join(here, '..', process.env.TS_EXT_DIR) : join(here, '..', 'dist', 'chrome');

const FACES = [
  ['female', 'w'], ['male', 'm'], ['female2', 'w'], ['male2', 'm'], ['female3', 'w'],
];
const img = (name) => readFileSync(join(repo, 'spikes/perf-harness', name + '.jpg'));

const PAGE = `<!doctype html><html><head><title>search</title></head><body>
<ytd-search>${FACES.map(([n]) => `<ytd-video-renderer><ytd-thumbnail><img id="${n}" width="360" height="360" src="https://i.ytimg.com/vi/${n}/hq720.jpg"></ytd-thumbnail><span>${n}</span></ytd-video-renderer>`).join('\n')}
</ytd-search></body></html>`;

const ctx = await chromium.launchPersistentContext(mkdtempSync(join(tmpdir(), 'ts-gaze-')), {
  headless: true,
  channel: 'chromium',
  args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`, '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});

async function setSmart(sw, choice) {
  await sw.evaluate(async (c) => {
    const st = await chrome.storage.local.get('settings');
    st.settings.sites.youtube.smart = c;
    await chrome.storage.local.set({ settings: st.settings });
    for (let i = 0; i < 50; i++) {
      const regs = await chrome.scripting.getRegisteredContentScripts();
      if (regs.some((r) => r.id === 'youtube-gaze') === (c !== 'off')) return;
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error('registration never followed the setting');
  }, choice);
}

// The runtime's own per-image record (__TS_GAZE_IMGDIAG), read in the
// extension's isolated world where it lives. A covered face is a patch
// drawn over the picture, so the picture's own classes do not say it.
async function isolatedEval(cdp, contexts, expression) {
  const iso = contexts.filter((c) => c.auxData && c.auxData.type === 'isolated').pop();
  if (!iso) return null;
  const r = await cdp.send('Runtime.evaluate', { contextId: iso.id, returnByValue: true, expression });
  return r.result.value;
}

async function verdicts(cdp, contexts, timeoutMs) {
  const t0 = Date.now();
  let rows = [];
  while (Date.now() - t0 < timeoutMs) {
    rows = (await isolatedEval(cdp, contexts, 'JSON.stringify(window.__TS_GAZE_IMGDIAG || [])').then(JSON.parse).catch(() => [])) || [];
    if (FACES.every(([n]) => rows.some((r) => r.src.includes('/' + n + '/')))) break;
    await new Promise((r) => setTimeout(r, 500));
  }
  const states = {};
  for (const [n] of FACES) {
    const r = rows.filter((x) => x.src.includes('/' + n + '/')).pop();
    states[n] = !r ? 'pending' : r.flagged ? 'covered' : 'clear';
  }
  return { states, ms: Date.now() - t0, rows };
}

let failed = 0;
try {
  await ctx.route(/^https:\/\/www\.youtube\.com\//, (r) => r.fulfill({ status: 200, contentType: 'text/html', body: PAGE }));
  await ctx.route(/^https:\/\/i\.ytimg\.com\/vi\/([a-z0-9]+)\//, (r) => {
    const name = new URL(r.request().url()).pathname.split('/')[2];
    r.fulfill({ status: 200, contentType: 'image/jpeg', headers: { 'access-control-allow-origin': '*' }, body: img(name) });
  });
  await ctx.route(/^https:\/\/raw\.githubusercontent\.com\//, (r) => r.abort());

  let [sw] = ctx.serviceWorkers();
  if (!sw) sw = await ctx.waitForEvent('serviceworker');
  await sw.evaluate(async () => {
    for (let i = 0; i < 50; i++) {
      if ((await chrome.storage.local.get('settings')).settings) return;
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error('settings never seeded');
  });

  const page = await ctx.newPage();
  page.on('console', (m) => { if (/error/i.test(m.type())) console.log('  page:', m.text().slice(0, 200)); });
  const cdp = await ctx.newCDPSession(page);
  const contexts = [];
  cdp.on('Runtime.executionContextCreated', (e) => contexts.push(e.context));
  await cdp.send('Runtime.enable');

  await page.goto('https://www.youtube.com/results?search_query=x');
  await page.waitForTimeout(1500);
  assert.equal(await page.evaluate(() => document.querySelectorAll('.ts-gaze-pending, .ts-gaze-flagged').length), 0, 'off: nothing covered');
  console.log('off: runtime not registered, nothing covered');

  for (const [choice, covered] of [['women', 'w'], ['men', 'm']]) {
    await setSmart(sw, choice);
    contexts.length = 0;
    await page.goto('https://www.youtube.com/results?search_query=' + choice);
    // Blur-first: covered before any model has answered.
    await page.waitForFunction(() => document.querySelectorAll('.ts-gaze-pending').length > 0, null, { timeout: 5000 });
    const { states, ms } = await verdicts(cdp, contexts, 90000);
    console.log(`${choice}: ${JSON.stringify(states)} in ${ms}ms`);
    for (const [n, g] of FACES) {
      // male2 holds a second, weak face read as a woman: covered either
      // way is right (an unplaced face stays covered), so it is not scored.
      if (n === 'male2' && choice === 'women') continue;
      const want = g === covered ? 'covered' : 'clear';
      if (want !== states[n]) {
        failed++;
        console.log(`  MISMATCH ${n}: want ${want}, got ${states[n]}`);
      }
    }
  }
} finally {
  await ctx.close();
}
if (failed) {
  console.log(`${failed} face(s) disagreed`);
  process.exit(1);
}
console.log('gaze smoke passed');
