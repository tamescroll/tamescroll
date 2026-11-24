// Smart blur on live YouTube, measured from the runtime's own state.
//
// Runs on a machine with a real GPU (ZV's PC). For each clip whose people
// are known to be all men or all women (spikes/gauntlet/GOAL.md rotation
// notes), it plays the clip in a test Chromium with the built extension
// and samples every 500ms, in the extension's isolated world:
//   - persons: how many people the last pass found (__TS_GAZE_PERSONS);
//   - covered: the whole player blurred, or at least one patch drawn;
//   - the pass costs the runtime recorded.
// Then, per mode, the share of sampled moments with people on screen
// that were wrong:
//   - EXPOSURE: people of the blurred gender on screen and nothing drawn;
//   - FALSE COVER: only people of the other gender and something drawn.
// It sees no pixels, so it cannot score a patch that misses part of a
// person (PARTIAL) or drifts; that needs the frame-by-frame gauntlet.
//
// BLUR ON (ZV, 2026-11-23): before the first page, every site's Blur
// pictures is on at Strong and an init stylesheet blurs every img,
// picture, video, canvas and background image at 28px. A CSS filter is
// presentation only: the runtime reads the video's own frames.
//
//   node build.mjs && node smoke/gaze-live.mjs [seconds per clip]
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const here = dirname(fileURLToPath(import.meta.url));
const ext = process.env.TS_EXT_DIR ? join(here, '..', process.env.TS_EXT_DIR) : join(here, '..', 'dist', 'chrome');
const SECONDS = Number(process.argv[2] || 60);

// Who is on screen, from the gauntlet's own round notes (GOAL.md).
const CLIPS = [
  { id: 'QEG4pI2cRE8', start: 475, people: 'men', note: 'news panel, five men in boxes, small faces' },
  { id: '1L_R0MB2W5A', start: 30, people: 'men', note: 'post-match interview, two men' },
  { id: 'g_2Wmzpx47I', start: 20, people: 'women', note: 'pitchside interview, women' },
  { id: 'eVFzbxmKNUw', start: 270, people: 'women', note: 'TED talk, one woman, wide then close' },
];

const BLUR_ALL = `(() => {
  const css = 'img, picture, video, canvas { filter: blur(28px) !important; } * { background-image: none !important; }';
  const add = () => { const s = document.createElement('style'); s.textContent = css; (document.head || document.documentElement).appendChild(s); };
  if (document.documentElement) add(); else document.addEventListener('DOMContentLoaded', add);
})();`;

const PROBE = `(function () {
  var v = document.querySelector('#movie_player video');
  var host = document.querySelector('#movie_player');
  if (!v || !host) return null;
  var patches = 0;
  host.querySelectorAll('.ts-gaze-vregion-host').forEach(function (e) {
    var r = e.getBoundingClientRect();
    if (r.width > 0 && r.height > 0 && getComputedStyle(e).display !== 'none') patches++;
  });
  var cls = v.className || '';
  var d = window.__TS_GAZE_IDS || {};
  var c = d.cost || {};
  var pill = document.querySelector('.ts-gaze-pill');
  return {
    t: +v.currentTime.toFixed(2),
    paused: v.paused,
    ad: /ad-showing|ad-interrupting/.test(host.className || ''),
    persons: typeof window.__TS_GAZE_PERSONS === 'number' ? window.__TS_GAZE_PERSONS : null,
    whole: cls.indexOf('ts-gaze-pending') !== -1 || cls.indexOf('ts-gaze-flagged') !== -1,
    patches: patches,
    pill: pill ? pill.textContent : null,
    verdictMs: (c.verdict || []).slice(-1)[0] || null,
    passMs: (c.pass || []).slice(-1)[0] || null,
  };
})()`;

async function run(mode) {
  const ctx = await chromium.launchPersistentContext(mkdtempSync(join(tmpdir(), 'ts-live-')), {
    headless: false,
    channel: 'chromium',
    viewport: { width: 1400, height: 900 },
    args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`, '--autoplay-policy=no-user-gesture-required'],
  });
  await ctx.addInitScript(BLUR_ALL);
  let [sw] = ctx.serviceWorkers();
  if (!sw) sw = await ctx.waitForEvent('serviceworker');
  await sw.evaluate(async (m) => {
    for (let i = 0; i < 50; i++) {
      const st = await chrome.storage.local.get('settings');
      if (st.settings) {
        st.settings.blurPx = 28;
        for (const s of Object.values(st.settings.sites)) s.blur = true;
        const yt = st.settings.sites.youtube;
        yt.smart = m;
        // Ads off in the test profile, so ad frames do not stand in for the clip.
        yt.shown = (yt.shown || []).filter((x) => x !== 'ads');
        await chrome.storage.local.set({ settings: st.settings });
        break;
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    for (let i = 0; i < 50; i++) {
      if ((await chrome.scripting.getRegisteredContentScripts()).some((r) => r.id === 'youtube-gaze')) return;
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error('Smart blur never registered');
  }, mode);

  const out = [];
  for (const clip of CLIPS) {
    const page = await ctx.newPage();
    const cdp = await ctx.newCDPSession(page);
    const contexts = [];
    cdp.on('Runtime.executionContextCreated', (e) => contexts.push(e.context));
    await cdp.send('Runtime.enable');
    await page.goto(`https://www.youtube.com/watch?v=${clip.id}&t=${clip.start}s`, { waitUntil: 'domcontentloaded' });
    if (/consent\./.test(page.url())) {
      // Never accepted on his behalf.
      out.push({ ...clip, mode, error: 'consent page: not accepted by the harness' });
      await page.close();
      continue;
    }
    const rows = [];
    const t0 = Date.now();
    // 8s for the models and the delay line to come up, then sample.
    await page.waitForTimeout(8000);
    while (Date.now() - t0 < 8000 + SECONDS * 1000) {
      const iso = contexts.filter((c) => c.auxData && c.auxData.type === 'isolated').pop();
      if (iso) {
        try {
          const r = await cdp.send('Runtime.evaluate', { contextId: iso.id, returnByValue: true, expression: PROBE });
          if (r.result.value) rows.push(r.result.value);
        } catch (e) { /* a navigation in flight */ }
      }
      await page.waitForTimeout(500);
    }
    out.push({ ...clip, mode, rows });
    await page.close();
  }
  await ctx.close();
  return out;
}

function score(r) {
  const blurred = r.mode; // 'women' or 'men': the gender that should be covered
  const live = r.rows.filter((x) => !x.ad && !x.paused && x.persons !== null);
  const withPeople = live.filter((x) => x.persons > 0);
  const covered = (x) => x.whole || x.patches > 0;
  const shouldCover = r.people === blurred;
  const wrong = withPeople.filter((x) => (shouldCover ? !covered(x) : covered(x)));
  const costs = live.map((x) => x.verdictMs).filter((x) => typeof x === 'number').sort((a, b) => a - b);
  return {
    clip: `${r.id}@${r.start}`,
    people: r.people,
    mode: `blur ${blurred}`,
    kind: shouldCover ? 'EXPOSURE' : 'FALSE COVER',
    samples: live.length,
    withPeople: withPeople.length,
    wrong: wrong.length,
    wrongPct: withPeople.length ? Math.round((100 * wrong.length) / withPeople.length) : null,
    verdictP50: costs.length ? costs[Math.floor(costs.length / 2)] : null,
    pill: (live.find((x) => x.pill) || {}).pill || null,
    error: r.error || null,
  };
}

const all = [];
for (const mode of ['women', 'men']) all.push(...(await run(mode)));
const table = all.map((r) => (r.error ? { clip: `${r.id}@${r.start}`, mode: r.mode, error: r.error } : score(r)));
const file = join(here, '..', 'dist', `gaze-live-${Date.now()}.json`);
writeFileSync(file, JSON.stringify({ seconds: SECONDS, table, raw: all }, null, 1));
console.table(table);
console.log('raw samples:', file);
